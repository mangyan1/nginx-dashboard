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
} finally {
  server.kill()
}

console.log(failed ? `\n${failed} of ${ran} FAILED` : `\nall ${ran} checks passed`)
process.exit(failed ? 1 : 0)