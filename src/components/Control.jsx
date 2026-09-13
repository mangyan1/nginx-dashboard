import { useState } from 'react'
import { api } from '../api.js'
import { Btn, Out, useAsync } from './ui.jsx'

const ACTIONS = ['start', 'stop', 'restart', 'reload', 'test']

// stop and restart both drop in-flight connections; reload is the one you almost always want,
// so it is the only primary and the other two say what they will actually cost.
const CONFIRM = {
  stop: 'Stop nginx? Every site goes offline and in-flight connections are dropped.',
  restart: 'Restart nginx? In-flight connections are dropped — reload applies config without that.',
}

export default function Control({ status, onStatus }) {
  const [result, setResult] = useState(null)
  const [run, busy] = useAsync(async action => {
    setResult(await api('POST', `/api/nginx/${action}`))
    onStatus()
  })

  const click = a => { if (!CONFIRM[a] || confirm(CONFIRM[a])) run(a) }

  const dry = status?.dry
  const state = dry ? 'dry run' : (status?.active || 'unknown')
  const dot = dry ? 'warn' : status?.active === 'active' ? '' : 'err'

  return (
    <div className="control">
      <div className="sec-head">
        <h2>Process control</h2>
        <p>systemctl and nginx signals, no shell required</p>
      </div>

      <section className="panel">
        <div className="panel-head">
          <span className="panel-title">Actions</span>
          <span className="spacer" />
          <span className="kv"><i>engine</i><b className="live"><span className={`dot ${dot}`} />{state}</b></span>
        </div>
        <div className="panel-body">
          <div className="actions">
            {ACTIONS.map(a => (
              <Btn key={a} kind={a === 'reload' ? 'primary' : a === 'stop' ? 'danger' : ''}
                disabled={busy} onClick={() => click(a)}>
                {a === 'test' ? 'Test config' : a[0].toUpperCase() + a.slice(1)}
              </Btn>
            ))}
          </div>
          <p className="sub">
            Reload applies config without dropping connections. Test parses the config first and touches nothing.
            {dry && ' In dry mode nothing reaches nginx — the buttons report what they would run.'}
          </p>
          {status?.version && <p className="sub">{status.version}</p>}
        </div>
      </section>

      {result && (
        <section className="panel">
          <div className="panel-head">
            <span className="panel-title">Output</span>
            <span className="spacer" />
            <span className={`chip ${result.ok ? 'ok' : 'warn'}`}>{result.ok ? 'ok' : 'failed'}</span>
          </div>
          <div className="panel-body"><Out result={result} /></div>
        </section>
      )}
    </div>
  )
}
