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
 * Publishing the dashboard's own vhost — the one thing the Sites module cannot do for itself,
 * because the site has to be named exactly what the server pins (DASH_SELF_NAME) or the guards
 * do not recognise it. Getting that name wrong by hand fails silently, which is why the button
 * exists: it is the same prefill every time, including the parts that are easy to leave out.
 */
function Access({ status }) {
  const [has, setHas] = useState(null) // is the self vhost already a managed site?
  const [result, setResult] = useState(null)
  const [busy, setBusy] = useState(false)
  const [addr, setAddr] = useState('')
  const [domain, setDomain] = useState('')

  const self = status?.selfName || ''
  const addrs = status?.addresses || []
  const bindAddr = addr || addrs[0]?.address || ''

  useEffect(() => {
    if (!self) { setHas(false); return }
    api('GET', '/api/sites')
      .then(r => setHas(r.sites.some(s => s.name === self)))
      .catch(() => setHas(null))
  }, [self, result])

  const publish = async () => {
    setBusy(true)
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
      setResult({
        ok: true,
        output: `created "${r.site.name}" — it is written but not enabled yet. Open it under Sites and click Enable to put it live.`
          + (r.warnings?.length ? `\n\nworth a look:\n` + r.warnings.map(w => `  ! ${w}`).join('\n') : ''),
      })
    } catch (e) { setResult({ ok: false, output: e.message }) } finally { setBusy(false) }
  }

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

        {self && has === false && <>
          <p className="sub">
            Publish a vhost for this dashboard: bound to one LAN address, allowlisted to private
            ranges only, rate limited, and proxying <code>/</code> back to this process. It is
            created disabled — Enable it on the Sites tab, which is also where it gets a TLS
            certificate.
          </p>
          <Field label="Bind to address">
            <select value={bindAddr} onChange={e => setAddr(e.target.value)}>
              {!addrs.length && <option value="">(no non-loopback address found)</option>}
              {addrs.map(a => <option key={a.address} value={a.address}>{a.address}  (IPv{a.family})</option>)}
            </select>
          </Field>
          <Field label="Domains (comma-separated, optional)">
            <input value={domain} onChange={e => setDomain(e.target.value)} placeholder="dash.example.com — or leave blank and use the IP" />
          </Field>
          <div className="actions">
            <Btn kind="primary" disabled={busy || !bindAddr} onClick={publish}>{busy ? '…' : `Publish as "${self}"`}</Btn>
          </div>
        </>}

        {self && has === true && (
          <p className="sub">
            <b>{self}</b> is published and pinned: it is listed under Sites with a <em>self</em> badge,
            deleting or disabling it is refused, and every save of it is checked to still point back
            at this process.
          </p>
        )}

        <Out result={result} />
      </div>
    </section>
  )
}

export default function Control({ status, onStatus }) {
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

      <Access status={status} />
    </div>
  )
}
