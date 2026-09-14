import { useEffect, useState } from 'react'
import { api } from '../api.js'
import { Btn, Chip, Field, Toggle, Section, Out } from './ui.jsx'
import FileManager from './FileManager.jsx'
import { at } from '../defaults.js'

// The menu of what nginx knows how to compress and cache — deliberately wider than the default
// list, because a site may legitimately want a type the default leaves out (a PDF is not worth
// compressing by default and may be worth caching). What is *on* by default comes from the server.
const GZIP_TYPES = ['text/css', 'application/javascript', 'application/json', 'image/svg+xml', 'text/plain', 'text/xml', 'application/xml']
const CACHE_EXT = ['css', 'js', 'png', 'jpg', 'jpeg', 'gif', 'svg', 'ico', 'woff', 'woff2', 'pdf']

// What a new row starts as, shared by the "+" button and the row's own chip so the two can never
// disagree. Only the fields the chip governs are listed: a proxy rule carries a `verify` flag this
// form does not show, and a reset must merge rather than replace it.
const PROXY_ROW = { path: '/', target: 'http://127.0.0.1:8080' }
const SERVER_ROW = { scheme: 'http', host: '127.0.0.1', port: 3001 }
const USER_ROW = { user: '', password: '' }
const upstreamRow = name => ({ name: `${name || 'app'}_backends`, algorithm: 'round_robin', healthCheck: false })

const domainList = v => v.split(',').map(d => d.trim()).filter(Boolean)

/**
 * The defaults are the server's, so they are fetched rather than kept here. The copy that used to
 * live at the top of this file had already drifted from `defaultSite` — nine cache extensions
 * against ten — and a chip drawn from a guess would promise a value the server would not write.
 * Nothing is rendered against a guess: the form waits for the answer.
 */
export default function SiteForm(props) {
  const [D, setD] = useState(null)
  const [err, setErr] = useState('')
  const load = () => {
    setErr('')
    api('GET', '/api/site-defaults').then(r => setD(r.defaults)).catch(e => setErr(e.message))
  }
  useEffect(load, [])

  if (err) return (
    <div className="panel-body">
      <p className="hint">Could not read the site defaults from the server: {err}</p>
      <Btn onClick={load}>Retry</Btn>
    </div>
  )
  if (!D) return <div className="panel-body"><p className="hint">loading…</p></div>
  return <SiteEditor {...props} D={D} />
}

/**
 * One mapping from a site object to the form's shape, used both to open the form and to re-seed it
 * from what the server actually stored. The second use is the point of having it as a function:
 * `sanitizeSite` fills and clamps, so a value the server did not take verbatim — a port past 65535
 * comes back as 80 — would otherwise sit on screen as what was typed, baselined as clean, and
 * disagree with the conf on disk with nothing said about it.
 *
 * Copied key by key and collection by collection, because `D` is also what the chips read: a setter
 * that reached into it would move the default it is being measured against.
 */
const seed = (b, blankRoot = false) => ({
  name: b.name || '',
  domains: (b.domains || []).join(', '),
  // blank for a new site, so the docroot follows the name as it is typed; the placeholder and the
  // chip both say what that will be
  root: blankRoot ? '' : (b.root || ''),
  port: b.port,
  serveHttp: b.serveHttp,
  httpsPort: b.httpsPort,
  listenAddress: b.listenAddress,
  index: b.index,
  clientMaxBodySize: b.clientMaxBodySize,
  https: { ...b.https },
  hsts: { ...b.hsts },
  listen: { ...b.listen },
  php: { ...b.php },
  proxy: (b.proxy || []).map(p => ({ ...p })),
  upstreams: (b.upstreams || []).map(u => ({ ...u, servers: (u.servers || []).map(x => ({ ...x })) })),
  rateLimit: { ...b.rateLimit },
  ipRules: { ...b.ipRules, ips: [...b.ipRules.ips] },
  basicAuth: { ...b.basicAuth, users: b.basicAuth.users.map(u => ({ ...u })) },
  gzip: { ...b.gzip, types: [...b.gzip.types] },
  staticCache: { ...b.staticCache, extensions: [...b.staticCache.extensions] },
})

function SiteEditor({ site, D, onSaved, onDeleted, onDirty }) {
  const isNew = !site
  const [s, setS] = useState(() => seed(isNew ? D : site, isNew))
  const [result, setResult] = useState(null)
  const [warns, setWarns] = useState([])
  const [busy, setBusy] = useState(false)
  // the state this form was opened (or last saved) with, so "dirty" means "differs from that"
  const [baseline, setBaseline] = useState(() => JSON.stringify(s))
  const dirty = JSON.stringify(s) !== baseline
  useEffect(() => { onDirty?.(dirty) }, [dirty, onDirty])

  const set = (patch, key) => setS(prev => ({ ...prev, ...(key ? { [key]: { ...prev[key], ...patch } } : patch) }))
  const setArr = (key, arr) => setS(prev => ({ ...prev, [key]: arr }))
  const upS = patch => setS(prev => ({ ...prev, https: { ...prev.https, ...patch } }))
  const upL = patch => setS(prev => ({ ...prev, listen: { ...prev.listen, ...patch } }))

  // Three things per control — what it holds, the server's default, and how to write one back —
  // in one call instead of three at each of the forty call sites. `tog` is the same for a toggle,
  // which reads its own `checked` as the value.
  const chip = (path, value, onDef) => ({ def: at(D, path), value, onDef })
  const tog = (path, onDef) => ({ def: at(D, path), onDef })
  // `root` is the only default that depends on the name, and for a new site the name is not known
  // until it is typed. The prefix comes from the server's own value for a nameless site, so the
  // rule stays in one place; only the concatenation is here.
  const rootDef = D.root + s.name

  const toPayload = () => ({ ...s, domains: domainList(s.domains) })

  const save = async () => {
    setBusy(true)
    try {
      const p = toPayload()
      const r = isNew
        ? await api('POST', '/api/sites', p)
        : await api('PUT', `/api/sites/${s.name}`, p)
      setResult({ ok: true, output: 'saved & applied' })
      // the server accepts this and still has something to say about it — advisory only, so it
      // is shown next to the result rather than instead of it
      setWarns(r.warnings || [])
      // Re-seeded from the response, not from what was typed: what the server stored is the truth,
      // and it is not always what was sent. Re-baselining from that same object is what keeps the
      // form clean afterwards, and an existing site keeps its key, so the form is not remounted
      // after a save and would otherwise stay "dirty" forever, prompting on the next click.
      const next = seed(r.site || s)
      setS(next)
      setBaseline(JSON.stringify(next))
      onSaved(p.name)
    } catch (e) {
      setWarns([])
      setResult({ ok: false, output: e.message })
    } finally { setBusy(false) }
  }

  const toggle = async (action, method = 'POST') => {
    setBusy(true)
    try {
      setResult(await api(method, `/api/sites/${s.name}/${action}`))
      onSaved()
    } catch (e) { setResult({ ok: false, output: e.message }) } finally { setBusy(false) }
  }

  const selfSigned = async () => {
    setBusy(true)
    try { setResult(await api('POST', `/api/sites/${s.name}/selfsigned`)); onSaved() }
    catch (e) { setResult({ ok: false, output: e.message }) } finally { setBusy(false) }
  }

  const certbot = async () => {
    setBusy(true)
    try { setResult(await api('POST', '/api/cert', { domain: s.domains.split(',')[0].trim() })); onSaved() }
    catch (e) { setResult({ ok: false, output: e.message }) } finally { setBusy(false) }
  }

  const del = async () => {
    if (!confirm(`Delete site ${s.name}? Its conf file and symlink are removed; docroot stays.`)) return
    setBusy(true)
    try { await api('DELETE', `/api/sites/${s.name}`); onDeleted() }
    catch (e) { setResult({ ok: false, output: e.message }) } finally { setBusy(false) }
  }

  return (
    <div className="site-form">
      <div className="panel-head formhead">
        <span className="panel-title">{isNew ? 'New site' : s.name}</span>
        {!isNew && <>
          <span className={`chip ${site.enabled ? 'ok' : 'off'}`}>{site.enabled ? 'enabled' : 'disabled'}</span>
          {site.drift && <span className="chip warn" title={`the conf file on disk is ${site.drift} — saving rewrites it`}>{site.drift}</span>}
          {!site.managed && <span className="chip un">unmanaged</span>}
          {site.self && <span className="chip self" title="this is the vhost you are reading this page through">self</span>}
        </>}
        <span className="spacer" />
        {dirty && <span className="chip warn">unsaved</span>}
      </div>

      {/* On screen for the whole life of this site rather than only after something fails: the
          mistake it warns about is made by typing in the fields directly below it. */}
      {site?.self && (
        <div className="selfnote">
          <h4>This is the vhost you are reading this page through.</h4>
          <p>
            Saving here rewrites the file nginx uses to serve this dashboard. It is checked before
            anything is written — there has to be a proxy rule on <code>/</code> that points back at
            this process — and disabling or deleting it is refused outright. Everything else, from
            the domain to the certificate mode to the allowlist, is yours to change.
          </p>
          {site.drift && (
            <p>
              <b>It has drifted.</b> The file on disk is <code>{site.drift}</code>, so it has been
              edited outside the dashboard or removed. {site.drift === 'missing'
                ? 'nginx fails on the dangling include until it is back, so every save on every site is refused — the dashboard rewrites this file by itself at the next change, and Save here does it now.'
                : 'A hand repair over SSH survives until the next Save, which regenerates the file and silently undoes it. Make the change here, or copy the repair into these fields first.'}
            </p>
          )}
          {site.recovery && <pre className="out">{site.recovery}</pre>}
        </div>
      )}

      <Section title="Basics">
        {isNew && <Field label="Name (slug)"><input value={s.name} onChange={e => set({ name: e.target.value })} placeholder="myapp" /></Field>}
        <Field label="Domains (comma-separated)" {...chip('domains', domainList(s.domains), v => set({ domains: v.join(', ') }))}>
          <input value={s.domains} onChange={e => set({ domains: e.target.value })} placeholder="myapp.example.com — blank answers to any name on this port" />
        </Field>
        <Field label="Document root" def={rootDef} value={s.root} onDef={v => set({ root: v })}>
          <input value={s.root} onChange={e => set({ root: e.target.value })} placeholder={rootDef} />
        </Field>
        <Field label="Index files (in order)" {...chip('index', s.index, v => set({ index: v }))}>
          <input value={s.index} onChange={e => set({ index: e.target.value })} placeholder="index.php index.html" />
        </Field>
        <Field label="Port (HTTP)" {...chip('port', s.port, v => set({ port: v }))}>
          <input type="number" value={s.port} onChange={e => set({ port: Number(e.target.value) })} />
        </Field>
        <Field label="Listen address (blank = every interface)" {...chip('listenAddress', s.listenAddress, v => set({ listenAddress: v }))}>
          <input value={s.listenAddress} onChange={e => set({ listenAddress: e.target.value.trim() })} placeholder="192.168.1.10" />
        </Field>
        <p className="hint">
          Names one address to bind this vhost to. Blank listens on every interface, IPv6 included —
          which is what a site facing the internet wants. For a site that must stay on the LAN it is
          the stronger of the two controls: an allowlist can be got wrong, a bind cannot.
        </p>
        <Field label="Max request body (MB)" {...chip('clientMaxBodySize', s.clientMaxBodySize, v => set({ clientMaxBodySize: v }))}>
          <input type="number" min="0" value={s.clientMaxBodySize} onChange={e => set({ clientMaxBodySize: Number(e.target.value) })} placeholder="0" />
        </Field>
        <p className="hint">0 keeps nginx's own 1m default. Raise it for large uploads — nginx answers 413 before the file ever reaches PHP or the backend.</p>
      </Section>

      <Section title="HTTPS">
        <Field label="Certificate" {...chip('https.mode', s.https.mode, v => upS({ mode: v }))}>
          <select value={s.https.mode} onChange={e => upS({ mode: e.target.value })}>
            <option value="none">off</option>
            <option value="selfsigned">self-signed</option>
            <option value="certbot">Let's Encrypt (certbot)</option>
            <option value="manual">existing cert paths</option>
          </select>
        </Field>
        {s.https.mode === 'manual' && <>
          <Field label="Cert file path" {...chip('https.manualCert', s.https.manualCert, v => upS({ manualCert: v }))}>
            <input value={s.https.manualCert} onChange={e => upS({ manualCert: e.target.value })} placeholder="/etc/ssl/certs/site.pem" />
          </Field>
          <Field label="Key file path" {...chip('https.manualKey', s.https.manualKey, v => upS({ manualKey: v }))}>
            <input value={s.https.manualKey} onChange={e => upS({ manualKey: e.target.value })} placeholder="/etc/ssl/private/site.key" />
          </Field>
        </>}
        <Field label="Port (HTTPS)" {...chip('httpsPort', s.httpsPort, v => set({ httpsPort: v }))}>
          <input type="number" value={s.httpsPort} onChange={e => set({ httpsPort: Number(e.target.value) })} />
        </Field>
        <Toggle checked={s.serveHttp} onChange={v => set({ serveHttp: v })} label="Also serve plain HTTP on the port above"
          {...tog('serveHttp', v => set({ serveHttp: v }))} />
        {s.serveHttp && s.https.mode !== 'none' && <Toggle checked={s.https.forceRedirect} onChange={v => upS({ forceRedirect: v })} label={`Force HTTPS redirect (plain HTTP → 301 on port ${s.httpsPort})`}
          {...tog('https.forceRedirect', v => upS({ forceRedirect: v }))} />}
        {/* Offered once there is a certificate to enforce — the header is ignored on a plain-HTTP
            response, so on an HTTPS-off site the toggle would do nothing at all. But if it is
            already on, it stays on screen: hiding the only control that can turn it back off
            would leave the site unsavable over a setting nothing on this page can reach. */}
        {(s.https.mode !== 'none' || s.hsts.enabled) && <>
          <Toggle checked={s.hsts.enabled} onChange={v => set({ enabled: v }, 'hsts')} label="HSTS — tell browsers to refuse plain HTTP for this domain"
            {...tog('hsts.enabled', v => set({ enabled: v }, 'hsts'))} />
          {s.hsts.enabled && <>
            {s.https.mode === 'none'
              ? <p className="hint warn">Armed but inert: this site serves no TLS, so the header is never sent and no browser has seen it. It takes effect the moment a certificate is configured — and from then on it is a one-way door.</p>
              : <p className="hint">A one-way door: once a browser has seen this header it will refuse plain HTTP to {s.domains.trim() || 'this domain'} for the whole max-age, even if you turn this off again. Turn it on when HTTPS is confirmed working, not before.</p>}
            <Field label={`Max-age: ${Math.round(s.hsts.maxAge / 86400)} days`} {...chip('hsts.maxAge', s.hsts.maxAge, v => set({ maxAge: v }, 'hsts'))}>
              <input type="range" min="86400" max="63072000" step="86400" value={s.hsts.maxAge} onChange={e => set({ maxAge: Number(e.target.value) }, 'hsts')} />
            </Field>
            <Toggle checked={s.hsts.includeSubDomains} onChange={v => set({ includeSubDomains: v }, 'hsts')} label="Include subdomains — every subdomain must then serve a valid cert too"
              {...tog('hsts.includeSubDomains', v => set({ includeSubDomains: v }, 'hsts'))} />
            <Toggle checked={s.hsts.preload} onChange={v => set({ preload: v }, 'hsts')} label="preload — opt in to the browsers' hardcoded list (needs one year and subdomains)"
              {...tog('hsts.preload', v => set({ preload: v }, 'hsts'))} />
          </>}
        </>}
        <div className="row">
          {!isNew && <>
            <Btn disabled={busy} onClick={selfSigned} title="issue a self-signed cert now — HTTPS works instantly">Issue self-signed</Btn>
            <Btn disabled={busy || !s.domains.trim()} onClick={certbot} title="run certbot --nginx for the first domain">Get Let's Encrypt</Btn>
          </>}
        </div>
      </Section>

      <Section title="Reverse proxy">
        <p className="hint">Route paths to any backend — another app, container, or remote instance (http:// or https://host:port).</p>
        {s.proxy.map((p, i) => (
          <div className="row" key={i}>
            <input value={p.path} placeholder={PROXY_ROW.path} onChange={e => setArr('proxy', s.proxy.map((x, j) => j === i ? { ...x, path: e.target.value } : x))} />
            <input value={p.target} placeholder={PROXY_ROW.target} onChange={e => setArr('proxy', s.proxy.map((x, j) => j === i ? { ...x, target: e.target.value } : x))} />
            <Chip def={PROXY_ROW} value={p} title={`use the default rule: ${PROXY_ROW.path} → ${PROXY_ROW.target}`}
              onUse={d => setArr('proxy', s.proxy.map((x, j) => j === i ? { ...x, ...d } : x))} />
            <Btn kind="danger" onClick={() => setArr('proxy', s.proxy.filter((_, j) => j !== i))}>✕</Btn>
          </div>
        ))}
        <Btn onClick={() => setArr('proxy', [...s.proxy, { ...PROXY_ROW, verify: false }])}>+ proxy rule</Btn>
        <p className="hint">Empty proxy list = serve static files from the document root, resolving <code>/about</code> to <code>about.html</code> as well as <code>about/index.html</code> — which is what a static Astro or Next export needs. A rule on <code>/</code> replaces that.</p>
      </Section>

      <Section title="Application backend">
        <p className="hint">FastCGI covers PHP-FPM and anything else that speaks it — WordPress, AzuraCast, Laravel. A Node, Python or container app is a proxy rule above instead.</p>
        <Toggle checked={s.php.enabled} onChange={v => set({ enabled: v }, 'php')} label="Serve .php through FastCGI"
          {...tog('php.enabled', v => set({ enabled: v }, 'php'))} />
        {s.php.enabled && <>
          <Field label="FastCGI endpoint" {...chip('php.endpoint', s.php.endpoint, v => set({ endpoint: v }, 'php'))}>
            <input value={s.php.endpoint} onChange={e => set({ endpoint: e.target.value }, 'php')} placeholder="unix:/run/php/php8.3-fpm.sock  or  127.0.0.1:9000" />
          </Field>
          <Toggle checked={s.php.frontController} onChange={v => set({ frontController: v }, 'php')} label="Front controller — unmatched paths go to /index.php"
            {...tog('php.frontController', v => set({ frontController: v }, 'php'))} />
          <p className="hint">The script file is checked for existence before FastCGI sees it, so a .php path that does not exist is a 404 rather than code handed to the interpreter.</p>
        </>}
      </Section>

      <Section title="Load balancer upstreams">
        {s.upstreams.map((u, ui) => (
          <div className="upstream" key={ui}>
            <div className="row">
              <input value={u.name} placeholder="name (e.g. myapp_backends)" onChange={e => setArr('upstreams', s.upstreams.map((x, j) => j === ui ? { ...x, name: e.target.value } : x))} />
              <select value={u.algorithm} onChange={e => setArr('upstreams', s.upstreams.map((x, j) => j === ui ? { ...x, algorithm: e.target.value } : x))}>
                <option value="round_robin">round robin</option>
                <option value="least_conn">least connections</option>
                <option value="ip_hash">IP hash</option>
              </select>
              <label className="toggle"><input type="checkbox" checked={!!u.healthCheck} onChange={e => setArr('upstreams', s.upstreams.map((x, j) => j === ui ? { ...x, healthCheck: e.target.checked } : x))} /><span>health checks (passive)</span></label>
              <Chip def={upstreamRow(s.name)} value={u} title="reset this upstream's name, algorithm and health checks"
                onUse={d => setArr('upstreams', s.upstreams.map((x, j) => j === ui ? { ...x, ...d } : x))} />
              <Btn kind="danger" onClick={() => setArr('upstreams', s.upstreams.filter((_, j) => j !== ui))}>✕</Btn>
            </div>
            {u.servers.map((sv, si) => (
              <div className="row" key={si}>
                <select value={sv.scheme} onChange={e => setArr('upstreams', s.upstreams.map((x, j) => j === ui ? { ...x, servers: x.servers.map((y, k) => k === si ? { ...y, scheme: e.target.value } : y) } : x))}>
                  <option value="http">http</option>
                  <option value="https">https</option>
                </select>
                <input value={sv.host} placeholder={SERVER_ROW.host} onChange={e => setArr('upstreams', s.upstreams.map((x, j) => j === ui ? { ...x, servers: x.servers.map((y, k) => k === si ? { ...y, host: e.target.value } : y) } : x))} />
                <input type="number" value={sv.port} placeholder={SERVER_ROW.port} onChange={e => setArr('upstreams', s.upstreams.map((x, j) => j === ui ? { ...x, servers: x.servers.map((y, k) => k === si ? { ...y, port: Number(e.target.value) } : y) } : x))} />
                <Chip def={SERVER_ROW} value={sv} title={`use the default backend: ${SERVER_ROW.scheme}://${SERVER_ROW.host}:${SERVER_ROW.port}`}
                  onUse={d => setArr('upstreams', s.upstreams.map((x, j) => j === ui ? { ...x, servers: x.servers.map((y, k) => k === si ? { ...y, ...d } : y) } : x))} />
                <Btn kind="danger" onClick={() => setArr('upstreams', s.upstreams.map((x, j) => j === ui ? { ...x, servers: x.servers.filter((_, k) => k !== si) } : x))}>✕</Btn>
              </div>
            ))}
            <Btn onClick={() => setArr('upstreams', s.upstreams.map((x, j) => j === ui ? { ...x, servers: [...x.servers, { ...SERVER_ROW }] } : x))}>+ backend server</Btn>
          </div>
        ))}
        <Btn onClick={() => setArr('upstreams', [...s.upstreams, { ...upstreamRow(s.name), servers: [{ ...SERVER_ROW }] }])}>+ upstream</Btn>
        <p className="hint">Reference an upstream from a proxy rule with target "upstream:{name}".</p>
      </Section>

      <Section title="Security">
        <Toggle checked={s.rateLimit.enabled} onChange={v => set({ enabled: v }, 'rateLimit')} label="Rate limiting"
          {...tog('rateLimit.enabled', v => set({ enabled: v }, 'rateLimit'))} />
        {s.rateLimit.enabled && <>
          <Field label={`Requests/sec: ${s.rateLimit.rps}`} {...chip('rateLimit.rps', s.rateLimit.rps, v => set({ rps: v }, 'rateLimit'))}>
            <input type="range" min="1" max="1000" value={s.rateLimit.rps} onChange={e => set({ rps: Number(e.target.value) }, 'rateLimit')} />
          </Field>
          <Field label={`Burst: ${s.rateLimit.burst}`} {...chip('rateLimit.burst', s.rateLimit.burst, v => set({ burst: v }, 'rateLimit'))}>
            <input type="range" min="1" max="200" value={s.rateLimit.burst} onChange={e => set({ burst: Number(e.target.value) }, 'rateLimit')} />
          </Field>
          <p className="hint">
            The zone counts per client address, so an office behind one NAT — or anything behind a
            CDN — shares a single bucket. nginx answers 503 to the excess rather than queueing it,
            which is why the default sits well above what a page of assets costs.
          </p>
        </>}
        <Field label="IP rules" {...chip('ipRules.mode', s.ipRules.mode, v => set({ mode: v }, 'ipRules'))}>
          <select value={s.ipRules.mode} onChange={e => set({ mode: e.target.value }, 'ipRules')}>
            <option value="none">none</option>
            <option value="allowlist">allowlist (only these IPs)</option>
            <option value="denylist">denylist (block these IPs)</option>
          </select>
        </Field>
        {s.ipRules.mode !== 'none' && <>
          {s.ipRules.ips.map((ip, i) => (
            <div className="row" key={i}>
              <input value={ip} placeholder="1.2.3.4 or 10.0.0.0/24" onChange={e => setArr('ipRules', { ...s.ipRules, ips: s.ipRules.ips.map((x, j) => j === i ? e.target.value : x) })} />
              <Chip def="" value={ip} title="clear this row"
                onUse={() => set({ ips: s.ipRules.ips.map((x, j) => j === i ? '' : x) }, 'ipRules')} />
              <Btn kind="danger" onClick={() => set({ ips: s.ipRules.ips.filter((_, j) => j !== i) }, 'ipRules')}>✕</Btn>
            </div>
          ))}
          <Btn onClick={() => set({ ips: [...s.ipRules.ips, ''] }, 'ipRules')}>+ IP</Btn>
          {/* A list that reads "on" while emitting nothing is the failure this warns about: an
              allowlist with no address is refused at save, not written open. */}
          {s.ipRules.mode === 'allowlist' && !s.ipRules.ips.some(x => x.trim()) && (
            <p className="hint warn">An allowlist with no address is refused at save: empty, it would emit no rule at all and serve everyone; with blank rows it would emit <code>deny all</code> and serve nobody, you included.</p>
          )}
        </>}
        <Toggle checked={s.basicAuth.enabled} onChange={v => set({ enabled: v }, 'basicAuth')} label="Basic HTTP auth"
          {...tog('basicAuth.enabled', v => set({ enabled: v }, 'basicAuth'))} />
        {s.basicAuth.enabled && <>
          {s.basicAuth.users.map((u, i) => (
            <div className="row" key={i}>
              <input value={u.user} placeholder="username" onChange={e => setArr('basicAuth', { ...s.basicAuth, users: s.basicAuth.users.map((x, j) => j === i ? { ...x, user: e.target.value } : x) })} />
              <input type="password" value={u.password} placeholder="password" onChange={e => setArr('basicAuth', { ...s.basicAuth, users: s.basicAuth.users.map((x, j) => j === i ? { ...x, password: e.target.value } : x) })} />
              <Chip def={USER_ROW} value={u} title="clear this user row"
                onUse={d => setArr('basicAuth', { ...s.basicAuth, users: s.basicAuth.users.map((x, j) => j === i ? { ...x, ...d } : x) })} />
              <Btn kind="danger" onClick={() => set({ users: s.basicAuth.users.filter((_, j) => j !== i) }, 'basicAuth')}>✕</Btn>
            </div>
          ))}
          <Btn onClick={() => set({ users: [...s.basicAuth.users, { ...USER_ROW }] }, 'basicAuth')}>+ user</Btn>
          {!s.basicAuth.users.some(u => u.user && u.password) && (
            <p className="hint warn">Every request answers 401 until there is one row with both halves filled in — no users at all emits no auth at all, so the site would be open instead of closed.</p>
          )}
        </>}
      </Section>

      <Section title="Performance">
        <Toggle checked={s.gzip.enabled} onChange={v => set({ enabled: v }, 'gzip')} label="Gzip compression"
          {...tog('gzip.enabled', v => set({ enabled: v }, 'gzip'))} />
        {s.gzip.enabled && <div className="checks">
          <Chip def={D.gzip.types} value={s.gzip.types} onUse={v => set({ types: v }, 'gzip')} />
          {GZIP_TYPES.map(t => (
            <label key={t} className="toggle">
              <input type="checkbox" checked={s.gzip.types.includes(t)}
                onChange={e => set({ types: e.target.checked ? [...s.gzip.types, t] : s.gzip.types.filter(x => x !== t) }, 'gzip')} />
              <span>{t}</span>
            </label>
          ))}
        </div>}
        <Toggle checked={s.listen.http2} onChange={v => upL({ http2: v })} label="HTTP/2" {...tog('listen.http2', v => upL({ http2: v }))} />
        <Toggle checked={s.listen.http3} onChange={v => upL({ http3: v })} label="HTTP/3 (QUIC — needs nginx ≥ 1.25)" {...tog('listen.http3', v => upL({ http3: v }))} />
        <Toggle checked={s.listen.reuseport} onChange={v => upL({ reuseport: v })} label="reuseport (one accept queue per worker, on every listener of the port)" {...tog('listen.reuseport', v => upL({ reuseport: v }))} />
        <Toggle checked={s.staticCache.enabled} onChange={v => set({ enabled: v }, 'staticCache')} label="Browser caching for static files"
          {...tog('staticCache.enabled', v => set({ enabled: v }, 'staticCache'))} />
        {s.staticCache.enabled && <>
          <Field label={`Expires after: ${s.staticCache.expiresDays} days`} {...chip('staticCache.expiresDays', s.staticCache.expiresDays, v => set({ expiresDays: v }, 'staticCache'))}>
            <input type="range" min="1" max="365" value={s.staticCache.expiresDays} onChange={e => set({ expiresDays: Number(e.target.value) }, 'staticCache')} />
          </Field>
          <div className="checks">
            <Chip def={D.staticCache.extensions} value={s.staticCache.extensions} onUse={v => set({ extensions: v }, 'staticCache')} />
            {CACHE_EXT.map(t => (
              <label key={t} className="toggle">
                <input type="checkbox" checked={s.staticCache.extensions.includes(t)}
                  onChange={e => set({ extensions: e.target.checked ? [...s.staticCache.extensions, t] : s.staticCache.extensions.filter(x => x !== t) }, 'staticCache')} />
                <span>.{t}</span>
              </label>
            ))}
          </div>
        </>}
      </Section>

      {!isNew && site.managed && <FileManager siteName={s.name} />}
      {!!warns.length && (
        <div className="warns">
          <b>saved — worth a look</b>
          <ul>{warns.map((w, i) => <li key={i}>{w}</li>)}</ul>
        </div>
      )}
      <Out result={result} />

      <div className="savebar">
        <Btn kind="primary" disabled={busy || (isNew && !s.name.trim())} onClick={save}>{busy ? '…' : 'Save & apply'}</Btn>
        {!isNew && <>
          {/* greyed rather than left to bounce off a 403: an operator who cannot reach this page
              again has no way back to the button that explains why */}
          <Btn disabled={busy || (site.self && site.enabled)} onClick={() => toggle(site.enabled ? 'disable' : 'enable')}
            title={site.self && site.enabled ? 'This vhost is how you reached this page — disabling it is refused.' : ''}>
            {site.enabled ? 'Disable' : 'Enable'}
          </Btn>
          <Btn kind="danger" disabled={busy || !!site.self} onClick={del}
            title={site.self ? 'This vhost is how you reached this page — deleting it is refused.' : ''}>
            Delete
          </Btn>
        </>}
        <span className="spacer" />
        <span className="note">
          {result ? (result.ok ? 'applied' : 'rejected — conf rolled back')
            : dirty ? 'unsaved changes' : 'writes → nginx -t → reload'}
        </span>
      </div>
    </div>
  )
}
