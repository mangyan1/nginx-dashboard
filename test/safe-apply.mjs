// Covers safeApply itself — the pipeline smoke.mjs never reaches, because DASH_DRY=1
// routes every mutation to safeApplyDry.
// Run: node test/safe-apply.mjs
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const D = path.join(path.dirname(fileURLToPath(import.meta.url)), 'probe-safeapply')
fs.rmSync(D, { recursive: true, force: true })
fs.mkdirSync(D, { recursive: true })

// Repoint every dashboard path at the probe dir BEFORE importing the libs — this test
// deletes the state dir, and on a real server that would be /var/lib/nginx-dashboard.
process.env.DASH_NGINX_DIR = path.join(D, 'nginx')
process.env.DASH_STATE_DIR = path.join(D, 'state')
process.env.DASH_LOG_DIR = path.join(D, 'logs')
// Read at module load, so it has to be set before the import — and it makes this suite the one
// place the self-vhost guards are exercised outside a running server.
process.env.DASH_SELF_NAME = 'nxd'
const { safeApply, hooks, MANIFEST, HTTP_CONF, PATHS, listHistory, revertHistory, clearHistory, scrubHistoryPasswords, listNginxFiles, readNginxConf } = await import('../lib/nginx.js')
const {
  SELF_NAME, isSelf, defaultSite, renderSiteConf, validateSite, siteConfPath, driftOf, httpConfDrift,
  renderHttpConf, readManifest, parseManifest, selfSiteErrors, selfSiteWarnings, selfRevertErrors,
  docrootRemovalRefusal,
  writeHtpasswd, htpasswdPath, hashUserRows,
} = await import('../lib/manifest.js')
const { b32encode, b32decode, totp, totpValid, newSecret, otpauth } = await import('../lib/totp.js')

const realRun = hooks.run
// `hooks.run` is stubbed throughout this suite so the pipeline can be driven without nginx. The
// hashing tests need the real process back: openssl's output *is* what they assert on, and a stub
// returning an empty hash passes a "no plaintext stored" check while proving nothing at all.
const withRealShell = async fn => {
  const stubbed = hooks.run
  hooks.run = realRun
  try { return await fn() } finally { hooks.run = stubbed }
}
let failed = 0
let ran = 0
const check = (name, cond, extra = '') => {
  ran++
  if (!cond) failed++
  console.log(`  ${cond ? 'ok  ' : 'FAIL'} ${name}${cond ? '' : `  ${extra}`}`)
}

// nginx -t succeeds / reload succeeds
const passNginx = async (cmd, args) => (
  args.includes('-t')
    ? { stdout: '', stderr: 'syntax is ok\nsyntax is ok\ntest is successful', status: 0 }
    : { stdout: '', stderr: '', status: 0 }
)
// nginx -t rejects the new config
const failTest = async (cmd, args) => (
  args.includes('-t')
    ? { stdout: '', stderr: 'nginx: [emerg] unknown directive "bogus"', status: 1 }
    : { stdout: '', stderr: '', status: 0 }
)
// config tests clean but the running master refuses the reload
const failReload = async (cmd, args) => (
  args.includes('reload')
    ? { stdout: '', stderr: 'nginx: [error] invalid PID number', status: 1 }
    : { stdout: '', stderr: 'test is successful', status: 0 }
)

const conf = path.join(D, 'site.conf')
const extra = path.join(D, 'extra.conf')
const ORIG = { [conf]: 'ORIGINAL CONF\n', [extra]: 'ORIGINAL EXTRA\n' }
const seed = () => { for (const [f, v] of Object.entries(ORIG)) fs.writeFileSync(f, v) }
const read = f => fs.readFileSync(f, 'utf8')

// ---- 1. success path: files kept, nothing restored ----
hooks.run = passNginx
seed()
let r = await safeApply([conf, extra], () => { fs.writeFileSync(conf, 'NEW CONF\n') })
check('success reports ok', r.ok, JSON.stringify(r))
check('success keeps the new content', read(conf) === 'NEW CONF\n')

// ---- 2. failure path: byte-for-byte restore + verbatim error ----
hooks.run = failTest
seed()
r = await safeApply([conf, extra], () => { fs.writeFileSync(conf, 'NEW CONF\n'); fs.writeFileSync(extra, 'NEW EXTRA\n') })
check('failure reports not-ok', !r.ok)
check('failure surfaces the nginx stderr', String(r.output).includes('unknown directive "bogus"'), r.output)
check('failure restores the mutated file', read(conf) === ORIG[conf], read(conf))
check('failure restores the untouched file', read(extra) === ORIG[extra])

// ---- 3. a file that did not exist is removed on rollback, not left behind ----
const fresh = path.join(D, 'fresh.conf')
fs.rmSync(fresh, { force: true })
hooks.run = failTest
seed()
await safeApply([conf, fresh], () => { fs.writeFileSync(fresh, 'SHOULD NOT SURVIVE\n') })
check('failure deletes a newly created file', !fs.existsSync(fresh))

// ---- 4. mutate() throwing is caught, rolled back, and the message surfaced ----
hooks.run = passNginx
seed()
r = await safeApply([conf], () => { throw new Error('openssl passwd failed') })
check('mutate throw is caught', !r.ok && String(r.output).includes('openssl passwd failed'), JSON.stringify(r))
check('mutate throw still rolls back', read(conf) === ORIG[conf])

// ---- 4b. a failed reload rolls back too: disk must match what nginx is actually running ----
hooks.run = failReload
seed()
r = await safeApply([conf], () => { fs.writeFileSync(conf, 'NEW CONF\n') })
check('failed reload reports not-ok', !r.ok && String(r.output).includes('invalid PID number'), JSON.stringify(r))
check('failed reload restores the file', read(conf) === ORIG[conf], read(conf))

// ---- 4c. an async mutate is awaited, not fired ----
// The routes hash passwords with openssl inside mutate(), so the pipeline has to wait for it:
// nginx -t must see the writes, and a throw after the yield must be caught — not become an
// unhandled rejection that kills the process while the files stay half-written.
hooks.run = passNginx
seed()
let sawAtTest = null
const probe = async (cmd, args) => {
  if (args.includes('-t')) sawAtTest = read(conf)
  return passNginx(cmd, args)
}
hooks.run = probe
let asyncDone = false
r = await safeApply([conf], async () => {
  await Promise.resolve() // the write lands after the event loop turns, not inside mutate()'s call
  fs.writeFileSync(conf, 'NEW CONF\n')
  asyncDone = true
})
check('nginx -t runs after an async mutate\'s writes, not during them',
  r.ok && sawAtTest === 'NEW CONF\n' && asyncDone, JSON.stringify({ r, sawAtTest }))

hooks.run = failTest
seed()
r = await safeApply([conf], async () => {
  await Promise.resolve()
  fs.writeFileSync(conf, 'NEW CONF\n')
  throw new Error('openssl passwd failed')
})
check('an async mutate that throws is caught, not an unhandled rejection',
  !r.ok && String(r.output).includes('openssl passwd failed'), JSON.stringify(r))
check('...and its writes are rolled back', read(conf) === ORIG[conf], read(conf))

// ---- 5. regression: MANIFEST must be inside the transaction ----
// server.js writes the manifest from inside mutate(); if it is not listed in `files`, a
// failed nginx -t rolls back the conf but keeps the manifest change (a phantom site).
hooks.run = failTest
fs.rmSync(PATHS.stateDir, { recursive: true, force: true })
fs.mkdirSync(PATHS.stateDir, { recursive: true })
const manifest = '{"sites":[{"name":"before"}]}\n'
fs.writeFileSync(MANIFEST, manifest)
const inTx = await safeApply([conf, MANIFEST], () => {
  fs.writeFileSync(conf, 'NEW CONF\n')
  fs.writeFileSync(MANIFEST, '{"sites":[{"name":"before"},{"name":"phantom"}]}\n')
})
check('rollback reverts the manifest too', read(MANIFEST) === manifest, read(MANIFEST))

// and prove the bug is real when MANIFEST is left out, so this check can never silently pass
fs.writeFileSync(MANIFEST, manifest)
await safeApply([conf], () => {
  fs.writeFileSync(conf, 'NEW CONF\n')
  fs.writeFileSync(MANIFEST, '{"sites":[{"name":"before"},{"name":"phantom"}]}\n')
})
check('omitting MANIFEST from files really does leak (guards the guard)', read(MANIFEST) !== manifest)

// ---- 6. the renderer refuses to emit a duplicate upstream name across two sites ----
const mk = n => ({
  ...defaultSite(n), domains: [`${n}.test`],
  upstreams: [{ name: 'backends', algorithm: 'round_robin', healthCheck: false, servers: [{ scheme: 'http', host: '10.0.0.1', port: 3000 }] }],
  proxy: [{ path: '/', target: 'upstream:backends' }],
})
const a = renderSiteConf(mk('a'))
const b = renderSiteConf(mk('b'))
check('site A proxies its own namespaced upstream', a.includes('proxy_pass http://a_backends;'), a.split('\n').find(l => l.includes('proxy_pass')))
check('site B proxies its own namespaced upstream', b.includes('proxy_pass http://b_backends;'), b.split('\n').find(l => l.includes('proxy_pass')))

// ---- 7. invalid fields are rejected before they can reach a conf ----
const bad = { ...defaultSite('x'), domains: ['ok.test'], port: 80, upstreams: [{ name: 'p', algorithm: 'round_robin', servers: [{ scheme: 'http', host: '10.0.0.9', port: '3000;\n}\nserver { root /etc; }' }] }] }
check('injection-shaped backend port rejected', validateSite(bad).some(e => e.includes('invalid backend port')), JSON.stringify(validateSite(bad)))
const badDomain = { ...defaultSite('x'), domains: ['ok.test; }'] }
check('injection-shaped domain rejected', validateSite(badDomain).some(e => e.includes('invalid domain')))
const dangling = { ...defaultSite('x'), domains: ['ok.test'], proxy: [{ path: '/', target: 'upstream:ghost' }] }
check('dangling upstream reference rejected', validateSite(dangling).some(e => e.includes('unknown upstream')), JSON.stringify(validateSite(dangling)))
check('a clean site passes validation', validateSite({ ...defaultSite('x'), domains: ['ok.test'], upstreams: mk('x').upstreams, proxy: mk('x').proxy }).length === 0, JSON.stringify(validateSite({ ...defaultSite('x'), domains: ['ok.test'], upstreams: mk('x').upstreams, proxy: mk('x').proxy })))
const badRoot = { ...defaultSite('x'), domains: ['ok.test'], root: '/var/www/x; }\nserver { root /etc;' }
check('injection-shaped docroot rejected', validateSite(badRoot).some(e => e.includes('invalid document root')), JSON.stringify(validateSite(badRoot)))

// ---- 7b. the dynamic-backend surface ----
// fastcgi_pass and `index` are emitted verbatim, so their validators are the only thing between
// the form and a conf file.
for (const endpoint of ['unix:/run/php/fpm.sock; }', 'unix:/run/php/fpm.sock\n', '127.0.0.1:9000; }', 'unix:relative.sock', '$(id)', '']) {
  const s = { ...defaultSite('x'), domains: ['ok.test'], php: { enabled: true, endpoint, frontController: true } }
  check(`fastcgi endpoint rejected: ${JSON.stringify(endpoint)}`, validateSite(s).some(e => e.includes('invalid fastcgi endpoint')), JSON.stringify(validateSite(s)))
}
const fpm = e => ({ ...defaultSite('x'), domains: ['ok.test'], php: { enabled: true, endpoint: e, frontController: false } })
check('a unix socket endpoint is accepted', validateSite(fpm('unix:/run/php/php8.3-fpm.sock')).length === 0, JSON.stringify(validateSite(fpm('unix:/run/php/php8.3-fpm.sock'))))
check('a host:port endpoint is accepted', validateSite(fpm('127.0.0.1:9000')).length === 0, JSON.stringify(validateSite(fpm('127.0.0.1:9000'))))

const badIndex = { ...defaultSite('x'), domains: ['ok.test'], index: 'index.php; }' }
check('injection-shaped index rejected', validateSite(badIndex).some(e => e.includes('invalid index entry')), JSON.stringify(validateSite(badIndex)))
check('empty index rejected', validateSite({ ...defaultSite('x'), domains: ['ok.test'], index: '   ' }).some(e => e.includes('index needs')))
check('colliding http/https port rejected', validateSite({ ...defaultSite('x'), domains: ['ok.test'], port: 8443, httpsPort: 8443, https: { mode: 'selfsigned' } }).some(e => e.includes('must differ')))
check('site with no listener rejected', validateSite({ ...defaultSite('x'), domains: ['ok.test'], serveHttp: false, https: { mode: 'none' } }).some(e => e.includes('nothing to serve')))
const noName = { ...defaultSite('x'), root: '/var/www/x' }
check('a domainless site is valid and answers to _',
  validateSite(noName).length === 0 && renderSiteConf(noName).includes('server_name _;'), JSON.stringify(validateSite(noName)))

// the shape this was written for: WordPress behind php-fpm on a non-443 TLS port
const wp = {
  ...defaultSite('mixradio'),
  domains: ['mixviberadio.com'],
  root: '/var/www/html/mixradio/wordpress',
  index: 'index.php index.html',
  httpsPort: 44306,
  https: { mode: 'selfsigned', forceRedirect: true, manualCert: '', manualKey: '' },
  listen: { http2: false, http3: true, reuseport: true },
  php: { enabled: true, endpoint: 'unix:/run/php/php8.3-fpm.sock', frontController: true },
}
check('wordpress config validates', validateSite(wp).length === 0, JSON.stringify(validateSite(wp)))
const wpConf = renderSiteConf(wp)
check('tls listener on the custom port', wpConf.includes('listen 44306 ssl reuseport;'), wpConf)
check('quic listener carries reuseport too', wpConf.includes('listen 44306 quic reuseport;'), 'both listeners of one port need it')
check('alt-svc names the custom port', wpConf.includes(`Alt-Svc 'h3=":44306"`))
check('redirect names the custom port', wpConf.includes('return 301 https://$host:44306$request_uri;'), 'a bare $host would bounce to a dead 443')
check('index order is the configured one', wpConf.includes('index index.php index.html;'))
check('fastcgi block', wpConf.includes('location ~ [^/]\\.php(/|$) {') && wpConf.includes('fastcgi_pass unix:/run/php/php8.3-fpm.sock;'))
check('the script is checked for existence before fastcgi_pass',
  wpConf.indexOf('try_files $fastcgi_script_name =404;') < wpConf.indexOf('fastcgi_pass'),
  'a nonexistent .php path must 404, not reach the interpreter')
check('front controller is emitted before the php block',
  wpConf.includes('try_files $uri $uri/ /index.php?$query_string;') && wpConf.indexOf('location / {') < wpConf.indexOf('location ~ [^/]\\.php'))
check('php block precedes the static-cache regex', wpConf.indexOf('location ~ [^/]\\.php') < wpConf.indexOf('location ~* \\.('), 'regex locations match in order')
check('dotfiles denied, well-known left open', wpConf.includes('location ~ /\\.(?!well-known) {') && wpConf.includes('deny all;'))
check('tls session hardening', wpConf.includes('ssl_session_tickets off;') && wpConf.includes('ssl_prefer_server_ciphers off;') && wpConf.includes('shared:dash_ssl'))
check('nothing hardcodes 443', !/listen 443[ ;]/.test(wpConf), (wpConf.match(/listen[^;]*/g) || []).join(' | '))
check('tls-only drops the plain-http block', !renderSiteConf({ ...wp, serveHttp: false }).includes('listen 80;'))
check('front controller yields to a root proxy rule',
  !renderSiteConf({ ...wp, proxy: [{ path: '/', target: 'http://127.0.0.1:8080' }] }).includes('try_files $uri $uri/ /index.php'),
  'two location / blocks in one server would fail nginx -t')

// ---- 7c. a manifest written before these fields existed ----
// The renderer dereferences php/httpsPort/index directly, so readManifest has to fill them in or
// an upgrade turns every existing site into `listen undefined ssl;`.
fs.writeFileSync(MANIFEST, JSON.stringify({
  sites: [{
    name: 'legacy', domains: ['legacy.test'], root: '/var/www/legacy', port: 80,
    https: { mode: 'none', forceRedirect: false },
    listen: { http2: false, http3: false },
    rateLimit: { enabled: false, rps: 10, burst: 20 },
    ipRules: { mode: 'none', ips: [] }, basicAuth: { enabled: false, users: [] },
    gzip: { enabled: true, types: ['text/css'] },
    staticCache: { enabled: true, extensions: ['css'], expiresDays: 30 },
  }],
}))
const legacy = readManifest().sites[0]
check('an old manifest is filled in on read', legacy.php?.enabled === false && legacy.httpsPort === 443 && legacy.serveHttp === true && legacy.index === 'index.html index.htm' && legacy.listen.reuseport === false, JSON.stringify(legacy))
check('an old manifest still renders', renderSiteConf(legacy).includes('listen 80;') && !renderSiteConf(legacy).includes('undefined'), renderSiteConf(legacy))
fs.writeFileSync(MANIFEST, '{"sites":[]}\n')

// The form's verify/CA pair has to survive the round-trip through the manifest, or the switch would
// look saved and write nothing — readManifest normalises every site, and a normaliser that rebuilds
// a proxy row from `path`/`target` alone would drop both fields silently.
fs.writeFileSync(MANIFEST, JSON.stringify({
  sites: [{ ...defaultSite('v'), domains: ['v.test'], proxy: [{ path: '/', target: 'https://10.0.0.2:8443', verify: true, ca: '/etc/ssl/private/own-ca.pem' }] }],
}))
const rt = readManifest().sites[0].proxy[0]
check('a proxy rule keeps its verify flag and CA across a read',
  rt.verify === true && rt.ca === '/etc/ssl/private/own-ca.pem', JSON.stringify(rt))
fs.writeFileSync(MANIFEST, '{"sites":[]}\n')

// ---- 8. a proxy rule must not drop the docroot ----
// Emitting only the proxy locations left the site with no `root`, so every other path fell
// through to nginx's compiled-in default root and served its stock welcome page.
const withProxy = renderSiteConf({ ...mk('p'), root: '/var/www/p', proxy: [{ path: '/api', target: 'http://10.0.0.1:8080' }] })
check('proxy site still emits its docroot', withProxy.includes('root /var/www/p;'), withProxy)
check('proxy site still emits a proxy location', withProxy.includes('location /api {'), withProxy)
check('static-cache block survives alongside a proxy rule', withProxy.includes('expires 30d;'), withProxy)

// ---- 8b. the static fallback, the body limit, and HSTS ----
// A static generator that writes `about.html` for `/about` 404s under a bare root + index.
// The fallback has to appear once per server block and stand down for anything else wanting `/`.
const plain = { ...defaultSite('s'), domains: ['s.test'], root: '/var/www/s' }
const sConf = renderSiteConf(plain)
const sTls = renderSiteConf({ ...plain, https: { mode: 'selfsigned', forceRedirect: false, manualCert: '', manualKey: '' } })
check('a static site resolves /about from about.html', sConf.includes('try_files $uri $uri/ $uri.html =404;'), sConf)
check('exactly one location / when nothing else claims it', (sConf.match(/location \/ \{/g) || []).length === 1, sConf)
check('a root proxy rule replaces the static fallback',
  !renderSiteConf({ ...plain, proxy: [{ path: '/', target: 'http://127.0.0.1:8080' }] }).includes('$uri.html'), 'two location / blocks would fail nginx -t')
check('so does a php front controller',
  !renderSiteConf({ ...plain, php: { enabled: true, endpoint: 'unix:/run/php/php8.3-fpm.sock', frontController: true } }).includes('$uri.html'))
check('a non-root proxy rule keeps it',
  renderSiteConf({ ...plain, proxy: [{ path: '/api', target: 'http://127.0.0.1:8080' }] }).includes('$uri.html'), 'the rest of the docroot still has to resolve')

check('the body limit is absent by default', !sConf.includes('client_max_body_size'), 'nginx keeps its own 1m')
check('the body limit is emitted in MB', renderSiteConf({ ...plain, clientMaxBodySize: 64 }).includes('client_max_body_size 64m;'))

// HSTS is the one directive that has to be written twice: `add_header` does not merge into a
// location that declares one of its own, and the static-cache block declares Cache-Control.
const tls = { mode: 'selfsigned', forceRedirect: false, manualCert: '', manualKey: '' }
const hsts = { enabled: true, maxAge: 31536000, includeSubDomains: true, preload: false }
const dual = { ...plain, https: tls, hsts, clientMaxBodySize: 64 }
const hConf = renderSiteConf(dual)
const [httpBlock, tlsBlock] = hConf.split('server {').slice(1)
check('the body limit lands in both blocks', (hConf.match(/client_max_body_size 64m;/g) || []).length === 2, hConf)
check('hsts is emitted on the tls listener', tlsBlock.includes('add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;'), tlsBlock)
check('hsts is repeated inside the static-cache location',
  (tlsBlock.match(/Strict-Transport-Security/g) || []).length === 2, 'add_header does not inherit past a location that sets its own')
check('...and the repeat is inside that location, not after it',
  tlsBlock.indexOf('Strict-Transport-Security', tlsBlock.indexOf('Cache-Control')) < tlsBlock.indexOf('}', tlsBlock.indexOf('Cache-Control')),
  'emitted past the closing brace it would land at server scope and silently do nothing')
check('the plain-http block carries no hsts', !httpBlock.includes('Strict-Transport-Security'), 'the header is ignored over http, so the cache location there must not claim it either')
check('...and that block really did render a cache location', httpBlock.includes('Cache-Control'), 'otherwise the check above passes for the wrong reason')
check('preload rides along when asked', renderSiteConf({ ...dual, hsts: { ...hsts, preload: true } }).includes('max-age=31536000; includeSubDomains; preload"'))
check('hsts is off unless turned on', !sTls.includes('Strict-Transport-Security'))
check('hsts on a site with no certificate is not emitted', !renderSiteConf({ ...plain, hsts }).includes('Strict-Transport-Security'), 'ignored on http, so emitting it would misdescribe the site')

check('a body limit over 10 GB is rejected', validateSite({ ...plain, clientMaxBodySize: 20000 }).some(e => e.includes('invalid max request body')))
check('a negative body limit is rejected', validateSite({ ...plain, clientMaxBodySize: -1 }).some(e => e.includes('invalid max request body')))
check('a fractional body limit is rejected', validateSite({ ...plain, clientMaxBodySize: 1.5 }).some(e => e.includes('invalid max request body')))
check('preload without subdomains is rejected', validateSite({ ...dual, hsts: { enabled: true, maxAge: 31536000, includeSubDomains: false, preload: true } }).some(e => e.includes('preload requires includeSubDomains')))
check('preload under a year is rejected', validateSite({ ...dual, hsts: { enabled: true, maxAge: 86400, includeSubDomains: true, preload: true } }).some(e => e.includes('preload requires a max-age')))
check('a preload-ready site validates', validateSite({ ...dual, hsts: { ...hsts, preload: true } }).length === 0, JSON.stringify(validateSite({ ...dual, hsts: { ...hsts, preload: true } })))

// ---- 9. history: a change that *succeeded* and turned out to be wrong ----
// Sections 1-5 prove a failed change rolls back. That leaves the case this exists for: nginx
// accepted it, it is live, and it was the wrong change. Nothing else can undo that.
hooks.run = passNginx
fs.rmSync(path.join(PATHS.stateDir, 'history'), { recursive: true, force: true })
seed()
fs.writeFileSync(conf, 'GOOD CONF\n')
r = await safeApply([conf], () => { fs.writeFileSync(conf, 'WORSE CONF\n') }, { label: 'break it' })
check('the successful change reports ok', r.ok, JSON.stringify(r))
check('history has the change', listHistory().length === 1 && listHistory()[0].label === 'break it', JSON.stringify(listHistory()))
check('history names the file it touched', listHistory()[0].paths.includes(conf), JSON.stringify(listHistory()[0].paths))

const undo = await revertHistory(listHistory()[0].id)
check('revert reports ok', undo.ok, JSON.stringify(undo))
check('revert restored the previous content', read(conf) === 'GOOD CONF\n', read(conf))
check('the revert is itself undoable', listHistory().length === 2 && listHistory()[0].label === 'undo: break it', JSON.stringify(listHistory().map(h => h.label)))
check('undo of the undo puts the change back', (await revertHistory(listHistory()[0].id)).ok && read(conf) === 'WORSE CONF\n', read(conf))
check('the label is not trusted as a path', !(await revertHistory('../../etc/passwd')).ok && !(await revertHistory('nope.json')).ok)
check('a corrupt entry is not fatal to the list', (() => {
  fs.writeFileSync(path.join(PATHS.stateDir, 'history', '1700000000000-0000ff.json'), '{ truncated')
  const l = listHistory()
  fs.rmSync(path.join(PATHS.stateDir, 'history', '1700000000000-0000ff.json'), { force: true })
  return l.length === 3 && l.every(e => e.label)
})(), JSON.stringify(listHistory().map(h => h.label)))

// a change that was rejected never happened, so it must not be offered for undo
const before = listHistory().length
hooks.run = failTest
seed()
await safeApply([conf], () => { fs.writeFileSync(conf, 'NEW CONF\n') }, { label: 'rejected' })
check('a rejected change records nothing', listHistory().length === before, JSON.stringify(listHistory().map(h => h.label)))

// ---- 10. history must remember a symlink as a symlink ----
// sites-enabled/*.conf is a symlink pointing at sites-available. readFileSync follows it, so a
// backup that stores text restores a plain copy of the target — the site keeps serving, then
// silently stops tracking the conf it is supposed to be a view of.
hooks.run = passNginx
const link = path.join(D, 'enabled.conf')
fs.rmSync(link, { force: true })
fs.writeFileSync(conf, 'REAL CONF\n')
fs.symlinkSync(conf, link, 'file')
r = await safeApply([link], () => fs.rmSync(link, { force: true }), { label: 'disable' })
check('disabling through the link reports ok', r.ok && !fs.existsSync(link), JSON.stringify(r))
check('undo brings the link back', (await revertHistory(listHistory()[0].id)).ok)
check('...as a symlink, not a copy', fs.lstatSync(link).isSymbolicLink() && fs.readlinkSync(link) === conf, String(fs.lstatSync(link).isSymbolicLink()))
check('...and the real conf was never rewritten', read(conf) === 'REAL CONF\n', read(conf))

// ---- 11. retention: keep the newest, drop the oldest ----
hooks.run = passNginx
fs.rmSync(path.join(PATHS.stateDir, 'history'), { recursive: true, force: true })
seed()
for (let i = 0; i < 22; i++) await safeApply([conf], () => fs.writeFileSync(conf, `CONF ${i}\n`), { label: `change ${i}` })
const kept = listHistory()
check('retention keeps the newest 20', kept.length === 20, String(kept.length))
check('retention drops the oldest, not the newest', kept[0].label === 'change 21' && kept.at(-1).label === 'change 2', `${kept[0].label} .. ${kept.at(-1).label}`)
check('the oldest snapshots are gone from disk', !kept.some(e => e.label === 'change 0' || e.label === 'change 1'))

// ---- 11b. clearing the history ----
const histPath = path.join(PATHS.stateDir, 'history')

// ---- 11c. the snapshots behind the manifest ----
// Hashing the manifest fixes the file the dashboard reads, but the twenty snapshots hold the
// manifest as it *was* — so a box that upgraded would keep the plaintext in state/history for as
// long as those took to age out, which is exactly the file an operator worried about this opens.
{
  await withRealShell(async () => {
    const snap = path.join(histPath, '1700000000000-abcdef.json')
    fs.mkdirSync(histPath, { recursive: true })
    fs.writeFileSync(snap, JSON.stringify({
      at: 1700000000000,
      label: 'legacy snapshot',
      files: [{ path: MANIFEST, content: JSON.stringify({ sites: [{ name: 'legacy', basicAuth: { enabled: true, users: [{ user: 'old', password: 'oldsecret' }] } }] }, null, 2), link: null }],
    }))
    check('a plaintext password in a history snapshot is hashed',
      (await scrubHistoryPasswords(hashUserRows)) === 1 && !fs.readFileSync(snap, 'utf8').includes('oldsecret'))
    const replayed = JSON.parse(JSON.parse(fs.readFileSync(snap, 'utf8')).files[0].content)
    const row = replayed.sites[0].basicAuth.users[0]
    // Re-derived from the password and the salt already in the hash, by openssl itself: the only
    // check that proves the stored hash unlocks the same password rather than merely looking like
    // one. A revert replays this snapshot, so a different password here would be a lockout.
    const rederived = (await realRun('openssl', ['passwd', '-apr1', '-salt', String(row.hash || '').split('$')[2], 'oldsecret'])).stdout.trim()
    check('...to a hash that still verifies that same password, so a revert is unaffected',
      /^\$apr1\$/.test(row.hash || '') && rederived === row.hash, `${row.hash} vs ${rederived}`)
    check('...leaving the snapshot one revertHistory would replay', replayed.sites[0].name === 'legacy' && !!replayed.sites.length)
    check('...and a second pass finds nothing left to do', (await scrubHistoryPasswords(hashUserRows)) === 0)
    fs.rmSync(snap, { force: true })
  })
}

// Every snapshot carries the manifest, and the manifest names every upstream backend — the internal
// network map — so this is not housekeeping, it is the thing an operator about to hand the box over
// needs. It also has to survive being asked twice, and being asked when there is nothing there.
const beforeClear = listHistory().length
clearHistory()
check('clearing the history empties it', beforeClear === 20 && listHistory().length === 0, String(beforeClear))
check('...taking every file with it', fs.readdirSync(histPath).length === 0, fs.readdirSync(histPath).join(','))
check('...and clearing nothing is not an error', (clearHistory(), listHistory().length === 0))

// ---- 12. drift: the conf on disk is not the one this manifest generates ----
// Nothing parses a conf back, so without this a hand-edit is silently overwritten by the next
// click and the user never learns it happened.
fs.mkdirSync(PATHS.sitesAvail, { recursive: true })
const drifted = { ...defaultSite('drift'), domains: ['drift.test'] }
fs.writeFileSync(siteConfPath('drift'), renderSiteConf(drifted))
check('a conf we just generated is not drift', driftOf(drifted) === null, String(driftOf(drifted)))
check('a whitespace-level edit counts', (fs.appendFileSync(siteConfPath('drift'), '\n'), driftOf(drifted) === 'modified'), String(driftOf(drifted)))
fs.rmSync(siteConfPath('drift'), { force: true })
check('a manifest entry with no conf is flagged', driftOf(drifted) === 'missing', String(driftOf(drifted)))
fs.writeFileSync(siteConfPath('drift'), renderSiteConf({ ...drifted, port: 8080 }))
check('a conf generated from a *different* site is flagged', driftOf(drifted) === 'modified', String(driftOf(drifted)))

fs.rmSync(HTTP_CONF, { force: true })
fs.mkdirSync(path.dirname(HTTP_CONF), { recursive: true })
check('the shared http conf is flagged when absent', httpConfDrift([]) === true)
fs.writeFileSync(HTTP_CONF, renderHttpConf([]))
check('...and not when it matches', httpConfDrift([]) === false)
fs.appendFileSync(HTTP_CONF, '# hand edit\n')
check('...and flagged again once touched', httpConfDrift([]) === true)

// ---- 13. the dashboard's own vhost ----
// A site whose absence locks the operator out of the UI that manages every other site. The
// guards are semantic — "does this still reach the dashboard" — so they are tested on intent
// rather than on fields: every case below passes `nginx -t` and still leaves the UI unreachable.
const nx = { ...defaultSite('nxd'), domains: ['dash.test'], proxy: [{ path: '/', target: 'http://127.0.0.1:3000' }] }
const at = { host: '127.0.0.1', port: 3000, enabled: true }
const errsOf = s => selfSiteErrors(s, at)

check('SELF_NAME is read from the environment', SELF_NAME === 'nxd' && isSelf('nxd') && !isSelf('dashboard'))
check('a self site pointed at the dashboard is accepted', errsOf(nx).length === 0, errsOf(nx).join(' | '))
for (const [name, host, target] of [
  ['via localhost', '127.0.0.1', 'http://localhost:3000'],
  ['via [::1]', '127.0.0.1', 'http://[::1]:3000'],
  ['via the configured host', '192.168.1.10', 'http://192.168.1.10:3000'],
]) {
  const e = selfSiteErrors({ ...nx, proxy: [{ path: '/', target }] }, { ...at, host })
  check(`...including ${name}`, e.length === 0, e.join(' | '))
}
check('a missing / rule is refused', errsOf({ ...nx, proxy: [{ path: '/api', target: 'http://127.0.0.1:3000' }] }).length === 1)
check('the wrong port is refused', errsOf({ ...nx, proxy: [{ path: '/', target: 'http://127.0.0.1:9999' }] }).some(e => e.includes('port 9999')))
check('another host is refused', errsOf({ ...nx, proxy: [{ path: '/', target: 'http://10.0.0.9:3000' }] }).some(e => e.includes('10.0.0.9')))
check('an upstream pool is refused', errsOf({ ...nx, proxy: [{ path: '/', target: 'upstream:pool' }] }).some(e => e.includes('upstream pool')))
check('...and a target that is not a url at all', errsOf({ ...nx, proxy: [{ path: '/', target: 'nonsense' }] }).some(e => e.includes('not a URL this can read')))
check('https to itself is refused', errsOf({ ...nx, proxy: [{ path: '/', target: 'https://127.0.0.1:3000' }] }).some(e => e.includes('plain HTTP')))
check('a disabled self site is refused', selfSiteErrors(nx, { ...at, enabled: false }).length === 1)
check('...but not while enable-ness is unknown', selfSiteErrors(nx, { host: '127.0.0.1', port: 3000 }).length === 0)
check('changing the domain still passes', errsOf({ ...nx, domains: ['other.test'] }).length === 0)
check('turning on hsts still passes', errsOf({ ...nx, https: { mode: 'selfsigned' }, hsts: { enabled: true, maxAge: 31536000 } }).length === 0)

const hardened = { ...nx, listenAddress: '192.168.1.10', https: { mode: 'selfsigned' }, ipRules: { mode: 'allowlist', ips: ['192.168.0.0/16'] }, rateLimit: { enabled: true, rps: 30, burst: 60 } }
check('a hardened self site has nothing to warn about', selfSiteWarnings(hardened).length === 0, selfSiteWarnings(hardened).join(' | '))
check('a bare one warns about the bind', selfSiteWarnings(nx).some(w => w.includes('listen address')))
check('...and about the missing allowlist', selfSiteWarnings(nx).some(w => w.includes('allowlist')))
check('...and about plain http', selfSiteWarnings(nx).some(w => w.includes('clear text')))

// the bind: one listener on one address, and no wildcard left behind
const bound = renderSiteConf({ ...defaultSite('b'), domains: ['b.test'], https: { mode: 'selfsigned' }, listenAddress: '192.168.1.10' })
check('a bound site listens on its address', bound.includes('listen 192.168.1.10:80;'), bound.match(/listen[^;]*/g).join(' | '))
check('...and on the tls port', bound.includes('listen 192.168.1.10:443 ssl;'))
check('...and on nothing else', !/listen (80|443)[ ;]/.test(bound) && !bound.includes('[::]'), bound.match(/listen[^;]*/g).join(' | '))
const bound6 = renderSiteConf({ ...defaultSite('b6'), domains: ['b6.test'], https: { mode: 'selfsigned' }, listenAddress: 'fd00::10' })
check('an ipv6 bind is bracketed', bound6.includes('listen [fd00::10]:80;') && bound6.includes('listen [fd00::10]:443 ssl;'))
check('an unbound site still listens everywhere', renderSiteConf({ ...defaultSite('u'), domains: ['u.test'] }).includes('listen 80;'))
check('a bogus listen address is refused', validateSite({ ...defaultSite('x'), listenAddress: '192.168.1.10; }' }).some(e => e.includes('invalid listen address')))
check('an interface name is not a listen address', validateSite({ ...defaultSite('x'), listenAddress: 'eth0' }).some(e => e.includes('invalid listen address')))

// a proxy rule has to keep the connection open, or the log tail freezes behind it
const prox = renderSiteConf({ ...defaultSite('p'), domains: ['p.test'], proxy: [{ path: '/api', target: 'http://127.0.0.1:8080' }] })
check('a proxy rule speaks http/1.1 upstream', prox.includes('proxy_http_version 1.1;') && prox.includes('proxy_set_header Connection "";'))
check('...and does not buffer the response', prox.includes('proxy_buffering off;'))

// Verification is opt-in, and asking for it used to require a CA file of your own — so an upstream
// with a publicly-signed certificate could not be verified at all. Silence is the thing to avoid:
// `proxy_ssl_verify off` and no such directive mean the same to nginx, but only one of them says so.
const httpsRow = { path: '/', target: 'https://10.0.0.2:8443' }
const httpsSite = t => ({ ...defaultSite('v'), domains: ['v.test'], proxy: [{ ...httpsRow, ...t }] })
const vDef = renderSiteConf(httpsSite({}))
check('an https target is not verified unless asked', vDef.includes('proxy_ssl_verify off;'), vDef.split('\n').find(l => l.includes('proxy_ssl')))
const vWant = httpsSite({ verify: true })
check('asking for it is valid with no CA file', validateSite(vWant).length === 0, JSON.stringify(validateSite(vWant)))
const vOn = renderSiteConf(vWant)
check('...and verifies against the system trust store',
  vOn.includes('proxy_ssl_verify on;') && vOn.includes('proxy_ssl_trusted_certificate /etc/ssl/certs/ca-certificates.crt;'),
  vOn.split('\n').filter(l => l.includes('proxy_ssl')).join(' | '))
check('...allowing a root plus an intermediate', vOn.includes('proxy_ssl_verify_depth 2;'))
const vOwn = renderSiteConf(httpsSite({ verify: true, ca: '/etc/ssl/private/own-ca.pem' }))
check('a CA the operator gave is the one used',
  vOwn.includes('proxy_ssl_trusted_certificate /etc/ssl/private/own-ca.pem;') && !vOwn.includes('ca-certificates.crt'))
check('a malformed CA path is still refused',
  validateSite(httpsSite({ verify: true, ca: '/etc/ssl/private/own ca.pem' })).some(e => e.includes('absolute path')))
check('a plain-http target gets no proxy_ssl directives',
  !renderSiteConf({ ...defaultSite('v'), domains: ['v.test'], proxy: [{ path: '/', target: 'http://10.0.0.2:8080', verify: true }] }).includes('proxy_ssl'))
const poolSite = t => ({
  ...defaultSite('v'), domains: ['v.test'],
  upstreams: [{ name: 'app', algorithm: 'round_robin', healthCheck: false, servers: [{ scheme: 'https', host: '10.0.0.2', port: 8443 }] }],
  proxy: [{ path: '/', target: 'upstream:app', ...t }],
})
check('the flag means the same on a backend pool',
  renderSiteConf(poolSite({ verify: true })).includes('proxy_ssl_trusted_certificate /etc/ssl/certs/ca-certificates.crt;')
  && renderSiteConf(poolSite({})).includes('proxy_ssl_verify off;'))
// SNI is off by default in nginx, and proxy_ssl_name defaults to the host part of proxy_pass — which
// for a pool is the generated name `site_app`, a name no certificate carries.
check('TLS to a backend always sends SNI', vOn.includes('proxy_ssl_server_name on;') && renderSiteConf(poolSite({})).includes('proxy_ssl_server_name on;'))
check('a direct https target keeps nginx\'s own name default', !vOn.includes('proxy_ssl_name'), vOn.split('\n').filter(l => l.includes('proxy_ssl_name')).join(' | '))
check('a pool names the backend, because the pool name is not a host',
  renderSiteConf(poolSite({ verify: true })).includes('proxy_ssl_name 10.0.0.2;'),
  renderSiteConf(poolSite({ verify: true })).split('\n').filter(l => l.includes('proxy_ssl_name')).join(' | '))
// `$host` is the name with the port dropped, so a site on a non-443 TLS port would hand the backend a
// Host that names a port this server does not listen on — and a redirect built from it would 404.
check('the proxied Host is passed verbatim, port and all', prox.includes('proxy_set_header Host $http_host;'), prox)

check('a typo in an ip rule is refused', validateSite({ ...defaultSite('i'), ipRules: { mode: 'allowlist', ips: ['192.168.1.0/24', 'not-an-ip'] } }).some(e => e.includes('invalid ip rule')))
check('a blank ip rule row is not an error', validateSite({ ...defaultSite('i'), ipRules: { mode: 'allowlist', ips: ['192.168.1.0/24', ''] } }).length === 0)
check('cidr and ipv6 rules are accepted', validateSite({ ...defaultSite('i'), ipRules: { mode: 'allowlist', ips: ['10.0.0.0/8', '::1/128', 'fe80::/10'] } }).length === 0)

// ---- 13b. the defaults a site is created with ----
check('a new site rate limits by default',
  defaultSite('r').rateLimit.enabled === true && defaultSite('r').rateLimit.rps === 50 && defaultSite('r').rateLimit.burst === 100,
  JSON.stringify(defaultSite('r').rateLimit))
// The zone lives in the shared conf and the directive in the site conf, rendered from the same
// object — a default that reached only one of them would be a site that 503s against no zone.
check('...the zone reaches the shared conf', renderHttpConf([{ ...defaultSite('r'), domains: ['r.test'] }]).includes('zone=r_rl:10m rate=50r/s'))
check('...the directive reaches the site conf', renderSiteConf({ ...defaultSite('r'), domains: ['r.test'] }).includes('limit_req zone=r_rl burst=100 nodelay;'))
// A one-way door: a browser that has read this header refuses plain HTTP for the whole max-age,
// and that outlives turning the toggle back off. Never armed for someone by default, because the
// moment a new site is pointed at a self-signed cert it would brick that site with no click-through.
check('a new site does not arm HSTS', defaultSite('r').hsts.enabled === false)

// ---- 13c. lists the operator asked for and left empty ----
// These read "on" in the form while nginx sees no directive at all. Each predicate is the
// renderer's own, so the rule fires exactly when renderDirectives would emit nothing.
check('an empty allowlist is refused — it emits nothing at all, so the site is open',
  validateSite({ ...defaultSite('a'), ipRules: { mode: 'allowlist', ips: [] } }).some(e => e.includes('open to everyone')))
check('...and one holding only blank rows, which denies everyone including you',
  validateSite({ ...defaultSite('a'), ipRules: { mode: 'allowlist', ips: ['', ' '] } }).some(e => e.includes('403 for everyone')))
check('an empty denylist is not refused', validateSite({ ...defaultSite('a'), ipRules: { mode: 'denylist', ips: [] } }).length === 0, 'blocking nothing is honest')
check('basic auth on with no users is refused', validateSite({ ...defaultSite('a'), basicAuth: { enabled: true, users: [] } }).some(e => e.includes('open to everyone')))
check('...with one blank row, which writes an empty password file and 401s everyone',
  validateSite({ ...defaultSite('a'), basicAuth: { enabled: true, users: [{ user: '', password: '' }] } }).some(e => e.includes('401')))
check('...and with a username but no password, which does the same',
  validateSite({ ...defaultSite('a'), basicAuth: { enabled: true, users: [{ user: 'bob', password: '' }] } }).some(e => e.includes('401')))
check('...but one complete row is enough', validateSite({ ...defaultSite('a'), basicAuth: { enabled: true, users: [{ user: 'bob', password: 'pw' }] } }).length === 0)
// A stored row has a hash and no password, and it is a complete row: refusing it would make every
// site with basic auth unsavable the moment the form stopped sending a password it cannot show.
check('...and a stored row, which carries a hash instead of a password',
  validateSite({ ...defaultSite('a'), basicAuth: { enabled: true, users: [{ user: 'bob', hash: '$apr1$x$y' }] } }).length === 0)

// ---- writeHtpasswd: the plaintext stops here ----
// Called with a real openssl, because the hash it produces is the thing under test — a stub would
// only prove the stub works. The returned rows are what the manifest stores, so this is where the
// promise "no password in the manifest" is either kept or not.
{
  await withRealShell(async () => {
    const pwSite = { ...defaultSite('pwsite'), basicAuth: { enabled: true, users: [{ user: 'bob', password: 'hunter2' }] } }
    const rows = await writeHtpasswd(pwSite)
    check('writeHtpasswd returns rows carrying a hash, not the password',
      rows.length === 1 && rows[0].user === 'bob' && !!rows[0].hash && rows[0].password === undefined,
      JSON.stringify(rows))
    check('...an apr1 hash, the format nginx is being fed',
      /^\$apr1\$[./A-Za-z0-9]{8}\$[./A-Za-z0-9]{22}$/.test(rows[0].hash || ''), rows[0].hash)
    check('...and the password file holds user:hash',
      fs.readFileSync(htpasswdPath('pwsite'), 'utf8') === `bob:${rows[0].hash}\n`,
      fs.readFileSync(htpasswdPath('pwsite'), 'utf8'))

    // The row the form sends back after a save: no password, hash intact. Re-hashing a hash would
    // write the hash itself as the password, which authenticates nothing.
    const kept = await writeHtpasswd({ ...pwSite, basicAuth: { enabled: true, users: rows } })
    check('a row arriving with only its hash keeps that exact hash', kept[0].hash === rows[0].hash, kept[0].hash)

    // Changing it means sending a password beside the old hash, and the new one wins.
    const changed = await writeHtpasswd({ ...pwSite, basicAuth: { enabled: true, users: [{ ...rows[0], password: 'other' }] } })
    check('...and a password sent beside it replaces it', changed[0].hash !== rows[0].hash && /^\$apr1\$/.test(changed[0].hash), changed[0].hash)

    // Disabled: the rows still come back hashed, so the manifest is migrated either way, but the
    // file nginx reads is left alone — deleting it would break the site the moment it was turned
    // back on.
    const fileBefore = fs.readFileSync(htpasswdPath('pwsite'), 'utf8')
    const off = await writeHtpasswd({ ...pwSite, basicAuth: { enabled: false, users: [{ user: 'eve', password: 'x' }] } })
    check('a disabled site still has its rows hashed', !!off[0].hash && off[0].password === undefined)
    check('...but its password file is left as it was', fs.readFileSync(htpasswdPath('pwsite'), 'utf8') === fileBefore)
  })
}
check('gzip on with no types is refused', validateSite({ ...defaultSite('a'), gzip: { enabled: true, types: [] } }).some(e => e.includes('nothing would be compressed')))
check('...including when every type in it is invalid', validateSite({ ...defaultSite('a'), gzip: { enabled: true, types: ['nonsense'] } }).some(e => e.includes('nothing would be compressed')))
check('caching on with no extensions is refused', validateSite({ ...defaultSite('a'), staticCache: { enabled: true, extensions: [], expiresDays: 30 } }).some(e => e.includes('no cache location')))
check('turning any of them off is always allowed',
  validateSite({ ...defaultSite('a'), gzip: { enabled: false, types: [] }, staticCache: { enabled: false, extensions: [], expiresDays: 30 }, basicAuth: { enabled: false, users: [] } }).length === 0)
// Deliberately *not* refused. The toggle is hidden unless there is a certificate, so refusing this
// would leave the site unsavable with no visible control to fix it — the lockout this whole feature
// is meant to remove. It is inert on disk (hstsValue returns null without a TLS block) and it is a
// legitimate staging state; the form carries the warning instead.
const armed = { ...defaultSite('a'), domains: ['a.test'], https: { ...defaultSite('a').https }, hsts: { ...defaultSite('a').hsts, enabled: true } }
check('hsts left armed with https off still saves', validateSite(armed).length === 0)
check('...and emits no header, because it is inert rather than applied', !renderSiteConf(armed).includes('Strict-Transport-Security'))

// ---- 11d. reading the config directories ----
// The viewer's whole job is showing what the manifest cannot: a link whose target is gone, a file
// enabled and never written. Both are built here by hand, because neither is a state the dashboard
// will ever write itself.
const avail = PATHS.sitesAvail
const en = PATHS.sitesEn
fs.mkdirSync(avail, { recursive: true })
fs.mkdirSync(en, { recursive: true })
fs.writeFileSync(path.join(avail, 'alpha.conf'), '# alpha\n')
fs.writeFileSync(path.join(avail, 'backup.conf.bak'), '# not a conf\n')
fs.writeFileSync(path.join(avail, '.hidden'), '# dotfile\n')
fs.symlinkSync(path.join(avail, 'alpha.conf'), path.join(en, 'alpha.conf'), 'file')
fs.symlinkSync(path.join(avail, 'gone.conf'), path.join(en, 'gone.conf'), 'file')
fs.writeFileSync(path.join(en, 'loose'), '# a real file nginx still loads: include sites-enabled/*;\n')

const listing = listNginxFiles()
check('both directories are listed', listing.available.includes('alpha.conf') && listing.enabled.some(f => f.name === 'alpha.conf'))
check('a conf that is not named .conf is still listed', listing.available.includes('backup.conf.bak'))
// validName is the reader's own gate, so listing anything it would refuse is listing a dead link.
check('...but a name the reader could not open is not', !listing.available.includes('.hidden'))
check('an entry whose target was deleted reads as unresolved',
  listing.enabled.find(f => f.name === 'gone.conf')?.resolves === false)
check('...and one whose target is there does not',
  listing.enabled.find(f => f.name === 'alpha.conf')?.resolves === true)
// nginx includes sites-enabled/* with no extension filter, so this file is loaded and has to show.
check('a non-conf file in sites-enabled is listed, and carries no link target',
  listing.enabled.find(f => f.name === 'loose')?.target === '')

const alpha = readNginxConf('alpha.conf')
check('a conf is read back with its dir', alpha?.text === '# alpha\n' && alpha.dir === 'sites-available')
check('...and a bare name finds <name>.conf, so the site list can hand over what it displays', readNginxConf('alpha')?.name === 'alpha.conf')
// Both directories are searched, so an enabled-only conf is readable — that is the case that has
// nowhere else to be seen.
check('a file that exists only in sites-enabled is readable', readNginxConf('loose')?.text.startsWith('# a real file'))
check('a name that is not there is null, not an error', readNginxConf('nosuch') === null)
check('traversal is refused', readNginxConf('../state/manifest.json') === null && readNginxConf('..') === null)
check('an absolute path is refused', readNginxConf('/etc/shadow') === null)

// The one that matters: validName rules out traversal, but a symlink planted in sites-available
// points anywhere, and this route returns file contents.
fs.symlinkSync(MANIFEST, path.join(avail, 'escape.conf'), 'file')
check('a symlink out of the nginx dir is refused rather than followed', readNginxConf('escape.conf') === null)

// ---- 14. TOTP, against RFC 6238's own vectors ----
const SEED = b32encode(Buffer.from('12345678901234567890'))
check('rfc 6238 vector at T=59', totp(SEED, 59_000) === '287082', totp(SEED, 59_000))
check('rfc 6238 vector at T=1111111109', totp(SEED, 1111111109_000) === '081804', totp(SEED, 1111111109_000))
check('a code is accepted at its own step', totpValid(SEED, '287082', 59_000))
check('...and one step either side', totpValid(SEED, totp(SEED, 29_000), 59_000) && totpValid(SEED, totp(SEED, 89_000), 59_000))
check('...but not two steps out', !totpValid(SEED, totp(SEED, 149_000), 59_000))
// timingSafeEqual throws on unequal lengths; the length is checked before it is reached
check('a wrong-length code is rejected, not thrown', !totpValid(SEED, '12345', 59_000) && !totpValid(SEED, '', 59_000) && !totpValid(SEED, 'abcdef', 59_000))
check('a malformed secret throws rather than meaning 2FA off', (() => { try { b32decode('not base32!'); return false } catch { return true } })())
const minted = newSecret()
check('a generated secret accepts its own code', minted.length === 32 && totpValid(minted, totp(minted)))
// Pinned character for character: this string is what the QR encodes and what the phone stores. A
// subtly different one — a missing `issuer`, digits the app defaults differently — enrols a secret
// that never produces a code this server accepts, and the operator only finds out at the next
// sign-in, locked out of the page that would fix it.
check('the otpauth uri is the exact string an authenticator expects',
  otpauth('JBSWY3DPEHPK3PXP', 'nxd') === 'otpauth://totp/nxd?secret=JBSWY3DPEHPK3PXP&issuer=nxd&algorithm=SHA1&digits=6&period=30',
  otpauth('JBSWY3DPEHPK3PXP', 'nxd'))

// a revert restores the manifest wholesale, so the snapshot has to be inspected first
const snap = sites => ({ at: 1, label: 'x', files: [{ path: MANIFEST, content: JSON.stringify({ sites }), link: null }] })
// The live manifest decides this, so it is written here rather than inherited from whatever the
// fixture happened to be left holding.
fs.writeFileSync(MANIFEST, JSON.stringify({ sites: [nx] }))
check('reverting to before the self site is refused', selfRevertErrors(snap([]), at).some(e => e.includes('predates')))
check('...and a snapshot that keeps it is allowed', selfRevertErrors(snap([nx]), at).length === 0)
check('...but not one that keeps it and repoints /', selfRevertErrors(snap([{ ...nx, proxy: [{ path: '/', target: 'http://10.0.0.9:3000' }] }]), at).some(e => e.includes('10.0.0.9')))
// With nothing published there is nothing to protect: an old undo must still run, or every
// snapshot taken before the vhost existed would be permanently unusable.
fs.writeFileSync(MANIFEST, '{"sites":[]}\n')
check('...while nothing is published, an old snapshot is allowed', selfRevertErrors(snap([]), at).length === 0)
check('reverting to a disabled symlink is refused',
  selfRevertErrors({ at: 1, label: 'x', files: [{ path: path.join(PATHS.sitesEn, 'nxd.conf'), content: null, link: null }] }, at).some(e => e.includes('disabled')))
check('a snapshot that never mentions the symlink is allowed',
  selfRevertErrors({ at: 1, label: 'x', files: [{ path: HTTP_CONF, content: '# x', link: null }] }, at).length === 0)

// ---------- the recursive-delete guard ----------
// The only place this is exercised: DRY routes the delete to safeApplyDry in smoke.mjs, and the
// demo's document roots are real absolute paths, so a guard that let one through would `rm -rf`
// outside the probe dir on a developer's own machine.
//
// Absolute fake paths throughout, which is deliberate twice over: they do not exist, so
// `realpathSync` throws and the symlink rule stays out of the way while the *other* rules are
// tested — and a guard that wrongly allowed one would still only be pointed at a nonexistent path.
const refuse = (root, sites = [], self = '') => docrootRemovalRefusal(root, sites, self)
const site = (name, root) => ({ name, root })
// Absolute, and rooted the way *this* platform roots things, so the paths below stay absent and the
// symlink rule stays out of the way. A literal '/var/www' is absolute on Linux but resolves to
// 'D:\\var\\www' on Windows, where realpathSync answering anything at all makes the two differ and
// the symlink rule fires first — hiding whichever rule was actually under test.
const abs = (...p) => path.join(path.parse(D).root, ...p)

check('the filesystem root is refused', refuse(path.parse(D).root) !== null, String(refuse(path.parse(D).root)))
// Refused on both platforms, though for different reasons: one segment on Linux, and on Windows
// realpathSync answering 'D:\\etc' where the literal says '/etc'. The segment rule itself is pinned
// by the two checks below instead, which say the same thing without the drive prefix ambiguity.
check('...and so is one step below it', refuse('/etc') !== null && refuse('/usr') !== null, String(refuse('/etc')))
// The boundary is "at least two segments below the root", and a drive prefix is one of them on
// Windows — so the root itself and a genuine two-deep path are the portable way to state it.
check('...while two segments down is allowed', refuse(abs('var', 'www')) === null, String(refuse(abs('var', 'www'))))
check('a blank document root is refused', refuse('') !== null && refuse('   ') !== null)
// ROOT_RE accepts this today and POST /api/sites will mkdirSync it — resolving it against wherever
// the dashboard was started from is not something to guess at.
check('a relative document root is refused', refuse('relative/site') !== null, String(refuse('relative/site')))
check('...and its refusal names the path', refuse('relative/site').includes('relative/site'))

const siblings = [site('a', abs('var', 'www')), site('b', abs('var', 'www', 'b'))]
check('a root that contains another site is refused',
  refuse(abs('var', 'www'), siblings, 'a') !== null, String(refuse(abs('var', 'www'), siblings, 'a')))
check('...and a root that sits inside another site is refused the other way round',
  refuse(abs('var', 'www', 'a', 'b'), [site('a', abs('var', 'www', 'a')), site('self', abs('var', 'www', 'a', 'b'))], 'self') !== null)
check('...naming the site it would take with it', refuse(abs('var', 'www'), siblings, 'a').includes('"b"'))

// The direction that is easy to miss, and the reason this iterates PATHS rather than listing it:
// the docroot is not inside the state dir here, a state dir is inside the docroot.
const stateDocroot = path.join(PATHS.stateDir, 'www')
check('a document root inside the dashboard state dir is refused', refuse(stateDocroot) !== null, String(refuse(stateDocroot)))
check('...and its parent is refused too', refuse(path.join(path.dirname(PATHS.stateDir), 'x')) !== null, String(refuse(path.join(path.dirname(PATHS.stateDir), 'x'))))
check('...as is anything that would take the app itself', refuse(path.dirname(path.dirname(path.dirname(D)))) !== null)

// The check that fails if the rule is ever written too broadly — a lone site's own root is not
// "another site's root", and if this regresses every delete-with-files becomes impossible.
check('a lone site\'s own document root is allowed', refuse(abs('var', 'www', 'a'), [site('self', abs('var', 'www', 'a'))], 'self') === null)
check('...and an ordinary path on a real box is allowed', refuse(abs('srv', 'www', 'shop')) === null)
// Absent, not unsafe: realpathSync throws, which must skip the symlink rule rather than returning
// early — the early-return version let this exact path past every other rule.
check('...including one that is not on disk yet', refuse(abs('srv', 'www', 'not-yet')) === null)

// Tolerant of a box without symlink privileges (Windows without Developer Mode), where this is
// simply not testable rather than failing.
const realRoot = path.join(D, 'real-docroot')
const linkRoot = path.join(D, 'link-docroot')
fs.mkdirSync(realRoot, { recursive: true })
try {
  fs.symlinkSync(realRoot, linkRoot, 'dir')
  check('a symlinked document root is refused', refuse(linkRoot) !== null, String(refuse(linkRoot)))
  check('...and the refusal says where it points', refuse(linkRoot).includes(realRoot), String(refuse(linkRoot)))
} catch {
  console.log('  --  skipped: this box will not create a symlink without elevation')
}

// An install that never sets the variable must be untouched by all of the above — including not
// finding some existing site of its own suddenly undeletable.
delete process.env.DASH_SELF_NAME
const off = await import('../lib/manifest.js?self-unset')
check('with DASH_SELF_NAME unset nothing is pinned', off.SELF_NAME === '' && off.isSelf('nxd') === false)
check('...and no revert is refused', off.selfRevertErrors(snap([]), at).length === 0)
check('...and no site is stamped as self', off.readManifest().sites.every(s => !s.self))
process.env.DASH_SELF_NAME = 'nxd'

hooks.run = realRun
fs.rmSync(D, { recursive: true, force: true })
console.log(failed ? `\n${failed} of ${ran} FAILED` : `\nall ${ran} checks passed`)
process.exit(failed ? 1 : 0)

