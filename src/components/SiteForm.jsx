import { useEffect, useState } from 'react'
import { api } from '../api.js'
import { Btn, Field, Toggle, Section, Out, useAsync } from './ui.jsx'
import FileManager from './FileManager.jsx'

const GZIP_TYPES = ['text/css', 'application/javascript', 'application/json', 'image/svg+xml', 'text/plain', 'text/xml', 'application/xml']
const CACHE_EXT = ['css', 'js', 'png', 'jpg', 'jpeg', 'gif', 'svg', 'ico', 'woff', 'woff2', 'pdf']

const PHP_BLANK = { enabled: false, endpoint: '', frontController: false }

export default function SiteForm({ site, onSaved, onDeleted, onDirty }) {
  const isNew = !site
  const [s, setS] = useState(() => ({
    name: site?.name || '',
    domains: (site?.domains || []).join(', '),
    root: site?.root || '',
    port: site?.port || 80,
    serveHttp: site?.serveHttp !== false,
    httpsPort: site?.httpsPort || 443,
    index: site?.index || 'index.html index.htm',
    clientMaxBodySize: site?.clientMaxBodySize || 0,
    https: site?.https || { mode: 'none', forceRedirect: false, manualCert: '', manualKey: '' },
    hsts: site?.hsts || { enabled: false, maxAge: 31536000, includeSubDomains: false, preload: false },
    listen: site?.listen || { http2: false, http3: false, reuseport: false },
    php: site?.php || PHP_BLANK,
    proxy: site?.proxy ? [...site.proxy] : [],
    upstreams: site?.upstreams ? site.upstreams.map(u => ({ ...u, servers: [...u.servers] })) : [],
    rateLimit: site?.rateLimit || { enabled: false, rps: 10, burst: 20 },
    ipRules: site?.ipRules || { mode: 'none', ips: [] },
    basicAuth: site?.basicAuth || { enabled: false, users: [] },
    gzip: site?.gzip || { enabled: true, types: GZIP_TYPES.slice(0, 5) },
    staticCache: site?.staticCache || { enabled: true, extensions: CACHE_EXT.slice(0, 9), expiresDays: 30 },
  }))
  const [result, setResult] = useState(null)
  const [busy, setBusy] = useState(false)
  // the state this form was opened (or last saved) with, so "dirty" means "differs from that"
  const [baseline, setBaseline] = useState(() => JSON.stringify(s))
  const dirty = JSON.stringify(s) !== baseline
  useEffect(() => { onDirty?.(dirty) }, [dirty, onDirty])

  const set = (patch, key) => setS(prev => ({ ...prev, ...(key ? { [key]: { ...prev[key], ...patch } } : patch) }))
  const setArr = (key, arr) => setS(prev => ({ ...prev, [key]: arr }))
  const upS = patch => setS(prev => ({ ...prev, https: { ...prev.https, ...patch } }))
  const upL = patch => setS(prev => ({ ...prev, listen: { ...prev.listen, ...patch } }))

  const toPayload = () => ({
    ...s,
    domains: s.domains.split(',').map(d => d.trim()).filter(Boolean),
    root: s.root || `/var/www/${s.name}`,
  })

  const save = async () => {
    setBusy(true)
    try {
      const p = toPayload()
      const r = isNew
        ? await api('POST', '/api/sites', p)
        : await api('PUT', `/api/sites/${s.name}`, p)
      setResult({ ok: true, output: 'saved & applied' })
      // re-baseline: an existing site keeps its key, so the form is not remounted after a save
      // and would otherwise stay "dirty" forever, prompting on the next click
      setBaseline(JSON.stringify(s))
      onSaved(p.name)
    } catch (e) {
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
        </>}
        <span className="spacer" />
        {dirty && <span className="chip warn">unsaved</span>}
      </div>
      <Section title="Basics">
        {isNew && <Field label="Name (slug)"><input value={s.name} onChange={e => set({ name: e.target.value })} placeholder="myapp" /></Field>}
        <Field label="Domains (comma-separated)"><input value={s.domains} onChange={e => set({ domains: e.target.value })} placeholder="myapp.example.com — blank answers to any name on this port" /></Field>
        <Field label="Document root"><input value={s.root} onChange={e => set({ root: e.target.value })} placeholder={`/var/www/${s.name || 'myapp'}`} /></Field>
        <Field label="Index files (in order)"><input value={s.index} onChange={e => set({ index: e.target.value })} placeholder="index.php index.html" /></Field>
        <Field label="Port (HTTP)"><input type="number" value={s.port} onChange={e => set({ port: Number(e.target.value) })} /></Field>
        <Field label="Max request body (MB)"><input type="number" min="0" value={s.clientMaxBodySize} onChange={e => set({ clientMaxBodySize: Number(e.target.value) })} placeholder="0" /></Field>
        <p className="hint">0 keeps nginx's own 1m default. Raise it for large uploads — nginx answers 413 before the file ever reaches PHP or the backend.</p>
      </Section>

      <Section title="HTTPS">
        <Field label="Certificate">
          <select value={s.https.mode} onChange={e => upS({ mode: e.target.value })}>
            <option value="none">off</option>
            <option value="selfsigned">self-signed</option>
            <option value="certbot">Let's Encrypt (certbot)</option>
            <option value="manual">existing cert paths</option>
          </select>
        </Field>
        {s.https.mode === 'manual' && <>
          <Field label="Cert file path"><input value={s.https.manualCert} onChange={e => upS({ manualCert: e.target.value })} placeholder="/etc/ssl/certs/site.pem" /></Field>
          <Field label="Key file path"><input value={s.https.manualKey} onChange={e => upS({ manualKey: e.target.value })} placeholder="/etc/ssl/private/site.key" /></Field>
        </>}
        <Field label="Port (HTTPS)"><input type="number" value={s.httpsPort} onChange={e => set({ httpsPort: Number(e.target.value) })} /></Field>
        <Toggle checked={s.serveHttp} onChange={v => set({ serveHttp: v })} label="Also serve plain HTTP on the port above" />
        {s.serveHttp && s.https.mode !== 'none' && <Toggle checked={s.https.forceRedirect} onChange={v => upS({ forceRedirect: v })} label={`Force HTTPS redirect (plain HTTP → 301 on port ${s.httpsPort})`} />}
        {/* Only offered once there is a certificate to enforce — the header is ignored on a
            plain-HTTP response, so on an HTTPS-off site the toggle would do nothing at all. */}
        {s.https.mode !== 'none' && <>
          <Toggle checked={s.hsts.enabled} onChange={v => set({ enabled: v }, 'hsts')} label="HSTS — tell browsers to refuse plain HTTP for this domain" />
          {s.hsts.enabled && <>
            <p className="hint">A one-way door: once a browser has seen this header it will refuse plain HTTP to {s.domains.trim() || 'this domain'} for the whole max-age, even if you turn this off again. Turn it on when HTTPS is confirmed working, not before.</p>
            <Field label={`Max-age: ${Math.round(s.hsts.maxAge / 86400)} days`}>
              <input type="range" min="86400" max="63072000" step="86400" value={s.hsts.maxAge} onChange={e => set({ maxAge: Number(e.target.value) }, 'hsts')} />
            </Field>
            <Toggle checked={s.hsts.includeSubDomains} onChange={v => set({ includeSubDomains: v }, 'hsts')} label="Include subdomains — every subdomain must then serve a valid cert too" />
            <Toggle checked={s.hsts.preload} onChange={v => set({ preload: v }, 'hsts')} label="preload — opt in to the browsers' hardcoded list (needs one year and subdomains)" />
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
            <input value={p.path} placeholder="/api" onChange={e => setArr('proxy', s.proxy.map((x, j) => j === i ? { ...x, path: e.target.value } : x))} />
            <input value={p.target} placeholder="http://127.0.0.1:3000" onChange={e => setArr('proxy', s.proxy.map((x, j) => j === i ? { ...x, target: e.target.value } : x))} />
            <Btn kind="danger" onClick={() => setArr('proxy', s.proxy.filter((_, j) => j !== i))}>✕</Btn>
          </div>
        ))}
        <Btn onClick={() => setArr('proxy', [...s.proxy, { path: '/', target: 'http://127.0.0.1:8080', verify: false }])}>+ proxy rule</Btn>
        <p className="hint">Empty proxy list = serve static files from the document root, resolving <code>/about</code> to <code>about.html</code> as well as <code>about/index.html</code> — which is what a static Astro or Next export needs. A rule on <code>/</code> replaces that.</p>
      </Section>

      <Section title="Application backend">
        <p className="hint">FastCGI covers PHP-FPM and anything else that speaks it — WordPress, AzuraCast, Laravel. A Node, Python or container app is a proxy rule above instead.</p>
        <Toggle checked={s.php.enabled} onChange={v => set({ enabled: v, endpoint: s.php.endpoint, frontController: s.php.frontController }, 'php')} label="Serve .php through FastCGI" />
        {s.php.enabled && <>
          <Field label="FastCGI endpoint">
            <input value={s.php.endpoint} onChange={e => set({ endpoint: e.target.value }, 'php')} placeholder="unix:/run/php/php8.3-fpm.sock  or  127.0.0.1:9000" />
          </Field>
          <Toggle checked={s.php.frontController} onChange={v => set({ frontController: v }, 'php')} label="Front controller — unmatched paths go to /index.php" />
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
              <Btn kind="danger" onClick={() => setArr('upstreams', s.upstreams.filter((_, j) => j !== ui))}>✕</Btn>
            </div>
            {u.servers.map((sv, si) => (
              <div className="row" key={si}>
                <select value={sv.scheme} onChange={e => setArr('upstreams', s.upstreams.map((x, j) => j === ui ? { ...x, servers: x.servers.map((y, k) => k === si ? { ...y, scheme: e.target.value } : y) } : x))}>
                  <option value="http">http</option>
                  <option value="https">https</option>
                </select>
                <input value={sv.host} placeholder="127.0.0.1" onChange={e => setArr('upstreams', s.upstreams.map((x, j) => j === ui ? { ...x, servers: x.servers.map((y, k) => k === si ? { ...y, host: e.target.value } : y) } : x))} />
                <input type="number" value={sv.port} placeholder="3001" onChange={e => setArr('upstreams', s.upstreams.map((x, j) => j === ui ? { ...x, servers: x.servers.map((y, k) => k === si ? { ...y, port: Number(e.target.value) } : y) } : x))} />
                <Btn kind="danger" onClick={() => setArr('upstreams', s.upstreams.map((x, j) => j === ui ? { ...x, servers: x.servers.filter((_, k) => k !== si) } : x))}>✕</Btn>
              </div>
            ))}
            <Btn onClick={() => setArr('upstreams', s.upstreams.map((x, j) => j === ui ? { ...x, servers: [...x.servers, { scheme: 'http', host: '127.0.0.1', port: 3001 }] } : x))}>+ backend server</Btn>
          </div>
        ))}
        <Btn onClick={() => setArr('upstreams', [...s.upstreams, { name: `${s.name || 'app'}_backends`, algorithm: 'round_robin', servers: [{ scheme: 'http', host: '127.0.0.1', port: 3001 }], healthCheck: false }])}>+ upstream</Btn>
        <p className="hint">Reference an upstream from a proxy rule with target "upstream:{name}".</p>
      </Section>

      <Section title="Security">
        <Toggle checked={s.rateLimit.enabled} onChange={v => set({ enabled: v, rps: s.rateLimit.rps, burst: s.rateLimit.burst }, 'rateLimit')} label="Rate limiting" />
        {s.rateLimit.enabled && <>
          <Field label={`Requests/sec: ${s.rateLimit.rps}`}>
            <input type="range" min="1" max="1000" value={s.rateLimit.rps} onChange={e => set({ rps: Number(e.target.value) }, 'rateLimit')} />
          </Field>
          <Field label={`Burst: ${s.rateLimit.burst}`}>
            <input type="range" min="1" max="200" value={s.rateLimit.burst} onChange={e => set({ burst: Number(e.target.value) }, 'rateLimit')} />
          </Field>
        </>}
        <Field label="IP rules">
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
              <Btn kind="danger" onClick={() => set({ ips: s.ipRules.ips.filter((_, j) => j !== i) }, 'ipRules')}>✕</Btn>
            </div>
          ))}
          <Btn onClick={() => set({ ips: [...s.ipRules.ips, ''] }, 'ipRules')}>+ IP</Btn>
        </>}
        <Toggle checked={s.basicAuth.enabled} onChange={v => set({ enabled: v, users: s.basicAuth.users }, 'basicAuth')} label="Basic HTTP auth" />
        {s.basicAuth.enabled && <>
          {s.basicAuth.users.map((u, i) => (
            <div className="row" key={i}>
              <input value={u.user} placeholder="username" onChange={e => setArr('basicAuth', { ...s.basicAuth, users: s.basicAuth.users.map((x, j) => j === i ? { ...x, user: e.target.value } : x) })} />
              <input type="password" value={u.password} placeholder="password" onChange={e => setArr('basicAuth', { ...s.basicAuth, users: s.basicAuth.users.map((x, j) => j === i ? { ...x, password: e.target.value } : x) })} />
              <Btn kind="danger" onClick={() => set({ users: s.basicAuth.users.filter((_, j) => j !== i) }, 'basicAuth')}>✕</Btn>
            </div>
          ))}
          <Btn onClick={() => set({ users: [...s.basicAuth.users, { user: '', password: '' }] }, 'basicAuth')}>+ user</Btn>
        </>}
      </Section>

      <Section title="Performance">
        <Toggle checked={s.gzip.enabled} onChange={v => set({ enabled: v, types: s.gzip.types }, 'gzip')} label="Gzip compression" />
        {s.gzip.enabled && <div className="checks">
          {GZIP_TYPES.map(t => (
            <label key={t} className="toggle">
              <input type="checkbox" checked={s.gzip.types.includes(t)}
                onChange={e => set({ types: e.target.checked ? [...s.gzip.types, t] : s.gzip.types.filter(x => x !== t) }, 'gzip')} />
              <span>{t}</span>
            </label>
          ))}
        </div>}
        <Toggle checked={s.listen.http2} onChange={v => upL({ http2: v })} label="HTTP/2" />
        <Toggle checked={s.listen.http3} onChange={v => upL({ http3: v })} label="HTTP/3 (QUIC — needs nginx ≥ 1.25)" />
        <Toggle checked={s.listen.reuseport} onChange={v => upL({ reuseport: v })} label="reuseport (one accept queue per worker, on every listener of the port)" />
        <Toggle checked={s.staticCache.enabled} onChange={v => set({ enabled: v, extensions: s.staticCache.extensions, expiresDays: s.staticCache.expiresDays }, 'staticCache')} label="Browser caching for static files" />
        {s.staticCache.enabled && <>
          <Field label={`Expires after: ${s.staticCache.expiresDays} days`}>
            <input type="range" min="1" max="365" value={s.staticCache.expiresDays} onChange={e => set({ expiresDays: Number(e.target.value) }, 'staticCache')} />
          </Field>
          <div className="checks">
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
      <Out result={result} />

      <div className="savebar">
        <Btn kind="primary" disabled={busy || (isNew && !s.name.trim())} onClick={save}>{busy ? '…' : 'Save & apply'}</Btn>
        {!isNew && <>
          <Btn disabled={busy} onClick={() => toggle(site.enabled ? 'disable' : 'enable')}>{site.enabled ? 'Disable' : 'Enable'}</Btn>
          <Btn kind="danger" disabled={busy} onClick={del}>Delete</Btn>
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