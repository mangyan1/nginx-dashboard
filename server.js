import express from 'express'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import multer from 'multer'
import { spawn } from 'node:child_process' // tail -F for SSE; args are a fixed array, never user strings
import {
  PATHS, MANIFEST, HTTP_CONF, mkdirs, validName, safeJoin, safeApply,
  nginxTest, systemctl, shell, listHistory, revertHistory, readHistoryEntry,
} from './lib/nginx.js'
import {
  SELF_NAME, isSelf, defaultSite, readManifest, writeManifest, siteConfPath, enabledConfPath, certDir,
  renderHttpConf, renderSiteConf, writeHtpasswd, validateSite, driftOf, httpConfDrift,
  parseManifest, selfSiteErrors, selfSiteWarnings, selfRevertErrors,
} from './lib/manifest.js'
import { b32decode, totpValid } from './lib/totp.js'

// Number(), not the raw string: every comparison against this port is numeric, and a string
// would make each one false — the self-vhost check included.
const PORT = Number(process.env.DASH_PORT) || 7412
const HOST = process.env.DASH_HOST || '127.0.0.1'
const PASSWORD = process.env.DASH_PASSWORD
const DRY = process.env.DASH_DRY === '1' // dev mode: write files, skip nginx -t / reload / systemctl / certbot
const TOTP_SECRET = process.env.DASH_TOTP_SECRET || ''
const MAX_UPLOAD_MB = Number(process.env.DASH_MAX_UPLOAD_MB) || 2048

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
  next()
}

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
  const given = crypto.createHash('sha256').update(String(req.body?.password || '')).digest()
  const stored = crypto.createHash('sha256').update(PASSWORD).digest()
  const pwOk = crypto.timingSafeEqual(given, stored) // both fixed-width digests, so equal length
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
    active, version: raw.includes('nginx/') ? raw : '', dry: DRY,
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
  const s = { ...base, ...input }
  for (const k of ['https', 'hsts', 'listen', 'php', 'rateLimit', 'ipRules', 'basicAuth', 'gzip', 'staticCache']) {
    s[k] = { ...(base?.[k] || defaultSite(s.name)[k]), ...(input?.[k] || {}) }
  }
  s.proxy = Array.isArray(input?.proxy) ? input.proxy : (base?.proxy || [])
  s.upstreams = Array.isArray(input?.upstreams) ? input.upstreams : (base?.upstreams || [])
  s.domains = (s.domains || []).map(String).map(d => d.trim()).filter(Boolean)
  // API must be safe regardless of what the client sends
  if (base) s.name = base.name // the URL param names the file; never let the body rename it
  if (typeof s.root !== 'string' || !s.root.trim()) s.root = `/var/www/${s.name}`
  if (typeof s.port !== 'number' || s.port < 1 || s.port > 65535) s.port = 80
  if (typeof s.httpsPort !== 'number' || s.httpsPort < 1 || s.httpsPort > 65535) s.httpsPort = 443
  if (typeof s.index !== 'string' || !s.index.trim()) s.index = 'index.html index.htm'
  // validateSite rejects an out-of-range value outright; this only keeps a bad one from being
  // rendered if a caller ever reaches the writer without validating first.
  if (!Number.isInteger(s.clientMaxBodySize) || s.clientMaxBodySize < 0) s.clientMaxBodySize = 0
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
  const site = sanitizeSite({ ...req.body, name })

  const errs = validateSite(site)
  // `enabled` deliberately not passed: every site is created disabled, so requiring the self
  // vhost to already be live here would make publishing it impossible. The form says to click
  // Enable, and the next save is checked against the state on disk.
  if (isSelf(name)) errs.push(...selfSiteErrors(site, { host: HOST, port: PORT }))
  if (errs.length) return res.status(400).json({ error: errs.join('; ') + (isSelf(name) ? `\n\n${SELF_RECOVERY}` : '') })

  m.sites.push(site)
  await writeHtpasswd(site)
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

  await writeHtpasswd(site)
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

app.listen(PORT, HOST, () => console.log(`nginx-dashboard on http://${HOST}:${PORT} (dry=${DRY})`))