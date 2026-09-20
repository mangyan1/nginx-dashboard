import { useEffect, useRef, useState } from 'react'
// Registered by hand rather than `chart.js/auto`, which pulls every controller and scale into the
// bundle for the sake of one line chart. This is the whole set the chart below touches: a line
// controller with its element and points, two scales, the area fill, and hover tooltips. A new
// chart type here needs its own registration — the failure mode is a blank canvas, not an error.
import { Chart, LineController, LineElement, PointElement, LinearScale, CategoryScale, Filler, Tooltip } from 'chart.js'
import { api } from '../api.js'

Chart.register(LineController, LineElement, PointElement, LinearScale, CategoryScale, Filler, Tooltip)

const TILES = [
  ['active', 'Active connections'],
  ['accepted', 'Accepted'],
  ['handled', 'Handled'],
  ['requests', 'Total requests'],
  ['reading', 'Reading'],
  ['writing', 'Writing'],
  ['waiting', 'Waiting'],
]

// chart.js takes real colour values, not var() references, so the tokens are read off the
// document — once on mount and again whenever the theme flips.
const token = n => getComputedStyle(document.documentElement).getPropertyValue(n).trim()

export default function Metrics({ status, theme }) {
  const [m, setM] = useState(null)
  const [err, setErr] = useState('')
  const history = useRef([])
  const canvas = useRef(null)
  const chart = useRef(null)

  useEffect(() => {
    if (!canvas.current) return
    chart.current = new Chart(canvas.current, {
      type: 'line',
      data: { labels: [], datasets: [{ label: 'active connections', data: [], fill: true, tension: .3, pointRadius: 0, borderWidth: 1.5 }] },
      options: {
        animation: false,
        plugins: { legend: { display: false } },
        scales: {
          y: { beginAtZero: true, grid: { color: () => token('--line-soft') }, ticks: { color: () => token('--dimmer'), font: { family: 'IBM Plex Mono, monospace', size: 10 } } },
          x: { grid: { display: false }, ticks: { display: false } },
        },
      },
    })
    return () => chart.current?.destroy()
  }, [])

  useEffect(() => {
    const c = chart.current
    if (!c) return
    c.data.datasets[0].borderColor = token('--accent-ink')
    c.data.datasets[0].backgroundColor = token('--accent-wash')
    c.update('none')
  }, [theme])

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
      <div className="sec-head">
        <h2>Metrics</h2>
        <p>stub_status, sampled every two seconds</p>
      </div>
      {err && <p className="banner mb">{err}</p>}

      <div className="tiles">
        {TILES.map(([k, label]) => (
          <div className="tile" key={k}>
            <span>{label}</span>
            <b>{m ? m[k] : '—'}</b>
          </div>
        ))}
      </div>

      <section className="panel">
        <div className="panel-head">
          <span className="panel-title">Active connections</span>
          <span className="spacer" />
          <span className="chip">last 60 samples</span>
        </div>
        <div className="panel-body">
          <canvas ref={canvas} width="900" height="220" />
        </div>
      </section>

      {status?.version && <p className="sub">{status.version}</p>}
    </div>
  )
}
