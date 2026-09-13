import { useEffect, useRef, useState } from 'react'
import { api } from '../api.js'
import { Btn, Out } from './ui.jsx'

const MAX_LINES = 500

function useTail(file) {
  const [lines, setLines] = useState([])
  const paused = useRef(false)
  const box = useRef(null)

  useEffect(() => {
    const es = new EventSource(`/api/logs/tail?file=${file}`)
    es.onmessage = e => {
      setLines(prev => {
        const next = [...prev, e.data]
        return next.length > MAX_LINES ? next.slice(-MAX_LINES) : next
      })
      if (!paused.current && box.current) box.current.scrollTop = box.current.scrollHeight
    }
    return () => es.close()
  }, [file])

  return { lines, paused, box }
}

function Pane({ file, label }) {
  const { lines, paused, box } = useTail(file)
  return (
    <div className="log-pane" onMouseEnter={() => (paused.current = true)} onMouseLeave={() => (paused.current = false)}>
      <h3>{label}</h3>
      <pre ref={box} className="log">{lines.join('\n') || 'waiting for log lines…'}</pre>
    </div>
  )
}

export default function Logs() {
  const [result, setResult] = useState(null)
  const rotate = () => api('POST', '/api/logs/rotate').then(setResult).catch(e => setResult({ ok: false, output: e.message }))
  const purge = () => api('POST', '/api/logs/purge', { days: 30 }).then(setResult).catch(e => setResult({ ok: false, output: e.message }))

  return (
    <div className="logs">
      <div className="row">
        <Btn onClick={rotate}>Rotate logs now</Btn>
        <Btn kind="danger" onClick={purge}>Purge rotated logs older than 30 days</Btn>
      </div>
      <Out result={result} />
      <div className="log-grid">
        <Pane file="access" label="access.log" />
        <Pane file="error" label="error.log" />
      </div>
    </div>
  )
}