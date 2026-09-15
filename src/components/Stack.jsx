import { useEffect, useRef, useState } from 'react'
import { api } from '../api.js'
import { Btn, Section } from './ui.jsx'

const MAX_LINES = 500

/**
 * The stack: nginx, a database, PHP-FPM — what a PHP site needs and a static one does not.
 *
 * This dashboard installs none of it. The button runs `deploy/lemp.sh`, which is the same file
 * `install.sh --lemp` runs, so the package list exists once. What is here is the watching: a package
 * install is the one action in this app nothing can roll back, so the output is shown as it runs and
 * the outcome is kept — a failure nobody can see would be worse than no button.
 *
 * The rows come from the server, which asks the box rather than remembering: `lemp.sh --detect`
 * parses PHP's own pool config, so the endpoint below is the one PHP is actually listening on.
 */
export default function Stack() {
  const [st, setSt] = useState(null)
  const [err, setErr] = useState('')
  const [lines, setLines] = useState([])
  const [verdict, setVerdict] = useState(null) // the stream's terminal event, or null
  const [running, setRunning] = useState(false)
  const [busy, setBusy] = useState(false)
  const box = useRef(null)
  const es = useRef(null)
  const done = useRef(false)
  const alive = useRef(true)

  useEffect(() => () => { alive.current = false; es.current?.close() }, [])
  // follows the tail the way the log panes do — the newest line is the one being waited on
  useEffect(() => { if (box.current) box.current.scrollTop = box.current.scrollHeight }, [lines])

  /**
   * One connection at a time, and every connection starts from an empty buffer: the server replays
   * the whole run to each new client, so keeping what a dropped connection already delivered would
   * show every line twice.
   */
  const attach = () => {
    if (es.current || !alive.current) return
    setLines([])
    done.current = false
    const s = new EventSource('/api/stack/install/stream')
    es.current = s
    s.onmessage = e => setLines(prev => {
      const next = [...prev, e.data]
      return next.length > MAX_LINES ? next.slice(-MAX_LINES) : next
    })
    s.addEventListener('done', e => {
      done.current = true
      setVerdict(JSON.parse(e.data))
      setRunning(false)
      s.close()
      if (es.current === s) es.current = null
      load() // re-read the rows, so success is shown rather than asserted
    })
    s.onerror = () => {
      s.close()
      if (es.current === s) es.current = null
      if (done.current || !alive.current) return
      // Not the end of the run: the connection dropped, or the dashboard restarted underneath it. A
      // job does not survive that, but its outcome does — settings.json — so re-reading is what
      // tells the truth here rather than a reconnect that would replay a buffer nothing is writing.
      setRunning(false)
      load()
    }
  }

  const load = () => api('GET', '/api/stack').then(s => {
    setSt(s)
    setErr('')
    // a reload mid-install reattaches and replays, so navigating away does not lose the run
    if (s.installing) { setRunning(true); attach() }
  }).catch(e => setErr(e.message))

  useEffect(() => { load() }, [])

  const install = async () => {
    setBusy(true)
    setVerdict(null)
    setErr('')
    try {
      await api('POST', '/api/stack/install')
      setRunning(true)
      attach()
    } catch (e) {
      setErr(e.message)
    } finally { setBusy(false) }
  }

  const title = 'Stack — nginx, database, PHP'
  if (err && !st) {
    return (
      <Section title={title}>
        <p className="hint">Could not read the stack: {err}</p>
        <div className="actions"><Btn onClick={load}>Retry</Btn></div>
      </Section>
    )
  }
  if (!st) return <Section title={title}><p className="hint">loading…</p></Section>

  const last = st.last
  // A version or a token, never a sentence: `.kv b` is nowrap by design, so a row of prose values
  // sits a character apart and reads as one run. Absent is `—`, the same as everywhere else here.
  const at = (v, ok) => <b className={ok ? 'ok' : 'warn'}>{v || '—'}</b>

  return (
    <Section title={title}>
      <p className="sub">
        A static site needs none of this. PHP sites — WordPress included — need all of it, and
        <b> Install LEMP</b> runs <code>deploy/lemp.sh</code>: the same script as
        <code> install.sh --lemp</code>, so there is one package list and not two. It cannot be
        undone, which is why its output appears below while it runs rather than as a summary after.
      </p>

      <div className="row">
        <span className="kv"><i>nginx</i>{at(st.nginx.version || (st.nginx.present ? 'present' : ''), st.nginx.present)}</span>
        <span className="kv"><i>PHP-FPM</i>{at(st.php.version, !!st.php.endpoint)}</span>
        <span className="kv"><i>database</i>{at(st.db.kind, !!st.db.kind)}</span>
        <span className="kv"><i>unzip</i>{at(st.unzip ? 'present' : '', st.unzip)}</span>
      </div>
      {/* Not in the row above: an absolute path and two states, and a `.kv` value is nowrap by
          design — a row of them runs together and none of it is readable. */}
      {(st.php.endpoint || st.db.kind) && (
        <ul>
          {st.php.endpoint && (
            <li>
              <code>{st.php.endpoint}</code> — {st.php.active ? 'running' : 'not running'}, and what
              a new site’s PHP endpoint is filled from
            </li>
          )}
          {st.db.kind && <li>{st.db.kind} {st.db.version} — {st.db.active ? 'running' : 'not running'}</li>}
        </ul>
      )}

      <div className="actions">
        <Btn onClick={load} disabled={busy || running}>Check again</Btn>
        {/* Absent rather than disabled when there is nothing to do — a dead control invites a click
            and then explains itself, which is worse than not being there. */}
        {(st.missing.length > 0 || running) && (
          <Btn kind="primary" disabled={busy || running || st.dry} onClick={install}
            title={st.dry ? 'dry mode writes config but installs nothing' : 'runs apt-get as root on this server'}>
            {running ? 'installing…' : `Install LEMP — ${st.missing.join(', ')}`}
          </Btn>
        )}
      </div>

      {st.dry && (
        <p className="hint warn">
          dry mode — installing is refused here. Run <code>deploy/lemp.sh</code>, or
          <code> install.sh --lemp</code>, on the server.
        </p>
      )}
      {err && <p className="hint warn">{err}</p>}

      {verdict && (
        <p className="sub">
          <span className={`chip ${verdict.ok ? 'ok' : 'warn'}`}>{verdict.ok ? 'installed' : 'failed'}</span>{' '}
          {verdict.ok ? 'the stack is up — the rows above were re-read, not assumed'
            : verdict.error || `lemp.sh exited ${verdict.status}`}
        </p>
      )}

      {/* The last attempt, when it is not the one on screen. Written to settings.json as the job
          ends, so this survives a reload, a different browser, and a restart of the dashboard. */}
      {!running && !verdict && last && (
        <p className="sub">
          <span className={`chip ${last.ok ? 'ok' : 'warn'}`}>{last.ok ? 'installed' : 'failed'}</span>{' '}
          last attempt {new Date(last.at).toLocaleString()}
        </p>
      )}
      {!running && !verdict && last && !last.ok && <pre className="out">{(last.tail || []).join('\n')}</pre>}

      {lines.length > 0 && <pre ref={box} className="out">{lines.join('\n')}</pre>}
    </Section>
  )
}
