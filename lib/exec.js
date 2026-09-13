import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const run = promisify(execFile)

// execFile everywhere — no shell string interpolation, so no injection surface.
// Command args from the UI are additionally name-validated upstream (validName, isIp, domain regex).
export async function execFileNoThrow(cmd, args, opts = {}) {
  try {
    const { stdout, stderr } = await run(cmd, args, { timeout: 30_000, ...opts })
    return { stdout: stdout.toString(), stderr: stderr.toString(), status: 0 }
  } catch (e) {
    return { stdout: (e.stdout || '').toString(), stderr: (e.stderr || e.message || '').toString(), status: e.code ?? 1 }
  }
}