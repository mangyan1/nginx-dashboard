import { useState } from 'react'
import { fmt, isDefault, short } from '../defaults.js'

/**
 * "Use default", on every editable control. It is drawn on the caption line by CSS grid, which is
 * what lets it stay *after* the control in the DOM: a label's labeled control is its first
 * labelable element descendant, and `<button>` is labelable — so a chip placed before the input
 * would take the label over and leave the input with no accessible name. After it, the input keeps
 * the caption and clicking the caption still focuses it.
 *
 * It reads `ok` and stops responding once the field holds the default, so the chip doubles as the
 * answer to "is this the default?".
 */
export function Chip({ def, value, onUse, title }) {
  const ok = isDefault(value, def)
  const v = short(def)
  return (
    <button type="button" className={`chip def${ok ? ' ok' : ''}`} disabled={ok}
      onClick={() => onUse(def)}
      title={ok ? 'this is the default' : title || `use the default: ${fmt(def) || 'the server’s own'}`}>
      {v ? `default: ${v}` : 'default'}
    </button>
  )
}

export function Field({ label, children, def, value, onDef }) {
  return (
    <label className="field">
      <span>{label}</span>
      {children}
      {onDef && <Chip def={def} value={value} onUse={onDef} />}
    </label>
  )
}

export function Toggle({ checked, onChange, label, def, onDef }) {
  return (
    <label className="toggle">
      <input type="checkbox" checked={!!checked} onChange={e => onChange(e.target.checked)} />
      <span>{label}</span>
      {onDef && <Chip def={def} value={!!checked} onUse={onDef} />}
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