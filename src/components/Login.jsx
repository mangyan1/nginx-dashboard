import { useEffect, useState } from 'react'
import { api } from '../api.js'
import { Btn } from './ui.jsx'

export default function Login({ onLogin }) {
  const [password, setPassword] = useState('')
  const [code, setCode] = useState('')
  const [needsCode, setNeedsCode] = useState(false)
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)

  // Asked of the server rather than guessed: 2FA is off unless the unit sets DASH_TOTP_SECRET or it
  // was enrolled in Settings, and a box with no second factor has nothing to type in that field.
  // Unreachable server leaves it hidden — the password box still submits, and a refusal below
  // brings the field back anyway.
  useEffect(() => {
    api('GET', '/api/login').then(s => setNeedsCode(!!s.totp)).catch(() => {})
  }, [])

  const submit = async e => {
    e.preventDefault()
    setBusy(true); setErr('')
    try {
      await api('POST', '/api/login', { password, code })
      onLogin()
    } catch (ex) {
      setErr(ex.message)
      // A refusal means the form may be out of date — the second factor can be enrolled from
      // another session while this page sits open, and without this the operator is told the code
      // is wrong with no field to type one into.
      setNeedsCode(true)
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
      {needsCode &&
        <input inputMode="numeric" placeholder="authenticator code" value={code}
          onChange={e => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
          aria-label="Authenticator code" autoComplete="one-time-code" autoFocus />}
      <Btn kind="primary" disabled={busy || !password}>{busy ? '…' : 'Sign in'}</Btn>
      {err && <p className="err">{err}</p>}
    </form>
  )
}
