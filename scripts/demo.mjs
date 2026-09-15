#!/usr/bin/env node
// A dashboard on this machine with nothing to configure: DRY mode, so it writes conf files but
// never runs nginx, systemctl or certbot (there is no nginx here to run), its own tree under
// .demo/ so it cannot reach a real install's manifest or history, and the password `demo`.
// Run: npm run demo
//
// DASH_DEMO=1 is the whole of what makes a placeholder password startable, and nothing in deploy/
// sets it — so an install that somehow ran this file gets server.js's refusal, not a dashboard
// behind a password printed in the repository. Everything is set on process.env *before* the
// import, because lib/nginx.js reads its paths at module load.
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const dir = path.join(root, '.demo')

process.env.DASH_DEMO = '1'
process.env.DASH_PASSWORD = 'demo'
process.env.DASH_DRY = '1'
process.env.DASH_HOST ??= '127.0.0.1'
process.env.DASH_PORT ??= '7412'
process.env.DASH_NGINX_DIR = path.join(dir, 'nginx')
process.env.DASH_LOG_DIR = path.join(dir, 'logs')
process.env.DASH_STATE_DIR = path.join(dir, 'state')

await import('../server.js')
