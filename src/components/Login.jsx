import { useState } from 'react'
import { api } from '../api.js'
import { Btn } from './ui.jsx'

export default function Login({ onLogin }) {
  const [password, setPassword] = useState('')
  const [code, setCode] = useState('')
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)

  const submit = async e => {
    e.preventDefault()
    setBusy(true); setErr('')
    try {
      await api('POST', '/api/login', { password, code })
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
      {/* Always shown, not revealed after a failed attempt: TOTP is off unless the service unit
          sets DASH_TOTP_SECRET, and one operator who knows whether they turned it on is better
          served by one form that always works than by one that needs two submissions. */}
      <input inputMode="numeric" placeholder="authenticator code — blank if 2FA is off" value={code}
        onChange={e => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
        aria-label="Authenticator code" autoComplete="one-time-code" />
      <Btn kind="primary" disabled={busy || !password}>{busy ? '…' : 'Sign in'}</Btn>
      {err && <p className="err">{err}</p>}
    </form>
  )
}
