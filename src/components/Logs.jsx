import { useEffect, useRef, useState } from 'react'
import { api } from '../api.js'
import { ask } from '../confirm.jsx'
import { Btn, Out, useAsync } from './ui.jsx'

const MAX_LINES = 500

function useTail(file) {
  const [lines, setLines] = useState([])
  const [open, setOpen] = useState(false)
  const paused = useRef(false)
  const box = useRef(null)

  useEffect(() => {
    const es = new EventSource(`/api/logs/tail?file=${file}`)
    es.onopen = () => setOpen(true)
    es.onerror = () => setOpen(false)
    es.onmessage = e => {
      setLines(prev => {
        const next = [...prev, e.data]
        return next.length > MAX_LINES ? next.slice(-MAX_LINES) : next
      })
      if (!paused.current && box.current) box.current.scrollTop = box.current.scrollHeight
    }
    return () => es.close()
  }, [file])

  // hovering holds the scroll position: the stream keeps filling, the view stops chasing it
  return { lines, paused, box, open }
}

function Pane({ file, label }) {
  const { lines, paused, box, open } = useTail(file)
  return (
    <div className="log-pane panel">
      <div className="panel-head">
        <span className="panel-title">{label}</span>
        <span className="spacer" />
        <span className="kv"><b className="dim">{lines.length ? `${lines.length} line${lines.length === 1 ? '' : 's'}` : '—'}</b></span>
        <span className={`chip ${open ? 'ok' : 'off'}`}>{open ? 'streaming' : 'offline'}</span>
      </div>
      <pre ref={box} className="log"
        onMouseEnter={() => (paused.current = true)} onMouseLeave={() => (paused.current = false)}>
        {lines.join('\n') || 'waiting for log lines…'}
      </pre>
    </div>
  )
}

export default function Logs() {
  const [result, setResult] = useState(null)
  const [rotate, rotating] = useAsync(() => api('POST', '/api/logs/rotate'))
  const [purge, purging] = useAsync(days => api('POST', '/api/logs/purge', { days }))

  const doRotate = async () => setResult(await rotate().catch(e => ({ ok: false, output: e.message })))
  const doPurge = async () => {
    // irreversible: the rotated files are deleted, not archived
    if (!(await ask({ title: 'Delete rotated logs?', body: 'Everything older than 30 days. The files are deleted, not archived, and this cannot be undone.', go: 'Delete', danger: true }))) return
    setResult(await purge(30).catch(e => ({ ok: false, output: e.message })))
  }

  return (
    <div className="logs">
      <div className="sec-head">
        <h2>Logs</h2>
        <p>live tail over server-sent events, hover a pane to hold it still</p>
      </div>

      <section className="panel">
        <div className="panel-head">
          <span className="panel-title">Retention</span>
          <span className="spacer" />
          {result && <span className={`chip ${result.ok ? 'ok' : 'warn'}`}>{result.ok ? 'ok' : 'failed'}</span>}
        </div>
        <div className="panel-body">
          <div className="actions">
            <Btn disabled={rotating} onClick={doRotate}>Rotate logs now</Btn>
            <Btn kind="danger" disabled={purging} onClick={doPurge}>Purge rotated logs older than 30 days</Btn>
          </div>
          <p className="sub">Rotation renames the live files and signals nginx to reopen them. Purge deletes what is already rotated — it does not archive.</p>
          <Out result={result} />
        </div>
      </section>

      <div className="log-grid">
        <Pane file="access" label="access.log" />
        <Pane file="error" label="error.log" />
      </div>
    </div>
  )
}
