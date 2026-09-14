import * as toast from './toast.js'

let on401 = () => {}
export const set401Handler = fn => { on401 = fn }

// Only the verbs that change something report. Two of the GETs are polled on a timer — /api/status
// every ten seconds, /api/metrics every two, and metrics answers 503 whenever nginx is down, which
// is exactly when the operator is on Control trying to start it — so a toast per failed GET would
// be thirty a minute. A 401 says nothing either: it already routes to the sign-in screen, and that
// screen is the message.
const WRITES = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])

// What the operator just did, in one line, keyed by the shape of the route rather than written out
// at each of the eighteen call sites — where the nineteenth would forget. A route that is not here
// still reports its failures; it simply has nothing to boast about when it works.
const said = (method, path, data) => {
  const p = path.split('?')[0].split('/').filter(Boolean)   // ['api','sites','shop','enable']
  const site = data?.site?.name || p[2] || ''
  if (p[1] === 'sites') {
    if (!p[2]) return `site ${site} created`
    if (p[3] === 'enable') return `site ${site} enabled`
    if (p[3] === 'disable') return `site ${site} disabled`
    if (p[3] === 'repair') return `site ${site} rewritten from the manifest`
    if (p[3] === 'selfsigned') return 'self-signed certificate issued'
    if (p[3] === 'upload-zip') return 'folder deployed'
    if (p[3] === 'files') return method === 'DELETE' ? 'file deleted' : 'file uploaded'
    return method === 'DELETE' ? `site ${site} deleted` : `site ${site} saved and applied`
  }
  if (p[1] === 'settings') {
    if (p[2] === '2fa') return p[3] === 'enable' ? 'second factor on' : p[3] === 'disable' ? 'second factor off' : 'second-factor setup started'
    if (p[2] === 'lockouts') return 'lockouts cleared'
    if (p[2] === 'history') return 'undo history cleared'
    if (p[2] === 'new-site-defaults') return 'new-site defaults saved'
    // `apply` runs once per package behind a progress bar, so the panel is already saying it —
    // a toast per package would be four of them stacked on top of the bar that shows the same.
    if (p[2] === 'updates') return ''
    if (p[2] === 'restart') return 'restarting the dashboard'
    return ''
  }
  if (p[1] === 'nginx') return `nginx ${p[2]}`
  if (p[1] === 'logs') return p[2] === 'rotate' ? 'logs rotated' : 'old logs purged'
  if (p[1] === 'cert') return 'certificate requested'
  return ''
}

export async function api(method, path, body) {
  const opts = { method, headers: {} }
  if (body !== undefined) {
    if (body instanceof FormData) opts.body = body
    else { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body) }
  }
  const write = WRITES.has(method)
  let res
  try {
    res = await fetch(path, opts)
  } catch (e) {
    // the dashboard itself is unreachable, which is the one failure a caller cannot render: there
    // is no response for it to render
    if (write) toast.err(`could not reach the dashboard — ${e.message}`)
    throw new Error(e.message)
  }
  if (res.status === 401) { on401(); throw new Error('unauthorized') }
  const data = await res.json().catch(() => ({}))
  if (!res.ok) {
    const msg = data.error || res.statusText
    if (write) toast.err(msg)
    throw new Error(msg)
  }
  // Some routes answer 200 with {ok:false} so the panel can show the output beside the button that
  // produced it — `nginx -t` and a reload both do. Status alone would let a rejected config look
  // like a success up here, which is the Control panel's whole purpose.
  if (write) {
    if (data.ok === false) toast.err(data.error || data.output || 'the action failed')
    else toast.ok(said(method, path, data))
  }
  return data
}
