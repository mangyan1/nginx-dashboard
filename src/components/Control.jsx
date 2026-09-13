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

  return (
    <div className="control">
      <div className="actions">
        {ACTIONS.map(a => (
          <Btn key={a} kind={a === 'reload' ? 'primary' : a === 'stop' ? 'danger' : ''}
            disabled={busy} onClick={() => click(a)}>
            {a === 'test' ? 'Test config' : a[0].toUpperCase() + a.slice(1)}
          </Btn>
        ))}
      </div>
      <p className="hint">Reload applies config changes without dropping connections. Test checks syntax first.</p>
      <Out result={result} />
      {status?.version && <pre className="out">{status.version}</pre>}
    </div>
  )
}