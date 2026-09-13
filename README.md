# nginx-dashboard

A web dashboard that controls NGINX entirely via buttons — no command line.
Runs next to nginx on your Ubuntu/Debian server.

## Modules

| Tab | What it does |
|---|---|
| **control** | start / stop / restart nginx, reload config (`nginx -s reload`), test config (`nginx -t`) |
| **sites** | create / edit / delete / enable / disable server blocks; per-site form covering: reverse-proxy rules, load-balancer upstreams (round robin / least connections / IP hash, http & https backends, passive health checks), HTTPS (self-signed / Let's Encrypt / existing certs, force-redirect), rate limiting, IP allow/deny lists, basic auth, gzip, HTTP/2 & HTTP/3, browser caching; built-in file manager with multi-upload and **deploy-folder-as-zip** |
| **logs** | live tail of access.log & error.log (SSE), rotate, purge old rotated logs |
| **metrics** | stub_status stats + live active-connections chart |

## How it works

- Every site the dashboard creates is stored in a JSON manifest
  (`/var/lib/nginx-dashboard/manifest.json`) and its `.conf` is **generated**
  from it — never parsed back. Foreign sites in `sites-available` are listed
  read-only.
- Every change goes through one pipeline: write file → `nginx -t` →
  on failure restore the previous file byte-for-byte and show the error →
  on success `nginx -s reload`. A config nginx rejects can never reach nginx.
  A *disabled* site is still tested — nginx only reads `sites-enabled`, so it is
  linked in for the test and unlinked again, keeping the error in the form you
  are looking at instead of saving it for Enable. One honest caveat: `nginx -s
  reload` exits 0 even when the master then refuses the config at runtime, so a
  port that is already taken leaves the UI saying "enabled" while nginx serves the
  previous config. See `AGENT.md` §4.
- **Every successful change is undoable.** `GET /api/history` lists the last 20
  changes (newest first, with the files each one touched);
  `POST /api/history/:id/revert` puts them back — through the same pipeline, so a
  revert is tested and reloaded like anything else, and is itself undoable.
  Config and manifest only: reverting a deletion restores the conf, not the docroot.
- **Hand edits are reported, not silently eaten.** The next click regenerates a
  site's `.conf` from the manifest, so an edit made outside the dashboard would
  vanish without a word. `GET /api/sites` returns `drift` per site
  (`'modified' | 'missing' | null`) plus `httpConfDrift` for the shared file, so the
  UI can warn first. Nothing is repaired automatically — that is the point.
- http-level directives (upstreams, rate-limit zones) live in the
  dashboard-owned `/etc/nginx/conf.d/00-dashboard.conf`. `nginx.conf` is
  never touched.

## Security model

- One password (`DASH_PASSWORD` env), session cookie, `HttpOnly SameSite=Strict`.
- Binds to `127.0.0.1:3000` — reach it via SSH tunnel or an nginx TLS vhost.
- Anyone with the password effectively has root: keep it strong.

## Dev & deploy

```bash
npm install
npm run build   # build the frontend
npm run dev     # or: Vite dev server at :5173, proxies /api to :3000
```

See `deploy/README.md` for deployment (installer script, systemd unit,
dev/dry mode). See `AGENT.md` for the architecture invariants, test layout and
open items — read that before changing the generator or the apply pipeline.