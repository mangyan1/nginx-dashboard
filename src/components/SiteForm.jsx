import { useState } from 'react'
import { api } from '../api.js'
import { Btn, Field, Toggle, Section, Out, useAsync } from './ui.jsx'
import FileManager from './FileManager.jsx'

const GZIP_TYPES = ['text/css', 'application/javascript', 'application/json', 'image/svg+xml', 'text/plain', 'text/xml', 'application/xml']
const CACHE_EXT = ['css', 'js', 'png', 'jpg', 'jpeg', 'gif', 'svg', 'ico', 'woff', 'woff2', 'pdf']

const blank = { name: '', domains: '', root: '', port: 80 }

export default function SiteForm({ site, onSaved, onDeleted }) {
  const isNew = !site
  const [s, setS] = useState(() => ({
    name: site?.name || '',
    domains: (site?.domains || []).join(', '),
    root: site?.root || '',
    port: site?.port || 80,
    https: site?.https || { mode: 'none', forceRedirect: false, manualCert: '', manualKey: '' },
    listen: site?.listen || { http2: false, http3: false },
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
      <Section title="Basics">
        {isNew && <Field label="Name (slug)"><input value={s.name} onChange={e => set({ name: e.target.value })} placeholder="myapp" /></Field>}
        <Field label="Domains (comma-separated)"><input value={s.domains} onChange={e => set({ domains: e.target.value })} placeholder="myapp.example.com, www.myapp.example.com" /></Field>
        <Field label="Document root"><input value={s.root} onChange={e => set({ root: e.target.value })} placeholder={`/var/www/${s.name || 'myapp'}`} /></Field>
        <Field label="Port (HTTP)"><input type="number" value={s.port} onChange={e => set({ port: Number(e.target.value) })} /></Field>
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
        <Toggle checked={s.https.forceRedirect} onChange={v => upS({ forceRedirect: v })} label="Force HTTPS redirect (port 80 → 301)" />
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
        <p className="hint">Empty proxy list = serve static files from the document root.</p>
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

      <div className="row form-actions">
        <Btn kind="primary" disabled={busy || !s.domains.trim() || (isNew && !s.name.trim())} onClick={save}>{busy ? '…' : 'Save & apply'}</Btn>
        {!isNew && <>
          <Btn disabled={busy} onClick={() => toggle(site.enabled ? 'disable' : 'enable')}>{site.enabled ? 'Disable' : 'Enable'}</Btn>
          <Btn kind="danger" disabled={busy} onClick={del}>Delete</Btn>
        </>}
      </div>
      <Out result={result} />
      {!isNew && site.managed && <FileManager siteName={s.name} />}
    </div>
  )
}