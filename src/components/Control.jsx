import { useEffect, useState } from 'react'
import { api } from '../api.js'
import { Btn, Field, Out, useAsync } from './ui.jsx'

const ACTIONS = ['start', 'stop', 'restart', 'reload', 'test']

// stop and restart both drop in-flight connections; reload is the one you almost always want,
// so it is the only primary and the other two say what they will actually cost.
const CONFIRM = {
  stop: 'Stop nginx? Every site goes offline and in-flight connections are dropped.',
  restart: 'Restart nginx? In-flight connections are dropped — reload applies config without that.',
}

// The RFC1918 + loopback set, which is what "on the LAN" means for an allowlist. Written out
// rather than computed: this is a list of the ranges a private network uses, and it is short.
const LAN_RANGES = ['127.0.0.1/32', '::1/128', '10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16', 'fc00::/7', 'fe80::/10']

/**
 * The dashboard's own vhost — the one thing the Sites module cannot do for itself, because the site
 * has to be named exactly what the server pins (DASH_SELF_NAME) or the guards do not recognise it.
 * Getting that name wrong by hand fails silently, which is why the button exists.
 *
 * It is also the only place it can be reached from now that Sites lists only the sites you serve,
 * so every state has to be resolvable from here: not published, published but broken, and fine.
 */
function Access({ status, onOpenSite }) {
  const [sites, setSites] = useState(null) // null = not loaded yet
  const [result, setResult] = useState(null)
  const [busy, setBusy] = useState(false)
  const [addr, setAddr] = useState('')
  const [domain, setDomain] = useState('')

  const self = status?.selfName || ''
  const addrs = status?.addresses || []
  const bindAddr = addr || addrs[0]?.address || ''

  useEffect(() => {
    if (!self) return
    api('GET', '/api/sites').then(setSites).catch(() => setSites(null))
  }, [self, result])

  const row = sites?.sites.find(s => s.name === self)
  const managed = !!row?.managed
  // the conf is gone from sites-available while its entry stays in sites-enabled: nginx fails on
  // the dangling include, so *every* write on the box is refused until it is back
  const broken = managed && row.drift === 'missing'
  const unmanaged = !!row && !row.managed

  const publish = async () => {
    setBusy(true)
    setResult(null)
    try {
      const r = await api('POST', '/api/sites', {
        name: self,
        domains: domain.split(',').map(d => d.trim()).filter(Boolean),
        listenAddress: bindAddr,
        proxy: [{ path: '/', target: `http://127.0.0.1:${status.port}` }],
        // at least as large as the dashboard's own upload limit, or a zip deploy 413s at the
        // vhost before the dashboard ever gets to answer
        clientMaxBodySize: status.maxUploadMB || 2048,
        ipRules: { mode: 'allowlist', ips: LAN_RANGES },
        rateLimit: { enabled: true, rps: 30, burst: 60 },
      })
      // Enable in the same click: a site is created disabled, and "now go and click Enable on the
      // Sites tab" stopped being true the moment the vhost was hidden from it
      await api('POST', `/api/sites/${self}/enable`)
      setResult({
        ok: true,
        output: `published "${self}" on ${bindAddr} and enabled it. Manage opens it as a form, where it can take a certificate or be changed.`
          + (r.warnings?.length ? `\n\nworth a look:\n` + r.warnings.map(w => `  ! ${w}`).join('\n') : ''),
      })
    } catch (e) { setResult({ ok: false, output: e.message }) } finally { setBusy(false) }
  }

  const repair = async () => {
    setBusy(true)
    setResult(null)
    try {
      await api('POST', `/api/sites/${self}/repair`)
      setResult({ ok: true, output: `rewrote ${self}.conf from what this dashboard has saved for it.` })
    } catch (e) { setResult({ ok: false, output: e.message }) } finally { setBusy(false) }
  }

  const enable = async () => {
    setBusy(true)
    setResult(null)
    try {
      await api('POST', `/api/sites/${self}/enable`)
      setResult({ ok: true, output: `${self} is enabled — nginx is serving this dashboard through it again.` })
    } catch (e) { setResult({ ok: false, output: e.message }) } finally { setBusy(false) }
  }

  const fields = <>
    <Field label="Bind to address">
      <select value={bindAddr} onChange={e => setAddr(e.target.value)}>
        {!addrs.length && <option value="">(no non-loopback address found)</option>}
        {addrs.map(a => <option key={a.address} value={a.address}>{a.address}  (IPv{a.family})</option>)}
      </select>
    </Field>
    <Field label="Domains (comma-separated, optional)">
      <input value={domain} onChange={e => setDomain(e.target.value)} placeholder="dash.example.com — or leave blank and use the IP" />
    </Field>
  </>

  return (
    <section className="panel">
      <div className="panel-head">
        <span className="panel-title">Reaching this dashboard</span>
        <span className="spacer" />
        <span className="kv"><i>listening on</i><b>{status?.host}:{status?.port}</b></span>
      </div>
      <div className="panel-body">
        <div className="row">
          <span className="kv"><i>pinned vhost</i><b className={self ? 'accent' : 'dim'}>{self || 'none'}</b></span>
          <span className="kv"><i>second factor</i><b className={status?.totp ? 'ok' : 'dim'}>{status?.totp ? 'on' : 'off'}</b></span>
          <span className="kv"><i>upload limit</i><b>{status?.maxUploadMB} MB</b></span>
        </div>

        {!self && (
          <p className="sub">
            No site is pinned as this dashboard's own, so nothing marks its vhost as the one you
            must not disable. Add <code>Environment=DASH_SELF_NAME=nxd</code> to the service unit,
            run <code>systemctl daemon-reload &amp;&amp; systemctl restart nginx-dashboard</code>, and
            the button below appears.
          </p>
        )}

        {self && !sites && <p className="sub">…</p>}

        {self && sites && !row && <>
          <p className="sub">
            No vhost serves this dashboard yet. Publishing one binds it to a single LAN address,
            allowlists private ranges only, rate limits it, and proxies <code>/</code> back to this
            process — then nginx serves this dashboard on <b>{bindAddr || 'that address'}</b>.
          </p>
          {fields}
          <div className="actions">
            <Btn kind="primary" disabled={busy || !bindAddr} onClick={publish}>{busy ? '…' : `Publish as "${self}"`}</Btn>
          </div>
        </>}

        {self && unmanaged && <>
          <p className="sub">
            <b>{self}.conf</b> is on disk but not in the manifest, so nothing is guarding it — it can
            be disabled or deleted like any other site. Publishing takes it back as a managed site,
            which rewrites the conf from the settings below.
          </p>
          {fields}
          <div className="actions">
            <Btn kind="primary" disabled={busy || !bindAddr} onClick={publish}>{busy ? '…' : 'Take it back'}</Btn>
          </div>
        </>}

        {self && broken && <>
          <div className="mb"><span className="chip warn">conf missing</span></div>
          <p className="sub">
            <b>{self}.conf</b> is gone from sites-available while its entry is still in
            sites-enabled. nginx fails on the dangling include, so every save on every site is
            refused until it is back — the dashboard rewrites it by itself the next time anything
            changes, or now:
          </p>
          <div className="actions">
            <Btn kind="primary" disabled={busy} onClick={repair}>{busy ? '…' : 'Repair it now'}</Btn>
            <Btn disabled={busy} onClick={() => onOpenSite?.(self)}>Manage</Btn>
          </div>
        </>}

        {self && managed && !broken && !row.enabled && <>
          <div className="mb"><span className="chip off">disabled</span></div>
          <p className="sub">
            <b>{self}</b> is saved but not enabled, so nginx is not serving this dashboard through
            it — you are reaching it on {status?.host}:{status?.port} directly.
          </p>
          <div className="actions">
            <Btn kind="primary" disabled={busy} onClick={enable}>{busy ? '…' : 'Enable it'}</Btn>
            <Btn disabled={busy} onClick={() => onOpenSite?.(self)}>Manage</Btn>
          </div>
        </>}

        {self && managed && !broken && row.enabled && <>
          <p className="sub">
            <b>{self}</b> is published and pinned, and nginx is serving this dashboard through it.
            Disabling or deleting it is refused, and every save of it is checked to still point back
            at this process. It is not listed under Sites — it is not one of the sites you serve.
          </p>
          <div className="actions">
            <Btn onClick={() => onOpenSite?.(self)}>Manage</Btn>
          </div>
        </>}

        {sites?.selfRepair && !sites.selfRepair.ok && (
          <div className="mb">
            <span className="chip warn">rewrite refused</span>
            <p className="sub">
              The dashboard found its own conf missing and nginx refused the rewritten one:
              <br /><code>{sites.selfRepair.output}</code>
            </p>
          </div>
        )}

        <Out result={result} />
      </div>
    </section>
  )
}

export default function Control({ status, onStatus, onOpenSite }) {
  const [result, setResult] = useState(null)
  const [run, busy] = useAsync(async action => {
    setResult(await api('POST', `/api/nginx/${action}`))
    onStatus()
  })

  const click = a => { if (!CONFIRM[a] || confirm(CONFIRM[a])) run(a) }

  const dry = status?.dry
  const state = dry ? 'dry run' : (status?.active || 'unknown')
  const dot = dry ? 'warn' : status?.active === 'active' ? '' : 'err'

  return (
    <div className="control">
      <div className="sec-head">
        <h2>Process control</h2>
        <p>systemctl and nginx signals, no shell required</p>
      </div>

      <section className="panel">
        <div className="panel-head">
          <span className="panel-title">Actions</span>
          <span className="spacer" />
          <span className="kv"><i>engine</i><b className="live"><span className={`dot ${dot}`} />{state}</b></span>
        </div>
        <div className="panel-body">
          <div className="actions">
            {ACTIONS.map(a => (
              <Btn key={a} kind={a === 'reload' ? 'primary' : a === 'stop' ? 'danger' : ''}
                disabled={busy} onClick={() => click(a)}>
                {a === 'test' ? 'Test config' : a[0].toUpperCase() + a.slice(1)}
              </Btn>
            ))}
          </div>
          <p className="sub">
            Reload applies config without dropping connections. Test parses the config first and touches nothing.
            {dry && ' In dry mode nothing reaches nginx — the buttons report what they would run.'}
          </p>
          {status?.version && <p className="sub">{status.version}</p>}
        </div>
      </section>

      {result && (
        <section className="panel">
          <div className="panel-head">
            <span className="panel-title">Output</span>
            <span className="spacer" />
            <span className={`chip ${result.ok ? 'ok' : 'warn'}`}>{result.ok ? 'ok' : 'failed'}</span>
          </div>
          <div className="panel-body"><Out result={result} /></div>
        </section>
      )}

      <Access status={status} onOpenSite={onOpenSite} />
    </div>
  )
}
