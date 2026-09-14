import { useEffect, useState } from 'react'
import { api } from '../api.js'
import { Btn } from './ui.jsx'
import SiteForm from './SiteForm.jsx'

// What the row's subtitle line says. Managed sites carry their real config; the ones that only
// exist as a conf file on disk have nothing but the name.
const subtitle = s => {
  if (!s.managed) return 'conf on disk, not in the manifest'
  const names = (s.domains || []).join(' · ')
  return `${names || 'any name'}  :${s.port}`
}

export default function Sites({ onDirty }) {
  const [sites, setSites] = useState(null)
  const [drift, setDrift] = useState(false) // the shared http-context file differs from the manifest
  const [selected, setSelected] = useState(null) // site name or 'new'
  const [dirty, setDirty] = useState(false)

  const markDirty = v => { setDirty(v); onDirty?.(v) }
  const load = () => api('GET', '/api/sites')
    .then(r => { setSites(r.sites); setDrift(!!r.httpConfDrift) })
    .catch(() => setSites([]))
  useEffect(() => { load() }, [])
  // leaving the module disarms the app-level guard; the form is gone, nothing left to lose
  useEffect(() => () => onDirty?.(false), [])

  // Selecting unmounts the form and every edit in it. Ask first rather than lose them.
  const select = name => {
    if (name === selected) return
    if (dirty && !confirm('Discard unsaved changes to this site?')) return
    markDirty(false)
    setSelected(name)
  }

  if (sites === null) return <div className="loading">…</div>

  const creating = selected === 'new'
  const site = !creating && selected ? sites.find(s => s.name === selected) : null

  return (
    <div className="sites">
      <aside className="panel">
        <div className="panel-head">
          <span className="panel-title">Sites</span>
          <span className="spacer" />
          <span className="chip">{sites.length}</span>
        </div>
        <div className="panel-body">
          {drift && (
            <div className="mb" title="00-dashboard.conf on disk is not what the manifest would render — the next save rewrites it">
              <span className="chip warn">shared conf drifted</span>
            </div>
          )}
          <ul>
            {sites.map(s => (
              <li key={s.name} className={selected === s.name ? 'active' : ''} onClick={() => select(s.name)}>
                <span className={`dot ${s.drift ? 'warn' : s.enabled ? '' : 'idle'}`} />
                <span className="col">
                  <span className="site-name">{s.name}</span>
                  <span className="site-dom">{subtitle(s)}</span>
                </span>
                <span className="badges">
                  {s.self && <em className="chip self" title="the vhost this dashboard is reached through — cannot be disabled or deleted">self</em>}
                  {s.drift && <em className="chip warn" title={`the conf file is ${s.drift} — saving from here rewrites it`}>{s.drift}</em>}
                  {!s.managed && <em className="chip un">unmanaged</em>}
                  {s.managed && <em className={`chip ${s.enabled ? 'ok' : 'off'}`}>{s.enabled ? 'on' : 'off'}</em>}
                </span>
              </li>
            ))}
            {!sites.length && <li className="none">no sites yet</li>}
          </ul>
          <Btn kind="primary" onClick={() => select('new')}>+ New site</Btn>
        </div>
      </aside>

      <section className="site-pane">
        {creating && <SiteForm key="new" onSaved={name => { load(); setSelected(name) }} onDirty={markDirty} />}
        {site && <SiteForm key={site.name} site={site} onDirty={markDirty}
          onSaved={() => { load(); setSelected(site.name) }}
          onDeleted={() => { load(); markDirty(false); setSelected(null) }} />}
        {!creating && !site && (
          <div className="panel-body">
            <p className="hint">Select a site on the left, or create one. Every save writes the conf, runs <code>nginx -t</code>, and only then reloads — a config nginx rejects is rolled back and the old file stays.</p>
          </div>
        )}
      </section>
    </div>
  )
}
