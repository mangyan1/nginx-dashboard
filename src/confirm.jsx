import { useEffect, useRef, useSyncExternalStore } from 'react'

// One question at a time, asked from anywhere. Same shape as the snackbar store next door: a
// module-level value plus a single component App mounts once.
//
// This replaces `confirm()`, which is browser chrome and cannot be styled at all — so it arrived
// wearing a different program's clothes ("localhost:7412 says…"), and it blocks the thread, so
// nothing on the page could move while it was up. Half of these questions are about destroying
// something, and a question the operator recognises as part of this dashboard is one they read.
let pending = null
const listeners = new Set()
const emit = () => listeners.forEach(l => l())
export const subscribe = l => { listeners.add(l); return () => listeners.delete(l) }
export const snapshot = () => pending

/**
 * Ask, and answer with a promise. `title` is the question; `body` is what happens if you say yes,
 * which is the part a delete needs and a native `confirm` had room for. Anything that is not the
 * confirming button — Cancel, Esc, the backdrop — is a no.
 *
 * `option` is `{ label, checked }` and adds a checkbox under the body. Its answer is written back
 * onto that same object before the promise resolves — the object is the caller's, and the promise
 * still resolves a bare boolean, because six call sites read it and the one that matters
 * (`Control.jsx`) treats any truthy answer as "yes". An out-parameter is what lets the two travel
 * together without changing the type the other five already depend on.
 */
export const ask = ({ title, body, go, danger = false, option }) =>
  new Promise(resolve => { pending = { title, body, go, danger, option, resolve }; emit() })

export function Confirmer() {
  const q = useSyncExternalStore(subscribe, snapshot)
  const box = useRef(null)

  useEffect(() => {
    const dlg = box.current
    if (q && !dlg.open) {
      // returnValue survives from the last time this was opened, so Esc on a second question would
      // otherwise read as the previous answer.
      dlg.returnValue = ''
      // The same hazard, one node over: this dialog is mounted once and reused, so `defaultChecked`
      // is only ever read at mount — a box left ticked on the last question would come back ticked,
      // and "delete the document root" would arrive pre-answered.
      const pick = dlg.querySelector('input[type="checkbox"]')
      if (pick) pick.checked = !!q.option?.checked
      dlg.showModal()
      // Explicit, because the platform focuses the first focusable descendant — which is Cancel, so
      // Enter would cancel. Whoever opened this clicked the button that means yes, and Enter should
      // agree with them.
      dlg.querySelector('button[value="yes"]')?.focus()
    } else if (!q && dlg.open) dlg.close()
  }, [q])

  // `close` is the single event every ending goes through — the form's buttons, Esc, and the
  // backdrop handler below — so it is the one place the promise can be settled. A question
  // dismissed with Esc that never resolved would leave its caller waiting for ever.
  const settle = e => {
    const yes = e.target.returnValue === 'yes'
    // Read before `emit()`, which re-renders with `pending` already null and unmounts the box — this
    // is the only moment the answer exists anywhere, and it is not recoverable afterwards.
    const pick = e.target.querySelector('input[type="checkbox"]')
    if (pending?.option && pick) pending.option.checked = pick.checked
    pending?.resolve(yes)
    pending = null
    emit()
  }

  return (
    <dialog ref={box} className="notes confirm" onClose={settle}
      onClick={e => { if (e.target === box.current) box.current.close('no') }}>
      <header><b>{q?.title}</b></header>
      {q?.body && <p className="confirm-body">{q.body}</p>}
      {/* Uncontrolled and last before the buttons: the answer is read off the DOM when the dialog
          closes, so ticking it must not re-render anything. `showModal()` would focus this first,
          and line 38 focuses the yes button straight after — so Enter still agrees with the click
          that opened the question rather than silently ticking a box. */}
      {q?.option && (
        <label className="toggle">
          <input type="checkbox" /><span>{q.option.label}</span>
        </label>
      )}
      {/* method="dialog" submits and closes in one step and puts the button's own value in
          returnValue, so the answer travels on the platform's channel rather than through a handler
          per button. Cancel is first in the DOM because that is the order it should read in. */}
      <form method="dialog">
        <button className="btn" value="no">Cancel</button>
        <button className={`btn ${q?.danger ? 'danger' : 'primary'}`} value="yes">{q?.go || 'Confirm'}</button>
      </form>
    </dialog>
  )
}
