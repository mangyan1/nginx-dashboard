import express from 'express'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import multer from 'multer'
import { spawn } from 'node:child_process' // tail -F for SSE; args are a fixed array, never user strings
import { fileURLToPath } from 'node:url'
import {
  PATHS, MANIFEST, HTTP_CONF, mkdirs, validName, safeJoin, safeApply,
  nginxTest, systemctl, shell, listHistory, clearHistory, revertHistory, readHistoryEntry,
  scrubHistoryPasswords, listNginxFiles, readNginxConf,
} from './lib/nginx.js'
import {
  SELF_NAME, isSelf, defaultSite, readManifest, writeManifest, siteConfPath, enabledConfPath, certDir,
  renderHttpConf, renderSiteConf, writeHtpasswd, hashUserRows, validateSite, driftOf, httpConfDrift,
  parseManifest, selfSiteErrors, selfSiteWarnings, selfRevertErrors, docrootRemovalRefusal,
  NESTED, htpasswdPath,
} from './lib/manifest.js'
import { b32decode, newSecret, otpauth, totpValid } from './lib/totp.js'

// Number(), not the raw string: every comparison against this port is numeric, and a string
// would make each one false — the self-vhost check included.
const PORT = Number(process.env.DASH_PORT) || 7412
const HOST = process.env.DASH_HOST || '127.0.0.1'
const PASSWORD = process.env.DASH_PASSWORD
const DRY = process.env.DASH_DRY === '1' // dev mode: write files, skip nginx -t / reload / systemctl / certbot
const MAX_UPLOAD_MB = Number(process.env.DASH_MAX_UPLOAD_MB) || 2048
// Read from the package.json that is actually on this box, and served, not baked into the bundle:
// a version compiled into the frontend is the version of whatever was built, which is exactly the
// thing you cannot trust when the question is "which release is running on this server".
const APP_VERSION = (() => {
  try { return JSON.parse(fs.readFileSync(new URL('./package.json', import.meta.url), 'utf8')).version || '' }
  catch { return '' }
})()

// ---------- settings ----------
// The only file here that can hold a secret (the second-factor secret). 0600, and written
// tmp-then-rename, so a crash mid-write cannot leave a truncated file that reads as "no second
// factor". Deliberately not in the manifest: history snapshots restore whole site objects, and a
// reverted snapshot could resurrect or drop a second factor — the same reasoning that made `self`
// derived rather than stored.
const SETTINGS = path.join(PATHS.stateDir, 'settings.json')

function readSettings() {
  try { return JSON.parse(fs.readFileSync(SETTINGS, 'utf8')) } catch { return {} }
}

function writeSettings(next) {
  const tmp = `${SETTINGS}.tmp`
  fs.writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 })
  fs.renameSync(tmp, SETTINGS)
  // `mode` on writeFileSync only applies when the file is created, and a tmp left behind by a crash
  // would carry whatever mode it had. This is the one file here that holds a secret, so it is stated
  // rather than assumed.
  fs.chmodSync(SETTINGS, 0o600)
}

// The env var outranks the file, so install.sh's carry-over and the documented SSH recovery both
// keep working untouched. When it owns the secret the settings routes refuse rather than offering a
// control that would be ignored on the next restart.
const TOTP_FROM_ENV = !!process.env.DASH_TOTP_SECRET
let TOTP_SECRET = process.env.DASH_TOTP_SECRET || readSettings().totpSecret || ''

if (!PASSWORD) {
  console.error('Set DASH_PASSWORD env var before starting.')
  process.exit(1)
}

// A password that is printed in this repository is not a password, and the failure this catches is
// not a careless operator — it is a unit file that was copied and never edited, which is exactly
// what deploy/install.sh used to leave behind. Refused rather than warned about, because the person
// in that position is reading `systemctl status`, not a log they have no reason to open.
// DASH_DEMO=1 is the deliberate way past it, and only `npm run demo` sets that.
const PLACEHOLDERS = new Set(['change-me', 'changeme', 'demo', 'password', 'admin'])
if (PLACEHOLDERS.has(PASSWORD.trim().toLowerCase()) && process.env.DASH_DEMO !== '1') {
  console.error(
    `DASH_PASSWORD is "${PASSWORD}", a placeholder that ships in this repository.\n` +
    `Set a real one in /etc/systemd/system/nginx-dashboard.service:\n` +
    `    Environment=DASH_PASSWORD=$(openssl rand -hex 12)\n` +
    `then: systemctl daemon-reload && systemctl restart nginx-dashboard\n` +
    `A throwaway dashboard on purpose is \`npm run demo\`, which sets DASH_DEMO=1.`)
  process.exit(1)
}

if (TOTP_SECRET) {
  try {
    b32decode(TOTP_SECRET)
  } catch (e) {
    // Never a silent "second factor off": a mistyped secret that quietly drops 2FA is worse than
    // a dashboard that will not start. `npm run totp:new` prints a secret that parses.
    console.error(`DASH_TOTP_SECRET is not a base32 secret (${e.message}). Run: npm run totp:new`)
    process.exit(1)
  }
}

// What to do when a self-vhost guard refuses. The point of every refusal is that the operator is
// mid-lockout, so the way out belongs in the refusal itself, not in a doc they cannot reach.
const SELF_RECOVERY = [
  `You are not locked out: nginx serves the websites, but this dashboard is its own process and`,
  `is still listening on ${HOST}:${PORT}.`,
  `  from your machine:  ssh -N -L ${PORT}:${HOST}:${PORT} you@server   then open http://localhost:${PORT}`,
  `  the vhost itself:   Control → "Reaching this dashboard" repairs it, and the dashboard rewrites`,
  `                      ${SELF_NAME ? `sites-available/${SELF_NAME}.conf` : 'its own conf'} by itself the next time anything changes`,
].join('\n')

mkdirs()

// multer's temp files: an upload whose client vanished leaves its temp behind — multer cleans its
// own errors, not a disappeared peer, and nothing reads this directory again. Anything older than
// a day at boot is litter; a fresh one belongs to an upload that may be in flight.
const UPLOADS = path.join(PATHS.stateDir, 'uploads')
try {
  for (const f of fs.readdirSync(UPLOADS)) {
    if (Date.now() - fs.statSync(path.join(UPLOADS, f)).mtimeMs > 86_400_000) fs.rmSync(path.join(UPLOADS, f), { force: true })
  }
} catch { /* no uploads directory yet: nothing to sweep */ }

const app = express()
// Behind its own vhost every request arrives from nginx, so without this req.ip is 127.0.0.1 for
// everybody — one shared throttle bucket, where one attacker's five wrong passwords lock out the
// operator. 'loopback' rather than true: a forged X-Forwarded-For is only believed when the peer
// really is nginx, which is not the case if the port is ever reachable directly.
app.set('trust proxy', 'loopback')
app.use(express.json({ limit: '1mb' }))

// Three headers the browser should be told on every response, including the static shell. nosniff
// keeps anything here from being re-read as a different type; no-referrer keeps a URL that carries
// a query (a ?path=… deep link) out of other sites' logs; DENY keeps the panel out of a frame.
// No Content-Security-Policy yet — the theme boots from an inline script, so a policy would need
// script-src 'unsafe-inline' and be weakened from its first day.
app.use((req, res, next) => {
  res.set('X-Content-Type-Options', 'nosniff')
  res.set('Referrer-Policy', 'no-referrer')
  res.set('X-Frame-Options', 'DENY')
  next()
})

// ---------- auth: random token, in-memory map, cookie ----------
const sessions = new Map()
const COOKIE = 'sid'

// Sliding expiry only advances sessions that are used, so an abandoned one would sit for as long
// as the process runs. One sweep an hour deletes what authed() would refuse anyway.
setInterval(() => { for (const [t, s] of sessions) if (Date.now() > s.expires) sessions.delete(t) }, 3_600_000).unref()

function parseCookies(req) {
  const out = {}
  for (const pair of (req.headers.cookie || '').split(';')) {
    const i = pair.indexOf('=')
    if (i > 0) out[pair.slice(0, i).trim()] = pair.slice(i + 1).trim()
  }
  return out
}

function authed(req) {
  const token = parseCookies(req)[COOKIE]
  if (!token || !sessions.has(token)) return false
  const s = sessions.get(token)
  if (Date.now() > s.expires) { sessions.delete(token); return false }
  s.expires = Date.now() + 24 * 3600_000 // sliding
  return true
}

function requireAuth(req, res, next) {
  if (!authed(req)) return res.status(401).json({ error: 'unauthorized' })
  res.set('Cache-Control', 'no-store') // config state must never come from browser cache
  // The session token, so a pending second-factor enrolment can be keyed to the session that began
  // it rather than to a slot any signed-in caller could overwrite.
  req.sid = parseCookies(req)[COOKIE]
  next()
}

// sha256 both sides, then timingSafeEqual: the digests are fixed-width, so it cannot throw on
// length the way a raw comparison would, and it does not leak how much of the password matched.
function passwordOk(given) {
  const a = crypto.createHash('sha256').update(String(given || '')).digest()
  const b = crypto.createHash('sha256').update(PASSWORD).digest()
  return crypto.timingSafeEqual(a, b)
}

// A half-enrolled second factor is a second factor that is not yet real, so it is held in memory
// keyed by the session that began it and never reaches disk. Keyed by session rather than by a
// single slot, so one operator mid-enrolment cannot overwrite another's.
const PENDING_2FA = new Map()
const PENDING_TTL = 10 * 60_000

// Secure only when the request actually arrived over TLS. Setting it unconditionally would break
// the plain-HTTP SSH tunnel — which is the documented way back in when the vhost is broken, so
// the one cookie flag that hardens the normal path must not disable the recovery path.
const sessionCookie = (req, value, maxAge) =>
  `${COOKIE}=${value}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}${req.secure ? '; Secure' : ''}`

// ---------- login throttle ----------
// One shared password that is effectively root, on a port the LAN can reach: unthrottled it is
// guessable at whatever rate the network allows. In memory on purpose — restarting the service
// clears a lockout, and that is the recovery. A lockout persisted to disk is a lockout with
// nobody holding the key.
const FAILS = new Map() // ip -> { n, first, until }
const FAIL_MAX = 5
const FAIL_WINDOW = 15 * 60_000
const LOCK_FOR = 15 * 60_000

/** Seconds the caller must wait, or 0. Also drops an entry whose window has rolled over. */
function lockoutFor(ip) {
  const f = FAILS.get(ip)
  if (!f) return 0
  const now = Date.now()
  if (f.until > now) return Math.ceil((f.until - now) / 1000)
  if (now - f.first > FAIL_WINDOW) FAILS.delete(ip)
  return 0
}

function noteFailure(ip) {
  const now = Date.now()
  const f = FAILS.get(ip)
  if (!f || now - f.first > FAIL_WINDOW) { FAILS.set(ip, { n: 1, first: now, until: 0 }); return }
  if (++f.n >= FAIL_MAX) f.until = now + LOCK_FOR
}

app.post('/api/login', (req, res) => {
  const ip = req.ip || 'unknown'
  const wait = lockoutFor(ip)
  if (wait) {
    res.setHeader('Retry-After', String(wait))
    return res.status(429).json({ error: `too many failed logins — try again in ${Math.ceil(wait / 60)} min` })
  }
  const pwOk = passwordOk(req.body?.password)
  // Checked after the password, never before: an unauthenticated caller must not get an oracle
  // that tells them whether a guessed code was right.
  const codeOk = !TOTP_SECRET || totpValid(TOTP_SECRET, req.body?.code)
  if (!pwOk || !codeOk) {
    noteFailure(ip)
    return res.status(401).json({ error: pwOk ? 'wrong code' : 'wrong password' })
  }
  FAILS.delete(ip)
  const token = crypto.randomBytes(32).toString('hex')
  sessions.set(token, { expires: Date.now() + 24 * 3600_000 })
  res.setHeader('Set-Cookie', sessionCookie(req, token, 86400))
  res.json({ ok: true })
})

// What the sign-in form has to ask for, before anyone has signed in. Whether this install carries a
// second factor is not a secret worth keeping from someone who can already reach the port, and the
// alternative — revealing the code field only after an attempt is refused — spends one of the five
// failures that lock an address out on every legitimate sign-in.
app.get('/api/login', (req, res) => res.json({ totp: !!TOTP_SECRET }))

app.post('/api/logout', (req, res) => {
  const token = parseCookies(req)[COOKIE]
  if (token) sessions.delete(token)
  res.setHeader('Set-Cookie', sessionCookie(req, '', 0))
  res.json({ ok: true })
})

app.use('/api', requireAuth)

// One mutating request at a time. Every mutation is a read-modify-write cycle over the manifest —
// read in the route, written inside its apply() — so two overlapping saves read the same manifest
// and the second write erases the first's site from it while its conf stays behind on disk. GETs
// pass through: they cannot tear a write, which runs to completion inside one event-loop turn.
let writes = Promise.resolve()
app.use('/api', (req, res, next) => {
  if (req.method === 'GET') return next()
  writes = writes.then(
    () => new Promise(done => { res.on('finish', done); res.on('close', done); next() }),
    () => {},
  )
})

// DRY mode: write files but skip nginx -t / reload
// Every write first gives the dashboard's own vhost a chance to put itself back; see selfRepair.
const apply = async (...a) => {
  await selfRepair()
  return DRY ? safeApplyDry(...a) : safeApply(...a)
}
async function safeApplyDry(files, mutate) {
  try {
    // Same await as safeApply: the callers hash passwords inside the transaction, and a not-awaited
    // mutate would report success before the write landed.
    await mutate()
    return { ok: true, output: 'dry mode: written without nginx -t' }
  } catch (e) { return { ok: false, output: e.message } }
}

// The most recent selfRepair, so the UI can say so when the dashboard rewrote its own conf — and
// say why when it could not. Reset per process; the journal has the full story.
let lastSelfRepair = null

/**
 * The dashboard's own vhost, put back after a shell command removed its conf.
 *
 * `sites-enabled/<self>.conf` is a symlink into sites-available, and `nginx -t` fails on a dangling
 * include — so one `rm` refuses every write to every site, including the one that would repair it.
 * That is the whole reason this exists, and it runs before every write for no other reason.
 *
 * Gated on a live trace — the entry is still in sites-enabled. A vhost that was deliberately
 * unpublished has no entry, and re-creating it would put the dashboard back on the LAN unasked. A
 * conf that exists but was edited by hand is drift of the other kind and is left alone.
 *
 * Its own transaction, never the caller's, so it cannot clobber what the caller is about to write
 * (/selfsigned renders from the same manifest, writes second, and wins) — and so that a failure
 * here is logged rather than turning an unrelated save into a 422.
 */
async function selfRepair() {
  if (!SELF_NAME) return null
  const m = readManifest()
  const site = m.sites.find(s => isSelf(s.name))
  if (!site || !linkExists(site.name) || fs.existsSync(siteConfPath(site.name))) return null
  // `enabled: true` because the entry exists and this write is what makes it resolve again. Never
  // write a conf already known to be bad: nginx -t is the real check, but there is no reason to
  // hand it something the guards already reject.
  if (selfSiteErrors(site, { host: HOST, port: PORT, enabled: true }).length) return null
  // The primitive, not `apply` — that would call this again.
  const result = await (DRY ? safeApplyDry : safeApply)(siteFiles(site.name), () => writeSiteFiles(site, m),
    { label: `rewrite ${site.name}.conf`, record: false })
  lastSelfRepair = { ok: result.ok, output: result.output, at: new Date().toISOString() }
  if (!result.ok) console.error(`self-repair of ${site.name}.conf failed: ${result.output}`)
  return result
}

// ---------- module 1: server control ----------
// `dry` is this dashboard's own state rather than nginx's, but it is the same question — is nginx
// serving? — and it is a question two places now ask, so they ask it once.
async function nginxState() {
  if (DRY) return 'dry'
  const r = await shell('systemctl', ['is-active', 'nginx'])
  return r.status === 0 ? r.stdout.trim() : r.stderr.trim()
}

app.get('/api/status', async (req, res) => {
  const v = await shell('nginx', ['-v'])
  const active = await nginxState()
  // `nginx -v` prints to stderr. When the binary is missing that slot holds ENOENT text
  // instead, which the UI would render as the version — so only send it when it is one.
  const raw = (v.stderr || v.stdout).trim()
  res.json({
    active, version: raw.includes('nginx/') ? raw : '', dry: DRY, dashboard: APP_VERSION,
    // what the dashboard itself is bound to, so the UI can prefill a vhost that points back here
    host: HOST, port: PORT, selfName: SELF_NAME, totp: !!TOTP_SECRET, maxUploadMB: MAX_UPLOAD_MB,
    // non-loopback addresses of this box, to pick a LAN bind from. link-local IPv6 carries a
    // scope id (`fe80::1%eth0`) that is not valid in a `listen`, so it is filtered out here; the
    // bare `fe80::` form is no better, since without the interface it reaches nothing that a
    // `listen` can express. Ordered IPv4-first because a private IPv4 address is what "on the
    // LAN" means to the operator picking one, and the first entry is the default.
    addresses: Object.values(os.networkInterfaces()).flat()
      .filter(i => i && !i.internal && !i.address.includes('%'))
      .filter(i => i.family !== 'IPv6' || !/^fe80:/i.test(i.address))
      .sort((a, b) => (a.family === 'IPv6' ? 1 : 0) - (b.family === 'IPv6' ? 1 : 0))
      .map(i => ({ address: i.address, family: i.family === 'IPv6' ? 6 : 4 })),
  })
})

// Debian and Ubuntu write these when an upgrade put a new kernel or libc on disk that the running
// system is not using yet. That is the OS's own answer to "needs a reboot", which is why the
// dashboard does not try to work one out for itself — and why the file being absent (every non-
// Debian host, and this one under a dev run on Windows) correctly means nothing to report.
const REBOOT_REQUIRED = '/var/run/reboot-required'

/**
 * What the bell has to say, derived from state this process can already see. Nothing is stored and
 * nothing is acknowledged: an item is a fact about right now, so it stops being an item when the
 * fact is fixed rather than when a button is pressed. A stored "read" flag would be a way to hide a
 * broken conf, which is the one thing a notification must never be able to do.
 *
 * `tab` is where the fix lives, or '' when there is nothing to click — a reboot has no tab, and a
 * dead end styled as a link is worse than plain text.
 */
app.get('/api/notifications', async (req, res) => {
  const items = []
  const say = (id, kind, title, detail, tab = '') => items.push({ id, kind, title, detail, tab })

  const state = await nginxState()
  if (state !== 'active' && state !== 'dry')
    say('nginx-down', 'err', 'nginx is not running',
      `systemctl says "${state}" — nothing is being served until it starts`, 'control')

  const m = readManifest()
  for (const s of m.sites) {
    const d = driftOf(s)
    if (d === 'missing')
      say(`drift-missing-${s.name}`, 'err', `${s.name}: its conf is gone from disk`,
        'the site is in the manifest and sites-available has no file for it — the next restart of nginx will not find it', 'sites')
    else if (d === 'modified')
      say(`drift-modified-${s.name}`, 'warn', `${s.name}: conf edited outside the dashboard`,
        'the next save from here rewrites the file and those edits are gone', 'sites')
  }
  if (httpConfDrift(m.sites))
    say('drift-http', 'warn', 'the shared http conf was edited outside the dashboard',
      'upstreams and rate-limit zones live in conf.d/00-dashboard.conf; saving any site rewrites it', 'sites')

  // Ranked above every site problem above it, because this is the one file fault that stops nginx
  // from starting at all rather than stopping one site from working.
  for (const e of listNginxFiles().enabled.filter(e => !e.resolves))
    say(`dangling-${e.name}`, 'err', `sites-enabled/${e.name} points at nothing`,
      'nginx will not start while that entry is there — remove it, or restore the file it names', 'sites')

  const locked = [...FAILS.values()].filter(f => f.until > Date.now()).length
  if (locked)
    say('locked', 'warn', `${locked} address${locked === 1 ? '' : 'es'} locked out`,
      'too many failed sign-ins; each clears itself, or clear them from Settings', 'settings')

  if (fs.existsSync(REBOOT_REQUIRED)) {
    // The .pkgs file is written alongside it but is not guaranteed, and an item that vanishes
    // because a second file is missing would be a strange failure for the operator to meet.
    let pkgs = []
    try { pkgs = fs.readFileSync(`${REBOOT_REQUIRED}.pkgs`, 'utf8').trim().split('\n').filter(Boolean) } catch {}
    say('reboot', 'warn', 'the server needs a reboot',
      pkgs.length ? `installed but not running yet: ${pkgs.join(', ')}` : 'a kernel or library update is installed and not in use')
  }

  // An update that has been installed and not loaded. This is the one case the Updates panel cannot
  // report after its tab has been closed: the old code is still serving requests, and nothing on
  // screen says so. BOOT_VERSIONS is what this process is running; installedVersion reads the disk.
  const stale = RUNTIME_DEPS().filter(n => {
    const now = installedVersion(n)
    return BOOT_VERSIONS[n] && now && now !== BOOT_VERSIONS[n]
  })
  if (stale.length)
    say('restart', 'warn', 'an update is installed but not loaded',
      `${stale.map(n => `${n} ${BOOT_VERSIONS[n]} → ${installedVersion(n)}`).join(', ')} — restart the dashboard to load it`, 'settings')

  // The registry is the only thing in this route that leaves the machine, so it is never allowed to
  // hold up the answer: on a cold cache the check is started and this response goes out without it,
  // and the next poll has it. The bell has to open instantly on the box where everything is broken,
  // and that is exactly the box where an outbound lookup is the slowest thing here — eight seconds a
  // package, on the screen the operator opened to find out why they are down.
  if (UPDATE_CACHE.data) {
    const { packages } = UPDATE_CACHE.data
    const behind = packages.filter(p => p.updatable && p.latest && p.installed && p.latest !== p.installed)
    if (behind.length)
      say('updates', 'info', `${behind.length} package update${behind.length === 1 ? '' : 's'} available`,
        behind.map(p => `${p.name} ${p.installed} → ${p.latest}`).join(', '), 'settings')
  } else if (!UPDATE_PENDING) {
    UPDATE_PENDING = true
    checkUpdates(true).catch(() => {}).finally(() => { UPDATE_PENDING = false })
  }

  // Severity, not the order they were discovered in: the list is read from the top on a phone, and
  // the one item that has to be seen is the one that has to be first. Array#sort is stable, so
  // within a kind the manifest's own order survives.
  const RANK = { err: 0, warn: 1, info: 2 }
  items.sort((a, b) => RANK[a.kind] - RANK[b.kind])

  res.json({ items })
})

/**
 * The server's own default-site factory, exposed. The site form puts a "use default" chip on every
 * editable control, and a chip can only be honest if it shows the value the server would actually
 * apply — the client kept its own copy of these defaults and had already drifted from them (a
 * nine-entry cache-extension list against the server's ten, so a new site's conf was rendered from
 * a list the form never displayed). `name` is optional: `root` is the only name-dependent field and
 * a form for a site that does not exist yet has no name. Declared below requireAuth, so it is
 * authenticated like every other /api route.
 */
app.get('/api/site-defaults', (req, res) => {
  const name = String(req.query.name || '')
  if (name && !validName(name)) return res.status(400).json({ error: 'invalid name' })
  res.json({ defaults: defaultSite(name), create: createDefaults(name) })
})

app.post('/api/nginx/:action', async (req, res) => {
  const { action } = req.params
  if (DRY) return res.json({ ok: true, output: 'dry mode: command skipped' })
  let result
  if (action === 'test') result = await nginxTest()
  else if (action === 'reload') {
    const r = await shell('nginx', ['-s', 'reload'])
    result = r.status === 0 ? { ok: true, output: 'reloaded' } : { ok: false, output: r.stderr.trim() }
  }
  else if (['start', 'stop', 'restart'].includes(action)) result = await systemctl(action)
  else return res.status(400).json({ error: 'unknown action' })
  res.json(result)
})

// ---------- modules 2-5: sites ----------
/**
 * Whether the site's symlink is in sites-enabled — the *entry*, not whether its target resolves.
 * `fs.existsSync` follows the link, so a dangling one (the conf was deleted by hand) reads as
 * "not there", and every reading that mistake produces is wrong: the site is reported disabled
 * while nginx is failing on it, testLinkFor decides it may link that path in — which makes safeApply
 * delete the operator's real symlink on the way out — and a save that would repair it is refused
 * for leaving the site disabled. `lstat` is the fix for all four.
 */
function linkExists(name) {
  try {
    return fs.lstatSync(enabledConfPath(name), { throwIfNoEntry: false }) !== undefined
  } catch {
    // ELOOP or EACCES: something is there and it is not a plain missing entry. Say it is linked and
    // let nginx -t complain in its own words — this is also called on the way up, and a throw there
    // would be the dashboard failing to start.
    return true
  }
}

function siteState(name) {
  return { enabled: linkExists(name) }
}

function findSite(name) {
  return readManifest().sites.find(s => s.name === name)
}

function sanitizeSite(input, base) {
  // The name is pinned *first*, because it decides the docroot default: read the other way round,
  // `PUT /api/sites/real` with `{"name":"evil","root":""}` would fill root from /var/www/evil and
  // write it into real's conf. The URL param names the file; the body never renames it.
  const name = base ? base.name : String(input?.name || '')
  const d = defaultSite(name)
  // Unknown keys are dropped, not stored: overlayErrors refuses a key that is not a site field,
  // and a save draws the same line — anything else rides into the manifest for ever, unread by
  // anything and uncleanable by any save. `base` is left as it is: already-stored keys are the
  // manifest's, and rewriting history here would rewrite sites nobody is editing.
  const known = Object.fromEntries(Object.entries(input || {}).filter(([k]) => k in d))
  const s = { ...base, ...known, name }
  for (const k of NESTED) {
    s[k] = { ...(base?.[k] || d[k]), ...(input?.[k] || {}) }
  }
  s.proxy = Array.isArray(input?.proxy) ? input.proxy : (base?.proxy || [])
  s.upstreams = Array.isArray(input?.upstreams) ? input.upstreams : (base?.upstreams || [])
  s.domains = (s.domains || []).map(String).map(x => x.trim()).filter(Boolean)
  // API must be safe regardless of what the client sends. These five fallbacks used to be literals
  // typed out again here — a second copy of defaultSite, which is exactly how a default and the
  // value the API actually applies drift apart. One factory, so the form's "use default" chip
  // cannot promise a number the server would not have written.
  if (typeof s.root !== 'string' || !s.root.trim()) s.root = d.root
  if (typeof s.port !== 'number' || s.port < 1 || s.port > 65535) s.port = d.port
  if (typeof s.httpsPort !== 'number' || s.httpsPort < 1 || s.httpsPort > 65535) s.httpsPort = d.httpsPort
  if (typeof s.index !== 'string' || !s.index.trim()) s.index = d.index
  // validateSite rejects an out-of-range value outright; this only keeps a bad one from being
  // rendered if a caller ever reaches the writer without validating first.
  if (!Number.isInteger(s.clientMaxBodySize) || s.clientMaxBodySize < 0) s.clientMaxBodySize = d.clientMaxBodySize
  // derived, never taken from the body: a forged `self: true` on an ordinary site would paint
  // the self badge and grey out its Delete button for no reason
  s.self = isSelf(s.name)
  return s
}

function writeSiteFiles(site, m) {
  writeManifest(m)
  fs.writeFileSync(siteConfPath(site.name), renderSiteConf(site))
  fs.writeFileSync(HTTP_CONF, renderHttpConf(m.sites))
}

/**
 * The site factory with the operator's own preferences laid over it. Applied **only when a site is
 * created**: `normalizeSite` keeps filling gaps from `defaultSite`, so changing a preference here
 * can never retroactively reinterpret a site that already exists and is already serving traffic.
 * Deep-merged one level, the same shape sanitizeSite builds, so an override like
 * `{"gzip":{"enabled":false}}` cannot drop the types that live beside it.
 */
function createDefaults(name, o = readSettings().newSiteDefaults || {}) {
  const d = defaultSite(name)
  const s = { ...d, ...o, name }
  for (const k of NESTED) s[k] = { ...d[k], ...(o[k] || {}) }
  return s
}

/**
 * Checks a partial site before it is allowed to become a default. Two questions, and the first is
 * the one that matters: is every key a real field? A typo'd key is accepted by every structural
 * check there is and then silently does nothing — the exact "reads ON while the conf emits nothing"
 * failure this whole pass exists to close. The second is the renderer's own validator, run against
 * the assembled site, so a value that passes here is one that can be written to a conf.
 */
function overlayErrors(o) {
  if (!o || typeof o !== 'object' || Array.isArray(o)) return ['must be a JSON object']
  const def = defaultSite('example')
  const errs = []
  for (const [k, v] of Object.entries(o)) {
    if (k === 'name' || k === 'self' || !(k in def)) { errs.push(`not a site field: ${k}`); continue }
    const dv = def[k]
    if (Array.isArray(dv)) {
      if (!Array.isArray(v)) errs.push(`${k} must be a list`)
    } else if (dv && typeof dv === 'object') {
      if (!v || typeof v !== 'object' || Array.isArray(v)) { errs.push(`${k} must be an object`); continue }
      for (const [k2, v2] of Object.entries(v)) {
        if (!(k2 in dv)) errs.push(`not a ${k} field: ${k2}`)
        else if (typeof v2 !== typeof dv[k2]) errs.push(`${k}.${k2} must be a ${typeof dv[k2]}`)
      }
    } else if (typeof v !== typeof dv) errs.push(`${k} must be a ${typeof dv}`)
  }
  if (!errs.length) errs.push(...validateSite(createDefaults('example', o)))
  return errs
}

// MANIFEST belongs in the transaction: it is written inside mutate(), so leaving it out of
// `files` means a failed nginx -t rolls the conf back while the manifest keeps the change.
// The htpasswd file belongs here for the same reason: a save that fails must put the password
// file back with the manifest and the conf, and a delete must take it away with them.
const siteFiles = name => [siteConfPath(name), HTTP_CONF, MANIFEST, htpasswdPath(name)]

// Advisory, and only for the dashboard's own vhost — a save that would work but leave it more
// exposed than it needs to be still goes through, and the response carries the reason to reconsider.
const warningPayload = site => {
  const warnings = isSelf(site.name) ? selfSiteWarnings(site) : []
  return warnings.length ? { warnings, recovery: SELF_RECOVERY } : {}
}

const recover = msg => `${msg}\n\n${SELF_RECOVERY}`

// A disabled site's conf must still be checked: `nginx -t` reads only sites-enabled, so without
// this it saves with a 200 and only fails later, on Enable. Harmless to link in for the test —
// see safeApply's testLink. `linkExists`, not existsSync: a *dangling* entry is a real symlink, and
// safeApply removes whatever it linked, so calling that one absent would delete it.
const testLinkFor = name => (linkExists(name)
  ? undefined
  : { path: enabledConfPath(name), target: siteConfPath(name) })

app.get('/api/sites', (req, res) => {
  const m = readManifest()
  const managed = new Set(m.sites.map(s => s.name))
  const onDisk = fs.existsSync(PATHS.sitesAvail)
    ? fs.readdirSync(PATHS.sitesAvail).filter(f => f.endsWith('.conf')).map(f => f.replace(/\.conf$/, ''))
    : []
  res.json({
    sites: [
      ...m.sites.map(s => ({ ...s, managed: true, ...siteState(s.name), drift: driftOf(s), ...(s.self ? { recovery: SELF_RECOVERY } : {}) })),
      ...onDisk.filter(n => !managed.has(n)).map(n => ({ name: n, managed: false, ...siteState(n) })),
    ],
    // every site's upstreams and rate-limit zones live in this one file
    httpConfDrift: httpConfDrift(m.sites),
    // only ever non-null once the dashboard has rewritten its own conf, or failed to
    selfRepair: lastSelfRepair,
  })
})

app.get('/api/sites/:name', (req, res) => {
  const { name } = req.params
  if (!validName(name)) return res.status(400).json({ error: 'invalid name' })
  const site = findSite(name)
  if (!site) return res.status(404).json({ error: 'not found (unmanaged sites are read-only)' })
  res.json({ site, ...siteState(name), drift: driftOf(site), ...(site.self ? { recovery: SELF_RECOVERY } : {}) })
})

/**
 * The two directories as files, which is the one view the manifest cannot give: a conf enabled but
 * never written, a symlink whose target was deleted by hand, a file that is neither. Read-only, and
 * the only route here that serves the contents of a file the operator did not create through this
 * dashboard — `readNginxConf` confines it to those two directories.
 */
app.get('/api/nginx-files', (req, res) => {
  const { available, enabled } = listNginxFiles()
  const managed = new Set(readManifest().sites.map(s => s.name))
  const knows = file => managed.has(file.replace(/\.conf$/, ''))
  res.json({
    available: available.map(name => ({ name, managed: knows(name) })),
    enabled: enabled.map(e => ({ ...e, managed: knows(e.name) })),
  })
})

app.get('/api/nginx-files/:name', (req, res) => {
  const file = readNginxConf(req.params.name)
  if (!file) return res.status(404).json({ error: 'no such conf in sites-available or sites-enabled' })
  res.json({ file })
})

app.post('/api/sites', async (req, res) => {
  const name = String(req.body?.name || '')
  if (!validName(name)) return res.status(400).json({ error: 'invalid site name' })
  const m = readManifest()
  if (m.sites.some(s => s.name === name)) return res.status(409).json({ error: 'site exists' })
  // Under the body, so an unmentioned field lands on the operator's own preference and not on the
  // built-in. The form always sends every field, so this decides only what a blank one means — and
  // it is the same object the form seeds from, which is what keeps a blank from meaning two things.
  const site = sanitizeSite({ ...createDefaults(name), ...req.body, name })

  const errs = validateSite(site)
  // `enabled` deliberately not passed: every site is created disabled, so requiring the self
  // vhost to already be live here would make publishing it impossible. The form says to click
  // Enable, and the next save is checked against the state on disk.
  if (isSelf(name)) errs.push(...selfSiteErrors(site, { host: HOST, port: PORT }))
  if (errs.length) return res.status(400).json({ error: errs.join('; ') + (isSelf(name) ? `\n\n${SELF_RECOVERY}` : '') })

  m.sites.push(site)
  // The password write happens *inside* the transaction, after safeApply has backed the previous
  // file up: a failed nginx -t or reload then restores the old password file along with the
  // manifest, instead of leaving a new password live on a site the save just refused. Back onto
  // the object *before* the manifest is written: the returned rows are the hashed ones, and
  // `site` is what writeSiteFiles stores. Left unassigned, the plaintext the form sent would be
  // what lands in the manifest — the hashing would look like it worked and change nothing.
  const result = await apply(siteFiles(name), async () => {
    site.basicAuth = { ...site.basicAuth, users: await writeHtpasswd(site) }
    writeSiteFiles(site, m)
  }, { label: `create site ${name}`, testLink: testLinkFor(name) })
  if (!result.ok) return res.status(422).json({ error: result.output })

  // docroot + placeholder so the site serves something immediately. Created only once the conf
  // is accepted: a create that nginx rejects must leave nothing behind, and nginx -t does not
  // care whether the docroot exists — only serving it does.
  fs.mkdirSync(site.root, { recursive: true })
  const idx = path.join(site.root, 'index.html')
  if (!fs.existsSync(idx)) fs.writeFileSync(idx, `<h1>${site.domains[0] || site.name}</h1>\n<p>Deployed via nginx-dashboard.</p>\n`)

  res.json({ ok: true, site, ...warningPayload(site) })
})

app.put('/api/sites/:name', async (req, res) => {
  const { name } = req.params
  const m = readManifest()
  const base = m.sites.find(s => s.name === name)
  if (!base) return res.status(404).json({ error: 'not found' })
  const site = sanitizeSite(req.body, base)

  const errs = validateSite(site)
  // read from disk, not from the body: testLinkFor links a disabled site in for `nginx -t`, so a
  // payload claiming `enabled` cannot be trusted to mean nginx will actually serve it
  if (isSelf(name)) errs.push(...selfSiteErrors(site, { host: HOST, port: PORT, enabled: linkExists(name) }))
  if (errs.length) return res.status(400).json({ error: errs.join('; ') + (isSelf(name) ? `\n\n${SELF_RECOVERY}` : '') })

  // Inside the transaction, for the same reason as the create route: a refused save must not
  // leave the new password on disk.
  m.sites = m.sites.map(s => (s.name === name ? site : s))
  const result = await apply(siteFiles(name), async () => {
    site.basicAuth = { ...site.basicAuth, users: await writeHtpasswd(site) }
    writeSiteFiles(site, m)
  }, { label: `update site ${name}`, testLink: testLinkFor(name) })
  if (!result.ok) return res.status(422).json({ error: result.output })
  res.json({ ok: true, site, ...warningPayload(site) })
})

/**
 * The document-root half of a delete, as one clause for the toast. Never throws: by the time this
 * runs the site is already gone, and a failed `rmSync` must not turn a completed deletion into an
 * error that reads as "nothing happened".
 */
function removeRootOutput(root) {
  // Dry mode is the demo, whose document roots are real absolute paths outside its throwaway tree.
  if (DRY) return `dry mode — the document root ${root} was not removed`
  if (!fs.existsSync(root)) return `nothing to remove at ${root}`
  try {
    fs.rmSync(root, { recursive: true, force: true })
    return `the document root ${root} was removed`
  } catch (e) {
    return `but the document root ${root} could not be removed (${e.message}) — the files are still there`
  }
}

app.delete('/api/sites/:name', async (req, res) => {
  const { name } = req.params
  // The one deletion that removes the page the operator is looking at. Refused rather than
  // warned: there is no "undo" click available to someone who cannot load the UI.
  if (isSelf(name)) {
    return res.status(403).json({ error: `"${name}" is this dashboard's own vhost — deleting it would take away the page you are clicking on.\n\n${SELF_RECOVERY}` })
  }
  const m = readManifest()
  const site = m.sites.find(s => s.name === name)
  if (!site) return res.status(404).json({ error: 'not found' })

  // Only asked for when the delete dialog's box was ticked. Everything below is skipped otherwise,
  // so a plain delete is byte-for-byte what it was.
  const withRoot = req.query.root === '1'
  // Both refusals, before a single file is written — a 400 here has to leave the site and its files
  // exactly as they were. Dry mode is checked *first* on purpose: the demo's document roots are real
  // absolute paths, so a guard that passed would put `rmSync` on real disk during `npm run demo`.
  // This refuses the *removal*, never the site deletion, so the demo still deletes sites.
  if (withRoot && !DRY) {
    const refusal = docrootRemovalRefusal(site.root, m.sites, name)
    if (refusal) return res.status(400).json({ error: refusal })
  }

  m.sites = m.sites.filter(s => s.name !== name)
  const result = await apply([...siteFiles(name), enabledConfPath(name)], () => {
    writeManifest(m)
    fs.rmSync(siteConfPath(name), { force: true })
    fs.rmSync(enabledConfPath(name), { force: true })
    // The site's password file goes with it — hashes for a site that no longer exists are
    // litter, and turning basic auth back on (which is why a disable leaves it) needs the site.
    // It is in `files`, so a failed delete restores it instead of leaving it gone.
    fs.rmSync(htpasswdPath(name), { force: true })
    fs.writeFileSync(HTTP_CONF, renderHttpConf(m.sites))
  }, { label: `delete site ${name}` })
  if (!result.ok) return res.status(422).json({ error: result.output })

  // After apply(), never inside it: safeApply rolls back by restoring byte-for-byte copies of the
  // files it was handed, and a directory cannot enter `backups` — so a removal in there would roll
  // the site's conf and manifest back while its files stayed gone, which is the exact state the
  // transaction exists to prevent. `revertHistory` cannot help either; it is a config history.
  const output = withRoot ? removeRootOutput(site.root) : undefined
  res.json(output ? { ok: true, output } : { ok: true })
})

// Express 5 (path-to-regexp 8) dropped inline regex params, so `:toggle(enable|disable)`
// becomes two literal routes instead of one. Literal segments keep the original matching
// exactly — a single `/:toggle` route would also match /files, /upload-zip and /selfsigned,
// which share this shape and are declared below, so it would shadow all three.
const toggleSite = toggle => async (req, res) => {
  const { name } = req.params
  if (!findSite(name)) return res.status(404).json({ error: 'not found' })
  // Disable is refused on the dashboard's own vhost; Enable is not. Enable is the way back in
  // after a hand-edit or a bad cert, so it has to stay available precisely where disabling is not.
  if (toggle === 'disable' && isSelf(name)) {
    return res.status(403).json({ error: recover(`"${name}" is this dashboard's own vhost — disabling it would take this page offline. Edit it instead, or take it out of sites-enabled on the server if that is really what you want.`) })
  }
  const result = await apply([enabledConfPath(name)], () => {
    if (toggle === 'enable') {
      fs.rmSync(enabledConfPath(name), { force: true })
      fs.symlinkSync(siteConfPath(name), enabledConfPath(name), 'file')
    } else {
      fs.rmSync(enabledConfPath(name), { force: true })
    }
  }, { label: `${toggle} site ${name}` })
  if (!result.ok) return res.status(422).json({ error: result.output })
  res.json({ ok: true })
}

app.post('/api/sites/:name/enable', toggleSite('enable'))
app.post('/api/sites/:name/disable', toggleSite('disable'))

// The one state no live trace heals: the vhost is genuinely disabled (no sites-enabled entry) and
// its conf is gone. There is nothing for selfRepair to key on, and Enable would link to a file that
// does not exist. Self-only, and only ever for a *missing* conf — a conf that is on disk is what
// Save is for, which also keeps this from becoming a general "overwrite any site" button.
app.post('/api/sites/:name/repair', async (req, res) => {
  const { name } = req.params
  if (!isSelf(name)) return res.status(403).json({ error: `"${name}" is not this dashboard's own vhost — open it in Sites and save it.` })
  const m = readManifest()
  const site = m.sites.find(s => s.name === name)
  if (!site) return res.status(404).json({ error: 'not found' })
  if (fs.existsSync(siteConfPath(name))) {
    return res.status(400).json({ error: `${siteConfPath(name)} is on disk — save the site to rewrite it.` })
  }
  // `enabled` deliberately not passed, the same as on create: this runs exactly when the site is
  // disabled, so requiring it to be live would refuse the repair it exists for.
  const errs = validateSite(site)
  errs.push(...selfSiteErrors(site, { host: HOST, port: PORT }))
  if (errs.length) return res.status(400).json({ error: errs.join('; ') + `\n\n${SELF_RECOVERY}` })

  const result = await apply(siteFiles(name), () => writeSiteFiles(site, m),
    { label: `rewrite ${name}.conf`, testLink: testLinkFor(name), record: false })
  if (!result.ok) return res.status(422).json({ error: result.output })
  res.json({ ok: true })
})

// ---------- change history: undo a change that turned out badly ----
// Every successful mutation above is snapshotted by safeApply. Only *failed* changes used to
// be reversible; a change that worked and then turned out to be wrong had no way back.
app.get('/api/history', (req, res) => res.json({ entries: listHistory() }))

app.post('/api/history/:id/revert', async (req, res) => {
  // Look at the snapshot before letting the restore run. revertHistory validates nothing — it
  // puts bytes back — and it restores the manifest wholesale, so an unrelated old change being
  // undone can carry the dashboard's own vhost back to a state that does not reach this page.
  const entry = readHistoryEntry(req.params.id)
  if (!entry) return res.status(422).json({ error: 'no such history entry' })
  const errs = selfRevertErrors(entry, { host: HOST, port: PORT, enabled: linkExists(SELF_NAME) })
  if (errs.length) return res.status(422).json({ error: recover(`not reverting: ${errs.join('; ')}`) })

  const result = await revertHistory(req.params.id, apply)
  if (!result.ok) return res.status(422).json({ error: result.output })
  res.json({ ok: true, output: result.output })
})

// ---------- module 2: docroot file manager ----------
// Bounded, because this writes into a process running as root and `express.json`'s 1mb cap does
// not apply to multipart at all — without a limit, "deploy a zip" is an unbounded write to /tmp.
const upload = multer({
  dest: path.join(PATHS.stateDir, 'uploads'),
  limits: { fileSize: MAX_UPLOAD_MB * 1024 * 1024, files: 200 },
})

/**
 * Give paths inside a document root to the web user, and say why if it will not.
 *
 * Everything this process writes is owned by root, and nginx only ever reads — so for the static
 * sites this dashboard mostly manages, root-owned files are invisible. They stop being invisible the
 * moment PHP is involved: php-fpm runs as www-data, and a tree it cannot write is one WordPress
 * cannot put an upload in, replace a plugin in, or read a 0640 wp-config.php out of. Read bits are
 * not the problem, which is why this is a chown and never a mode.
 *
 * Returns null when the paths now belong to www-data, else the reason chown gave. A sentence rather
 * than a throw, so each caller can name the state it left behind and the way out — the shape
 * `docrootRemovalRefusal` and `driftOf` already use.
 *
 * `recursive` is for the one caller that extracts an archive, whose paths cannot be listed; the
 * others pass the leaf paths they just wrote, where walking the tree would be a pointless traversal.
 */
async function handToWebUser(paths, recursive = false) {
  // Dry mode writes files and never touches the system — that is what `npm run demo` runs, on
  // whatever machine is trying this dashboard out, where there is no php-fpm and on Windows no
  // www-data to chown to. Ownership is system state, so it is skipped with the rest of it.
  if (DRY) return null
  const list = [].concat(paths).filter(Boolean)
  if (!list.length) return null
  const r = await shell('chown', [...(recursive ? ['-R'] : []), 'www-data:www-data', ...list], { timeout: 60_000 })
  return r.status === 0 ? null : ((r.stderr || '').trim() || 'chown refused')
}

app.get('/api/sites/:name/files', (req, res) => {
  const site = findSite(req.params.name)
  if (!site) return res.status(404).json({ error: 'not found' })
  try {
    const dir = safeJoin(site.root, String(req.query.path || ''))
    const entries = fs.readdirSync(dir, { withFileTypes: true }).map(e => {
      const st = fs.statSync(path.join(dir, e.name))
      return { name: e.name, dir: e.isDirectory(), size: st.size, mtime: st.mtime.toISOString() }
    })
    res.json({ path: path.relative(site.root, dir) || '.', entries })
  } catch (e) {
    res.status(400).json({ error: e.message })
  }
})

app.post('/api/sites/:name/files', upload.array('files'), async (req, res) => {
  const site = findSite(req.params.name)
  if (!site) return res.status(404).json({ error: 'not found' })
  try {
    const dir = safeJoin(site.root, String(req.body.path || ''))
    fs.mkdirSync(dir, { recursive: true })
    const written = []
    for (const f of req.files || []) {
      const dest = path.join(dir, path.basename(f.originalname))
      fs.renameSync(f.path, dest)
      written.push(dest)
    }
    // The directory as well as the files: `mkdirSync` above may have just made it, and one only root
    // can write into is the same problem one level up.
    const bad = await handToWebUser([dir, ...written])
    if (bad) return res.status(400).json({ error: `${bad} — the files are in ${dir} but are still owned by root, so a PHP site cannot rewrite them` })
    res.json({ ok: true, count: (req.files || []).length })
  } catch (e) {
    res.status(400).json({ error: e.message })
  }
})

// deploy a whole folder in one action: upload a zip, extract into the docroot
app.post('/api/sites/:name/upload-zip', upload.single('zip'), async (req, res) => {
  const site = findSite(req.params.name)
  if (!site || !req.file) return res.status(400).json({ error: 'site or zip missing' })
  let dir
  try {
    dir = safeJoin(site.root, String(req.body.path || ''))
    fs.mkdirSync(dir, { recursive: true })
    // unzip refuses absolute paths and .. by default, so zip-slip is contained to the docroot anyway
    const r = await shell('unzip', ['-o', req.file.path, '-d', dir])
    if (r.status !== 0) throw new Error(r.stderr.trim() || 'unzip failed')
    // Recursive here, because what unzip wrote is a tree whose paths were never listed.
    const bad = await handToWebUser(dir, true)
    if (bad) return res.status(400).json({ error: `${bad} — the archive was extracted into ${dir} but is still owned by root, so a PHP site cannot rewrite it` })
    res.json({ ok: true })
  } catch (e) {
    res.status(400).json({ error: String(e.message).slice(0, 500) })
  } finally {
    fs.rmSync(req.file.path, { force: true })
  }
})

// ---------- module 3b: WordPress ----------

const WP_META_URL = 'https://api.wordpress.org/core/version-check/1.7/'
const WP_SALT_URL = 'https://api.wordpress.org/secret-key/1.1/salt/'
const WP_MAX_ZIP = 64 * 1024 * 1024
// exactly what POST /api/sites writes into a fresh docroot, and nothing else
const WP_PLACEHOLDER = /^\s*<h1>[^<]*<\/h1>\s*<p>Deployed via nginx-dashboard\.<\/p>\s*$/

/**
 * `null` when the docroot is empty or holds only the placeholder the create route wrote, else a
 * description of what is there. Extracting over an operator's real files is the one irreversible
 * mistake this route can make, so "occupied" is decided by reading the file, not by counting.
 */
function docrootOccupied(root) {
  let names
  try { names = fs.readdirSync(root) } catch { return null } // no docroot is not an occupied one
  if (!names.length) return null
  if (names.length === 1 && names[0] === 'index.html') {
    try {
      if (WP_PLACEHOLDER.test(fs.readFileSync(path.join(root, 'index.html'), 'utf8'))) return null
    } catch { /* unreadable is not empty */ }
  }
  return names.slice(0, 8).join(', ') + (names.length > 8 ? ` and ${names.length - 8} more` : '')
}

/**
 * The release metadata and the archive, from wordpress.org's own version service. No version
 * constant anywhere, and `wordpress.org/latest.zip` is deliberately unused: it redirects but does
 * not say what it is, so the version reported to the operator would be a guess.
 */
async function fetchWordpress() {
  const meta = await fetch(WP_META_URL, { signal: AbortSignal.timeout(20_000) })
  if (!meta.ok) throw new Error(`wordpress.org answered ${meta.status} for the version list`)
  const { offers } = await meta.json()
  if (!Array.isArray(offers) || !offers.length) throw new Error('wordpress.org sent no releases')
  const { version, download } = offers.find(o => o.locale === 'en_US' && o.response === 'upgrade') || offers[0]
  // This URL arrives over the network and this route turns it into files in a served directory.
  const url = new URL(String(download || ''))
  if (url.protocol !== 'https:' || !/(^|\.)wordpress\.org$/.test(url.hostname)) {
    throw new Error(`wordpress.org offered a download from ${url.origin}, which is not wordpress.org`)
  }
  const zip = await fetch(url, { signal: AbortSignal.timeout(120_000) })
  if (!zip.ok) throw new Error(`the download answered ${zip.status}`)
  // content-length is a claim, so the same cap is applied again to what actually arrived
  if (Number(zip.headers.get('content-length') || 0) > WP_MAX_ZIP) throw new Error('the download is larger than this route will write')
  const buf = Buffer.from(await zip.arrayBuffer())
  if (buf.length > WP_MAX_ZIP) throw new Error(`the download was ${Math.round(buf.length / 1048576)} MB, larger than this route will write`)
  return { version: String(version || ''), buf }
}

const WP_SALTS = ['AUTH_KEY', 'SECURE_AUTH_KEY', 'LOGGED_IN_KEY', 'NONCE_KEY', 'AUTH_SALT', 'SECURE_AUTH_SALT', 'LOGGED_IN_SALT', 'NONCE_SALT']

/**
 * wp-config.php, from the sample WordPress ships, with the database and eight fresh salts.
 *
 * The salts come from WordPress's own endpoint rather than from `crypto` here — it is the canonical
 * source and the format is theirs. Every substitution uses a function replacer, so a value holding
 * `$&` cannot be read as a backreference; and a line the sample does not have throws, rather than
 * quietly leaving "put your unique phrase here" in a file the site serves.
 */
async function writeWpConfig(dir, { dbName, password }) {
  const r = await fetch(WP_SALT_URL, { signal: AbortSignal.timeout(20_000) })
  if (!r.ok) throw new Error(`wordpress.org answered ${r.status} for the salts`)
  const salts = new Map([...((await r.text()).matchAll(/define\(\s*'([A-Z_]+)'\s*,\s*'([^']*)'\s*\);/g))].map(m => [m[1], m[2]]))
  const missing = WP_SALTS.filter(k => !salts.get(k))
  if (missing.length) throw new Error(`wordpress.org sent no ${missing.join(', ')}`)

  const put = (text, key, val) => {
    const re = new RegExp(`define\\(\\s*'${key}'\\s*,\\s*'[^']*'\\s*\\);`)
    if (!re.test(text)) throw new Error(`wp-config-sample.php has no ${key} line`)
    return text.replace(re, () => `define( '${key}', '${val}' );`)
  }
  let conf = fs.readFileSync(path.join(dir, 'wp-config-sample.php'), 'utf8')
  const values = [['DB_NAME', dbName], ['DB_USER', dbName], ['DB_PASSWORD', password], ['DB_HOST', 'localhost'], ...WP_SALTS.map(k => [k, salts.get(k)])]
  for (const [k, v] of values) conf = put(conf, k, v)
  // 0640 and not 0644: this file holds the database password, and the group is what php-fpm runs as
  fs.writeFileSync(path.join(dir, 'wp-config.php'), conf, { mode: 0o640 })
}

/**
 * The database, its user and the grant, in one `-e` call. The SQL is a single argv element and never
 * a shell string, and both interpolated values are already constrained — the name passed
 * `validName`, so no quote, backtick or semicolon can reach it, and the password is base64url. That
 * constraint is the whole injection defense here; neither may be loosened without re-reading this.
 *
 * `CREATE ... IF NOT EXISTS` then `ALTER USER` is what makes a retry converge: a second attempt
 * mints a new password, and without the ALTER the user would keep the first one while the
 * wp-config.php just written got the second.
 */
async function createWordpressDb(bin, name, password) {
  const sql = [
    `CREATE DATABASE IF NOT EXISTS \`${name}\`;`,
    `CREATE USER IF NOT EXISTS '${name}'@'localhost' IDENTIFIED BY '${password}';`,
    `ALTER USER '${name}'@'localhost' IDENTIFIED BY '${password}';`,
    `GRANT ALL PRIVILEGES ON \`${name}\`.* TO '${name}'@'localhost';`,
    'FLUSH PRIVILEGES;',
  ].join(' ')
  const r = await shell(bin, ['-e', sql], { timeout: 30_000 })
  if (r.status !== 0) throw new Error((r.stderr || r.stdout).trim().slice(-500) || `${bin} refused the statement`)
}

/**
 * Download WordPress into a site's docroot, with a database and a wp-config.php for it.
 *
 * Deliberately outside apply() and outside the manifest. safeApply rolls back by restoring
 * byte-for-byte copies of the files it is handed, and a directory cannot enter `backups` — so the
 * ordering below is what makes a failure safe instead: everything lands in a scratch dir first, and
 * the docroot is only touched once the whole download, database and config have succeeded.
 *
 * The credentials live in wp-config.php and nowhere else. Not in the manifest, not in settings —
 * so they cannot be read back out of the dashboard, and a history revert cannot resurrect them.
 */
app.post('/api/sites/:name/wordpress', async (req, res) => {
  const site = findSite(req.params.name)
  if (!site) return res.status(404).json({ error: 'not found' })

  const occupied = docrootOccupied(site.root)
  if (occupied) {
    return res.status(409).json({ error: `${site.root} already holds ${occupied} — this would write over them. Move them aside, or delete the document root along with the site.` })
  }

  // Three things the conf has to say before WordPress can serve, checked together because they are
  // fixed in one place, the site form. Off, the static fallback serves wp-config.php as plain text;
  // no front controller and every permalink 404s; no index.php and the site root itself 403s. A site
  // created from the WordPress starting point has all three, so this normally never fires.
  const index = String(site.index || '').trim().split(/\s+/)
  const notReady = [
    !(site.php?.enabled && site.php?.endpoint) && 'PHP is off, so wp-config.php would be served as plain text',
    !site.php?.frontController && 'the PHP front controller is off, so permalinks would 404',
    !index.includes('index.php') && 'index.php is not in the index list, so the site root would 403',
  ].filter(Boolean)
  if (notReady.length) {
    return res.status(409).json({ error: `this site is not set up to run WordPress — ${notReady.join('; ')}. Open it in Sites and turn those on; Settings → Stack shows the PHP endpoint to paste in.` })
  }

  if (DRY) return res.status(409).json({ error: 'dry run — nothing is downloaded' })

  const stack = await stackStatus()
  if (!stack.db.kind) return res.status(409).json({ error: 'no database server on this box — install the stack from Settings → Stack first' })

  let scratch
  let version = ''
  try {
    const dl = await fetchWordpress()
    version = dl.version
    scratch = fs.mkdtempSync(path.join(PATHS.stateDir, 'wordpress-'))
    fs.writeFileSync(path.join(scratch, 'wordpress.zip'), dl.buf)
    // unzip refuses absolute paths and .. by default, so zip-slip is contained to the scratch dir
    const un = await shell('unzip', ['-q', '-o', path.join(scratch, 'wordpress.zip'), '-d', scratch], { timeout: 120_000 })
    if (un.status !== 0) throw new Error(un.stderr.trim() || 'unzip failed')
    // checked rather than assumed: unzip exits 0 on an archive whose top directory is named
    // anything at all, and the copy below needs to know which one it got
    const src = path.join(scratch, 'wordpress')
    if (!fs.existsSync(path.join(src, 'index.php'))) throw new Error('the archive contains no wordpress/index.php')

    const password = crypto.randomBytes(24).toString('base64url')
    // detection decided which server is on the box; its client is the matching one
    await createWordpressDb(stack.db.kind === 'mysql' ? 'mysql' : 'mariadb', site.name, password)
    await writeWpConfig(src, { dbName: site.name, password })

    fs.cpSync(src, site.root, { recursive: true, force: true })
    // Recursive: cpSync copies mode but never ownership, so the whole tree above landed root-owned.
    // No cleanup on failure — the files are already in the docroot and the route refuses a retry
    // while it is occupied, so the operator has to be told how to leave that state.
    const bad = await handToWebUser(site.root, true)
    if (bad) throw new Error(`${bad} — WordPress was written to ${site.root} but is still owned by root, so php-fpm cannot read it. Delete the site with its document root, then create it again.`)
    // not carried reliably by cpSync, and this is the file with the password in it
    fs.chmodSync(path.join(site.root, 'wp-config.php'), 0o640)
    // the placeholder would otherwise win the site's root URL: nginx resolves `/` through `index`,
    // which finds index.html long before it reaches the front controller
    const idx = path.join(site.root, 'index.html')
    if (fs.existsSync(idx) && WP_PLACEHOLDER.test(fs.readFileSync(idx, 'utf8'))) fs.rmSync(idx, { force: true })
  } catch (e) {
    return res.status(502).json({ error: String(e.message).slice(0, 600) })
  } finally {
    if (scratch) fs.rmSync(scratch, { recursive: true, force: true })
  }
  res.json({ ok: true, version, db: site.name })
})

app.delete('/api/sites/:name/files', (req, res) => {
  const site = findSite(req.params.name)
  if (!site) return res.status(404).json({ error: 'not found' })
  try {
    const target = safeJoin(site.root, String(req.query.path || ''))
    if (target === path.resolve(site.root)) return res.status(400).json({ error: 'cannot delete the docroot itself' })
    fs.rmSync(target, { recursive: true })
    res.json({ ok: true })
  } catch (e) {
    res.status(400).json({ error: e.message })
  }
})

// ---------- module 4: certificates ----------
app.post('/api/sites/:name/selfsigned', async (req, res) => {
  const m = readManifest()
  const site = m.sites.find(s => s.name === req.params.name)
  if (!site) return res.status(404).json({ error: 'not found' })
  if (!site.domains.length) return res.status(400).json({ error: 'add a domain first' })
  // the CN goes into an openssl -subj argument, so keep it to hostname characters
  if (!/^(\*\.)?[a-zA-Z0-9.-]+$/.test(site.domains[0])) return res.status(400).json({ error: 'invalid domain for a cert' })
  const dir = certDir(site.name)
  fs.mkdirSync(dir, { recursive: true })
  if (DRY) {
    fs.writeFileSync(path.join(dir, 'fullchain.pem'), 'dry-mode placeholder\n')
    fs.writeFileSync(path.join(dir, 'privkey.pem'), 'dry-mode placeholder\n')
  } else {
    const r = await shell('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '825',
      '-keyout', path.join(dir, 'privkey.pem'), '-out', path.join(dir, 'fullchain.pem'),
      '-subj', `/CN=${site.domains[0]}`,
      '-addext', `subjectAltName=DNS:${site.domains[0]}`])
    if (r.status !== 0) return res.status(500).json({ error: r.stderr.slice(0, 500) })
  }
  site.https.mode = 'selfsigned'
  const result = await apply(siteFiles(site.name), () => writeSiteFiles(site, m), { label: `self-signed cert for ${site.name}` })
  if (!result.ok) return res.status(422).json({ error: result.output })
  res.json({ ok: true })
})

app.post('/api/cert', async (req, res) => {
  const domain = String(req.body?.domain || '').trim()
  if (!/^[a-zA-Z0-9.-]+$/.test(domain)) return res.status(400).json({ error: 'invalid domain' })
  if (DRY) return res.json({ ok: true, output: 'dry mode: certbot skipped' })
  const r = await shell('certbot', ['--nginx', '-d', domain, '--non-interactive', '--agree-tos',
    '--register-unsafely-without-email'], { timeout: 120_000 })
  if (r.status !== 0) return res.status(500).json({ error: (r.stderr || r.stdout).slice(0, 2000) })
  // certbot edited the conf itself; mark the site so regeneration keeps the 443 block + cert paths
  const m = readManifest()
  const site = m.sites.find(s => s.domains.includes(domain))
  if (site) {
    site.https.mode = 'certbot'
    const result = await apply(siteFiles(site.name), () => writeSiteFiles(site, m), { label: `certbot cert for ${domain}` })
    if (!result.ok) return res.status(422).json({ error: result.output })
  }
  res.json({ ok: true, output: r.stdout.slice(0, 2000) })
})

// ---------- module 6: logs (SSE) + metrics ----------
app.get('/api/logs/tail', (req, res) => {
  let target
  try {
    target = safeJoin(PATHS.logDir, req.query.file === 'error' ? 'error.log' : 'access.log')
  } catch { return res.status(400).json({ error: 'bad file' }) }
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    // Tells any nginx in front not to buffer this response. It only matters when the dashboard is
    // reached through a hand-written vhost — one this dashboard generated sets proxy_buffering off
    // itself — but a frozen log tail is otherwise very hard to explain.
    'X-Accel-Buffering': 'no',
  })
  res.write(': connected\n\n') // flush, so a proxy in front opens the stream immediately

  const child = spawn('tail', ['-n', '200', '-F', target])
  let buf = ''
  let stopped = false
  let ping = null
  const stop = () => {
    if (stopped) return
    stopped = true
    clearInterval(ping)
    child.kill('SIGKILL')
  }
  // A half-closed peer (FIN_WAIT_2) leaves this socket undestroyed, so the tail child would
  // linger. The heartbeat turns a dead peer into a write error; both close events stop it.
  ping = setInterval(() => {
    try { res.write(': ping\n\n') } catch { stop() }
  }, 30_000)

  child.stdout.on('data', chunk => {
    buf += chunk.toString()
    const lines = buf.split('\n')
    buf = lines.pop() || ''
    for (const l of lines) if (l) res.write(`data: ${l}\n\n`)
  })
  child.on('error', () => { res.end(); stop() }) // tail missing (e.g. dev machine)
  res.on('close', stop)
  req.on('close', stop)
  // no per-file guard against duplicate streams; only this dashboard consumes it
})

app.post('/api/logs/rotate', async (req, res) => {
  if (DRY) return res.json({ ok: true, output: 'dry mode' })
  const r = await shell('logrotate', ['-f', '/etc/logrotate.d/nginx'])
  if (r.status !== 0) return res.json({ ok: false, output: r.stderr.trim() })
  // The reopen is ours, not the distribution's. logrotate only renames; the signal that makes
  // nginx let go of the old inode is supposed to come from that file's postrotate, which is
  // `invoke-rc.d nginx rotate` — denied by policy-rc.d inside a container, silently, exit 0.
  // nginx writes on to the renamed file and the fresh one stays empty for ever, while logrotate
  // still reports success. Rename-then-signal is the documented order either way, so doing it
  // here is the same thing one step closer to the code that depends on it.
  const s = await shell('nginx', ['-s', 'reopen'])
  res.json(s.status === 0 ? { ok: true, output: 'rotated' } : { ok: false, output: s.stderr.trim() })
})

app.post('/api/logs/purge', async (req, res) => {
  const days = Math.max(0, Math.min(3650, Number(req.body?.days ?? 30)))
  const r = await shell('find', [PATHS.logDir, '-name', '*.gz', '-mtime', `+${days}`, '-delete'])
  res.json(r.status === 0 ? { ok: true, output: `purged rotated logs older than ${days} days` } : { ok: false, output: r.stderr.trim() })
})

// Put the dashboard's own vhost back before anything else, so a restart on its own recovers a conf
// that was deleted by hand — and so the first /api/sites of the new process already reports healthy
// rather than waiting for some unrelated write to pass through the guard.
await selfRepair()

// stub_status: loopback-only status server, written once at startup
const STATUS_CONF = path.join(PATHS.confD, '00-dashboard-status.conf')
const STATUS_CONF_TEXT = `# managed by nginx-dashboard
server {
    listen 127.0.0.1:8099;
    location /nginx_status {
        stub_status;
        allow 127.0.0.1;
        deny all;
    }
}
`
if (!fs.existsSync(STATUS_CONF)) {
  // awaited so the server is not listening before stub_status is live — otherwise a first
  // /api/metrics call races the nginx -t + reload this triggers and 503s
  const stub = await apply([STATUS_CONF], () => fs.writeFileSync(STATUS_CONF, STATUS_CONF_TEXT), { label: 'enable metrics (stub_status)' })
  // Not silent: on a box where this write is refused (a conf.d the dashboard cannot write, say),
  // the only symptom was /api/metrics answering 503 for ever with no hint of why.
  if (!stub.ok) console.error(`could not write ${STATUS_CONF}: ${stub.output}`)
}

app.get('/api/metrics', async (req, res) => {
  try {
    const r = await fetch('http://127.0.0.1:8099/nginx_status', { signal: AbortSignal.timeout(3000) })
    const text = await r.text()
    const nums = text.match(/\d+/g)?.map(Number) || []
    res.json({
      active: nums[0], accepted: nums[1], handled: nums[2], requests: nums[3],
      reading: nums[4], writing: nums[5], waiting: nums[6],
    })
  } catch {
    res.status(503).json({ error: 'stub_status unreachable — is nginx running with the module loaded?' })
  }
})

// ---------- module 7: settings ----------
/** Where the second factor currently comes from, so the panel can say why a control is inert. */
const totpState = () => ({
  enabled: !!TOTP_SECRET,
  source: TOTP_FROM_ENV ? 'env' : (TOTP_SECRET ? 'file' : 'off'),
})

app.get('/api/settings', (req, res) => {
  res.json({
    totp: totpState(),
    newSiteDefaults: readSettings().newSiteDefaults || {},
    // read-only, and shown so the numbers behind a lockout are not folklore
    lockout: { max: FAIL_MAX, windowMin: FAIL_WINDOW / 60_000, lockMin: LOCK_FOR / 60_000 },
    // Never the addresses themselves beyond what the operator typed to get here — this is the list
    // they need to see to understand why they are locked out, and it is in memory by design.
    locked: [...FAILS.entries()].filter(([, f]) => f.until > Date.now()).map(([ip, f]) => ({ ip, until: f.until })),
    env: {
      host: HOST, port: PORT, dry: DRY, selfName: SELF_NAME,
      maxUploadMB: MAX_UPLOAD_MB, manifest: MANIFEST, settings: SETTINGS, stateDir: PATHS.stateDir,
      node: process.version,
    },
  })
})

// `code` is the code from the authenticator, not the password: enrolment is the one thing an
// already-signed-in operator does not have to re-prove a password for, because they had to give it
// to get the session. Disabling is the opposite — see below.
app.post('/api/settings/2fa/begin', (req, res) => {
  if (TOTP_FROM_ENV) return res.status(409).json({ error: 'the second factor is set by DASH_TOTP_SECRET in the service unit — remove that line and restart to manage it here' })
  const secret = newSecret()
  PENDING_2FA.set(req.sid, { secret, expires: Date.now() + PENDING_TTL })
  res.json({ secret, uri: otpauth(secret, SELF_NAME || 'nginx-dashboard'), expiresInSec: PENDING_TTL / 1000 })
})

app.post('/api/settings/2fa/enable', (req, res) => {
  if (TOTP_FROM_ENV) return res.status(409).json({ error: 'the second factor is set by DASH_TOTP_SECRET in the service unit' })
  const p = PENDING_2FA.get(req.sid)
  if (!p || p.expires < Date.now()) {
    PENDING_2FA.delete(req.sid)
    return res.status(400).json({ error: 'no enrolment in progress — start again, the secret is only held for ten minutes' })
  }
  // Verified before it is written: storing a secret whose code has never worked would lock the
  // operator out on the next sign-in, with no way back in but SSH.
  if (!totpValid(p.secret, req.body?.code)) {
    return res.status(400).json({ error: 'that code does not match — check the clock on the phone and try the current one' })
  }
  writeSettings({ ...readSettings(), totpSecret: p.secret })
  TOTP_SECRET = p.secret
  PENDING_2FA.delete(req.sid)
  res.json({ ok: true })
})

// Password only, and no code: a lost phone has to be recoverable from the UI, and the password is
// the thing the operator still has. Same check the login route makes, so there is one answer to
// "is this the password" rather than two that can disagree.
app.post('/api/settings/2fa/disable', (req, res) => {
  if (TOTP_FROM_ENV) return res.status(409).json({ error: 'the second factor is set by DASH_TOTP_SECRET in the service unit — the panel cannot turn it off' })
  // 403, not 401: the caller is signed in and this is the password being refused, and a 401 is what
  // the client reads as "your session ended" — it would sign the operator out over a typo in a field
  // on a page they were already using.
  if (!passwordOk(req.body?.password)) return res.status(403).json({ error: 'wrong password' })
  const s = readSettings()
  delete s.totpSecret
  writeSettings(s)
  TOTP_SECRET = ''
  // An enrolment still in progress belongs to a factor that no longer exists, so it goes too —
  // otherwise a code typed at a stale QR turns the second factor back on just after it was turned
  // off. Expired entries need no sweep of their own: `begin` overwrites and `enable` checks the
  // deadline when it reads.
  PENDING_2FA.delete(req.sid)
  res.json({ ok: true })
})

app.post('/api/settings/lockouts/clear', (req, res) => {
  const n = FAILS.size
  FAILS.clear()
  res.json({ ok: true, output: `${n} address${n === 1 ? '' : 'es'} unlocked` })
})

// The undo history is bounded at twenty snapshots already, so this is not housekeeping — it is for
// the case where the snapshots themselves are the problem: each one carries the manifest with its
// basic-auth passwords, and an operator about to hand the box over may want them gone.
app.delete('/api/settings/history', async (req, res) => {
  const n = listHistory().length
  clearHistory()
  res.json({ ok: true, output: `${n} snapshot${n === 1 ? '' : 's'} removed` })
})

app.put('/api/settings/new-site-defaults', (req, res) => {
  const o = req.body?.defaults
  const errs = overlayErrors(o)
  if (errs.length) return res.status(400).json({ error: errs.join('; ') })
  writeSettings({ ...readSettings(), newSiteDefaults: o })
  res.json({ ok: true, defaults: o })
})

// The seven dependencies, asked one at a time with a short timeout. Node 22's global fetch, so no
// new runtime dependency — and nothing about this install is sent beyond a package name. A host
// with no outbound internet gets a sentence, not a broken tab.
const DEP_NAMES = () => {
  try {
    const p = JSON.parse(fs.readFileSync(new URL('./package.json', import.meta.url), 'utf8'))
    return Object.keys({ ...p.dependencies, ...p.devDependencies })
  } catch { return [] }
}

// What is on disk, not the range package.json asks for. `^5.2.1` compared against a registry
// version is not a comparison at all — every package then reads as behind for ever, which is how a
// button reporting "8 of 8" teaches the operator to stop reading it. Blank means the package is not
// installed here, which is the honest answer for a devDependency on a server that ran
// `npm ci --omit=dev`: it is not part of that install and never updates there.
const installedVersion = name => {
  try {
    return JSON.parse(fs.readFileSync(new URL(`./node_modules/${name}/package.json`, import.meta.url), 'utf8')).version || ''
  } catch { return '' }
}

// What can actually be updated from here. A devDependency is bundled into `dist/` at build time and
// is not even installed on a server that ran `npm ci --omit=dev` — npm moving its version changes
// nothing that is served, and offering a button for it would be a button that does nothing.
const RUNTIME_DEPS = () => {
  try { return Object.keys(JSON.parse(fs.readFileSync(new URL('./package.json', import.meta.url), 'utf8')).dependencies || {}) }
  catch { return [] }
}

// Where npm runs: the directory server.js itself lives in, which is the same one `installedVersion`
// reads node_modules from. A URL is a valid `cwd`.
const APP_DIR = new URL('.', import.meta.url)
// npm is a shell script on Linux and a .cmd shim on Windows, and this is developed on Windows.
const NPM = process.platform === 'win32' ? 'npm.cmd' : 'npm'
// Windows refuses to spawn a .cmd without a shell — execFile answers EINVAL — so the shell is turned
// on there and only there. It stays off on the box this actually runs on, and `name` cannot reach a
// command line unchecked regardless: it is matched against the keys of this project's own
// package.json before anything is spawned.
const NPM_SHELL = process.platform === 'win32'

// What this process is actually running, read once at boot. A package whose version on disk has
// moved since is an update that has been installed and not loaded — the only thing "restart needed"
// can mean here, and invisible from the panel the moment its tab closes.
const BOOT_VERSIONS = Object.fromEntries(RUNTIME_DEPS().map(n => [n, installedVersion(n)]))

/**
 * The registry check is the one thing here that leaves the machine, and the bell asks on every poll,
 * so the answer is cached. A request per package per poll for a version number nobody is waiting on
 * is how a dashboard gets itself rate-limited, and on a host with no outbound DNS it is eight
 * seconds a package every thirty seconds for an item that would have been empty anyway. Six hours is
 * far shorter than any release cadence that matters. `?force=1` is the Settings panel's own fetch,
 * which skips the cache and refills it — so opening that tab is what keeps the bell's copy fresh.
 */
let UPDATE_CACHE = { at: 0, data: null }
let UPDATE_PENDING = false
const UPDATE_TTL = 6 * 60 * 60 * 1000

async function checkUpdates(force) {
  if (!force && UPDATE_CACHE.data && Date.now() - UPDATE_CACHE.at < UPDATE_TTL) return UPDATE_CACHE.data
  const runtime = RUNTIME_DEPS()
  const out = await Promise.all(DEP_NAMES().map(async name => {
    const installed = installedVersion(name)
    const updatable = runtime.includes(name)
    try {
      const r = await fetch(`https://registry.npmjs.org/${encodeURIComponent(name)}/latest`, { signal: AbortSignal.timeout(8000) })
      if (!r.ok) return { name, installed, latest: '', updatable, error: `registry answered ${r.status}` }
      const { version } = await r.json()
      return { name, installed, latest: version || '', updatable }
    } catch (e) {
      return { name, installed, latest: '', updatable, error: e.name === 'TimeoutError' ? 'timed out' : e.message }
    }
  }))
  // `systemd` tells the panel whether a restart is even on offer: nothing else will start this
  // process again, so offering the button where it would only stop the dashboard is the one mistake
  // here that cannot be undone from the browser.
  const data = { packages: out, reachable: out.some(p => p.latest), systemd: !!process.env.INVOCATION_ID }
  UPDATE_CACHE = { at: Date.now(), data }
  return data
}

// The panel forces, so it is always looking at a fresh answer; the bell reads through the cache.
app.get('/api/settings/updates', async (req, res) => res.json(await checkUpdates(req.query.force === '1')))

/**
 * Install one package at the registry's newest version, then prove it still imports.
 *
 * The second half is not ceremony. A restart is what applies an update, and the way back from a
 * node_modules that cannot be imported is a shell — the one thing this dashboard exists to not
 * need. So the new version is imported in a child process first, and a failure puts the old version
 * back rather than leaving a trap that springs on the next restart, when nobody is watching.
 *
 * `npm install <name>@latest` and not `npm update`: the point is this one package at whatever the
 * registry says is newest, and npm writes the new range back to package.json so it survives the
 * next `npm ci`. One package per request, which is what lets the UI draw real progress.
 */
app.post('/api/settings/updates/apply', async (req, res) => {
  const name = String(req.body?.name || '')
  if (!RUNTIME_DEPS().includes(name)) return res.status(400).json({ error: 'not a runtime dependency of this install' })
  if (DRY) return res.status(409).json({ error: 'dry run — nothing is installed' })
  const before = installedVersion(name)
  const install = v => shell(NPM, ['install', '--no-audit', '--no-fund', `${name}@${v}`], { cwd: APP_DIR, timeout: 180_000, shell: NPM_SHELL })

  const r = await install('latest')
  if (r.status !== 0) {
    return res.json({ ok: false, name, error: `npm could not install ${name} — ${(r.stderr || r.stdout).trim().slice(-2000)}` })
  }
  const after = installedVersion(name)
  const loads = await shell(process.execPath, ['--input-type=module', '-e', `await import(${JSON.stringify(name)})`], { cwd: APP_DIR, timeout: 60_000 })
  if (loads.status === 0) {
    return res.json({ ok: true, name, output: `${before || 'not installed'} → ${after} — restart to load it`, restart: true })
  }

  const back = before ? await install(before) : { status: 0 }
  return res.json({
    ok: false, name,
    error: `${after} was installed but does not import`
      + (before ? (back.status === 0 ? ` — put ${before} back` : ` — and putting ${before} back also failed, run: npm ci`) : '')
      + `. Restarting now would take the dashboard down.\n${(loads.stderr || '').trim().slice(-1000)}`,
  })
})

/**
 * Restart this process so an update takes effect. Sessions are in memory, so this signs everyone
 * out — hence the message rather than a silent reconnect.
 *
 * `INVOCATION_ID` is set by systemd for every service it starts, which is what makes "am I
 * supervised" answerable instead of guessed at. It has to be answered: a dashboard started by hand
 * in a terminal would simply be gone, and there would be no CLI to bring it back. Exit 1 because the
 * shipped unit is `Restart=on-failure` — 0 is a clean exit and nothing would start it again.
 */
app.post('/api/settings/restart', (req, res) => {
  if (!process.env.INVOCATION_ID) {
    return res.status(409).json({ error: 'this dashboard was not started by systemd — restart it the way you started it' })
  }
  // The response goes first, and the delay is it leaving: exiting in the same tick drops the socket
  // and the browser reports a network error instead of what happened.
  res.json({ ok: true, output: 'restarting — sign in again in a moment' })
  setTimeout(() => process.exit(1), 300)
})

// ---------- module 8: the stack (nginx + database + php) ----------
/**
 * This dashboard does not install packages. `deploy/lemp.sh` does, and it is the same file
 * `install.sh --lemp` runs — so the package list exists once, and what you get from the button is
 * what you get over SSH.
 *
 * What is here is the way to *watch* it. A package install is the one action in this app nothing
 * can roll back, so a failure nobody can see would be worse than no button at all: the output is
 * streamed as it happens, and the outcome outlives the request in settings.json.
 */
const LEMP_SH = fileURLToPath(new URL('./deploy/lemp.sh', import.meta.url))

// A systemd unit does not inherit a login shell's PATH, and `apt-get: not found` from a service is a
// confusing way to learn that. DEBIAN_FRONTEND because a package prompt would otherwise block for
// ever on a stream nobody can type into.
const LEMP_ENV = {
  ...process.env,
  PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
  DEBIAN_FRONTEND: 'noninteractive',
}

const LEMP_LINES = 500 // an apt run is chatty and this buffer lives in memory
let lempJob = null // one install at a time: { child, lines, status, done, error, subs }

// The script's own summary line is the answer to "what did we actually get", so it is parsed rather
// than re-derived here. A shell that finds nothing prints an empty value, not an error.
function parseLempLine(out) {
  const kv = {}
  for (const pair of ((out || '').match(/^NXD-LEMP (.*)$/m)?.[1] || '').split(' ')) {
    const i = pair.indexOf('=')
    if (i > 0) kv[pair.slice(0, i)] = pair.slice(i + 1)
  }
  return kv
}

/**
 * What is installed, asked of the box rather than remembered. Never throws: every probe is a
 * `shell()` call, and a missing binary comes back as a non-zero status.
 */
async function stackStatus() {
  const [detect, nginx, unzip] = await Promise.all([
    shell('bash', [LEMP_SH, '--detect'], { env: LEMP_ENV, timeout: 15_000 }),
    shell('nginx', ['-v'], { timeout: 5000 }), // -v writes the version to stderr, by design
    shell('unzip', ['-v'], { timeout: 5000 }),
  ])
  const kv = parseLempLine(detect.stdout)
  const [dbKind = '', dbVersion = ''] = (kv.db || '/').split('/')
  const isActive = async unit => (unit ? (await shell('systemctl', ['is-active', unit], { timeout: 5000 })).stdout.trim() === 'active' : false)

  const php = { version: kv.php || '', endpoint: kv.socket || '', service: kv.svc || '' }
  const db = { kind: dbKind, version: dbVersion }
  const nginxVersion = ((nginx.stderr || '').match(/nginx\/([0-9][0-9.]*)/) || [])[1] || ''
  const out = {
    dry: DRY,
    nginx: { present: nginx.status === 0, version: nginxVersion },
    php, db, unzip: unzip.status === 0,
    installing: !!lempJob && !lempJob.done,
  }
  // Labels only — the packages behind them live in deploy/lemp.sh. Naming them here as well would
  // be a second list to keep in step with the first.
  out.missing = [
    !out.nginx.present && 'nginx',
    !php.endpoint && 'PHP-FPM',
    !db.kind && 'a database server',
    !out.unzip && 'unzip',
  ].filter(Boolean)
  ;[php.active, db.active] = [await isActive(php.service), await isActive(db.kind)]
  out.last = readSettings().lastLempInstall || null
  return out
}

app.get('/api/stack', async (req, res) => res.json(await stackStatus()))

app.post('/api/stack/install', (req, res) => {
  if (DRY) return res.status(409).json({ error: 'dry run — nothing is installed' })
  if (lempJob && !lempJob.done) return res.status(409).json({ error: 'an install is already running' })

  const child = spawn('bash', [LEMP_SH], { env: LEMP_ENV })
  const job = { child, lines: [], buf: '', status: null, done: false, error: '', subs: new Set() }
  lempJob = job
  const push = chunk => {
    job.buf += chunk.toString()
    const parts = job.buf.split('\n')
    job.buf = parts.pop() || ''
    for (const l of parts) job.lines.push(l)
    if (job.lines.length > LEMP_LINES) job.lines = job.lines.slice(-LEMP_LINES)
    for (const notify of job.subs) notify()
  }
  child.stdout.on('data', push)
  child.stderr.on('data', push) // apt and dpkg report failures on stderr; both belong on screen
  child.on('error', e => { job.error = e.message; job.status = job.status ?? -1 })
  child.on('close', code => {
    job.status = code
    job.done = true
    for (const notify of job.subs) notify()
    // The panel is not the only reader — a reload, or another browser, has to be able to find out how
    // this went. settings.json is where this app already keeps small state: 0600, written atomically.
    try {
      writeSettings({ ...readSettings(), lastLempInstall: { ok: code === 0, status: code, at: new Date().toISOString(), tail: job.lines.slice(-40) } })
    } catch (e) {
      console.error(`could not record the stack install: ${e.message}`)
    }
  })
  res.json({ ok: true, output: 'installing — the output appears below as it runs' })
})

app.get('/api/stack/install/stream', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    // Stops any nginx in front buffering this. A frozen install would look exactly like a hung one.
    'X-Accel-Buffering': 'no',
  })
  res.write(': connected\n\n')

  const job = lempJob
  if (!job) {
    res.write(`event: done\ndata: ${JSON.stringify({ ok: false, status: null, error: 'no install is running' })}\n\n`)
    return res.end()
  }

  let sent = 0
  let stopped = false
  let ping = null
  const stop = () => {
    if (stopped) return
    stopped = true
    clearInterval(ping)
    job.subs.delete(flush)
  }
  // A half-closed peer leaves this socket undestroyed; the heartbeat turns a dead peer into a write
  // error. Both close events stop it. Same reasoning as the log tail above.
  ping = setInterval(() => { try { res.write(': ping\n\n') } catch { stop() } }, 30_000)

  function flush() {
    if (stopped) return
    // From `sent`, not from zero: a reattaching client gets the lines it has not seen, and a fresh
    // one gets the whole run — which is what makes a reload mid-install not lose the output.
    for (; sent < job.lines.length; sent++) res.write(`data: ${job.lines[sent]}\n\n`)
    if (job.done) {
      res.write(`event: done\ndata: ${JSON.stringify({ ok: job.status === 0, status: job.status, error: job.error })}\n\n`)
      res.end()
      stop()
    }
  }
  job.subs.add(flush)
  res.on('close', stop)
  req.on('close', stop)
  flush() // replay whatever has already happened, immediately
})

// static frontend shell is not secret (all server data flows through the guarded /api);
// it must load before login or the login form itself can't render
app.use(express.static(path.resolve('dist')))

// last line of defense: one bad request must never kill the dashboard process
app.use((err, req, res, _next) => {
  console.error(err)
  if (res.headersSent) return
  // multer's own rejection, not a bug: "your zip is bigger than the limit" deserves a 413 and a
  // sentence about which knob raises it, not a 500 and a stack trace.
  if (err?.code === 'LIMIT_FILE_SIZE') {
    return res.status(413).json({ error: `file too large — the dashboard's upload limit is ${MAX_UPLOAD_MB} MB (raise DASH_MAX_UPLOAD_MB in the service unit)` })
  }
  res.status(500).json({ error: 'internal error' })
})

// A manifest written before this version carries basic-auth passwords in plaintext. Hash them once
// here rather than waiting for each site to be saved: the file on disk is the thing being fixed, and
// a site nobody edits again would keep its plaintext for ever. A row is rewritten only when it
// still has a `password`, so this runs once and then finds nothing to do.
//
// Not fatal on failure — a missing openssl must not stop the dashboard from starting — and the row
// is left exactly as it was, which the next save of that site will migrate instead.
async function migrateBasicAuth() {
  const m = readManifest()
  let changed = false
  for (const s of m.sites) {
    if (!(s.basicAuth?.users || []).some(u => u?.password)) continue
    try {
      s.basicAuth = { ...s.basicAuth, users: await writeHtpasswd(s) }
      changed = true
    } catch (e) {
      console.error(`could not hash the stored basic-auth password for "${s.name}": ${e.message}`)
    }
  }
  if (changed) writeManifest(m)
  // And the copies behind it. Hashing the manifest alone leaves the plaintext in the twenty undo
  // snapshots, which is where it would have sat for as long as they took to age out.
  try {
    const n = await scrubHistoryPasswords(hashUserRows)
    if (n) console.log(`hashed stored basic-auth passwords in ${n} history snapshot${n === 1 ? '' : 's'}`)
  } catch (e) {
    console.error(`could not scrub the undo history: ${e.message}`)
  }
}

await migrateBasicAuth()

app.listen(PORT, HOST, () => console.log(`nginx-dashboard on http://${HOST}:${PORT} (dry=${DRY})`))