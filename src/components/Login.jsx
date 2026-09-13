import { useState } from 'react'
import { api } from '../api.js'
import { Btn } from './ui.jsx'

export default function Login({ onLogin }) {
  const [password, setPassword] = useState('')
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)

  const submit = async e => {
    e.preventDefault()
    setBusy(true); setErr('')
    try {
      await api('POST', '/api/login', { password })
      onLogin()
    } catch (ex) {
      setErr(ex.message)
    } finally { setBusy(false) }
  }

  return (
    <form className="login" onSubmit={submit}>
      <h1>NGINX <small>dashboard</small></h1>
      <input type="password" placeholder="password" value={password}
        onChange={e => setPassword(e.target.value)} autoFocus />
      <Btn kind="primary" disabled={busy || !password}>{busy ? '…' : 'Sign in'}</Btn>
      {err && <p className="err">{err}</p>}
    </form>
  )
}