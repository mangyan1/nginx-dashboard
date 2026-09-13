import { useEffect, useState } from 'react'
import { api } from '../api.js'
import { Btn } from './ui.jsx'
import SiteForm from './SiteForm.jsx'

export default function Sites({ onDirty }) {
  const [sites, setSites] = useState(null)
  const [selected, setSelected] = useState(null) // site name or 'new'
  const [dirty, setDirty] = useState(false)

  const markDirty = v => { setDirty(v); onDirty?.(v) }
  const load = () => api('GET', '/api/sites').then(r => setSites(r.sites)).catch(() => setSites([]))
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
      <aside>
        <ul>
          {sites.map(s => (
            <li key={s.name} className={selected === s.name ? 'active' : ''} onClick={() => select(s.name)}>
              <span className="site-name">{s.name}</span>
              <span className="badges">
                {!s.managed && <em className="badge warn" title="created outside the dashboard — read-only">unmanaged</em>}
                <em className={`badge ${s.enabled ? 'ok' : ''}`}>{s.enabled ? 'on' : 'off'}</em>
              </span>
            </li>
          ))}
          {!sites.length && <li className="none">no sites yet</li>}
        </ul>
        <Btn kind="primary" onClick={() => select('new')}>+ New site</Btn>
      </aside>
      <section className="site-pane">
        {creating && <SiteForm key="new" onSaved={name => { load(); setSelected(name) }} onDirty={markDirty} />}
        {site && <SiteForm key={site.name} site={site} onDirty={markDirty}
          onSaved={() => { load(); setSelected(site.name) }}
          onDeleted={() => { load(); markDirty(false); setSelected(null) }} />}
        {!creating && !site && <p className="hint">Select a site or create one.</p>}
      </section>
    </div>
  )
}
