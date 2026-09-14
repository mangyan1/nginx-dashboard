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
const { safeApply, hooks, MANIFEST, HTTP_CONF, PATHS, listHistory, revertHistory } = await import('../lib/nginx.js')
const { defaultSite, renderSiteConf, validateSite, siteConfPath, driftOf, httpConfDrift, renderHttpConf, readManifest } = await import('../lib/manifest.js')

const realRun = hooks.run
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

hooks.run = realRun
fs.rmSync(D, { recursive: true, force: true })
console.log(failed ? `\n${failed} of ${ran} FAILED` : `\nall ${ran} checks passed`)
process.exit(failed ? 1 : 0)
