import { useEffect, useState } from 'react'
import { api, set401Handler } from './api.js'
import Login from './components/Login.jsx'
import Control from './components/Control.jsx'
import Sites from './components/Sites.jsx'
import Logs from './components/Logs.jsx'
import Metrics from './components/Metrics.jsx'
import Settings from './components/Settings.jsx'
import Toaster from './components/Toaster.jsx'

const TABS = [
  ['control', 'Control'],
  ['sites', 'Sites'],
  ['logs', 'Logs'],
  ['metrics', 'Metrics'],
  ['settings', 'Settings'],
]

// index.html already picked a theme before first paint; this only reads it back
const readTheme = () => (document.documentElement.dataset.theme === 'light' ? 'light' : 'dark')
// `nginx -v` is the string "nginx version: nginx/1.24.0 (Ubuntu)" — the number is the part worth a cell
const nginxVer = v => (String(v || '').match(/nginx\/([\d.]+)/) || [])[1] || '—'

export default function App() {
  const [authed, setAuthed] = useState(null) // null = unknown
  const [tab, setTab] = useState(() => location.hash.slice(1) || 'control')
  const [status, setStatus] = useState(null)
  const [dirty, setDirty] = useState(false) // a site form has unsaved edits
  const [theme, setTheme] = useState(readTheme)
  // The dashboard's own vhost is not in the Sites list, so Control has to be able to open it there.
  // Cleared by Sites once it has selected the name, so clicking Manage again works a second time.
  const [openSite, setOpenSite] = useState(null)

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

  const openSiteIn = name => {
    setOpenSite(name)
    setDirty(false)
    setTab('sites')
    location.hash = 'sites'
  }

  const pick = t => {
    setTheme(t)
    document.documentElement.dataset.theme = t
    try { localStorage.setItem('nxd-theme', t) } catch { /* private mode */ }
  }

  if (authed === null) return <div className="loading">…</div>
  if (!authed) return <Login onLogin={probe} />

  // in dry mode `active` is already the word "dry", so appending another "(dry)" read "dry (dry)"
  const dry = status?.dry
  const state = dry ? 'dry run' : (status?.active || 'unknown')
  const dot = dry ? 'warn' : status?.active === 'active' ? '' : 'err'

  return (
    <div className="app">
      <header className="strip">
        <div className="mark">
          <img src="/branding/logo-primary.svg" alt="" width="22" height="22" />
          <b>NXD</b>
          <span>observe · configure · deploy</span>
        </div>
        <div className="readouts">
          <div className="readout-cell">
            <i>state</i>
            <b className="live"><span className={`dot ${dot}`} />{state}</b>
          </div>
          <div className="readout-cell"><i>nginx</i><b>{nginxVer(status?.version)}</b></div>
          <div className="readout-cell"><i>writes</i><b className={dry ? 'dim' : 'accent'}>{dry ? 'skipped' : 'live'}</b></div>
        </div>
        <span className="strip-spacer" />
        {dry && <span className="tag" title="writes conf files but never calls nginx or systemctl">dry run</span>}
        <div className="seg" role="group" aria-label="Theme">
          <button className={theme === 'dark' ? 'on' : ''} onClick={() => pick('dark')}>Dark</button>
          <button className={theme === 'light' ? 'on' : ''} onClick={() => pick('light')}>Light</button>
        </div>
        <button className="ghost" onClick={() => api('POST', '/api/logout').then(() => setAuthed(false))}>Sign out</button>
      </header>

      <div className="body">
        <aside className="rail">
          <nav>
            {TABS.map(([id, label], i) => (
              <button key={id} className={`nav-item ${tab === id ? 'on' : ''}`} onClick={() => go(id)}>
                <i>{String(i + 1).padStart(2, '0')}</i>
                {label}
              </button>
            ))}
          </nav>
          <div className="rail-foot">
            <img src="/branding/logo-primary.svg" alt="" width="20" height="20" />
            <div className="ver">{status?.version ? nginxVer(status.version) : '—'}</div>
          </div>
        </aside>
        <main className="main">
          {tab === 'control' && <Control status={status} onStatus={probe} onOpenSite={openSiteIn} />}
          {tab === 'sites' && <Sites onDirty={setDirty} openSite={openSite} onOpened={() => setOpenSite(null)} />}
          {tab === 'logs' && <Logs />}
          {tab === 'metrics' && <Metrics status={status} theme={theme} />}
          {tab === 'settings' && <Settings status={status} theme={theme} onTheme={pick} />}
        </main>
      </div>
      <Toaster />
    </div>
  )
}
