// Snackbars. Plain JS with no React import, so the ordering rules can be pinned under plain node
// the way api.js is: api() pushes, <Toaster/> subscribes, and nothing else in the app knows there
// is a store at all.

const listeners = new Set()
let items = []
let seq = 0

const emit = () => { for (const l of listeners) l() }

export const subscribe = fn => { listeners.add(fn); return () => listeners.delete(fn) }
// useSyncExternalStore needs the same reference back while nothing has changed, which is why items
// is replaced rather than mutated
export const snapshot = () => items

const TTL = 5000

export function push(text, kind = 'ok') {
  if (!text) return      // a route with nothing to say says nothing
  const id = ++seq
  items = [...items, { id, kind, text }]
  emit()
  // a failure is worth reading, and is usually the longer message. unref() so the pending timer
  // does not hold the process open — it exists in node and not in a browser, where setTimeout
  // hands back a number.
  const t = setTimeout(() => dismiss(id), kind === 'err' ? TTL * 3 : TTL)
  t?.unref?.()
  return id
}

export function dismiss(id) {
  const next = items.filter(i => i.id !== id)
  if (next.length === items.length) return
  items = next
  emit()
}

export const ok = text => push(text, 'ok')
export const err = text => push(text, 'err')
