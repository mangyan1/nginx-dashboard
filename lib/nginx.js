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
 * On success optionally reloads nginx.
 */
export async function safeApply(files, mutate, { reload = true } = {}) {
  const backups = new Map()
  for (const f of files) {
    backups.set(f, fs.existsSync(f) ? fs.readFileSync(f) : null)
  }
  try {
    mutate()
  } catch (e) {
    restore(backups)
    return { ok: false, output: e.message }
  }
  const t = await nginxTest()
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
  }
  return t
}

function restore(backups) {
  for (const [f, content] of backups) {
    if (content === null) fs.rmSync(f, { force: true })
    else fs.writeFileSync(f, content)
  }
}

// Resolve a user-supplied path inside a jail dir; throws on traversal.
export function safeJoin(jail, rel) {
  const j = path.resolve(jail)
  const p = path.resolve(j, rel || '.')
  if (p !== j && !p.startsWith(j + path.sep)) throw new Error('path escapes root')
  return p
}