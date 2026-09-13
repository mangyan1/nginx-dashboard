let on401 = () => {}
export const set401Handler = fn => { on401 = fn }

export async function api(method, path, body) {
  const opts = { method, headers: {} }
  if (body !== undefined) {
    if (body instanceof FormData) opts.body = body
    else { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body) }
  }
  const res = await fetch(path, opts)
  if (res.status === 401) { on401(); throw new Error('unauthorized') }
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(data.error || res.statusText)
  return data
}