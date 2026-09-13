# nginx-dashboard

A web dashboard that controls NGINX entirely via buttons — no command line.
Runs next to nginx on your Ubuntu/Debian server.

## Modules

| Tab | What it does |
|---|---|
| **control** | start / stop / restart nginx, reload config (`nginx -s reload`), test config (`nginx -t`) |
| **sites** | create / edit / delete / enable / disable server blocks; per-site form covering: reverse-proxy rules, load-balancer upstreams (round robin / least connections / IP hash, http & https backends, passive health checks), **PHP / FastCGI backends**, HTTPS on any port (self-signed / Let's Encrypt / existing certs, force-redirect, TLS-only vhosts), rate limiting, IP allow/deny lists, basic auth, gzip, HTTP/2 & HTTP/3 (+ reuseport), browser caching; built-in file manager with multi-upload and **deploy-folder-as-zip** |
| **logs** | live tail of access.log & error.log (SSE), rotate, purge old rotated logs |
| **metrics** | stub_status stats + live active-connections chart |

The interface is a dark instrument panel in the NXD palette, with every number
set in IBM Plex Mono. Archivo and IBM Plex Mono come from Google Fonts, so on a
host with no outbound internet the browser falls back to system fonts — the
layout does not depend on them.

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
  are looking at instead of saving it for Enable.
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

## Dynamic backends

Any HTTP app — Node, Python, a container, a remote instance — is a **proxy rule**
under *Reverse proxy*. PHP-FPM and anything else that speaks FastCGI is a
**FastCGI endpoint** under *Application backend*:

- Endpoint takes either form: `unix:/run/php/php8.3-fpm.sock` or `127.0.0.1:9000`.
- The script file is checked for existence *before* FastCGI sees it
  (`try_files $fastcgi_script_name =404`), so `/uploads/avatar.jpg/x.php` is a
  404 rather than code handed to the interpreter.
- **Front controller** sends unmatched paths to `/index.php` — that is the
  WordPress / Laravel / Drupal shape.
- The **TLS port** is a field, not a constant: `listen 44306 ssl`, the QUIC
  listener, the `Alt-Svc` header and the plain-HTTP redirect all follow it. A
  vhost can also be TLS-only (`serveHttp` off), and its `server_name` may be
  left blank — it then answers to anything arriving on that port.

Hardening emitted for every site: dotfiles denied (`location ~ /\.(?!well-known)`)
in both blocks, TLS 1.2+ only, `ssl_session_tickets off`, and a shared session
cache. Not emitted, deliberately: HSTS (a one-way door — needs its own toggle)
and `client_max_body_size` (raise it yourself for large WordPress uploads).

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

See `deploy/README.md` for deployment (installer script, systemd unit, dev/dry
mode).