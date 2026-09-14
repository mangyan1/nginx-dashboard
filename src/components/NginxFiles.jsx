import { useEffect, useState } from 'react'
import { api } from '../api.js'
import { Btn } from './ui.jsx'

/**
 * What is actually in sites-available and sites-enabled, as files.
 *
 * The site list is built from the manifest, so a conf that only exists on disk appears there as a
 * name with no config, and one that exists only in sites-enabled appears nowhere at all. Both are
 * exactly the situations worth looking at, and neither is visible without reading the directories.
 *
 * Read-only on purpose: these files are what the manifest renders, so editing one here would be
 * editing something the next save overwrites. A managed site is edited in its form; this is where
 * you look when the form cannot explain what you are seeing.
 *
 * `name` opens straight to one conf — the unmanaged row on Sites lands here rather than in a form
 * whose Save could only ever answer 404.
 */
export default function NginxFiles({ name = '' }) {
  const [files, setFiles] = useState(null)
  const [open, setOpen] = useState(null) // { name, dir, path, text }
  const [err, setErr] = useState('')

  const load = () => {
    setErr('')
    api('GET', '/api/nginx-files').then(setFiles).catch(e => setErr(e.message))
  }
  useEffect(load, [])

  const show = n => {
    setErr('')
    api('GET', `/api/nginx-files/${encodeURIComponent(n)}`)
      .then(r => setOpen(r.file))
      .catch(e => { setOpen(null); setErr(e.message) })
  }
  // Opening a selected unmanaged site lands on its conf, and re-runs when a different one is picked.
  useEffect(() => { if (name) show(name) }, [name])

  if (err && !files) return <div className="panel-body"><p className="hint">Could not read the nginx directories: {err}</p><Btn onClick={load}>Retry</Btn></div>
  if (!files) return <div className="panel-body"><p className="hint">loading…</p></div>

  const list = (title, dir, rows) => (
    <div className="nf-col">
      <div className="nf-head">{title} <span className="dim">{rows.length}</span></div>
      <ul className="nf-list">
        {rows.map(f => (
          <li key={f.name} className={open?.name === f.name && open?.dir === dir ? 'on' : ''} onClick={() => show(f.name)}>
            <span className="nf-name">{f.name}</span>
            {f.managed && <em className="chip ok">managed</em>}
            {dir === 'sites-enabled' && (f.resolves
              ? <em className="chip" title={f.target || 'a real file, not a symlink'}>{f.target ? 'link' : 'file'}</em>
              : <em className="chip err" title={`points at ${f.target || 'nothing'}, which is not there — nginx will not start`}>broken</em>)}
          </li>
        ))}
        {!rows.length && <li className="none">empty</li>}
      </ul>
    </div>
  )

  return (
    <div className="panel-body nf">
      <div className="row">
        <Btn onClick={load}>Refresh</Btn>
        {files.enabled.some(f => !f.resolves) && <span className="chip err">a broken link in sites-enabled stops nginx</span>}
      </div>
      <div className="nf-grid">
        {list('sites-available', 'sites-available', files.available)}
        {list('sites-enabled', 'sites-enabled', files.enabled)}
      </div>
      {err && <p className="hint warn">{err}</p>}
      {open
        ? <>
            <div className="nf-path">{open.path}</div>
            <pre className="out nf-conf">{open.text}</pre>
          </>
        : <p className="hint">Pick a file to read it. Nothing here is editable — a managed site is edited in its form, and the next save rewrites its conf.</p>}
    </div>
  )
}
