import { useEffect, useState } from 'react'
import { api } from '../api.js'
import { Btn, fmtSize } from './ui.jsx'

export default function FileManager({ siteName }) {
  const [dir, setDir] = useState('.')
  const [entries, setEntries] = useState(null)
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)

  const load = p => api('GET', `/api/sites/${siteName}/files?path=${encodeURIComponent(p)}`)
    .then(r => { setEntries(r.entries); setDir(r.path); setErr('') })
    .catch(e => setErr(e.message))

  useEffect(() => { load('.') }, [siteName])

  const go = rel => load(rel === '..' ? (dir.split('/').slice(0, -1).join('/') || '.') : (dir === '.' ? rel : `${dir}/${rel}`))
  const del = async name => {
    if (!confirm(`Delete ${name}?`)) return
    await api('DELETE', `/api/sites/${siteName}/files?path=${encodeURIComponent(dir === '.' ? name : `${dir}/${name}`)}`)
    load(dir)
  }

  const upload = async files => {
    if (!files.length) return
    setBusy(true)
    const fd = new FormData()
    for (const f of files) fd.append('files', f)
    fd.append('path', dir)
    await api('POST', `/api/sites/${siteName}/files`, fd).catch(e => setErr(e.message))
    setBusy(false)
    load(dir)
  }

  const uploadZip = async file => {
    if (!file) return
    setBusy(true)
    const fd = new FormData()
    fd.append('zip', file)
    fd.append('path', dir)
    await api('POST', `/api/sites/${siteName}/upload-zip`, fd).catch(e => setErr(e.message))
    setBusy(false)
    load(dir)
  }

  if (entries === null) return <p className="hint">{err || '…'}</p>

  return (
    <fieldset className="section files">
      <legend>Files — {siteName}/{dir}</legend>
      {err && <p className="err">{err}</p>}
      <div className="row">
        {dir !== '.' && <Btn onClick={() => go('..')}>↑ up</Btn>}
        <label className="btn primary">
          Upload files
          <input type="file" multiple hidden onChange={e => { upload([...e.target.files]); e.target.value = '' }} />
        </label>
        <label className="btn">
          Deploy folder (.zip)
          <input type="file" accept=".zip" hidden onChange={e => { uploadZip(e.target.files[0]); e.target.value = '' }} />
        </label>
        {busy && <span>uploading…</span>}
      </div>
      <table>
        <thead>
          <tr><th>Name</th><th>Size</th><th>Modified</th><th /></tr>
        </thead>
        <tbody>
          {entries.map(en => (
            <tr key={en.name}>
              <td>
                {en.dir
                  ? <a href="#" onClick={() => go(en.name)}>{en.name}/</a>
                  : en.name}
              </td>
              <td>{fmtSize(en.size)}</td>
              <td>{new Date(en.mtime).toLocaleString()}</td>
              <td><Btn kind="danger" onClick={() => del(en.name)}>✕</Btn></td>
            </tr>
          ))}
          {!entries.length && <tr><td colSpan="4" className="none">empty — upload files or deploy a zip</td></tr>}
        </tbody>
      </table>
    </fieldset>
  )
}