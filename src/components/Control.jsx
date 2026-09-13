import { useState } from 'react'
import { api } from '../api.js'
import { Btn, Out, useAsync } from './ui.jsx'

const ACTIONS = ['start', 'stop', 'restart', 'reload', 'test']

export default function Control({ status, onStatus }) {
  const [result, setResult] = useState(null)
  const [run, busy] = useAsync(async action => {
    setResult(await api('POST', `/api/nginx/${action}`))
    onStatus()
  })

  return (
    <div className="control">
      <div className="actions">
        {ACTIONS.map(a => (
          <Btn key={a} kind={a === 'stop' ? 'danger' : a === 'test' ? '' : 'primary'}
            disabled={busy} onClick={() => run(a)}>
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