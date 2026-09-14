import fs from 'node:fs'
import path from 'node:path'
import { execFileNoThrow } from './exec.js'

// All nginx paths in one place, overridable via env for local testing.
const BASE = process.env.DASH_NGINX_DIR || '/etc/nginx'
export const PATHS = {
  nginxDir: BASE,
  sitesAvail: process.env.DASH_SITES_AVAIL || path.join(BASE, 'sites-available'),
  sitesEn: process.env.DASH_SITES_EN || path.join(BASE, 'sites-enabled'),
  confD: process.env.DASH_CONF_D || path.join(BASE, 'conf.d'),
  logDir: process.env.DASH_LOG_DIR || '/var/log/nginx',
  stateDir: process.env.DASH_STATE_DIR || '/var/lib/nginx-dashboard',
  certsDir: process.env.DASH_CERTS_DIR || path.join(BASE, 'dashboard-certs'),
  htpasswdDir: process.env.DASH_HTPASSWD_DIR || path.join(BASE, 'dashboard-htpasswd'),
}

export const MANIFEST = path.join(PATHS.stateDir, 'manifest.json')
export const HTTP_CONF = path.join(PATHS.confD, '00-dashboard.conf')

export function mkdirs() {
  for (const d of [PATHS.sitesAvail, PATHS.sitesEn, PATHS.confD, PATHS.logDir, PATHS.stateDir, PATHS.certsDir, PATHS.htpasswdDir])
    fs.mkdirSync(d, { recursive: true })
}

// Site names become filenames and shell arguments — strict allowlist is the whole injection defense.
export function validName(name) {
  return typeof name === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(name) && name.length <= 64
}

// Test seam: test/safe-apply.mjs swaps hooks.run to drive the pipeline without a real
// nginx binary. Production never touches it.
export const hooks = { run: execFileNoThrow }
export const shell = (cmd, args, opts) => hooks.run(cmd, args, opts)

export async function nginxTest() {
  const r = await shell('nginx', ['-t'])
  const output = (r.stderr || r.stdout).trim()
  return r.status === 0 ? { ok: true, output } : { ok: false, output }
}

export async function systemctl(action) {
  const r = await shell('systemctl', [action, 'nginx'])
  return r.status === 0 ? { ok: true, output: (r.stdout || 'done').trim() } : { ok: false, output: r.stderr.trim() }
}

/**
 * The one guard every mutation routes through.
 * Backs up `files`, runs `mutate()`, tests with `nginx -t`; on failure restores
 * every file byte-for-byte and returns the test error verbatim.
 * On success optionally reloads nginx and records the change in the history.
 *
 * opts.label    — what the change was, for the history list.
 * opts.testLink — `{ path, target }`: link this in for the `nginx -t` only (see below).
 * opts.record   — false keeps the change out of the history; see the call at the end.
 */
export async function safeApply(files, mutate, { reload = true, label = '', testLink, record = true } = {}) {
  const backups = new Map()
  for (const f of files) backups.set(f, readState(f))
  try {
    mutate()
  } catch (e) {
    restore(backups)
    return { ok: false, output: e.message }
  }

  // `nginx -t` reads only sites-enabled, so a *disabled* site's conf is invisible to it and
  // would go unvalidated until someone clicks Enable. Link it in for the test alone: nginx -t
  // never reloads, so the site does not start serving, and the link is gone before we return.
  const linked = !!testLink && !fs.existsSync(testLink.path)
  if (linked) {
    try { fs.symlinkSync(testLink.target, testLink.path, 'file') } catch { /* cannot link: the test just won't see it */ }
  }
  let t
  try {
    t = await nginxTest()
  } finally {
    if (linked) fs.rmSync(testLink.path, { force: true })
  }
  if (!t.ok) {
    restore(backups)
    return t
  }

  if (reload) {
    const r = await shell('nginx', ['-s', 'reload'])
    // A failed reload leaves nginx running the old config, so roll the files back too —
    // otherwise disk says one thing and the master process serves another.
    if (r.status !== 0) {
      restore(backups)
      return { ok: false, output: r.stderr.trim() || 'reload failed' }
    }
    // exit 0 only proves the master was *signalled*, not that it adopted the config.
    // A reload the master rejects at runtime — e.g. another process already holds :443, which
    // `nginx -t` cannot see — logs `[emerg] bind() ... Address already in use` and keeps the old
    // workers, while this returns ok. Disk then disagrees with the master and the site the UI
    // says is live is not. Detecting that means diffing worker pids around the reload; add it
    // if a port conflict ever bites in practice.
  }
  // Skipped only for a change the operator did not ask for — the dashboard rewriting its own conf
  // after a hand-edit deleted it. That has nothing to undo: the snapshot's "before" is a file that
  // did not exist, so replaying it would delete the conf and re-break what the repair just fixed.
  if (record) recordHistory(backups, label)
  return t
}

// A file as it was: its text, or the target of a symlink. `sites-enabled/x.conf` is a symlink
// and readFileSync follows it, so backing one up as text and writing it back on restore would
// swap the link for a plain copy of its target — the site keeps serving, then quietly stops
// tracking the real conf. Hence lstat, and both fields.
function readState(f) {
  try {
    if (fs.lstatSync(f).isSymbolicLink()) return { path: f, content: null, link: fs.readlinkSync(f) }
    return { path: f, content: fs.readFileSync(f, 'utf8'), link: null }
  } catch {
    return { path: f, content: null, link: null } // did not exist
  }
}

function writeState(s) {
  fs.mkdirSync(path.dirname(s.path), { recursive: true })
  if (s.link) {
    fs.rmSync(s.path, { force: true })
    fs.symlinkSync(s.link, s.path, 'file')
  } else if (s.content === null) {
    fs.rmSync(s.path, { force: true })
  } else {
    fs.writeFileSync(s.path, s.content)
  }
}

function restore(backups) {
  for (const s of backups.values()) writeState(s)
}

// ---------- change history ----------
// safeApply already reads a byte-for-byte snapshot of everything it is about to overwrite, and
// until now threw it away on success. Keeping the last few turns "I clicked the wrong button"
// into a recoverable state. Conf files and the manifest only — a config history, not a backup
// of anyone's docroot.
const HISTORY_MAX = 20
const historyDir = () => path.join(PATHS.stateDir, 'history')
// Doubles as the traversal guard: what arrives from the client is used as a filename.
const HISTORY_ID_RE = /^[0-9]{10,16}-[0-9a-f]{6}\.json$/

let historySeq = 0
function recordHistory(backups, label) {
  try {
    fs.mkdirSync(historyDir(), { recursive: true })
    // Timestamp plus a counter, not a random suffix: two changes in the same millisecond have
    // to keep their order, or "newest first" is a coin toss for both the list and the tests.
    const name = `${Date.now()}-${(historySeq++).toString(16).padStart(6, '0')}.json`
    // 0600: the manifest snapshot in here carries basic-auth passwords in plaintext, the same
    // as the manifest itself.
    fs.writeFileSync(path.join(historyDir(), name), JSON.stringify({ at: Date.now(), label, files: [...backups.values()] }), { mode: 0o600 })
    const all = fs.readdirSync(historyDir()).filter(f => HISTORY_ID_RE.test(f)).sort()
    for (const old of all.slice(0, Math.max(0, all.length - HISTORY_MAX))) fs.rmSync(path.join(historyDir(), old), { force: true })
  } catch {
    // History is a convenience. A read-only or full state dir must not turn a config change
    // that already succeeded and reloaded into an error.
  }
}

/** Newest first. A snapshot that will not parse is skipped, not fatal. */
export function listHistory() {
  try {
    return fs.readdirSync(historyDir())
      .filter(f => HISTORY_ID_RE.test(f))
      .sort() // the name is timestamp+counter, so this is chronological
      .reverse()
      .flatMap(f => {
        try {
          const h = JSON.parse(fs.readFileSync(path.join(historyDir(), f), 'utf8'))
          return [{ id: f, at: h.at, label: h.label || '(unlabelled change)', paths: h.files.map(x => x.path) }]
        } catch { return [] }
      })
  } catch {
    return []
  }
}

/**
 * The raw snapshot behind a history id, or null. Same traversal guard as revertHistory — what
 * arrives from the client is used as a filename — and read here so a caller can inspect what a
 * revert *would* do before letting it run.
 */
export function readHistoryEntry(id) {
  if (!HISTORY_ID_RE.test(String(id || ''))) return null
  try {
    return JSON.parse(fs.readFileSync(path.join(historyDir(), id), 'utf8'))
  } catch { return null }
}

/**
 * Put the files back the way they were before the recorded change. Runs through safeApply, so
 * the restore is itself tested and reloaded — and snapshotted, which makes it undoable in turn.
 * Note it restores the manifest too, so reverting past a later change reverts that as well.
 * `apply` is injectable for the same reason `hooks.run` is: the server's DRY mode swaps in a
 * version that writes without shelling out, and a revert has to honour that like every other write.
 */
export async function revertHistory(id, apply = safeApply) {
  if (!HISTORY_ID_RE.test(String(id || ''))) return { ok: false, output: 'bad history id' }
  const file = path.join(historyDir(), id)
  let h
  try {
    h = JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return { ok: false, output: 'no such history entry' }
  }
  if (!Array.isArray(h.files) || !h.files.length) return { ok: false, output: 'history entry is empty' }
  return apply(h.files.map(x => x.path), () => { for (const s of h.files) writeState(s) }, { label: `undo: ${h.label || 'change'}` })
}

// Resolve a user-supplied path inside a jail dir; throws on traversal.
export function safeJoin(jail, rel) {
  const j = path.resolve(jail)
  const p = path.resolve(j, rel || '.')
  if (p !== j && !p.startsWith(j + path.sep)) throw new Error('path escapes root')
  return p
}