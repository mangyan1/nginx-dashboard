# Deploying nginx-dashboard

## Build (dev machine)

```bash
npm install
npm run build        # produces dist/
```

Then copy the whole folder (including `dist/`) to the server and run the installer:

```bash
scp -r . user@server:/tmp/nginx-dashboard
ssh user@server 'sudo bash /tmp/nginx-dashboard/deploy/install.sh'
```

`install.sh` is idempotent — re-running it upgrades outdated dependencies
(node, nginx, certbot, npm packages) and refreshes the app files.

## First run

The installer generates a random `DASH_PASSWORD` and prints it once.
It's stored in `/etc/systemd/system/nginx-dashboard.service` — change it there,
then `systemctl restart nginx-dashboard`.

## Environment

Everything is set in the systemd unit. The installer carries an existing
`DASH_TOTP_SECRET` across a re-run; the rest come from the shipped unit file.

| Variable | Default | What it does |
|---|---|---|
| `DASH_PASSWORD` | — | the login password; required |
| `DASH_HOST` / `DASH_PORT` | `127.0.0.1` / `3000` | what the dashboard itself binds |
| `DASH_SELF_NAME` | `nxd` | name of the dashboard's own managed vhost; unset pins nothing |
| `DASH_MAX_UPLOAD_MB` | `2048` | upload cap for the file manager, and the default for the self vhost's `client_max_body_size` |
| `DASH_TOTP_SECRET` | unset | base32 TOTP secret; unset = password only |
| `DASH_DRY` | unset | `1` writes config but skips `nginx -t`, reloads and certbot |

`npm run totp:new` on the server prints a fresh secret, the `otpauth://` URI to
scan, and the exact `Environment=` line to paste into the unit.

## Access

The dashboard binds to `127.0.0.1:3000` only. Two options:

- **SSH tunnel:** `ssh -L 3000:localhost:3000 server` → open http://localhost:3000
- **Its own vhost (from the UI):** open the dashboard over the tunnel, then
  Control → **Reaching this dashboard** → Publish. It writes a site named
  `DASH_SELF_NAME`, bound to one LAN address you pick, allowlisted to private
  ranges, rate limited, proxying `/` back at this process, and enables it in the
  same click. **Manage** opens it as the usual editor form, which is where it
  takes a certificate.

That second option is the supported one — the vhost is managed like any other
site, so it gets a certificate and is pinned against disable/delete. It is *not*
listed under Sites, since it is not one of the sites you serve; it lives on the
Control tab. Doing it by hand is possible but the name has to match
`DASH_SELF_NAME` exactly or the guards do not recognise it.

## If you lock yourself out

The dashboard does not depend on nginx: it is still listening on `DASH_HOST:DASH_PORT`
whatever the vhost says. `ssh -N -L 3000:127.0.0.1:3000 user@server` and open
http://localhost:3000. From there, Control → **Reaching this dashboard** fixes it: it
rewrites `/etc/nginx/sites-available/$DASH_SELF_NAME.conf` from what the dashboard has
saved, which is also what happens by itself at the next write or on restart if the file
was deleted by hand. **Repair it now** is for when the file and its `sites-enabled` entry
are both gone.

Editing the file over SSH is not a fix — the dashboard renders that file from its own
saved settings, so the next save discards the edit. Change the settings in the UI
instead. The one exception is `sites-enabled`: removing the symlink *is* how you
unpublish it, and a vhost with no entry left is never resurrected.

- **Lost the authenticator:** delete the `DASH_TOTP_SECRET` line from the unit,
  `systemctl daemon-reload && systemctl restart nginx-dashboard`.
- **Locked out by the allowlist or a bad `listen`:** the tunnel is unaffected —
  `req.ip` is loopback there, and nothing in the dashboard's own bind changes.
- **Lost the password:** set a new `DASH_PASSWORD` in the unit and restart. Login
  throttling is in memory, so a restart also clears a lockout.

## Privileges

The service runs as **root** by design: it writes `/etc/nginx` and runs
`systemctl`/`nginx`/`certbot`. The app is the trust boundary — anyone with the
password effectively has root on the box, so keep the password strong and the
port loopback-only.

If you insist on not running as root, a sudoers allowlist is possible
(`systemctl start/stop/restart nginx`, `nginx -t`, `nginx -s reload`,
`certbot`, `logrotate`, plus writable `/etc/nginx`), but it adds complexity
without removing the fundamental exposure — the app writes arbitrary nginx
config, which is code execution as the nginx user anyway.

## Dev mode (no nginx on the machine)

```bash
DASH_PASSWORD=x DASH_DRY=1 \
  DASH_NGINX_DIR=./test/fixtures/nginx DASH_SITES_AVAIL=./test/fixtures/nginx/sites-available \
  DASH_SITES_EN=./test/fixtures/nginx/sites-enabled DASH_CONF_D=./test/fixtures/nginx/conf.d \
  DASH_LOG_DIR=./test/fixtures/nginx/logs DASH_STATE_DIR=./test/fixtures/state \
  DASH_CERTS_DIR=./test/fixtures/certs DASH_HTPASSWD_DIR=./test/fixtures/htpasswd \
  node server.js
```

`DASH_DRY=1` writes config files but skips `nginx -t`, reloads and certbot —
lets you exercise the whole UI on a dev machine.