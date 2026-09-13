import { useEffect, useState } from 'react'
import { api } from '../api.js'
import { Btn } from './ui.jsx'
import SiteForm from './SiteForm.jsx'

export default function Sites() {
  const [sites, setSites] = useState(null)
  const [selected, setSelected] = useState(null) // site name or 'new'

  const load = () => api('GET', '/api/sites').then(r => setSites(r.sites)).catch(() => setSites([]))
  useEffect(() => { load() }, [])

  if (sites === null) return <div className="loading">…</div>

  const creating = selected === 'new'
  const site = !creating && selected ? sites.find(s => s.name === selected) : null

  return (
    <div className="sites">
      <aside>
        <ul>
          {sites.map(s => (
            <li key={s.name} className={selected === s.name ? 'active' : ''} onClick={() => setSelected(s.name)}>
              <span className="site-name">{s.name}</span>
              <span className="badges">
                {!s.managed && <em className="badge warn" title="created outside the dashboard — read-only">unmanaged</em>}
                <em className={`badge ${s.enabled ? 'ok' : ''}`}>{s.enabled ? 'on' : 'off'}</em>
              </span>
            </li>
          ))}
          {!sites.length && <li className="none">no sites yet</li>}
        </ul>
        <Btn kind="primary" onClick={() => setSelected('new')}>+ New site</Btn>
      </aside>
      <section className="site-pane">
        {creating && <SiteForm key="new" onSaved={name => { load(); setSelected(name) }} />}
        {site && <SiteForm key={site.name} site={site} onSaved={() => { load(); setSelected(site.name) }} onDeleted={() => { load(); setSelected(null) }} />}
        {!creating && !site && <p className="hint">Select a site or create one.</p>}
      </section>
    </div>
  )
}