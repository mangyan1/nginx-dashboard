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
      <div className="mark">
        <img src="/branding/logo-primary.svg" alt="" width="30" height="30" />
        <b>NXD</b>
        <span>observe · configure · deploy</span>
      </div>
      <h1>NGINX dashboard <small>sign in to manage this server</small></h1>
      <input type="password" placeholder="password" value={password}
        onChange={e => setPassword(e.target.value)} autoFocus
        aria-label="Password" autoComplete="current-password" />
      <Btn kind="primary" disabled={busy || !password}>{busy ? '…' : 'Sign in'}</Btn>
      {err && <p className="err">{err}</p>}
    </form>
  )
}
