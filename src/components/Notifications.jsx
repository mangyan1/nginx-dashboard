import { useEffect, useRef, useState } from 'react'
import { api } from '../api.js'

// Every item is a fact about the current state, recomputed on the server each time — so the poll is
// what makes one disappear once it is fixed, and there is nothing to mark as read. Slow on purpose:
// this is not a metric, and a bell that flickers is a bell nobody reads.
const POLL = 30_000

/**
 * The bell. Counts what the server reports, opens a native <dialog> listing it, and hands each item
 * back to the app so "open sites" lands on the tab where the fix lives.
 *
 * <dialog> + showModal() rather than a hand-rolled overlay: the focus trap, Esc to close, the
 * inert background and the ::backdrop are all the platform's, and every one of them is something a
 * div-based modal gets subtly wrong.
 */
export default function Notifications({ onGo }) {
  const [items, setItems] = useState([])
  const box = useRef(null)

  useEffect(() => {
    const load = () => api('GET', '/api/notifications').then(d => setItems(d.items || [])).catch(() => {})
    load()
    const t = setInterval(load, POLL)
    return () => clearInterval(t)
  }, [])

  // Asked again on the click, not just on the poll: the answer is cheap, and a bell showing a count
  // from up to thirty seconds ago is the one thing it must not do — the operator clicks it *because*
  // something just happened.
  const open = () => { api('GET', '/api/notifications').then(d => setItems(d.items || [])).catch(() => {}); box.current?.showModal() }
  const close = () => box.current?.close()
  const worst = items.some(i => i.kind === 'err') ? 'err' : items.some(i => i.kind === 'warn') ? 'warn' : 'info'

  return (
    <>
      <button className={`ghost bell ${items.length ? worst : 'quiet'}`} onClick={open}
        aria-label={items.length ? `Notifications: ${items.length}` : 'Notifications: nothing to report'}>
        <svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true" focusable="false">
          <path d="M8 1.9a3.9 3.9 0 0 0-3.9 3.9v2.3L2.9 10.4h10.2l-1.2-2.3V5.8A3.9 3.9 0 0 0 8 1.9Z"
            fill="none" stroke="currentColor" strokeWidth="1.25" strokeLinejoin="round" />
          <path d="M6.5 12.1a1.5 1.5 0 0 0 3 0" fill="none" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" />
        </svg>
        {items.length > 0 && <i className={`bell-n ${worst}`}>{items.length}</i>}
      </button>

      {/* Clicking the backdrop targets the dialog itself, which is the only place it is that element
          — so this needs no listener on the document and no hit-testing of coordinates. */}
      <dialog ref={box} className="notes" onClick={e => { if (e.target === box.current) close() }}>
        <header>
          <b>Notifications</b>
          {items.length > 0 && <span className="notes-n">{items.length}</span>}
          <button className="ghost" onClick={close} aria-label="Close">✕</button>
        </header>

        {items.length === 0
          ? <p className="notes-none">Nothing to report. nginx is running and every conf on disk matches what this dashboard has saved.</p>
          : <ul>
            {items.map(i => (
              <li key={i.id} className={i.kind}>
                <b>{i.title}</b>
                <span>{i.detail}</span>
                {/* Empty `tab` is deliberate — a reboot has nowhere to send you, and a button that
                    goes nowhere is worse than no button. */}
                {i.tab && <button className="ghost" onClick={() => { close(); onGo?.(i.tab) }}>open {i.tab} →</button>}
              </li>
            ))}
          </ul>}
      </dialog>
    </>
  )
}
