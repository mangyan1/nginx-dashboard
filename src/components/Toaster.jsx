import { useSyncExternalStore } from 'react'
import { dismiss, snapshot, subscribe } from '../toast.js'

/**
 * Mounted once, at the foot of the app shell. A save result also renders into <Out>, which lives
 * inside the scrolled panel while the buttons that produced it are pinned to the bottom of it — so
 * a failure can be off screen entirely. This is what makes the outcome unmissable.
 *
 * role="status" for a success and role="alert" for a failure, because a screen reader should
 * interrupt for one of those and not the other.
 */
export default function Toaster() {
  const items = useSyncExternalStore(subscribe, snapshot)
  if (!items.length) return null
  return (
    <div className="toasts">
      {items.map(t => (
        <div key={t.id} className={`toast ${t.kind}`} role={t.kind === 'err' ? 'alert' : 'status'}>
          <span>{t.text}</span>
          <button className="toast-x" onClick={() => dismiss(t.id)} aria-label="Dismiss">✕</button>
        </div>
      ))}
    </div>
  )
}
