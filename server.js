import express from 'express'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import multer from 'multer'
import { spawn } from 'node:child_process' // tail -F for SSE; args are a fixed array, never user strings
import {
  PATHS, MANIFEST, HTTP_CONF, mkdirs, validName, safeJoin, safeApply,
  nginxTest, systemctl, shell, listHistory, clearHistory, revertHistory, readHistoryEntry,
  scrubHistoryPasswords,
} from './lib/nginx.js'
import {
  SELF_NAME, isSelf, defaultSite, readManifest, writeManifest, siteConfPath, enabledConfPath, certDir,
  renderHttpConf, renderSiteConf, writeHtpasswd, hashUserRows, validateSite, driftOf, httpConfDrift,
  parseManifest, selfSiteErrors, selfSiteWarnings, selfRevertErrors,
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

const app = express()
// Behind its own vhost every request arrives from nginx, so without this req.ip is 127.0.0.1 for
// everybody — one shared throttle bucket, where one attacker's five wrong passwords lock out the
// operator. 'loopback' rather than true: a forged X-Forwarded-For is only believed when the peer
// really is nginx, which is not the case if the port is ever reachable directly.
app.set('trust proxy', 'loopback')
app.use(express.json({ limit: '1mb' }))

// ---------- auth: random token, in-memory map, cookie ----------
const sessions = new Map()
const COOKIE = 'sid'

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

app.post('/api/logout', (req, res) => {
  const token = parseCookies(req)[COOKIE]
  if (token) sessions.delete(token)
  res.setHeader('Set-Cookie', sessionCookie(req, '', 0))
  res.json({ ok: true })
})

app.use('/api', requireAuth)

// DRY mode: write files but skip nginx -t / reload
// Every write first gives the dashboard's own vhost a chance to put itself back; see selfRepair.
const apply = async (...a) => {
  await selfRepair()
  return DRY ? safeApplyDry(...a) : safeApply(...a)
}
function safeApplyDry(files, mutate) {
  try {
    mutate()
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
app.get('/api/status', async (req, res) => {
  const v = await shell('nginx', ['-v'])
  let active = 'dry'
  if (!DRY) {
    const r = await shell('systemctl', ['is-active', 'nginx'])
    active = r.status === 0 ? r.stdout.trim() : r.stderr.trim()
  }
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
  const s = { ...base, ...input, name }
  for (const k of ['https', 'hsts', 'listen', 'php', 'rateLimit', 'ipRules', 'basicAuth', 'gzip', 'staticCache']) {
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

// Deep-merged one level, the same shape sanitizeSite builds, so an override like
// {"gzip":{"enabled":false}} cannot drop the types that live beside it.
const NESTED_KEYS = ['https', 'hsts', 'listen', 'php', 'rateLimit', 'ipRules', 'basicAuth', 'gzip', 'staticCache']

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
  for (const k of NESTED_KEYS) s[k] = { ...d[k], ...(o[k] || {}) }
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
const siteFiles = name => [siteConfPath(name), HTTP_CONF, MANIFEST]

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
  // Back onto the object *before* the manifest is written: the returned rows are the hashed ones,
  // and `site` is what writeSiteFiles stores. Left unassigned, the plaintext the form sent would be
  // what lands in the manifest — the hashing would look like it worked and change nothing.
  site.basicAuth = { ...site.basicAuth, users: await writeHtpasswd(site) }
  const result = await apply(siteFiles(name), () => writeSiteFiles(site, m), { label: `create site ${name}`, testLink: testLinkFor(name) })
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

  site.basicAuth = { ...site.basicAuth, users: await writeHtpasswd(site) }
  m.sites = m.sites.map(s => (s.name === name ? site : s))
  const result = await apply(siteFiles(name), () => writeSiteFiles(site, m), { label: `update site ${name}`, testLink: testLinkFor(name) })
  if (!result.ok) return res.status(422).json({ error: result.output })
  res.json({ ok: true, site, ...warningPayload(site) })
})

app.delete('/api/sites/:name', async (req, res) => {
  const { name } = req.params
  // The one deletion that removes the page the operator is looking at. Refused rather than
  // warned: there is no "undo" click available to someone who cannot load the UI.
  if (isSelf(name)) {
    return res.status(403).json({ error: `"${name}" is this dashboard's own vhost — deleting it would take away the page you are clicking on.\n\n${SELF_RECOVERY}` })
  }
  const m = readManifest()
  if (!m.sites.some(s => s.name === name)) return res.status(404).json({ error: 'not found' })
  m.sites = m.sites.filter(s => s.name !== name)
  const result = await apply([...siteFiles(name), enabledConfPath(name)], () => {
    writeManifest(m)
    fs.rmSync(siteConfPath(name), { force: true })
    fs.rmSync(enabledConfPath(name), { force: true })
    fs.writeFileSync(HTTP_CONF, renderHttpConf(m.sites))
  }, { label: `delete site ${name}` })
  if (!result.ok) return res.status(422).json({ error: result.output })
  res.json({ ok: true })
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

app.post('/api/sites/:name/files', upload.array('files'), (req, res) => {
  const site = findSite(req.params.name)
  if (!site) return res.status(404).json({ error: 'not found' })
  try {
    const dir = safeJoin(site.root, String(req.body.path || ''))
    fs.mkdirSync(dir, { recursive: true })
    for (const f of req.files || []) {
      fs.renameSync(f.path, path.join(dir, path.basename(f.originalname)))
    }
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
    res.json({ ok: true })
  } catch (e) {
    res.status(400).json({ error: String(e.message).slice(0, 500) })
  } finally {
    fs.rmSync(req.file.path, { force: true })
  }
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
  res.json(r.status === 0 ? { ok: true, output: 'rotated' } : { ok: false, output: r.stderr.trim() })
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
  await apply([STATUS_CONF], () => fs.writeFileSync(STATUS_CONF, STATUS_CONF_TEXT), { label: 'enable metrics (stub_status)' })
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

app.get('/api/settings/updates', async (req, res) => {
  const out = await Promise.all(DEP_NAMES().map(async name => {
    const installed = installedVersion(name)
    try {
      const r = await fetch(`https://registry.npmjs.org/${encodeURIComponent(name)}/latest`, { signal: AbortSignal.timeout(8000) })
      if (!r.ok) return { name, installed, latest: '', error: `registry answered ${r.status}` }
      const { version } = await r.json()
      return { name, installed, latest: version || '' }
    } catch (e) {
      return { name, installed, latest: '', error: e.name === 'TimeoutError' ? 'timed out' : e.message }
    }
  }))
  res.json({ packages: out, reachable: out.some(p => p.latest) })
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