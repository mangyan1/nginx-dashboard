// Smoke test: boots server.js in DRY mode against the fixture tree, exercises the
// API end to end with plain asserts. Run: node test/smoke.mjs
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const FIX = path.join(root, 'test', 'fixtures')
const API = 'http://127.0.0.1:3123'

const env = {
  ...process.env,
  DASH_PASSWORD: 'testpw', DASH_DRY: '1', DASH_PORT: '3123', DASH_HOST: '127.0.0.1',
  DASH_SELF_NAME: 'nxd',
  DASH_NGINX_DIR: path.join(FIX, 'nginx'),
  DASH_SITES_AVAIL: path.join(FIX, 'nginx', 'sites-available'),
  DASH_SITES_EN: path.join(FIX, 'nginx', 'sites-enabled'),
  DASH_CONF_D: path.join(FIX, 'nginx', 'conf.d'),
  DASH_LOG_DIR: path.join(FIX, 'nginx', 'logs'),
  DASH_STATE_DIR: path.join(FIX, 'state'),
  DASH_CERTS_DIR: path.join(FIX, 'certs'),
  DASH_HTPASSWD_DIR: path.join(FIX, 'htpasswd'),
}

// fresh fixture tree each run
fs.rmSync(path.join(FIX, 'state'), { recursive: true, force: true })
for (const d of ['sites-available', 'sites-enabled', 'conf.d', 'logs']) {
  fs.rmSync(path.join(FIX, 'nginx', d), { recursive: true, force: true })
  fs.mkdirSync(path.join(FIX, 'nginx', d), { recursive: true })
}
fs.writeFileSync(path.join(FIX, 'nginx', 'logs', 'access.log'), '1.2.3.4 - - "GET / HTTP/1.1" 200\n')
fs.writeFileSync(path.join(FIX, 'nginx', 'logs', 'error.log'), '')

let cookie = ''
let failed = 0
let ran = 0

async function req(method, p, body) {
  const opts = { method, headers: { ...(cookie ? { cookie } : {}) } }
  if (body !== undefined) {
    if (body instanceof FormData) { opts.body = body }
    else { opts.headers['content-type'] = 'application/json'; opts.body = JSON.stringify(body) }
  }
  const res = await fetch(API + p, opts)
  const setC = res.headers.get('set-cookie')
  if (setC?.includes('sid=')) cookie = setC.split(';')[0]
  return { status: res.status, body: await res.json().catch(() => ({})) }
}

// `ran` is printed at the end so a suite that silently stops executing checks (an early
// throw, a skip that became a no-op) is visible instead of reading as a pass.
function check(name, cond, extra = '') {
  ran++
  if (cond) console.log(`  ok  ${name}`)
  else { failed++; console.log(`FAIL  ${name} ${extra}`) }
}

const server = spawn(process.execPath, [path.join(root, 'server.js')], { env, stdio: ['ignore', 'pipe', 'pipe'] })
server.stderr.on('data', d => process.stderr.write(d))

try {
  await new Promise(r => {
    server.stdout.on('data', d => String(d).includes('3123') && r())
    setTimeout(() => r(), 3000)
  })

  // auth
  check('unauthenticated blocked', (await req('GET', '/api/sites')).status === 401)
  check('wrong password rejected', (await req('POST', '/api/login', { password: 'nope' })).status === 401)
  check('login sets cookie', (await req('POST', '/api/login', { password: 'testpw' })).body.ok === true)

  // control
  const st = await req('GET', '/api/status')
  check('status ok', st.status === 200 && st.body.active === 'dry')
  check('dry test-config action', (await req('POST', '/api/nginx/test')).body.ok === true)

  // sites: create + validate
  check('bad name rejected', (await req('POST', '/api/sites', { name: '../evil', domains: ['x.com'] })).status === 400)
  const created = await req('POST', '/api/sites', { name: 'myapp', domains: ['myapp.test'], root: path.join(FIX, 'www', 'myapp') })
  check('site created', created.status === 200 && created.body.site.name === 'myapp')

  const conf = fs.readFileSync(path.join(FIX, 'nginx', 'sites-available', 'myapp.conf'), 'utf8')
  check('conf generated', conf.includes('server_name myapp.test') && conf.includes('root ') && !conf.includes('listen 443'))
  check('placeholder index written', fs.existsSync(path.join(FIX, 'www', 'myapp', 'index.html')))
  check('http conf generated', fs.readFileSync(path.join(FIX, 'nginx', 'conf.d', '00-dashboard.conf'), 'utf8').includes('# managed by nginx-dashboard'))

  // enable/disable
  check('enable site', (await req('POST', '/api/sites/myapp/enable')).body.ok === true)
  check('symlink created', fs.existsSync(path.join(FIX, 'nginx', 'sites-enabled', 'myapp.conf')))
  check('disable site', (await req('POST', '/api/sites/myapp/disable')).body.ok === true)
  check('symlink removed', !fs.existsSync(path.join(FIX, 'nginx', 'sites-enabled', 'myapp.conf')))
  // These share the `/api/sites/:name/<verb>` shape. They are separate routes, but a single
  // `/:toggle` route would match them too and shadow whichever is declared later — and the
  // toggle handler answers 200, so asserting the *body* is what proves which handler ran.
  check('unknown action is not a toggle', (await req('POST', '/api/sites/myapp/frobnicate')).status === 404)
  check('upload-zip reaches its own handler',
    (await req('POST', '/api/sites/myapp/upload-zip')).body.error === 'site or zip missing')

  // update with all features: proxy + upstream + rate limit + ip rules + https selfsigned
  const upd = await req('PUT', '/api/sites/myapp', {
    domains: ['myapp.test'],
    proxy: [{ path: '/', target: 'upstream:myapp_backends' }],
    upstreams: [{ name: 'myapp_backends', algorithm: 'least_conn', healthCheck: true, servers: [{ scheme: 'https', host: '10.0.0.5', port: 8443 }] }],
    rateLimit: { enabled: true, rps: 5, burst: 10 },
    ipRules: { mode: 'denylist', ips: ['1.2.3.4'] },
    https: { mode: 'selfsigned', forceRedirect: true },
    listen: { http2: true, http3: true },
  })
  check('update ok', upd.status === 200)
  const conf2 = fs.readFileSync(path.join(FIX, 'nginx', 'sites-available', 'myapp.conf'), 'utf8')
  const http2 = fs.readFileSync(path.join(FIX, 'nginx', 'conf.d', '00-dashboard.conf'), 'utf8')
  // upstreams are global to the http context, so the generated pool name is namespaced by site
  check('upstream in http conf', http2.includes('upstream myapp_myapp_backends') && http2.includes('least_conn') && http2.includes('max_fails=3'))
  check('rate zone in http conf', http2.includes('zone=myapp_rl:10m rate=5r/s'))
  check('proxy_pass via https upstream', conf2.includes('proxy_pass https://myapp_myapp_backends;'))
  check('proxy_ssl_verify off', conf2.includes('proxy_ssl_verify off;'))
  check('limit_req in server', conf2.includes('limit_req zone=myapp_rl burst=10 nodelay;'))
  check('deny rule', conf2.includes('deny 1.2.3.4;'))
  check('https block', conf2.includes('listen 443 ssl http2;') && conf2.includes('listen 443 quic;') && conf2.includes("Alt-Svc 'h3=\":443\""))
  check('force redirect', conf2.includes('return 301 https://$host$request_uri;'))
  check('selfsigned cert path', conf2.includes('fullchain.pem') && conf2.includes('myapp'), `got: ${conf2.match(/ssl_certificate[^;]*/g)}`)

  // the real-world shape: WordPress behind php-fpm, TLS on a forwarded port
  const wp = await req('PUT', '/api/sites/myapp', {
    domains: ['mixviberadio.com'],
    root: path.join(FIX, 'www', 'myapp'),
    index: 'index.php index.html',
    httpsPort: 44306,
    https: { mode: 'selfsigned', forceRedirect: true },
    listen: { http2: false, http3: true, reuseport: true },
    php: { enabled: true, endpoint: 'unix:/run/php/php8.3-fpm.sock', frontController: true },
    proxy: [],   // the earlier update put a proxy rule on `/`, which outranks the front controller
  })
  check('wordpress-shaped site saved', wp.status === 200, JSON.stringify(wp.body))
  const conf3 = fs.readFileSync(path.join(FIX, 'nginx', 'sites-available', 'myapp.conf'), 'utf8')
  check('tls on the forwarded port', conf3.includes('listen 44306 ssl reuseport;'))
  check('quic on the forwarded port', conf3.includes('listen 44306 quic reuseport;'))
  check('redirect carries the port', conf3.includes('return 301 https://$host:44306$request_uri;'), 'a bare $host would bounce to a dead 443')
  check('index order', conf3.includes('index index.php index.html;'))
  check('fastcgi block', conf3.includes('fastcgi_pass unix:/run/php/php8.3-fpm.sock;') && conf3.includes('try_files $fastcgi_script_name =404;'))
  check('front controller', conf3.includes('try_files $uri $uri/ /index.php?$query_string;'))
  check('dotfiles denied', conf3.includes('location ~ /\\.(?!well-known) {'))
  check('no listener left on 443', !/listen 443[ ;]/.test(conf3), (conf3.match(/listen[^;]*/g) || []).join(' | '))

  // rejected shapes never reach the conf
  check('a colliding http/https port is refused', (await req('PUT', '/api/sites/myapp', { httpsPort: 80 })).status === 400)
  check('an injection-shaped fpm endpoint is refused', (await req('PUT', '/api/sites/myapp', { php: { enabled: true, endpoint: 'unix:/run/php/x.sock; }' } })).status === 400)
  check('a site with no listener at all is refused', (await req('PUT', '/api/sites/myapp', { serveHttp: false, https: { mode: 'none' } })).status === 400)
  check('the conf is untouched after a refusal', fs.readFileSync(path.join(FIX, 'nginx', 'sites-available', 'myapp.conf'), 'utf8') === conf3)

  // last, because it changes the conf: a proxy rule on `/` and the front controller are both
  // `location /`, and nginx refuses a duplicate — the proxy rule is the one that wins
  const rootProxy = await req('PUT', '/api/sites/myapp', { proxy: [{ path: '/', target: 'http://127.0.0.1:8080' }] })
  const conf4 = fs.readFileSync(path.join(FIX, 'nginx', 'sites-available', 'myapp.conf'), 'utf8')
  check('a root proxy rule outranks the front controller',
    rootProxy.status === 200 && !conf4.includes('try_files $uri $uri/ /index.php') && conf4.includes('proxy_pass http://127.0.0.1:8080;'),
    JSON.stringify(rootProxy.body))

  // a vhost with no name yet: serves on its port, answers to anything
  const catchall = await req('POST', '/api/sites', { name: 'catchall', domains: [], root: path.join(FIX, 'www', 'catchall'), port: 8080 })
  check('a domainless site is accepted', catchall.status === 200, JSON.stringify(catchall.body))
  check('...and answers to _',
    fs.readFileSync(path.join(FIX, 'nginx', 'sites-available', 'catchall.conf'), 'utf8').includes('server_name _;'))
  check('...and its placeholder is not "undefined"',
    fs.readFileSync(path.join(FIX, 'www', 'catchall', 'index.html'), 'utf8').includes('<h1>catchall</h1>'))
  check('cleanup', (await req('DELETE', '/api/sites/catchall')).body.ok === true)

  // the static fallback, the request-body limit and HSTS — through the API, since these are
  // new fields and the round trip is what proves sanitizeSite does not drop them
  const stat = await req('POST', '/api/sites', { name: 'static1', domains: ['static1.test'], root: path.join(FIX, 'www', 'static1') })
  check('static site created', stat.status === 200, JSON.stringify(stat.body))
  const statPath = path.join(FIX, 'nginx', 'sites-available', 'static1.conf')
  let statConf = fs.readFileSync(statPath, 'utf8')
  check('a static site gets the .html fallback', statConf.includes('try_files $uri $uri/ $uri.html =404;'), statConf)
  check('...and neither new directive by default',
    !statConf.includes('client_max_body_size') && !statConf.includes('Strict-Transport-Security'))

  const secured = await req('PUT', '/api/sites/static1', {
    https: { mode: 'selfsigned', forceRedirect: false },
    clientMaxBodySize: 64,
    hsts: { enabled: true, maxAge: 31536000, includeSubDomains: true, preload: false },
  })
  check('body limit and hsts saved', secured.status === 200, JSON.stringify(secured.body))
  statConf = fs.readFileSync(statPath, 'utf8')
  check('body limit reaches the conf', statConf.includes('client_max_body_size 64m;'), statConf)
  check('hsts reaches the tls block', statConf.includes('add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;'))
  check('hsts is re-emitted in the cache location', (statConf.match(/Strict-Transport-Security/g) || []).length === 2, statConf)
  check('the plain-http block carries no hsts', !statConf.split('server {')[1].includes('Strict-Transport-Security'))

  check('an out-of-range body limit is refused', (await req('PUT', '/api/sites/static1', { clientMaxBodySize: 99999 })).status === 400)
  check('preload without subdomains is refused', (await req('PUT', '/api/sites/static1', { hsts: { enabled: true, maxAge: 31536000, includeSubDomains: false, preload: true } })).status === 400)
  check('the conf is untouched after those refusals', fs.readFileSync(statPath, 'utf8') === statConf)

  const taken = await req('PUT', '/api/sites/static1', { proxy: [{ path: '/', target: 'http://127.0.0.1:8080' }] })
  check('a root proxy rule withdraws the fallback',
    taken.status === 200 && !fs.readFileSync(statPath, 'utf8').includes('$uri.html'), JSON.stringify(taken.body))
  check('cleanup', (await req('DELETE', '/api/sites/static1')).body.ok === true)

  // files: upload + traversal guard + delete
  const fd = new FormData()
  fd.append('files', new Blob(['<h1>hi</h1>']), 'index.html')
  fd.append('path', '.')
  const up = await req('POST', '/api/sites/myapp/files', fd)
  check('file upload', up.status === 200 && fs.readFileSync(path.join(FIX, 'www', 'myapp', 'index.html'), 'utf8') === '<h1>hi</h1>',
    `status=${up.status} body=${JSON.stringify(up.body)}`)

  check('path traversal blocked', (await req('DELETE', '/api/sites/myapp/files?path=' + encodeURIComponent('../../state/manifest.json'))).status === 400)
  check('manifest still there', fs.existsSync(path.join(FIX, 'state', 'manifest.json')))

  // list files
  const ls = await req('GET', '/api/sites/myapp/files?path=.')
  check('file list', ls.body.entries?.some(e => e.name === 'index.html'))

  // unmanaged site listed read-only
  fs.writeFileSync(path.join(FIX, 'nginx', 'sites-available', 'foreign.conf'), 'server {}\n')
  const list = await req('GET', '/api/sites')
  const foreign = list.body.sites.find(s => s.name === 'foreign')
  check('unmanaged site listed', foreign && foreign.managed === false)
  check('unmanaged not editable', (await req('GET', '/api/sites/foreign')).status === 404)

  // logs SSE
  const sse = await fetch(API + '/api/logs/tail?file=access', { headers: { cookie } })
  check('sse content-type', sse.headers.get('content-type').startsWith('text/event-stream'))
  const reader = sse.body.getReader()
  const dec = new TextDecoder()
  // the stream opens with a `: connected` comment, so the first chunk may hold no data line yet
  let seen = ''
  for (let i = 0; i < 5 && !seen.includes('data:'); i++) seen += dec.decode((await reader.read()).value || '')
  check('sse lines', seen.includes('data: 1.2.3.4'), JSON.stringify(seen.slice(0, 120)))
  await reader.cancel()
  await reader.cancel()

  // delete
  check('delete site', (await req('DELETE', '/api/sites/myapp')).body.ok === true)
  check('conf gone', !fs.existsSync(path.join(FIX, 'nginx', 'sites-available', 'myapp.conf')))
  check('manifest updated', !(JSON.parse(fs.readFileSync(path.join(FIX, 'state', 'manifest.json'))).sites || []).some(s => s.name === 'myapp'))

  // ---- the dashboard's own vhost, through the API ----
  // DASH_SELF_NAME is 'nxd' in this env, so that one name is pinned. Everything below is the
  // difference between a vhost and the vhost you are reading the page through.
  const selfConf = path.join(FIX, 'nginx', 'sites-available', 'nxd.conf')
  const pub = await req('POST', '/api/sites', {
    name: 'nxd', domains: ['dash.test'], port: 8443, listenAddress: '127.0.0.1',
    proxy: [{ path: '/', target: `http://127.0.0.1:3123` }],
    ipRules: { mode: 'allowlist', ips: ['127.0.0.1/32', '192.168.0.0/16'] },
    https: { mode: 'selfsigned' }, rateLimit: { enabled: true, rps: 30, burst: 60 },
    clientMaxBodySize: 2048,
  })
  check('the dashboard vhost is created', pub.status === 200 && pub.body.site.self === true, JSON.stringify(pub.body))
  check('...with no warnings when it is hardened', !pub.body.warnings, JSON.stringify(pub.body.warnings))
  let selfText = fs.readFileSync(selfConf, 'utf8')
  check('...bound to its address on both ports',
    selfText.includes('listen 127.0.0.1:8443;') && selfText.includes('listen 127.0.0.1:443 ssl;'), selfText.match(/listen[^;]*/g).join(' | '))
  check('...with the allowlist and no wildcard listener',
    selfText.includes('allow 192.168.0.0/16;') && selfText.includes('deny all;') && !/listen (8443|443)[ ;]/.test(selfText))
  check('...proxying / back at the dashboard',
    selfText.includes('proxy_pass http://127.0.0.1:3123;') && selfText.includes('proxy_buffering off;'))

  check('it cannot be disabled', (await req('POST', '/api/sites/nxd/disable')).status === 403)
  check('...but it can be enabled', (await req('POST', '/api/sites/nxd/enable')).body.ok === true)
  check('it cannot be deleted', (await req('DELETE', '/api/sites/nxd')).status === 403)
  check('...and the refusal says how to get back in',
    (await req('DELETE', '/api/sites/nxd')).body.error.includes('still listening on 127.0.0.1:3123'))

  const beforeRefusals = fs.readFileSync(selfConf, 'utf8')
  check('dropping the / rule is refused',
    (await req('PUT', '/api/sites/nxd', { proxy: [{ path: '/api', target: 'http://127.0.0.1:3123' }] })).status === 400)
  check('repointing / elsewhere is refused',
    (await req('PUT', '/api/sites/nxd', { proxy: [{ path: '/', target: 'http://10.0.0.9:3123' }] })).status === 400)
  check('pointing / at the wrong port is refused',
    (await req('PUT', '/api/sites/nxd', { proxy: [{ path: '/', target: 'http://127.0.0.1:9999' }] })).status === 400)
  check('pointing / at an upstream pool is refused',
    (await req('PUT', '/api/sites/nxd', { proxy: [{ path: '/', target: 'upstream:pool' }] })).status === 400)
  check('a bogus listen address is refused', (await req('PUT', '/api/sites/nxd', { listenAddress: '127.0.0.1; }' })).status === 400)
  check('a typo in an ip rule is refused',
    (await req('PUT', '/api/sites/nxd', { ipRules: { mode: 'allowlist', ips: ['192.168.0.0/16', 'oops'] } })).status === 400)
  check('the conf is untouched after those refusals', fs.readFileSync(selfConf, 'utf8') === beforeRefusals)
  check('...and it is still enabled', fs.existsSync(path.join(FIX, 'nginx', 'sites-enabled', 'nxd.conf')))

  const loosened = await req('PUT', '/api/sites/nxd', { ipRules: { mode: 'denylist', ips: [] }, listenAddress: '' })
  check('a legitimate change still goes through', loosened.status === 200, JSON.stringify(loosened.body))
  check('...with warnings rather than a refusal',
    loosened.body.warnings?.some(w => w.includes('listen address')) && loosened.body.warnings.some(w => w.includes('allowlist')),
    JSON.stringify(loosened.body.warnings))
  check('...and the warnings come with the way back in', loosened.body.recovery?.includes('ssh -N -L 3123:127.0.0.1:3123'))

  // reverts are file restorers that validate nothing, so the snapshot is inspected first
  const histDir = path.join(FIX, 'state', 'history')
  fs.mkdirSync(histDir, { recursive: true })
  const writeSnap = (id, sites) => fs.writeFileSync(path.join(histDir, id), JSON.stringify({
    at: 1, label: 'x', files: [{ path: path.join(FIX, 'state', 'manifest.json'), content: JSON.stringify({ sites }), link: null }],
  }))
  writeSnap('1700000000000-000001.json', [])
  // the id is the snapshot's filename, `.json` included — that is what /api/history hands the UI
  check('reverting to before the vhost existed is refused',
    (await req('POST', '/api/history/1700000000000-000001.json/revert')).status === 422)
  const rr = await req('POST', '/api/history/1700000000000-000001.json/revert')
  check('...and names the reason', rr.body.error.includes('predates'), JSON.stringify(rr))
  check('...leaving the manifest alone',
    JSON.parse(fs.readFileSync(path.join(FIX, 'state', 'manifest.json'), 'utf8')).sites.some(s => s.name === 'nxd'))
  writeSnap('1700000000000-000002.json', JSON.parse(fs.readFileSync(path.join(FIX, 'state', 'manifest.json'), 'utf8')).sites)
  const okRevert = await req('POST', '/api/history/1700000000000-000002.json/revert')
  check('a revert that keeps the vhost still runs', okRevert.body.ok === true, JSON.stringify(okRevert))
  check('a bad history id is still just a 422',
    (await req('POST', '/api/history/nope.json/revert')).status === 422)
  // and a slashed one never reaches the handler at all: it cannot match `:id`, so there is no
  // path to traverse with in the first place
  check('a slashed history id is not even a route',
    (await req('POST', '/api/history/../../manifest.json/revert')).status === 404)

  // last: five wrong passwords lock the address out, so nothing may need to log in after this
  for (let i = 0; i < 5; i++) await req('POST', '/api/login', { password: 'nope' })
  const locked = await req('POST', '/api/login', { password: 'testpw' })
  check('the sixth attempt is refused outright', locked.status === 429, `${locked.status} ${JSON.stringify(locked.body)}`)
  check('...for the right password too', locked.body.error.includes('too many failed logins'))
  check('...while the session already held still works', (await req('GET', '/api/sites')).status === 200)
} finally {
  server.kill()
}

console.log(failed ? `\n${failed} of ${ran} FAILED` : `\nall ${ran} checks passed`)
process.exit(failed ? 1 : 0)