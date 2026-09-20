// Smoke test: boots server.js in DRY mode against the fixture tree, exercises the
// API end to end with plain asserts. Run: node test/smoke.mjs
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const { totp, newSecret } = await import('../lib/totp.js')

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const FIX = path.join(root, 'test', 'fixtures')
const API = 'http://127.0.0.1:3123'
// The server's own severity order for the bell, restated here so a list that is no longer sorted
// fails rather than being compared against itself.
const RANK = { err: 0, warn: 1, info: 2 }

const env = {
  ...process.env,
  DASH_PASSWORD: 'testpw', DASH_DRY: '1', DASH_PORT: '3123', DASH_HOST: '127.0.0.1',
  DASH_SELF_NAME: 'nxd',
  // Explicitly empty, not inherited: systemd sets this for every service it starts, and the restart
  // route reads it to decide whether anything would start this process again. Inheriting it from a
  // developer's shell would make the refusal below untestable in exactly the environment it matters.
  INVOCATION_ID: '',
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
  // Both of these hand back file contents or install packages, so they are checked before the
  // session exists rather than assumed to be behind the same middleware as everything else.
  check('...including the conf reader', (await req('GET', '/api/nginx-files/nxd')).status === 401)
  check('...and the updater', (await req('POST', '/api/settings/updates/apply', { name: 'express' })).status === 401)
  // This one runs apt-get as root. It is the last route that should ever answer an anonymous caller.
  check('...and the stack installer', (await req('POST', '/api/stack/install')).status === 401)
  // What the bell would list is a description of this install's config, so it is behind the same
  // middleware as the config itself.
  check('...and the notifications', (await req('GET', '/api/notifications')).status === 401)
  // The one GET that must answer an anonymous caller: it is how the sign-in form knows whether to
  // draw the code field at all. `false` here, with no secret in the unit and none on disk.
  const anon = await req('GET', '/api/login')
  check('the sign-in form can ask what it needs before signing in',
    anon.status === 200 && anon.body.totp === false, JSON.stringify(anon.body))
  check('wrong password rejected', (await req('POST', '/api/login', { password: 'nope' })).status === 401)
  check('...and the refusal names the password, so the form can say so',
    (await req('POST', '/api/login', { password: 'nope' })).body.error === 'wrong password')
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

  // Two creates at once used to read the manifest together and write it one after the other: the
  // second write erased the first site from the manifest while its conf stayed behind on disk.
  // Mutating requests are queued now, so "last write wins" became "last request wins" and both
  // sites land. Two creates is the smallest overlap there is, and both must come back.
  const [raceA, raceB] = await Promise.all([
    req('POST', '/api/sites', { name: 'race-a', domains: ['race-a.test'], root: path.join(FIX, 'www', 'race-a') }),
    req('POST', '/api/sites', { name: 'race-b', domains: ['race-b.test'], root: path.join(FIX, 'www', 'race-b') }),
  ])
  const raceList = (await req('GET', '/api/sites')).body.sites
  check('two concurrent creates both land',
    raceA.status === 200 && raceB.status === 200 &&
    raceList.some(s => s.name === 'race-a') && raceList.some(s => s.name === 'race-b'),
    JSON.stringify({ a: raceA.status, b: raceB.status }))
  check('cleanup', (await req('DELETE', '/api/sites/race-a')).body.ok === true && (await req('DELETE', '/api/sites/race-b')).body.ok === true)

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

  // WordPress. The route is DRY-refused, so what is testable here is the *order* of its refusals —
  // which is the part that matters, because extracting over an operator's docroot is the one
  // irreversible thing it can do. The docroot is reset first: `www/` is not part of the fresh
  // fixture tree above, and a leftover file would make "the placeholder and nothing else" a lie.
  const wpRoot = path.join(FIX, 'www', 'wptest')
  fs.rmSync(wpRoot, { recursive: true, force: true })
  const wpt = await req('POST', '/api/sites', { name: 'wptest', domains: ['wptest.test'], root: wpRoot })
  check('a site for the wordpress refusals', wpt.status === 200, JSON.stringify(wpt.body))
  check('...whose docroot is the placeholder and nothing else', fs.readdirSync(wpRoot).join() === 'index.html')

  const notReady = await req('POST', '/api/sites/wptest/wordpress')
  check('WordPress on a site without PHP is refused, over the plain-text hazard',
    notReady.status === 409 && /plain text/.test(notReady.body.error), JSON.stringify(notReady.body))
  check('...and the same refusal names the front controller and index.php',
    /front controller/.test(notReady.body.error) && /index\.php/.test(notReady.body.error), notReady.body.error)

  await req('PUT', '/api/sites/wptest', {
    index: 'index.php index.html',
    php: { enabled: true, endpoint: 'unix:/run/php/php8.3-fpm.sock', frontController: true },
  })
  const dryWp = await req('POST', '/api/sites/wptest/wordpress')
  check('a ready site is refused for the dry run, not for its config',
    dryWp.status === 409 && /dry run/.test(dryWp.body.error), JSON.stringify(dryWp.body))
  check('...and the refusal downloaded nothing into the docroot',
    fs.readdirSync(wpRoot).join() === 'index.html')

  fs.writeFileSync(path.join(wpRoot, 'notes.txt'), 'mine\n')
  const occupied = await req('POST', '/api/sites/wptest/wordpress')
  check('a docroot holding real files is refused before either of those',
    occupied.status === 409 && /notes\.txt/.test(occupied.body.error), JSON.stringify(occupied.body))
  check('...naming the directory it would have written over', occupied.body.error.includes(wpRoot), occupied.body.error)
  check('cleanup the wordpress fixture', (await req('DELETE', '/api/sites/wptest')).body.ok === true)
  fs.rmSync(wpRoot, { recursive: true, force: true })

  // Deleting the document root along with the site. DRY, so what is asserted is that the *removal*
  // was refused while the site deletion went through anyway — and, the one that matters, that the
  // directory is still on disk. The demo's document roots are real absolute paths outside this
  // fixture tree, so this assertion is the whole distance between a dry run and `rm -rf` on a box.
  const delRoot = path.join(FIX, 'www', 'deltest')
  fs.rmSync(delRoot, { recursive: true, force: true })
  const mkDel = await req('POST', '/api/sites', { name: 'deltest', domains: ['deltest.test'], root: delRoot })
  check('a site to delete the document root of', mkDel.status === 200, JSON.stringify(mkDel.body))
  fs.writeFileSync(path.join(delRoot, 'keep.txt'), 'still here\n')

  const withRoot = await req('DELETE', '/api/sites/deltest?root=1')
  check('a delete with the document root is a dry run, not a failure',
    withRoot.status === 200 && withRoot.body.ok === true, JSON.stringify(withRoot.body))
  check('...and the sentence says the removal did not happen',
    /dry mode/.test(String(withRoot.body.output)) && String(withRoot.body.output).includes(delRoot), String(withRoot.body.output))
  check('...and the document root is still there, file and all',
    fs.readFileSync(path.join(delRoot, 'keep.txt'), 'utf8') === 'still here\n')
  check('...while the site itself is gone regardless',
    !(await req('GET', '/api/sites')).body.sites.some(s => s.name === 'deltest'))

  // A plain delete stays exactly what it was — no `output` key at all, which is what keeps the
  // appended clause in `said()` unreachable unless the box was ticked.
  const plainRoot = path.join(FIX, 'www', 'plaintest')
  fs.rmSync(plainRoot, { recursive: true, force: true })
  await req('POST', '/api/sites', { name: 'plaintest', domains: ['plaintest.test'], root: plainRoot })
  const plain = await req('DELETE', '/api/sites/plaintest')
  check('a plain delete is unchanged, and says nothing extra',
    plain.status === 200 && plain.body.ok === true && !('output' in plain.body), JSON.stringify(plain.body))
  check('...and leaves its document root where it was', fs.existsSync(plainRoot))
  fs.rmSync(plainRoot, { recursive: true, force: true })
  fs.rmSync(delRoot, { recursive: true, force: true })

  // The defaults the form reads. A "use default" chip can only be honest if it shows the value the
  // server would actually apply, so the client fetches them instead of keeping a second copy —
  // it used to have one, and it had already drifted (nine cache extensions against ten here).
  const defs = await req('GET', '/api/site-defaults?name=myapp')
  check('site-defaults returns the server defaults',
    defs.status === 200 && defs.body.defaults.root === '/var/www/myapp' && defs.body.defaults.rateLimit.rps === 50,
    JSON.stringify(defs.body?.defaults?.rateLimit))
  check('...and answers before a name exists', (await req('GET', '/api/site-defaults')).body.defaults.root === '/var/www/')
  check('...and refuses a name that is not one', (await req('GET', '/api/site-defaults?name=' + encodeURIComponent('../evil'))).status === 400)

  // Lists that read "on" in the form while emitting no directive at all. An allowlist is the one
  // that fails *open*: with no addresses the whole ipRules block is skipped, so no allow and no
  // deny all are written and the vhost serves everybody.
  check('an empty allowlist is refused at save, not saved open',
    (await req('PUT', '/api/sites/myapp', { ipRules: { mode: 'allowlist', ips: [] } })).status === 400)
  check('...as is one holding only blank rows, which would deny everyone',
    (await req('PUT', '/api/sites/myapp', { ipRules: { mode: 'allowlist', ips: [''] } })).status === 400)
  check('...while an empty denylist still saves', (await req('PUT', '/api/sites/myapp', { ipRules: { mode: 'denylist', ips: [] } })).status === 200)
  check('basic auth on with no users is refused',
    (await req('PUT', '/api/sites/myapp', { basicAuth: { enabled: true, users: [] } })).status === 400)

  // A basic-auth password is hashed on the way in and never stored. The form has to send it, so
  // this is the last moment it exists — and the manifest is where an operator's own reused password
  // would otherwise sit in the clear, twenty times over, inside the undo history.
  const pwSite = await req('PUT', '/api/sites/myapp', { basicAuth: { enabled: true, users: [{ user: 'bob', password: 'hunter2' }] } })
  const storedRow = pwSite.body.site?.basicAuth?.users?.[0] || {}
  check('a basic-auth password is stored as a hash, not the password',
    pwSite.status === 200 && !!storedRow.hash && storedRow.password === undefined && !JSON.stringify(storedRow).includes('hunter2'),
    JSON.stringify(storedRow))
  const manifestText = fs.readFileSync(path.join(FIX, 'state', 'manifest.json'), 'utf8')
  check('...and the password appears nowhere in the manifest file',
    !manifestText.includes('hunter2') && manifestText.includes(storedRow.hash), storedRow.hash)
  check('...with the hash in the file nginx reads',
    fs.readFileSync(path.join(FIX, 'htpasswd', 'myapp'), 'utf8') === `bob:${storedRow.hash}\n`)

  // Re-saving the site as the form would — password box blank, hash carried through — must keep
  // that user's password. Dropping the hash here is how an operator silently locks a user out.
  const resaved = await req('PUT', '/api/sites/myapp', { basicAuth: { enabled: true, users: [{ user: 'bob', hash: storedRow.hash }] } })
  check('re-saving with the password box left blank keeps the same hash',
    resaved.body.site?.basicAuth?.users?.[0]?.hash === storedRow.hash, JSON.stringify(resaved.body.site?.basicAuth))

  // ...and typing a new one replaces it, rather than being ignored as "already set".
  const rehashed = await req('PUT', '/api/sites/myapp', { basicAuth: { enabled: true, users: [{ user: 'bob', hash: storedRow.hash, password: 'different' }] } })
  check('...while a typed one wins over it',
    rehashed.body.site?.basicAuth?.users?.[0]?.hash !== storedRow.hash &&
    !fs.readFileSync(path.join(FIX, 'state', 'manifest.json'), 'utf8').includes('different'),
    JSON.stringify(rehashed.body.site?.basicAuth))

  // Put it back off, so the conf tests further down see the site they expect.
  await req('PUT', '/api/sites/myapp', { basicAuth: { enabled: false, users: [] } })
  check('...and turning it off writes no auth_basic at all',
    !fs.readFileSync(path.join(FIX, 'nginx', 'sites-available', 'myapp.conf'), 'utf8').includes('auth_basic'))

  // The password file is inside the transaction now, so its lifecycle follows the site's: a
  // delete takes it away with the conf and the manifest row, instead of leaving a hash file
  // behind for a site that no longer exists. (Turning basic auth *off* still leaves it — that
  // is deliberate, and writeHtpasswd's comment says why.)
  const authdel = await req('POST', '/api/sites', {
    name: 'authdel', domains: ['authdel.test'], root: path.join(FIX, 'www', 'authdel'),
    basicAuth: { enabled: true, users: [{ user: 'carl', password: 'pw1' }] },
  })
  check('a site with basic auth is created', authdel.status === 200, JSON.stringify(authdel.body))
  check('...and its password file is written', fs.readFileSync(path.join(FIX, 'htpasswd', 'authdel'), 'utf8').startsWith('carl:$apr1$'))
  check('deleting the site takes its password file with it',
    (await req('DELETE', '/api/sites/authdel')).body.ok === true && !fs.existsSync(path.join(FIX, 'htpasswd', 'authdel')))

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
  // A blank docroot is not an error, it is the default — filled from the same factory the chip
  // reads, so what the form promises is what lands in the conf.
  const filled = await req('PUT', '/api/sites/catchall', { root: '' })
  check('a blank docroot is filled from that same default',
    filled.status === 200 && filled.body.site.root === '/var/www/catchall', JSON.stringify(filled.body.site?.root))
  check('cleanup', (await req('DELETE', '/api/sites/catchall')).body.ok === true)

  // A key that is not a site field used to ride into the manifest for ever — unread by anything
  // and uncleanable by any save. The defaults overlay refuses such a key by name (`not a site
  // field`); a save draws the same line silently, because the client that sent the typo still
  // gets a site that works.
  const junked = await req('POST', '/api/sites', {
    name: 'junktest', domains: ['junktest.test'], root: path.join(FIX, 'www', 'junktest'),
    gzipp: { enabled: false }, bogus: 1,
  })
  check('an unknown body key is dropped, not stored',
    junked.status === 200 && !('bogus' in junked.body.site) && !('gzipp' in junked.body.site),
    JSON.stringify(Object.keys(junked.body.site || {})))
  check('cleanup', (await req('DELETE', '/api/sites/junktest')).body.ok === true)

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

  // ---- the directories as files: what "nginx files" on Sites renders ----
  // A dangling link is the state this exists to show and the dashboard never writes one, so it is
  // made here by hand — the way deleting a conf with `rm` and leaving its symlink behind does.
  fs.symlinkSync(path.join(FIX, 'nginx', 'sites-available', 'foreign.conf'),
    path.join(FIX, 'nginx', 'sites-enabled', 'foreign.conf'), 'file')
  fs.symlinkSync(path.join(FIX, 'nginx', 'sites-available', 'vanished.conf'),
    path.join(FIX, 'nginx', 'sites-enabled', 'vanished.conf'), 'file')
  const nf = await req('GET', '/api/nginx-files')
  check('the nginx file list answers', nf.status === 200, JSON.stringify(nf.body))
  check('sites-available is listed as files', nf.body.available.some(f => f.name === 'foreign.conf'))
  check('...tagged with whether the manifest manages it',
    nf.body.available.find(f => f.name === 'myapp.conf')?.managed === true &&
    nf.body.available.find(f => f.name === 'foreign.conf')?.managed === false)
  const linked = nf.body.enabled.find(f => f.name === 'vanished.conf')
  check('a link whose target is gone is reported unresolved', linked && linked.resolves === false, JSON.stringify(linked ?? null))
  check('...and one that resolves is not',
    nf.body.enabled.find(f => f.name === 'foreign.conf')?.resolves === true)

  const readConf = await req('GET', '/api/nginx-files/foreign')
  check('a conf is readable under the bare name the site list shows',
    readConf.status === 200 && readConf.body.file.text === 'server {}\n', JSON.stringify(readConf.body))
  check('...and says which directory it came from', readConf.body.file.dir === 'sites-available')
  check('traversal is refused', (await req('GET', '/api/nginx-files/..%2Fstate%2Fmanifest.json')).status === 404)
  check('a name that is not there is 404', (await req('GET', '/api/nginx-files/nosuch')).status === 404)

  // ---- notifications: the same facts, collected for the bell ----
  // A second, milder problem on purpose: one item cannot tell a sorted list from an unsorted one, and
  // `myapp` is discovered before the dangling link below, so without the sort the warn would lead.
  const myappConf = path.join(FIX, 'nginx', 'sites-available', 'myapp.conf')
  const myappText = fs.readFileSync(myappConf, 'utf8')
  fs.writeFileSync(myappConf, myappText + '\n# edited by hand\n')
  const notes = await req('GET', '/api/notifications')
  // Asked twice with the disk in the same state: nothing is stored, so nothing can be marked read
  // and the second answer has to be the first one again.
  const again = await req('GET', '/api/notifications')
  fs.writeFileSync(myappConf, myappText)
  check('the bell has something to list', notes.status === 200 && Array.isArray(notes.body.items), JSON.stringify(notes.body).slice(0, 200))
  // The dangling link made two blocks up, seen from the other end. This is the one file fault that
  // stops nginx starting at all, so it is the item that has to be there and has to be an error.
  const danglingNote = notes.body.items.find(i => i.id === 'dangling-vanished.conf')
  check('...and the dangling symlink on disk is in it, as an error',
    danglingNote?.kind === 'err' && danglingNote.tab === 'sites', JSON.stringify(danglingNote ?? null))
  check('...and a conf edited by hand is in it too, as a warning',
    notes.body.items.find(i => i.id === 'drift-modified-myapp')?.kind === 'warn')
  // Every item must say where the fix is or say so by leaving `tab` empty — a tab id that is not one
  // of the five would be a button that goes nowhere.
  check('...every item naming a tab names a real one',
    notes.body.items.every(i => ['sites', 'control', 'logs', 'metrics', 'settings', ''].includes(i.tab)),
    JSON.stringify(notes.body.items.map(i => i.tab)))
  check('...and asking again over the same state gives the same list, because none of it is stored',
    JSON.stringify(again.body.items) === JSON.stringify(notes.body.items),
    JSON.stringify(again.body.items.map(i => i.id)))
  // Worst first. The manifest happens to hold `demo` before `app` here, so this is checking the
  // sort rather than an accident of insertion order.
  check('...worst first, not the order the problems were found in',
    notes.body.items.every((i, n) => !n || RANK[notes.body.items[n - 1].kind] <= RANK[i.kind]),
    JSON.stringify(notes.body.items.map(i => i.kind)))

  // ---- dependency updates ----
  const deps = await req('GET', '/api/settings/updates')
  check('the update check lists this project\'s dependencies',
    deps.status === 200 && deps.body.packages.some(p => p.name === 'express'), JSON.stringify(deps.body).slice(0, 200))
  // Asserted on the classification, not on versions: whether the registry answers from a test box
  // is not this suite's business, and `p.latest` is empty when it does not.
  check('a runtime dependency is marked installable here',
    deps.body.packages.find(p => p.name === 'express')?.updatable === true)
  check('...and a build-time one is not, because npm moving it changes nothing served',
    deps.body.packages.find(p => p.name === 'react')?.updatable === false)
  // The bell reads that answer through a six-hour cache and the panel forces it past. Same route and
  // the same question, so the force has to mean "ask again", not "answer differently".
  const forced = await req('GET', '/api/settings/updates?force=1')
  check('forcing the check asks again and answers the same question',
    forced.status === 200 && forced.body.packages.length === deps.body.packages.length, JSON.stringify(forced.body).slice(0, 120))
  check('the restart is refused when nothing is supervising this process',
    (await req('POST', '/api/settings/restart')).status === 409)
  check('installing a build-time dependency is refused',
    (await req('POST', '/api/settings/updates/apply', { name: 'react' })).status === 400)
  check('installing a package that is not a dependency is refused',
    (await req('POST', '/api/settings/updates/apply', { name: 'left-pad' })).status === 400)
  // The last guard, and the one that keeps a test box from writing to its own node_modules: in dry
  // mode nothing is installed, whatever the registry said.
  check('a dry run installs nothing',
    (await req('POST', '/api/settings/updates/apply', { name: 'express' })).status === 409)

  // the stack. The status read is real work on any box — it shells out to lemp.sh --detect — and the
  // install is the one route here that can change the machine, so DRY refusing it is the point.
  const stack = await req('GET', '/api/stack')
  check('stack status answers', stack.status === 200 && stack.body.dry === true, JSON.stringify(stack.body))
  // Asserted as a mapping rather than as a list of what is absent here. What a box has installed is
  // a property of the box: this dev machine has no php-fpm and no database server, while the CI
  // runner ships nginx, php-fpm and mysql, so "these are missing" was never true everywhere — it
  // passed on Windows and failed on Linux for a reason that had nothing to do with the code. What
  // must hold on any box is the mapping, and that is the part actually worth testing: a label
  // appears exactly when the row it names reports the thing absent.
  const absent = {
    nginx: !stack.body.nginx.present, 'PHP-FPM': !stack.body.php.endpoint,
    'a database server': !stack.body.db.kind, unzip: !stack.body.unzip,
  }
  check('...and each missing label matches a row that really is absent',
    Object.entries(absent).every(([label, gone]) => stack.body.missing.includes(label) === gone),
    JSON.stringify({ missing: stack.body.missing, absent }))
  check('installing the stack is refused in dry mode',
    (await req('POST', '/api/stack/install')).status === 409)
  // `res.json`, then the SSE route, so a client that skips the POST cannot be left watching a stream
  // that will never say anything.
  const stackStream = await fetch(API + '/api/stack/install/stream', { headers: { cookie } })
  const stackText = await new Response(stackStream.body).text()
  check('...and the stream says nothing is running rather than hanging',
    stackText.includes('no install is running'), JSON.stringify(stackText.slice(0, 120)))

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
    // The root is not optional here, even though the route will invent one. Left off, the site
    // lands on the default `/var/www/nxd` and the route's `mkdirSync` creates a real directory
    // outside the fixture tree — which on Windows became `D:\var\www\nxd` and passed, and on Linux
    // is an EACCES under a root-owned /var/www. Every other site in this file names its root.
    root: path.join(FIX, 'www', 'nxd'),
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

  // ---- the dashboard's own vhost: what happens when a shell command deletes it ----
  // `sites-enabled/nxd.conf` is a symlink into sites-available, and `nginx -t` fails on a dangling
  // include — so one `rm` refuses every write on the box, including the one that would repair it.
  const enNxd = path.join(FIX, 'nginx', 'sites-enabled', 'nxd.conf')
  const selfBefore = fs.readFileSync(selfConf, 'utf8')
  // something unrelated to save, for the checks that a write which has nothing to do with the
  // dashboard's own vhost still puts it back
  check('a bystander site exists to save',
    (await req('POST', '/api/sites', { name: 'bystander', domains: ['bystander.test'], root: path.join(FIX, 'www', 'bystander') })).status === 200)

  fs.rmSync(selfConf, { force: true })
  const dangling = (await req('GET', '/api/sites')).body.sites.find(s => s.name === 'nxd')
  check('a hand-deleted conf reads as enabled-but-missing, not disabled',
    dangling.enabled === true && dangling.drift === 'missing', JSON.stringify(dangling))

  // the save that used to be impossible: the guard read the dangling entry as "disabled" and
  // refused before apply was ever reached, which is what left this state with no way out
  const saveIt = await req('PUT', '/api/sites/nxd', (await req('GET', '/api/sites/nxd')).body.site)
  check('the self vhost can be saved while its conf is missing', saveIt.status === 200, JSON.stringify(saveIt.body))
  check('...and the conf is back byte-for-byte', fs.readFileSync(selfConf, 'utf8') === selfBefore)

  // any write heals it, not only its own
  fs.rmSync(selfConf, { force: true })
  const otherSave = await req('PUT', '/api/sites/bystander', { domains: ['bystander.test'] })
  check('an unrelated save repairs it too', otherSave.status === 200, JSON.stringify(otherSave.body))
  check('...restoring the conf byte-for-byte', fs.readFileSync(selfConf, 'utf8') === selfBefore)
  check('...leaving its symlink alone', fs.existsSync(enNxd))
  check('...and the API reports the rewrite', (await req('GET', '/api/sites')).body.selfRepair?.ok === true)

  // no trace, no heal: a vhost deliberately taken out of sites-enabled stays out of it, and one
  // that never existed is never created — publishing the dashboard on the LAN is not a side effect
  fs.rmSync(selfConf, { force: true })
  fs.rmSync(enNxd, { force: true })
  const afterUnpublish = await req('PUT', '/api/sites/bystander', { domains: ['bystander.test'] })
  check('with the entry gone too, a write does not resurrect the vhost',
    afterUnpublish.status === 200 && !fs.existsSync(selfConf), JSON.stringify(afterUnpublish.body))

  // the one state no trace heals, and the only thing that can reach it
  check('repair is refused for a site that is not this dashboard',
    (await req('POST', '/api/sites/bystander/repair')).status === 403)
  const repaired = await req('POST', '/api/sites/nxd/repair')
  check('repair writes the missing conf back', repaired.status === 200, JSON.stringify(repaired.body))
  check('...byte-for-byte', fs.readFileSync(selfConf, 'utf8') === selfBefore)
  check('...without enabling it', !fs.existsSync(enNxd))
  check('...so enabling after a repair works', (await req('POST', '/api/sites/nxd/enable')).status === 200)
  check('...and it is linked again', fs.existsSync(enNxd))
  check('repair on a conf that is on disk is refused', (await req('POST', '/api/sites/nxd/repair')).status === 400)

  // A repair must leave no undo entry behind — its snapshot's "before" is a file that did not
  // exist, and replaying that would delete the conf it just wrote. History is written by safeApply,
  // which DRY mode never reaches, so that one is asserted in test/e2e.mjs instead.

  // a lost manifest entry is unmanaged, not adopted: /repair only rewrites a conf it can find in
  // the manifest, and Publish is the click that takes it back
  const mPath = path.join(FIX, 'state', 'manifest.json')
  const mLive = JSON.parse(fs.readFileSync(mPath, 'utf8'))
  fs.writeFileSync(mPath, JSON.stringify({ sites: mLive.sites.filter(s => s.name !== 'nxd') }))
  check('with the manifest entry gone it is on disk and unmanaged',
    !!(await req('GET', '/api/sites')).body.sites.find(s => s.name === 'nxd' && !s.managed))
  check('...so repair has nothing to write it from', (await req('POST', '/api/sites/nxd/repair')).status === 404)
  fs.writeFileSync(mPath, JSON.stringify(mLive))

  // ---- the settings file, the new-site defaults, and the second factor ----
  // All of it last, because the overlay below is applied to every site created after it is saved.

  // What a new site is created from. `defaults` is the factory, `create` is that factory with the
  // operator's overlay on it — and the two differ only once something has been saved.
  const cd = await req('GET', '/api/site-defaults?name=fresh')
  check('site-defaults hands back what a new site is created from',
    cd.body.create?.rateLimit?.rps === 50 && cd.body.create.root === '/var/www/fresh' && cd.body.create.name === 'fresh',
    JSON.stringify(cd.body?.create?.rateLimit))

  const settingsPath = path.join(FIX, 'state', 'settings.json')
  const saveDefaults = d => req('PUT', '/api/settings/new-site-defaults', { defaults: d })

  // A typo'd key is the dangerous shape: it reads as a setting that was saved and does nothing,
  // which is how a toggle ends up on screen while the conf emits no directive for it.
  check('a misspelled key in the new-site defaults is refused, and named',
    (await saveDefaults({ gzipp: { enabled: false } })).body.error === 'not a site field: gzipp')
  check('a nested key of the wrong type is refused',
    (await saveDefaults({ gzip: { enabled: 'yes' } })).body.error === 'gzip.enabled must be a boolean')
  check('...and `name` cannot be made a default, which would rename every new site',
    (await saveDefaults({ name: 'evil' })).body.error === 'not a site field: name')
  check('the refusals wrote nothing', !fs.existsSync(settingsPath) || !JSON.parse(fs.readFileSync(settingsPath, 'utf8')).newSiteDefaults)

  check('a valid overlay is saved', (await saveDefaults({ rateLimit: { rps: 80, burst: 150 }, gzip: { enabled: true } })).status === 200)
  const withOverlay = (await req('GET', '/api/site-defaults?name=fresh')).body.create
  check('...and it is what the chip would read',
    withOverlay.rateLimit.rps === 80 && withOverlay.rateLimit.burst === 150 && withOverlay.gzip.enabled === true)
  // Measured against the factory rather than against a count written here: the overlay is merged
  // one level deep, and a list living beside the key that was set is exactly what a shallow merge
  // would drop. Comparing the two lists is the invariant; a magic number would just need editing
  // the next time a MIME type is added.
  check('...without disturbing the fields it did not mention',
    withOverlay.rateLimit.enabled === true &&
    JSON.stringify(withOverlay.gzip.types) === JSON.stringify(cd.body.defaults.gzip.types),
    JSON.stringify(withOverlay.gzip.types))

  const fromOverlay = await req('POST', '/api/sites', { name: 'overlaid', domains: ['overlaid.test'], root: path.join(FIX, 'www', 'overlaid') })
  check('a new site is created from the overlay',
    fromOverlay.body.site?.rateLimit?.rps === 80 && fromOverlay.body.site.rateLimit.burst === 150, JSON.stringify(fromOverlay.body.site?.rateLimit))
  check('...and it reaches the conf',
    fs.readFileSync(path.join(FIX, 'nginx', 'conf.d', '00-dashboard.conf'), 'utf8').includes('zone=overlaid_rl:10m rate=80r/s'))

  // The point of applying it only on create. Saving an existing site must not reinterpret what it
  // already is, or changing a default would silently rewrite every vhost on the box.
  const before = (await req('GET', '/api/sites/overlaid')).body.site
  await saveDefaults({ rateLimit: { rps: 10, burst: 20 } })
  const after = await req('PUT', '/api/sites/overlaid', { domains: ['overlaid.test'] })
  check('an existing site keeps its own values when the default changes',
    after.body.site?.rateLimit?.rps === before.rateLimit.rps, `${before.rateLimit.rps} -> ${after.body.site?.rateLimit?.rps}`)
  check('...even though it was saved after the change', after.status === 200)
  check('cleanup', (await req('DELETE', '/api/sites/overlaid')).body.ok === true)

  check('a bad overlay is a 400, not a 500', (await saveDefaults(['not', 'an', 'object'])).status === 400)
  check('clearing the overlay puts the factory back', (await saveDefaults({})).status === 200 &&
    (await req('GET', '/api/site-defaults?name=fresh')).body.create.rateLimit.rps === 50)

  // The secret is the one thing in this file worth protecting, and it is written tmp-then-rename
  // then chmod'd, so the assertion is about the file that ends up in place, not the one created.
  check('the settings file is not readable by anyone but its owner',
    process.platform === 'win32' || (fs.statSync(settingsPath).mode & 0o777) === 0o600,
    (fs.statSync(settingsPath).mode & 0o777).toString(8))

  // The second factor, end to end: enrolled from a code, demanded at the door, and removable
  // without one — because a lost phone has to be recoverable from the page that turned it on.
  const begun = await req('POST', '/api/settings/2fa/begin')
  check('enrolment hands back a secret and a uri', begun.body.secret?.length === 32 && begun.body.uri.startsWith('otpauth://totp/nxd?secret='), JSON.stringify(begun.body?.uri))
  check('...and nothing is written until a code proves it', !JSON.parse(fs.readFileSync(settingsPath, 'utf8')).totpSecret)
  check('a code that does not match is refused', (await req('POST', '/api/settings/2fa/enable', { code: '000000' })).status === 400)
  check('an enable with no enrolment in progress is refused',
    (await req('POST', '/api/settings/2fa/enable', { code: totp(newSecret()) })).status === 400)
  const reBegun = await req('POST', '/api/settings/2fa/begin')
  check('turning it on takes a code from the secret it just showed',
    (await req('POST', '/api/settings/2fa/enable', { code: totp(reBegun.body.secret) })).body.ok === true)
  check('...and now it is on disk', JSON.parse(fs.readFileSync(settingsPath, 'utf8')).totpSecret === reBegun.body.secret)
  check('...and reported as on, from this dashboard',
    (await req('GET', '/api/settings')).body.totp.source === 'file')

  // The session cookie is already held, so this is the door rather than the room: a fresh login
  // without a code must fail, and the same one with a code must pass.
  const kept = cookie
  cookie = ''
  check('the password alone is no longer enough', (await req('POST', '/api/login', { password: 'testpw' })).status === 401)
  check('...and the form is told to ask for a code', (await req('GET', '/api/login')).body.totp === true)
  check('...and the refusal says which half was wrong',
    (await req('POST', '/api/login', { password: 'testpw' })).body.error === 'wrong code')
  check('the password and a code let the operator in',
    (await req('POST', '/api/login', { password: 'testpw', code: totp(reBegun.body.secret) })).body.ok === true)
  check('...while a wrong password is still a wrong password',
    (await req('POST', '/api/login', { password: 'nope', code: totp(reBegun.body.secret) })).body.error === 'wrong password')
  cookie = kept

  check('turning it off needs the password and refuses the wrong one',
    (await req('POST', '/api/settings/2fa/disable', { password: 'nope' })).status === 403)
  check('...and with it, turns it off', (await req('POST', '/api/settings/2fa/disable', { password: 'testpw' })).body.ok === true)
  check('...removing the secret from disk', !JSON.parse(fs.readFileSync(settingsPath, 'utf8')).totpSecret)
  check('cleanup: the password alone works again',
    (await req('POST', '/api/login', { password: 'testpw' })).body.ok === true)

  // The env var outranks the file, so an install that has always carried its secret in the unit
  // file is untouched — including the panel, which refuses rather than offering a control that the
  // next restart would ignore.
  const envSecret = newSecret()
  const envPort = '3124'
  // Seeded before boot: a manifest written by an older version, holding a basic-auth password in
  // the clear. This is the upgrade path that matters — an operator who installed this because of
  // that file would otherwise keep the plaintext for every site they never edit again.
  const envState = path.join(FIX, 'state-env')
  fs.mkdirSync(path.join(envState, 'history'), { recursive: true })
  fs.writeFileSync(path.join(envState, 'manifest.json'), JSON.stringify({
    sites: [{ name: 'legacy', domains: ['legacy.test'], basicAuth: { enabled: true, users: [{ user: 'old', password: 'oldsecret' }] } }],
  }, null, 2))
  // ...and an undo snapshot holding the manifest as it was, which the boot migration has to reach
  // as well: hashing the live file alone leaves the plaintext behind in state/history for as long
  // as those snapshots take to age out.
  const oldSnap = path.join(envState, 'history', '1700000000000-abc123.json')
  fs.writeFileSync(oldSnap, JSON.stringify({
    at: 1700000000000,
    label: 'a change made before the upgrade',
    files: [{ path: path.join(envState, 'manifest.json'), content: JSON.stringify({ sites: [{ name: 'ancient', basicAuth: { enabled: true, users: [{ user: 'older', password: 'snapshot-secret' }] } }] }, null, 2), link: null }],
  }))
  const second = spawn(process.execPath, [path.join(root, 'server.js')], {
    env: { ...env, DASH_PORT: envPort, DASH_STATE_DIR: path.join(FIX, 'state-env'), DASH_TOTP_SECRET: envSecret },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  try {
    await new Promise(r => { second.stdout.on('data', d => String(d).includes(envPort) && r()); setTimeout(r, 3000) })
    let envCookie = ''
    const envReq = async (method, p, body) => {
      const opts = { method, headers: { ...(envCookie ? { cookie: envCookie } : {}) } }
      if (body !== undefined) { opts.headers['content-type'] = 'application/json'; opts.body = JSON.stringify(body) }
      const res = await fetch(`http://127.0.0.1:${envPort}` + p, opts)
      const setC = res.headers.get('set-cookie')
      if (setC?.includes('sid=')) envCookie = setC.split(';')[0]
      return { status: res.status, body: await res.json().catch(() => ({})) }
    }
    check('the env secret is what this install demands',
      (await envReq('POST', '/api/login', { password: 'testpw' })).status === 401 &&
      (await envReq('POST', '/api/login', { password: 'testpw', code: totp(envSecret) })).body.ok === true)
    check('...and the panel reports it as owned by the unit',
      (await envReq('GET', '/api/settings')).body.totp.source === 'env')
    check('...and the sign-in form asks for a code for it too', (await envReq('GET', '/api/login')).body.totp === true)
    check('...so enrol, enable and disable all refuse the panel rather than lying',
      (await envReq('POST', '/api/settings/2fa/begin')).status === 409 &&
      (await envReq('POST', '/api/settings/2fa/enable', { code: '000000' })).status === 409 &&
      (await envReq('POST', '/api/settings/2fa/disable', { password: 'testpw' })).status === 409)
    check('...leaving it on', (await envReq('GET', '/api/settings')).body.totp.enabled === true)

    // The boot migration, against the file this process just wrote over.
    const migrated = fs.readFileSync(path.join(envState, 'manifest.json'), 'utf8')
    const legacyRow = JSON.parse(migrated).sites.find(s => s.name === 'legacy')?.basicAuth?.users?.[0] || {}
    check('a plaintext password in an existing manifest is hashed at boot',
      !migrated.includes('oldsecret') && /^\$apr1\$/.test(legacyRow.hash || ''), JSON.stringify(legacyRow))
    // ...and the file nginx reads was rewritten to match, so the two cannot disagree about a user.
    check('...with the password file rewritten to the same hash',
      fs.readFileSync(path.join(FIX, 'htpasswd', 'legacy'), 'utf8') === `old:${legacyRow.hash}\n`)

    // ...including in the undo snapshots, which are the copies an operator would not think to look
    // in. Asserted with a hash present, not merely the plaintext absent: empty would pass that too.
    const snapText = fs.readFileSync(oldSnap, 'utf8')
    check('...and the same is done to the manifest inside the undo history',
      !snapText.includes('snapshot-secret') && /^\$apr1\$/.test(JSON.parse(JSON.parse(snapText).files[0].content).sites[0].basicAuth.users[0].hash || ''),
      snapText.slice(0, 120))
  } finally {
    second.kill()
  }
  fs.rmSync(path.join(FIX, 'state-env'), { recursive: true, force: true })

  // last: five wrong passwords lock the address out, so nothing may need to log in after this
  for (let i = 0; i < 5; i++) await req('POST', '/api/login', { password: 'nope' })
  const locked = await req('POST', '/api/login', { password: 'testpw' })
  check('the sixth attempt is refused outright', locked.status === 429, `${locked.status} ${JSON.stringify(locked.body)}`)
  check('...for the right password too', locked.body.error.includes('too many failed logins'))
  check('...while the session already held still works', (await req('GET', '/api/sites')).status === 200)
} finally {
  server.kill()
}

// A password printed in this repository must not start a dashboard. This is the one check that has
// to run against a process that never binds, so it is a spawn of its own rather than a request.
async function boot(pw, extra = {}) {
  const p = spawn(process.execPath, [path.join(root, 'server.js')],
    { env: { ...env, DASH_PORT: '3124', DASH_PASSWORD: pw, ...extra }, stdio: ['ignore', 'pipe', 'pipe'] })
  let err = ''
  p.stderr.on('data', d => { err += d })
  const code = await new Promise(r => { p.on('exit', r); setTimeout(() => { p.kill(); r('still running') }, 5000) })
  return { code, err }
}

const placeholder = await boot('change-me')
check('the placeholder from the shipped unit refuses to start',
  placeholder.code === 1 && placeholder.err.includes('placeholder'), `${placeholder.code} ${placeholder.err.slice(0, 80)}`)
check('...and so does a password of "demo"', (await boot('demo')).code === 1)

// ...but DASH_DEMO=1 is the deliberate way past it. Asserted as "has not exited" rather than by
// waiting for a bind: a slow start on a loaded box would otherwise read as a refusal.
const demoRun = spawn(process.execPath, [path.join(root, 'server.js')],
  { env: { ...env, DASH_PORT: '3124', DASH_PASSWORD: 'demo', DASH_DEMO: '1' }, stdio: ['ignore', 'pipe', 'pipe'] })
let demoErr = ''
demoRun.stderr.on('data', d => { demoErr += d })
await new Promise(r => setTimeout(r, 1200))
check('...while DASH_DEMO=1 starts anyway, which is what npm run demo uses',
  demoRun.exitCode === null && !demoErr.includes('placeholder'), demoErr.slice(0, 80))
demoRun.kill()

console.log(failed ? `\n${failed} of ${ran} FAILED` : `\nall ${ran} checks passed`)
process.exit(failed ? 1 : 0)