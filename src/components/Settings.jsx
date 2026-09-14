import { useEffect, useMemo, useState } from 'react'
import qrcode from 'qrcode-generator'
import { api } from '../api.js'
import * as toast from '../toast.js'
import { Btn, Field, Section, Out } from './ui.jsx'

/**
 * The QR, drawn from the encoder's own module grid rather than from the SVG string it can also hand
 * back: one <path>, no raw HTML anywhere, and the modules pick up the panel's colour through
 * `fill: currentColor`. Four modules of quiet zone, which is what the spec asks for and what a phone
 * camera needs when it is looking at a screen rather than at paper.
 */
function Qr({ text, size = 168 }) {
  const d = useMemo(() => {
    const qr = qrcode(0, 'M')
    qr.addData(text)
    qr.make()
    const n = qr.getModuleCount()
    let path = ''
    for (let r = 0; r < n; r++) {
      for (let c = 0; c < n; c++) if (qr.isDark(r, c)) path += `M${c} ${r}h1v1h-1z`
    }
    return { path, n }
  }, [text])
  return (
    <svg className="qr" width={size} height={size} viewBox={`-4 -4 ${d.n + 8} ${d.n + 8}`}
      role="img" aria-label="Second-factor setup QR code">
      <path d={d.path} />
    </svg>
  )
}

/** A read-only line. Nothing here is editable, so it is text rather than a disabled input. */
const Kv = ({ k, v, cls = '' }) => <span className="kv"><i>{k}</i><b className={cls}>{v}</b></span>

/**
 * Security, Environment, new-site defaults, maintenance, appearance and updates.
 *
 * The second factor is the reason this tab exists. Enrolling used to mean SSH, `npm run totp:new`,
 * pasting a line into the unit file and restarting — three steps of which one is easy to get wrong
 * in a way that silently drops the factor. Here the secret is minted, shown as a QR and as text,
 * and written only once a code from the phone has proved it works.
 */
export default function Settings({ status, theme, onTheme }) {
  const [s, setS] = useState(null)
  const [err, setErr] = useState('')
  const [result, setResult] = useState(null)
  const [busy, setBusy] = useState(false)
  // the enrolment in progress: { secret, uri } once begun, plus whatever has been typed at it
  const [pending, setPending] = useState(null)
  const [code, setCode] = useState('')
  const [password, setPassword] = useState('')
  const [draft, setDraft] = useState('')
  const [history, setHistory] = useState(null)
  const [updates, setUpdates] = useState(null)

  const load = () => {
    setErr('')
    api('GET', '/api/settings')
      .then(r => { setS(r); setDraft(JSON.stringify(r.newSiteDefaults, null, 2)) })
      .catch(e => setErr(e.message))
    api('GET', '/api/history').then(r => setHistory(r.entries.length)).catch(() => setHistory(null))
  }
  useEffect(load, [])

  // One wrapper, so every action here reports the same way: the toast comes from api(), and this
  // only feeds the panel's own result line.
  const act = async (fn, ok) => {
    setBusy(true)
    setResult(null)
    try { setResult({ ok: true, output: (await fn()) || ok }) } catch (e) { setResult({ ok: false, output: e.message }) } finally { setBusy(false) }
  }

  if (err) return <div className="panel-body"><p className="hint">Could not read the settings: {err}</p><Btn onClick={load}>Retry</Btn></div>
  if (!s) return <div className="panel-body"><p className="hint">loading…</p></div>

  const fromEnv = s.totp.source === 'env'
  const begin = () => act(async () => {
    const r = await api('POST', '/api/settings/2fa/begin')
    setPending(r)
    setCode('')
    return 'Scan the code, then type the six digits it shows to switch the second factor on.'
  })
  const enable = () => act(async () => {
    await api('POST', '/api/settings/2fa/enable', { code })
    setPending(null)
    setCode('')
    load()
  }, 'second factor on')
  const disable = () => act(async () => {
    await api('POST', '/api/settings/2fa/disable', { password })
    setPassword('')
    load()
  }, 'second factor off')
  const saveDefaults = () => act(async () => {
    let parsed
    // Parsed here as well as on the server, because the message JSON.parse gives names the
    // character, and the character is the thing being fixed. It reports to the toast by hand
    // because it is the one failure in this panel that never reaches api() — the draft has to be an
    // object before it can be put in a request body, so there is nothing to send and nothing for
    // api() to report.
    try { parsed = JSON.parse(draft || '{}') } catch (e) {
      const msg = `not valid JSON — ${e.message}`
      toast.err(msg)
      throw new Error(msg)
    }
    const r = await api('PUT', '/api/settings/new-site-defaults', { defaults: parsed })
    setDraft(JSON.stringify(r.defaults, null, 2))
    return 'new sites will be created from this'
  })
  const checkUpdates = () => act(async () => {
    const r = await api('GET', '/api/settings/updates')
    setUpdates(r)
    // '' on success, so the fallback below is what the panel says — the table is the answer, and a
    // bare "ok" underneath it says nothing.
    return r.reachable ? '' : 'could not reach the npm registry from this server — nothing was changed'
  }, 'checked against the npm registry')

  // Counted over the packages this install actually has, not over every name in package.json: a
  // devDependency is not present on a server and there is nothing there to update.
  const known = updates?.packages.filter(p => p.installed && p.latest) || []
  const behind = known.filter(p => p.latest !== p.installed).length

  return (
    <section className="panel">
      <div className="panel-head">
        <span className="panel-title">Settings</span>
        <span className="spacer" />
        <span className="kv"><i>this dashboard</i><b className="accent">{s.env.host}:{s.env.port}</b></span>
      </div>
      <div className="panel-body">

        <Section title="Security — second factor">
          <div className="row">
            <Kv k="authenticator" v={s.totp.enabled ? 'on' : 'off'} cls={s.totp.enabled ? 'ok' : 'dim'} />
            <Kv k="set by" v={fromEnv ? 'the service unit' : s.totp.enabled ? 'this dashboard' : '—'} />
            <Kv k="lockout after" v={`${s.lockout.max} wrong passwords`} />
            <Kv k="locked for" v={`${s.lockout.lockMin} min`} />
          </div>

          {fromEnv && (
            <p className="sub">
              A time-based code is required at sign-in, and it is owned by
              <code> DASH_TOTP_SECRET</code> in the service unit. The environment variable outranks
              anything saved here, so these controls would be ignored — remove that line and restart
              to manage the factor from this page instead.
            </p>
          )}

          {!fromEnv && !s.totp.enabled && !pending && <>
            <p className="sub">
              A code from an authenticator app on your phone, asked for after the password. Google
              Authenticator, Aegis, 1Password, FreeOTP — anything that reads the standard
              <code> otpauth://</code> QR below will do.
            </p>
            <div className="actions"><Btn kind="primary" disabled={busy} onClick={begin}>Set up the second factor</Btn></div>
          </>}

          {!fromEnv && pending && <>
            <p className="sub">
              Scan this with the authenticator app. Then type the six digits it shows — the secret is
              written only once a code from it has been accepted, so a mistyped one cannot lock you
              out.
            </p>
            <div className="qrbox">
              <Qr text={pending.uri} />
              <div className="qrfacts">
                <p className="sub">Can’t scan it? Type this key into the app instead, or paste the URL.</p>
                <Field label="Setup key"><input readOnly value={pending.secret} onFocus={e => e.target.select()} /></Field>
                <Field label="otpauth URL"><input readOnly value={pending.uri} onFocus={e => e.target.select()} /></Field>
              </div>
            </div>
            <Field label="Code from the app">
              <input value={code} inputMode="numeric" autoComplete="one-time-code" placeholder="123456"
                onChange={e => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))} />
            </Field>
            <div className="actions">
              <Btn kind="primary" disabled={busy || code.length !== 6} onClick={enable}>{busy ? '…' : 'Turn it on'}</Btn>
              <Btn disabled={busy} onClick={() => { setPending(null); setCode('') }}>Cancel</Btn>
            </div>
          </>}

          {!fromEnv && s.totp.enabled && <>
            <p className="sub">
              On, and stored in <code>settings.json</code> on this server at mode 0600 — not in the
              manifest, because history snapshots restore whole sites and a revert could otherwise
              drop the factor silently. Losing the phone is recoverable here, with the password alone.
            </p>
            <Field label="Password (to turn it off)">
              <input type="password" value={password} autoComplete="current-password"
                onChange={e => setPassword(e.target.value)} placeholder="the dashboard password" />
            </Field>
            <div className="actions">
              <Btn disabled={busy || !password} onClick={disable}>Turn the second factor off</Btn>
            </div>
          </>}
        </Section>

        <Section title="Security — lockouts">
          <p className="sub">
            Failed sign-ins are counted per address, and the count lives in memory: restarting the
            service clears every lockout, which is the recovery that needs no password. This is the
            same thing without a restart.
          </p>
          {s.locked.length
            ? <ul>{s.locked.map(l => <li key={l.ip}><code>{l.ip}</code> — until {new Date(l.until).toLocaleTimeString()}</li>)}</ul>
            : <p className="sub">Nobody is locked out.</p>}
          <div className="actions">
            <Btn disabled={busy || !s.locked.length} onClick={() => act(async () => {
              const r = await api('POST', '/api/settings/lockouts/clear')
              load()
              return r.output
            }, '')}>Clear lockouts</Btn>
          </div>
        </Section>

        <Section title="New-site defaults">
          <p className="sub">
            What a new site starts from — and what a site created by the API gets when it does not
            mention a field. A partial site: anything left out comes from the built-in defaults.
            Applied only when a site is <b>created</b>, so a change here can never reinterpret a site
            that is already serving traffic.
          </p>
          <textarea className="code" rows={10} value={draft} spellCheck={false}
            onChange={e => setDraft(e.target.value)} aria-label="New-site defaults as JSON" />
          <div className="actions">
            <Btn kind="primary" disabled={busy} onClick={saveDefaults}>Save</Btn>
            <Btn disabled={busy} onClick={() => setDraft('{}')}>Clear all</Btn>
          </div>
        </Section>

        <Section title="Maintenance">
          <div className="row">
            <Kv k="undo history" v={history === null ? '—' : `${history} snapshot${history === 1 ? '' : 's'}`} />
          </div>
          {/* Not in the row above: these are absolute paths, and a `.kv` value is nowrap by design —
              two of them side by side run into each other and neither is readable. */}
          <ul>
            <li><code>{s.env.manifest}</code> — the sites, and their basic-auth passwords in plaintext</li>
            <li><code>{s.env.settings}</code> — what this page writes</li>
          </ul>
          <p className="sub">
            Every write keeps a snapshot of the conf files and the manifest, so the last twenty
            changes can be undone from the Logs tab. Each snapshot carries the manifest too, which is
            why clearing them is how you hand the box over without the passwords in it.
          </p>
          <div className="actions">
            <Btn disabled={busy || !history} onClick={() => act(async () => {
              const r = await api('DELETE', '/api/settings/history')
              load()
              return r.output
            }, '')}>Clear undo history</Btn>
          </div>
        </Section>

        <Section title="Appearance">
          <p className="sub">The same switch as the one in the header — here so it can be found without hunting for it.</p>
          <div className="seg" role="group" aria-label="Theme">
            <button className={theme === 'dark' ? 'on' : ''} onClick={() => onTheme('dark')}>Dark</button>
            <button className={theme === 'light' ? 'on' : ''} onClick={() => onTheme('light')}>Light</button>
          </div>
        </Section>

        <Section title="Updates">
          <p className="sub">
            Asks the npm registry what the newest version of each of this project's dependencies is.
            Nothing about this install is sent — the registry sees a package name and this server's
            address, and only when you press the button. It never updates anything by itself.
          </p>
          <div className="actions">
            <Btn disabled={busy} onClick={checkUpdates}>{busy ? '…' : 'Check for updates'}</Btn>
            {updates?.reachable && <span className="kv"><i>behind</i><b className={behind ? 'warn' : 'ok'}>{behind ? `${behind} of ${known.length}` : 'nothing'}</b></span>}
          </div>
          {updates && (
            <table>
              <thead><tr><th>package</th><th>installed</th><th>latest</th></tr></thead>
              <tbody>
                {updates.packages.map(p => (
                  <tr key={p.name}>
                    <td>{p.name}</td>
                    <td className={p.installed ? '' : 'dim'}>{p.installed || 'not installed'}</td>
                    <td className={p.error ? 'dim' : p.latest === p.installed ? 'dim' : 'accent'}>
                      {p.error || p.latest}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Section>

        <Section title="Environment">
          <p className="sub">Read-only. These come from where this dashboard is installed — the service unit, or the built-in defaults.</p>
          <div className="row">
            <Kv k="listening on" v={`${s.env.host}:${s.env.port}`} />
            <Kv k="mode" v={s.env.dry ? 'dry run' : 'live'} cls={s.env.dry ? 'warn' : ''} />
            <Kv k="upload limit" v={`${s.env.maxUploadMB} MB`} />
            <Kv k="pinned vhost" v={s.env.selfName || 'none'} cls={s.env.selfName ? 'accent' : 'dim'} />
            <Kv k="nginx" v={status?.version || '—'} />
            <Kv k="node" v={s.env.node} />
          </div>
        </Section>

        <Out result={result} />
      </div>
    </section>
  )
}
