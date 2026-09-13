import { useState } from 'react'

export function Field({ label, children }) {
  return (
    <label className="field">
      <span>{label}</span>
      {children}
    </label>
  )
}

export function Toggle({ checked, onChange, label }) {
  return (
    <label className="toggle">
      <input type="checkbox" checked={!!checked} onChange={e => onChange(e.target.checked)} />
      <span>{label}</span>
    </label>
  )
}

export function Btn({ onClick, children, kind = '', disabled, title }) {
  return (
    <button className={`btn ${kind}`} onClick={onClick} disabled={disabled} title={title}>{children}</button>
  )
}

export function Section({ title, children }) {
  return (
    <fieldset className="section">
      <legend>{title}</legend>
      {children}
    </fieldset>
  )
}

export function Out({ result }) {
  if (!result) return null
  return <pre className={result.ok ? 'out ok' : 'out err'}>{result.output || (result.ok ? 'ok' : 'failed')}</pre>
}

export function useAsync(fn) {
  const [busy, setBusy] = useState(false)
  const run = async (...args) => {
    setBusy(true)
    try { return await fn(...args) } finally { setBusy(false) }
  }
  return [run, busy]
}

export const fmtSize = n => n > 1048576 ? `${(n / 1048576).toFixed(1)} MB` : n > 1024 ? `${(n / 1024).toFixed(1)} KB` : `${n} B`