import { useEffect, useRef, useState } from 'react'
import Chart from 'chart.js/auto'
import { api } from '../api.js'

const TILES = [
  ['active', 'Active connections'],
  ['accepted', 'Accepted'],
  ['handled', 'Handled'],
  ['requests', 'Total requests'],
  ['reading', 'Reading'],
  ['writing', 'Writing'],
  ['waiting', 'Waiting'],
]

export default function Metrics({ status }) {
  const [m, setM] = useState(null)
  const [err, setErr] = useState('')
  const history = useRef([])
  const canvas = useRef(null)
  const chart = useRef(null)

  useEffect(() => {
    if (!canvas.current) return
    chart.current = new Chart(canvas.current, {
      type: 'line',
      data: { labels: [], datasets: [{ label: 'active connections', data: [], borderColor: '#4f8ef7', backgroundColor: 'rgba(79,142,247,.15)', fill: true, tension: .3, pointRadius: 0 }] },
      options: { animation: false, scales: { y: { beginAtZero: true } } },
    })
    return () => chart.current?.destroy()
  }, [])

  useEffect(() => {
    const t = setInterval(async () => {
      try {
        const data = await api('GET', '/api/metrics')
        setM(data); setErr('')
        const h = history.current
        h.push(data.active)
        if (h.length > 60) h.shift()
        const c = chart.current
        if (c) {
          c.data.labels = h.map((_, i) => i)
          c.data.datasets[0].data = h
          c.update('none')
        }
      } catch (e) { setErr(e.message) }
    }, 2000)
    return () => clearInterval(t)
  }, [])

  return (
    <div className="metrics">
      {err && <p className="err">{err}</p>}
      <div className="tiles">
        {TILES.map(([k, label]) => (
          <div className="tile" key={k}>
            <b>{m ? m[k] : '—'}</b>
            <span>{label}</span>
          </div>
        ))}
      </div>
      <canvas ref={canvas} width="600" height="200" />
      {status?.version && <p className="hint">{status.version}</p>}
    </div>
  )
}