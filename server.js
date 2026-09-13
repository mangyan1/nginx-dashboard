import express from 'express'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import multer from 'multer'
import { spawn } from 'node:child_process' // tail -F for SSE; args are a fixed array, never user strings
import {
  PATHS, MANIFEST, HTTP_CONF, mkdirs, validName, safeJoin, safeApply,
  nginxTest, systemctl, shell, listHistory, revertHistory,
} from './lib/nginx.js'
import {
  defaultSite, readManifest, writeManifest, siteConfPath, enabledConfPath, certDir,
  renderHttpConf, renderSiteConf, writeHtpasswd, validateSite, driftOf, httpConfDrift,
} from './lib/manifest.js'

const PORT = process.env.DASH_PORT || 3000
const HOST = process.env.DASH_HOST || '127.0.0.1'
const PASSWORD = process.env.DASH_PASSWORD
const DRY = process.env.DASH_DRY === '1' // dev mode: write files, skip nginx -t / reload / systemctl / certbot

if (!PASSWORD) {
  console.error('Set DASH_PASSWORD env var before starting.')
  process.exit(1)
}

mkdirs()

const app = express()
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

app.post('/api/login', (req, res) => {
  const given = crypto.createHash('sha256').update(String(req.body?.password || '')).digest()
  const stored = crypto.createHash('sha256').update(PASSWORD).digest()
  if (!crypto.timingSafeEqual(given, stored)) return res.status(401).json({ error: 'wrong password' })
  const token = crypto.randomBytes(32).toString('hex')
  sessions.set(token, { expires: Date.now() + 24 * 3600_000 })
  res.setHeader('Set-Cookie', `${COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=86400`)
  res.json({ ok: true })
})

app.post('/api/logout', (req, res) => {
  const token = parseCookies(req)[COOKIE]
  if (token) sessions.delete(token)
  res.setHeader('Set-Cookie', `${COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`)
  res.json({ ok: true })
})

app.use('/api', requireAuth)

// DRY mode: write files but skip nginx -t / reload
const apply = (...a) => (DRY
  ? (safeApplyDry(...a))
  : safeApply(...a))
function safeApplyDry(files, mutate) {
  try {
    mutate()
    return { ok: true, output: 'dry mode: written without nginx -t' }
  } catch (e) { return { ok: false, output: e.message } }
}

// ---------- module 1: server control ----------
app.get('/api/status', async (req, res) => {
  const v = await shell('nginx', ['-v'])
  let active = 'dry'
  if (!DRY) {
    const r = await shell('systemctl', ['is-active', 'nginx'])
    active = r.status === 0 ? r.stdout.trim() : r.stderr.trim()
  }
  res.json({ active, version: (v.stderr || v.stdout).trim(), dry: DRY })
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
function siteState(name) {
  return { enabled: fs.existsSync(enabledConfPath(name)) }
}

function findSite(name) {
  return readManifest().sites.find(s => s.name === name)
}

function sanitizeSite(input, base) {
  const s = { ...base, ...input }
  for (const k of ['https', 'listen', 'rateLimit', 'ipRules', 'basicAuth', 'gzip', 'staticCache']) {
    s[k] = { ...(base?.[k] || defaultSite(s.name)[k]), ...(input?.[k] || {}) }
  }
  s.proxy = Array.isArray(input?.proxy) ? input.proxy : (base?.proxy || [])
  s.upstreams = Array.isArray(input?.upstreams) ? input.upstreams : (base?.upstreams || [])
  s.domains = (s.domains || []).map(String).map(d => d.trim()).filter(Boolean)
  // API must be safe regardless of what the client sends
  if (base) s.name = base.name // the URL param names the file; never let the body rename it
  if (typeof s.root !== 'string' || !s.root.trim()) s.root = `/var/www/${s.name}`
  if (typeof s.port !== 'number' || s.port < 1 || s.port > 65535) s.port = 80
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

// A disabled site's conf must still be checked: `nginx -t` reads only sites-enabled, so without
// this it saves with a 200 and only fails later, on Enable. Harmless to link in for the test —
// see safeApply's testLink.
const testLinkFor = name => (fs.existsSync(enabledConfPath(name))
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
      ...m.sites.map(s => ({ ...s, managed: true, ...siteState(s.name), drift: driftOf(s) })),
      ...onDisk.filter(n => !managed.has(n)).map(n => ({ name: n, managed: false, ...siteState(n) })),
    ],
    // every site's upstreams and rate-limit zones live in this one file
    httpConfDrift: httpConfDrift(m.sites),
  })
})

app.get('/api/sites/:name', (req, res) => {
  const { name } = req.params
  if (!validName(name)) return res.status(400).json({ error: 'invalid name' })
  const site = findSite(name)
  if (!site) return res.status(404).json({ error: 'not found (unmanaged sites are read-only)' })
  res.json({ site, ...siteState(name), drift: driftOf(site) })
})

app.post('/api/sites', async (req, res) => {
  const name = String(req.body?.name || '')
  if (!validName(name)) return res.status(400).json({ error: 'invalid site name' })
  const m = readManifest()
  if (m.sites.some(s => s.name === name)) return res.status(409).json({ error: 'site exists' })
  const site = sanitizeSite({ ...req.body, name })

  const errs = validateSite(site)
  if (errs.length) return res.status(400).json({ error: errs.join('; ') })

  m.sites.push(site)
  await writeHtpasswd(site)
  const result = await apply(siteFiles(name), () => writeSiteFiles(site, m), { label: `create site ${name}`, testLink: testLinkFor(name) })
  if (!result.ok) return res.status(422).json({ error: result.output })

  // docroot + placeholder so the site serves something immediately. Created only once the conf
  // is accepted: a create that nginx rejects must leave nothing behind, and nginx -t does not
  // care whether the docroot exists — only serving it does.
  fs.mkdirSync(site.root, { recursive: true })
  const idx = path.join(site.root, 'index.html')
  if (!fs.existsSync(idx)) fs.writeFileSync(idx, `<h1>${site.domains[0]}</h1>\n<p>Deployed via nginx-dashboard.</p>\n`)

  res.json({ ok: true, site })
})

app.put('/api/sites/:name', async (req, res) => {
  const { name } = req.params
  const m = readManifest()
  const base = m.sites.find(s => s.name === name)
  if (!base) return res.status(404).json({ error: 'not found' })
  const site = sanitizeSite(req.body, base)

  const errs = validateSite(site)
  if (errs.length) return res.status(400).json({ error: errs.join('; ') })

  await writeHtpasswd(site)
  m.sites = m.sites.map(s => (s.name === name ? site : s))
  const result = await apply(siteFiles(name), () => writeSiteFiles(site, m), { label: `update site ${name}`, testLink: testLinkFor(name) })
  if (!result.ok) return res.status(422).json({ error: result.output })
  res.json({ ok: true, site })
})

app.delete('/api/sites/:name', async (req, res) => {
  const { name } = req.params
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

app.post('/api/sites/:name/:toggle(enable|disable)', async (req, res) => {
  const { name, toggle } = req.params
  if (!findSite(name)) return res.status(404).json({ error: 'not found' })
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
})

// ---------- change history: undo a change that turned out badly ----
// Every successful mutation above is snapshotted by safeApply. Only *failed* changes used to
// be reversible; a change that worked and then turned out to be wrong had no way back.
app.get('/api/history', (req, res) => res.json({ entries: listHistory() }))

app.post('/api/history/:id/revert', async (req, res) => {
  const result = await revertHistory(req.params.id)
  if (!result.ok) return res.status(422).json({ error: result.output })
  res.json({ ok: true, output: result.output })
})

// ---------- module 2: docroot file manager ----------
const upload = multer({ dest: path.join(PATHS.stateDir, 'uploads') })

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
  // ponytail: no per-file guard against duplicate streams; only this dashboard consumes it
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
  res.status(500).json({ error: 'internal error' })
})

app.listen(PORT, HOST, () => console.log(`nginx-dashboard on http://${HOST}:${PORT} (dry=${DRY})`))