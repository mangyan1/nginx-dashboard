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
const { defaultSite, renderSiteConf, validateSite, siteConfPath, driftOf, httpConfDrift, renderHttpConf } = await import('../lib/manifest.js')

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

// ---- 8. a proxy rule must not drop the docroot ----
// Emitting only the proxy locations left the site with no `root`, so every other path fell
// through to nginx's compiled-in default root and served its stock welcome page.
const withProxy = renderSiteConf({ ...mk('p'), root: '/var/www/p', proxy: [{ path: '/api', target: 'http://10.0.0.1:8080' }] })
check('proxy site still emits its docroot', withProxy.includes('root /var/www/p;'), withProxy)
check('proxy site still emits a proxy location', withProxy.includes('location /api {'), withProxy)
check('static-cache block survives alongside a proxy rule', withProxy.includes('expires 30d;'), withProxy)

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
