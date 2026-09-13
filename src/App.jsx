import { useEffect, useState } from 'react'
import { api, set401Handler } from './api.js'
import Login from './components/Login.jsx'
import Control from './components/Control.jsx'
import Sites from './components/Sites.jsx'
import Logs from './components/Logs.jsx'
import Metrics from './components/Metrics.jsx'

const TABS = ['control', 'sites', 'logs', 'metrics']

export default function App() {
  const [authed, setAuthed] = useState(null) // null = unknown
  const [tab, setTab] = useState(() => location.hash.slice(1) || 'control')
  const [status, setStatus] = useState(null)
  const [dirty, setDirty] = useState(false) // a site form has unsaved edits

  const probe = () => api('GET', '/api/status')
    .then(s => { setStatus(s); setAuthed(true) })
    .catch(() => setAuthed(false))

  useEffect(() => {
    set401Handler(() => setAuthed(false))
    probe()
    const t = setInterval(probe, 10000)
    return () => clearInterval(t)
  }, [])

  // Switching module unmounts the form, which would drop the edits silently. So does
  // closing the tab, which the module guard cannot see — hence the beforeunload too.
  useEffect(() => {
    if (!dirty) return
    const warn = e => { e.preventDefault(); e.returnValue = '' }
    addEventListener('beforeunload', warn)
    return () => removeEventListener('beforeunload', warn)
  }, [dirty])

  const go = t => {
    if (t === tab) return
    if (dirty && !confirm('Discard unsaved changes to this site?')) return
    setDirty(false)
    setTab(t)
    location.hash = t
  }

  if (authed === null) return <div className="loading">…</div>
  if (!authed) return <Login onLogin={probe} />

  // in dry mode `active` is already the word "dry", so appending another "(dry)" read "dry (dry)"
  const dry = status?.dry
  const glyph = dry ? '◌' : status?.active === 'active' ? '●' : '○'
  const state = dry ? 'dry run' : (status?.active || 'unknown')

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand">
          <img src="/favicon.svg" alt="" width="26" height="26" />
          <span>NGINX <small>dashboard</small></span>
        </div>
        <nav>
          {TABS.map(t => (
            <button key={t} className={tab === t ? 'active' : ''} onClick={() => go(t)}>
              {t[0].toUpperCase() + t.slice(1)}
            </button>
          ))}
        </nav>
        <div className="sidebar-foot">
          <span className={`status ${status?.active}`} title={dry ? 'writes files but never calls nginx' : ''}>
            {glyph} {state}
          </span>
          <button className="logout" onClick={() => api('POST', '/api/logout').then(() => setAuthed(false))}>
            Sign out
          </button>
        </div>
      </aside>
      <main>
        {tab === 'control' && <Control status={status} onStatus={probe} />}
        {tab === 'sites' && <Sites onDirty={setDirty} />}
        {tab === 'logs' && <Logs />}
        {tab === 'metrics' && <Metrics status={status} />}
      </main>
    </div>
  )
}
