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

  const probe = () => api('GET', '/api/status')
    .then(s => { setStatus(s); setAuthed(true) })
    .catch(() => setAuthed(false))

  useEffect(() => {
    set401Handler(() => setAuthed(false))
    probe()
    const t = setInterval(probe, 10000)
    return () => clearInterval(t)
  }, [])

  if (authed === null) return <div className="loading">…</div>
  if (!authed) return <Login onLogin={probe} />

  return (
    <div className="app">
      <header>
        <h1>NGINX <small>dashboard</small></h1>
        <span className={`status ${status?.active}`}>
          {status?.active === 'active' ? '●' : status?.active === 'inactive' ? '○' : '◌'} {status?.active}
          {status?.dry ? ' (dry)' : ''}
        </span>
        <nav>
          {TABS.map(t => (
            <button key={t} className={tab === t ? 'active' : ''} onClick={() => { setTab(t); location.hash = t }}>
              {t}
            </button>
          ))}
          <button className="logout" onClick={() => api('POST', '/api/logout').then(() => setAuthed(false))}>logout</button>
        </nav>
      </header>
      <main>
        {tab === 'control' && <Control status={status} onStatus={probe} />}
        {tab === 'sites' && <Sites />}
        {tab === 'logs' && <Logs />}
        {tab === 'metrics' && <Metrics status={status} />}
      </main>
    </div>
  )
}