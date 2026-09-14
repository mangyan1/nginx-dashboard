// End-to-end against a REAL nginx: every other suite either runs in DRY mode (smoke.mjs)
// or only validates generated text with `nginx -t` (docker-conf.mjs). This one drives the
// live API and checks what nginx actually does — real reloads, real traffic, real rollback.
//
// Requires Linux with nginx + openssl + curl installed. Run it in the container:
//   npm run test:e2e
import { spawn, execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const API = 'http://127.0.0.1:3000'
const AVAIL = '/etc/nginx/sites-available'
const MANIFEST = '/var/lib/nginx-dashboard/manifest.json'

if (process.platform !== 'linux' || !fs.existsSync('/etc/nginx')) {
  console.error('test/e2e.mjs needs Linux with nginx at /etc/nginx — use `npm run test:e2e`.')
  process.exit(2)
}

const sh = (cmd, args) => {
  try { return { out: execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }), ok: true } }
  catch (e) { return { out: (e.stdout || '') + (e.stderr || ''), ok: false } }
}
// A request as nginx would see it, with an explicit address family. `localhost` here
// resolves to ::1 only, which is how the v4-only listen bug hid for so long: the default
// server answered every IPv6 request and the site looked like it worked.
const viaNginx = (host, p = '/', fam = 4) => sh('curl', ['-s', `-${fam}`, '-H', `Host: ${host}`, fam === 6 ? `http://[::1]${p}` : `http://127.0.0.1${p}`]).out
const read = f => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : null)

// `nginx -s reload` only signals the master; old workers finish in-flight requests before
// they exit, so a request sent immediately after can still be answered by the *previous*
// config. Poll instead of assuming the reload has already taken effect.
async function serves(host, needle, want = true, tries = 50) {
  for (let i = 0; i < tries; i++) {
    if (viaNginx(host).includes(needle) === want) return true
    await new Promise(r => setTimeout(r, 100))
  }
  return false
}

let cookie = ''
let failed = 0
let ran = 0
const check = (name, cond, extra = '') => {
  ran++
  if (cond) console.log(`  ok  ${name}`)
  else { failed++; console.log(`FAIL  ${name}  ${extra}`) }
}

async function req(method, p, body) {
  const opts = { method, headers: { ...(cookie ? { cookie } : {}) } }
  if (body !== undefined) { opts.headers['content-type'] = 'application/json'; opts.body = JSON.stringify(body) }
  const res = await fetch(API + p, opts)
  const setC = res.headers.get('set-cookie')
  if (setC?.includes('sid=')) cookie = setC.split(';')[0]
  return { status: res.status, body: await res.json().catch(() => ({})) }
}

// start from a clean slate so a re-run isn't confused by the previous one
fs.rmSync('/var/lib/nginx-dashboard', { recursive: true, force: true })
for (const f of fs.readdirSync(AVAIL)) if (f.endsWith('.conf')) fs.rmSync(path.join(AVAIL, f), { force: true })
for (const f of fs.readdirSync('/etc/nginx/sites-enabled')) fs.rmSync(path.join('/etc/nginx/sites-enabled', f), { force: true })
if (!sh('nginx', ['-t']).ok) { console.error('base nginx config is already broken'); process.exit(2) }
// Exactly one master, always. The image CMD already started nginx, and a second `nginx` here
// *succeeds* — the config we just wiped has nothing on :80, so the new master binds nothing.
// But the first master still holds :80 serving its pre-wipe config (the stock default server),
// and since the newcomer takes over /run/nginx.pid, every later reload signals a master that
// can never bind :80: `[emerg] bind() to 0.0.0.0:80 failed (98)`. `nginx -s reload` exits 0
// through all of it, so the suite would report success for changes nginx never applied.
const masterPid = () => { try { return Number(fs.readFileSync('/run/nginx.pid', 'utf8')) || 0 } catch { return 0 } }
const alive = pid => { if (!pid) return false; try { process.kill(pid, 0); return true } catch { return false } }
sh('nginx', alive(masterPid()) ? ['-s', 'reload'] : []) // reload the wipe in; -s reload needs a master

const server = spawn(process.execPath, [path.join(root, 'server.js')], {
  env: { ...process.env, DASH_PASSWORD: 'e2epw', DASH_SELF_NAME: 'nxd' }, // no DASH_DRY: real nginx -t and reload
  stdio: ['ignore', 'pipe', 'pipe'],
})
let serverLog = ''
server.stdout.on('data', d => { serverLog += d })
server.stderr.on('data', d => { serverLog += d })

try {
  await new Promise(r => {
    const t = setInterval(() => { if (serverLog.includes('nginx-dashboard on')) { clearInterval(t); r() } }, 100)
    setTimeout(() => { clearInterval(t); r() }, 15_000)
  })
  check('server booted in real (non-dry) mode', serverLog.includes('dry=false'), serverLog.slice(0, 200))

  // ---- auth ----
  check('unauthenticated blocked', (await req('GET', '/api/sites')).status === 401)
  check('login works', (await req('POST', '/api/login', { password: 'e2epw' })).body.ok === true)

  // ---- module 1: control, against a real nginx ----
  const st = await req('GET', '/api/status')
  check('status reports a real nginx version', st.body.version?.includes('nginx/'), JSON.stringify(st.body))
  check('test-config runs real nginx -t', (await req('POST', '/api/nginx/test')).body.ok === true)
  check('reload runs real nginx -s reload', (await req('POST', '/api/nginx/reload')).body.ok === true)

  // ---- module 2/3: create a site, reload for real, serve traffic ----
  const created = await req('POST', '/api/sites', { name: 'myapp', domains: ['myapp.test'], upstreams: [{ name: 'pool', algorithm: 'round_robin', servers: [{ scheme: 'http', host: '127.0.0.1', port: 3001 }] }], proxy: [{ path: '/api', target: 'upstream:pool' }] })
  check('site created with real nginx -t + reload', created.status === 200, JSON.stringify(created.body))
  // creating writes the conf; it is not in sites-enabled until it is enabled
  check('new site is not served until enabled', await serves('myapp.test', 'myapp.test', false))
  check('enable ok', (await req('POST', '/api/sites/myapp/enable')).status === 200)
  const servedV4 = await serves('myapp.test', 'myapp.test')
  check('nginx actually serves the new site over IPv4', servedV4)
  // a v4-only listen silently hands IPv6 clients to whatever is default for [::]:80
  const servedV6 = viaNginx('myapp.test', '/', 6).includes('myapp.test')
  check('...and over IPv6', servedV6, JSON.stringify(viaNginx('myapp.test', '/', 6).slice(0, 80)))
  check('proxy rule reached the conf', read(path.join(AVAIL, 'myapp.conf'))?.includes('proxy_pass http://myapp_pool;'))

  // A live master is what makes this suite worth running, and the failure that motivated it
  // (a second master holding :80 while the pid file points elsewhere) is invisible from the
  // API — every call answers 200. Assert the precondition directly.
  const masters = sh('sh', ['-c', 'ps -o pid=,cmd= -C nginx']).out.split('\n').filter(l => l.includes('master process')).length
  check('exactly one nginx master is running', masters === 1, `found ${masters}`)

  // the regression that only real nginx catches: upstreams are global to the http context
  const twin = await req('POST', '/api/sites', { name: 'twin', domains: ['twin.test'], upstreams: [{ name: 'pool', algorithm: 'ip_hash', servers: [{ scheme: 'http', host: '127.0.0.1', port: 3002 }] }], proxy: [{ path: '/', target: 'upstream:pool' }] })
  check('second site may reuse the pool name', twin.status === 200, JSON.stringify(twin.body))
  check('pools are namespaced per site in the conf', read('/etc/nginx/conf.d/00-dashboard.conf')?.includes('upstream twin_pool {'))
  check('nginx -t still passes with both sites', sh('nginx', ['-t']).ok)

  // ---- enable / disable changes what nginx actually serves ----
  await req('POST', '/api/sites/myapp/disable')
  check('disabled site stops being served', await serves('myapp.test', 'myapp.test', false))
  await req('POST', '/api/sites/myapp/enable')
  check('re-enabled site is served again', await serves('myapp.test', 'myapp.test'))

  // ---- the safety property, against real nginx ----
  // certbot mode points ssl_certificate at a path that does not exist yet, so a real
  // `nginx -t` rejects it. Nothing may be left behind: this is the whole point of safeApply.
  const manifestBefore = read(MANIFEST)
  const confBefore = read(path.join(AVAIL, 'myapp.conf'))
  const bad = await req('PUT', '/api/sites/myapp', { domains: ['myapp.test'], https: { mode: 'certbot' } })
  check('a config real nginx rejects returns 422', bad.status === 422, JSON.stringify(bad.body))
  check('the error is nginx\'s own', String(bad.body.error || '').includes('nginx'), JSON.stringify(bad.body))
  check('existing conf restored byte-for-byte', read(path.join(AVAIL, 'myapp.conf')) === confBefore)
  check('manifest rolled back with it', read(MANIFEST) === manifestBefore)
  check('site still served after the failed change', await serves('myapp.test', 'myapp.test'))

  // A *disabled* site's conf is invisible to `nginx -t`, which reads only sites-enabled. It used
  // to save with a 200 and fail later, on Enable. safeApply now links it in for the test alone,
  // so the error arrives while the user is still looking at the form.
  const ghost = await req('POST', '/api/sites', { name: 'ghost', domains: ['ghost.test'], https: { mode: 'certbot' } })
  check('a disabled site with a bad config is rejected at save time', ghost.status === 422, `${ghost.status} ${JSON.stringify(ghost.body?.error)}`)
  check('...with nginx\'s own error', String(ghost.body.error || '').includes('nginx'), JSON.stringify(ghost.body))
  check('...leaving no conf or symlink behind', !fs.existsSync(path.join(AVAIL, 'ghost.conf')) && !fs.existsSync('/etc/nginx/sites-enabled/ghost.conf'))
  check('...no docroot behind', !fs.existsSync('/var/www/ghost'))
  check('...and not in the manifest', !read(MANIFEST).includes('ghost'))
  check('nginx stayed healthy', sh('nginx', ['-t']).ok)

  // ...and the fix must not reject a *good* disabled site, which would be worse than the gap
  const dormant = await req('POST', '/api/sites', { name: 'dormant', domains: ['dormant.test'] })
  check('a good disabled site still saves', dormant.status === 200, JSON.stringify(dormant.body))
  check('...and stays disabled', !fs.existsSync('/etc/nginx/sites-enabled/dormant.conf'))
  check('...and its conf is on disk', read(path.join(AVAIL, 'dormant.conf'))?.includes('dormant.test'))

  // ---- drift: is the conf on disk still the one the manifest generates? ----
  // The next click would overwrite a hand-edit without a word, so the API has to admit it first.
  let list = await req('GET', '/api/sites')
  check('a freshly generated site reports no drift', list.body.sites.find(s => s.name === 'myapp')?.drift === null, JSON.stringify(list.body.sites.find(s => s.name === 'myapp')?.drift))
  fs.appendFileSync(path.join(AVAIL, 'myapp.conf'), '# edited by hand at 3am\n')
  list = await req('GET', '/api/sites')
  check('a hand-edited conf is reported as drift', list.body.sites.find(s => s.name === 'myapp')?.drift === 'modified', JSON.stringify(list.body.sites.find(s => s.name === 'myapp')?.drift))
  check('the shared http conf reports clean', list.body.httpConfDrift === false, String(list.body.httpConfDrift))
  // a re-save regenerates the conf, so the drift resolves — and the hand-edit is gone, which is
  // exactly why it had to be reported first
  await req('PUT', '/api/sites/myapp', { ...(await req('GET', '/api/sites/myapp')).body.site })
  list = await req('GET', '/api/sites')
  check('saving the site regenerates it and clears the drift', list.body.sites.find(s => s.name === 'myapp')?.drift === null)
  check('...having overwritten the hand-edit', !read(path.join(AVAIL, 'myapp.conf')).includes('3am'))

  // ---- history: undo a change that succeeded and turned out wrong ----
  const beforeUndo = read(path.join(AVAIL, 'twin.conf'))
  check('history is served', Array.isArray((await req('GET', '/api/history')).body.entries))
  const del = await req('DELETE', '/api/sites/twin')
  check('deleting twin works', del.status === 200)
  const hist = (await req('GET', '/api/history')).body.entries
  check('the delete is in the history', hist[0]?.label === 'delete site twin', JSON.stringify(hist[0]?.label))
  check('...and names the conf it removed', hist[0]?.paths.some(p => p.endsWith('twin.conf')), JSON.stringify(hist[0]?.paths))

  const undo = await req('POST', `/api/history/${hist[0].id}/revert`)
  check('revert ok', undo.status === 200, JSON.stringify(undo.body))
  check('the deleted conf is back, byte-for-byte', read(path.join(AVAIL, 'twin.conf')) === beforeUndo)
  check('the site is back in the manifest', (await req('GET', '/api/sites')).body.sites.some(s => s.name === 'twin'))
  check('the revert is itself undoable', (await req('GET', '/api/history')).body.entries[0].label === 'undo: delete site twin')
  check('a traversal-shaped history id is refused', (await req('POST', '/api/history/..%2f..%2fmanifest.json/revert')).status === 422)
  check('nginx -t passes after the revert', sh('nginx', ['-t']).ok)

  // the docroot of a site that was deleted is *not* restored — this is a config history
  const restoreServed = await req('POST', '/api/sites/twin/enable')
  check('the restored site can be enabled', restoreServed.status === 200, JSON.stringify(restoreServed.body))
  await req('POST', '/api/sites/twin/disable')

  // ---- module 4: real openssl ----
  const cert = await req('POST', '/api/sites/myapp/selfsigned')
  check('self-signed cert generated by real openssl', cert.status === 200, JSON.stringify(cert.body))
  check('cert files exist on disk', fs.existsSync('/etc/nginx/dashboard-certs/myapp/fullchain.pem'))
  check('443 block written and accepted', sh('nginx', ['-t']).ok && read(path.join(AVAIL, 'myapp.conf')).includes('listen 443 ssl'))

  // ---- module 6: live log tail over SSE (the path that was never verified on Linux) ----
  const sse = await fetch(API + '/api/logs/tail?file=access', { headers: { cookie } })
  check('sse content-type', sse.headers.get('content-type').startsWith('text/event-stream'))
  const reader = sse.body.getReader()
  const dec = new TextDecoder()
  await new Promise(r => setTimeout(r, 300))
  viaNginx('myapp.test', '/sse-canary')  // traffic generated *after* the stream opened
  let seen = ''
  for (let i = 0; i < 40 && !seen.includes('sse-canary'); i++) {
    const { value, done } = await reader.read()
    if (done) break
    seen += dec.decode(value || '')
  }
  check('live-tailed a request made after the stream opened', seen.includes('sse-canary'), JSON.stringify(seen.slice(-160)))
  await reader.cancel()

  // ---- the dashboard's own vhost, under a real nginx ----
  // Everything above serves a site *outward*. This one serves the dashboard itself, and it is the
  // only place these guards meet a genuine `nginx -t` and real traffic: DRY mode never loads the
  // generated conf at all. The allowlist is loopback-only so curl from inside the container passes.
  const selfPub = await req('POST', '/api/sites', {
    name: 'nxd', domains: ['nxd.test'],
    ipRules: { mode: 'allowlist', ips: ['127.0.0.1/32', '::1/128'] },
    proxy: [{ path: '/', target: 'http://127.0.0.1:3000' }],
    rateLimit: { enabled: true, rps: 30, burst: 60 },
  })
  check('the dashboard publishes its own vhost', selfPub.status === 200, JSON.stringify(selfPub.body))
  check('...and it is stamped as the pinned one', selfPub.body.site?.self === true, JSON.stringify(selfPub.body.site?.self))
  check('...with the streaming directives in its conf', read(path.join(AVAIL, 'nxd.conf'))?.includes('proxy_buffering off;'))
  check('disabling the pinned vhost is refused', (await req('POST', '/api/sites/nxd/disable')).status === 403)
  check('deleting it is refused', (await req('DELETE', '/api/sites/nxd')).status === 403)
  check('enabling it is not', (await req('POST', '/api/sites/nxd/enable')).status === 200)
  // /api/status rather than /: the shell is served either way, but a proxied API call is the part
  // that breaks when the proxy rule is wrong, and 401 from *our* process is the proof it arrived.
  let dashThroughVhost = false
  for (let i = 0; i < 50 && !dashThroughVhost; i++) {
    dashThroughVhost = viaNginx('nxd.test', '/api/status').includes('unauthorized')
    if (!dashThroughVhost) await new Promise(r => setTimeout(r, 100))
  }
  check('nginx serves the dashboard through its own vhost', dashThroughVhost,
    JSON.stringify(viaNginx('nxd.test', '/api/status').slice(0, 120)))

  // The buffering fix, proven rather than asserted: with proxy_buffering at nginx's default the
  // line below parks in nginx's buffer and never arrives inside the window. Read through the
  // vhost, and note this also exercises trust-proxy — the cookie has to survive the hop.
  const tailer = spawn('curl', ['-sN', '--max-time', '10',
    '-H', 'Host: nxd.test', '-H', `cookie: ${cookie}`, 'http://127.0.0.1/api/logs/tail?file=access'])
  let through = ''
  tailer.stdout.on('data', d => { through += d })
  await new Promise(r => setTimeout(r, 500))
  viaNginx('nxd.test', '/through-the-proxy-canary') // traffic generated *after* the stream opened
  for (let i = 0; i < 40 && !through.includes('through-the-proxy-canary'); i++) await new Promise(r => setTimeout(r, 100))
  check('a log line reaches an SSE client through the generated vhost',
    through.includes('through-the-proxy-canary'), JSON.stringify(through.slice(-200)))
  tailer.kill('SIGKILL')

  // ---- module 6: metrics from a real stub_status ----
  const m = await req('GET', '/api/metrics')
  check('stub_status reachable', m.status === 200, JSON.stringify(m.body))
  check('metrics carry real counters', Number.isFinite(m.body.requests) && m.body.requests > 0, JSON.stringify(m.body))

  // ---- module 2: file manager against a real docroot ----
  const files = await req('GET', '/api/sites/myapp/files')
  check('docroot listed', files.status === 200 && files.body.entries.some(e => e.name === 'index.html'), JSON.stringify(files.body))
  check('path traversal blocked', (await req('GET', '/api/sites/myapp/files?path=../../etc')).status === 400)

  // ---- delete ----
  check('delete ok', (await req('DELETE', '/api/sites/myapp')).status === 200)
  check('conf gone from disk', !fs.existsSync(path.join(AVAIL, 'myapp.conf')))
  check('site no longer served', await serves('myapp.test', 'myapp.test', false))
  check('nginx -t passes at the end', sh('nginx', ['-t']).ok)
} finally {
  server.kill('SIGKILL')
}

console.log(failed ? `\n${failed} of ${ran} FAILED` : `\nall ${ran} checks passed`)
process.exit(failed ? 1 : 0)
