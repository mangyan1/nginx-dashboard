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
(node, nginx, certbot, curl, rsync, unzip) and refreshes the app files. The app's
own npm dependencies are reinstalled from the lockfile, and only *reported* as
outdated if they are: upgrading them on a server would make the installed tree
differ from the one CI tested, so the lockfile decides and `npm outdated` says what
is waiting.

CI installs the whole thing onto a fresh Debian 12 and 13, Ubuntu 22.04, 24.04 and 26.04
(`test/install-container.sh`): it runs the installer twice, boots what it installed, logs in
with the password the installer generated and calls an authenticated endpoint. That is what
caught the installer calling `curl` and `rsync` without installing either — a bare Debian
image has neither. The same check runs here, minus systemd, which no container has:

```bash
docker run --rm -v "$PWD:/src" debian:13 bash /src/test/install-container.sh
```

The node version that installer puts on a server (`NODE_MIN`, 24 here) is a literal in
a shell script, which is not a manifest: Dependabot cannot see it, so it can go
end-of-life without a PR or a red test. `npm run test:floor` closes that — it reads
`NODE_MIN`, `engines.node` and the CI matrix, checks the three agree, and asks node's
own release schedule whether the floor is still supported. It fails past end-of-life and
warns once the version is in maintenance. A weekly CI job runs it and opens an issue when
it fails.

## The stack (optional)

The dashboard serves static sites out of the box. To run PHP sites — WordPress
included — install the rest of the stack:

```bash
ssh user@server 'sudo bash /tmp/nginx-dashboard/deploy/install.sh --lemp'
```

That is the same installer plus `deploy/lemp.sh`, which installs MariaDB (or
leaves the MySQL you already have alone) and PHP-FPM, starts them, and prints
the FastCGI endpoint it found. It is idempotent and opt-in: without `--lemp` a
re-run never touches the package set.

The same script is what the dashboard's **Settings → Stack** panel runs when you
press *Install LEMP*, so the two cannot drift apart. That panel also shows what
is installed and streams the output while an install runs — which is the point
of it, since a package install is the one thing here nothing can roll back.

`deploy/lemp.sh --detect` prints just the summary line, changes nothing and
needs no root. That is what the dashboard reads to prefill a site's PHP endpoint:

```
NXD-LEMP socket=unix:/run/php/php8.3-fpm.sock php=8.3 db=mariadb/10.11 svc=php8.3-fpm
```

The socket is parsed out of PHP's own pool config rather than guessed — the
version in those paths changes with every Ubuntu release.

## First run

The installer generates a random `DASH_PASSWORD` and prints it once.
It's stored in `/etc/systemd/system/nginx-dashboard.service` — change it there,
then `systemctl restart nginx-dashboard`.

## Backups

A nightly timer (`nginx-dashboard-backup.timer`, installed by the same installer)
tars nginx's config and the dashboard's state directory — the manifest, settings,
htpasswd files, undo history — into `/var/backups/nginx-dashboard/`, keeps the
newest 14 days, and catches up after downtime (`Persistent`). The undo history is
a way back one click, not a backup; this is the backup, and it is 0600 because it
holds certificates and password hashes. Restore, as root:

```bash
tar -xzf /var/backups/nginx-dashboard/nxd-<stamp>.tar.gz -C /
```

## Keeping nginx patched

nginx comes from the distribution, not from this repository and not from
nginx.org — that is deliberate, and it decides where the security fixes come
from. Debian and Ubuntu patch the release they shipped in place, so the version
number misleads on purpose: `1.22.1-9+deb12u9` is 1.22.1 with nine rounds of
security backports on top, and holding `1.22.1` up against an upstream advisory
will alarm you about bugs that were fixed months ago.

The patch path is therefore apt's, not this repository's:

- `install.sh` upgrades nginx when the distribution's candidate is newer than
  what is installed, so re-running it picks the fixes up.
- `unattended-upgrades` — on by default for the security pocket on both
  distributions — is what keeps a box current with nobody logging in.
- The header strip and Settings → Stack both print what `nginx -v` reports,
  which is the only thing on the box that knows it.

Two places the version matters more than usual:

- **HTTP/3** (the per-site toggle) needs nginx ≥ 1.25, and every release from
  1.25 up to 1.30.0 has an open HTTP/3 advisory (address spoofing). It is off
  by default and worth leaving off until the distribution's nginx is past that.
  It also needs a build with `--with-http_v3_module`; `nginx -V` says whether
  yours has it, and a build without it makes the toggle fail `nginx -t` on save
  rather than quietly serving HTTP/2 only.
- **TLS session resumption** across sites sharing one IP and port was fixed in
  1.26.3 / 1.27.4 (CVE-2025-23419). Debian 13 and Ubuntu 26.04 are past it;
  older releases depend on the backport. Generated configs already set
  `ssl_session_tickets off` regardless, which closes the ticket half of it.

What the generator writes is deliberately narrow — no `rewrite`, `map`,
`resolver`, `mp4`, `dav`, `ssi`, `charset` or `slice` appears in a vhost it
renders, TLS 1.2 is the floor, session tickets are off — which is why most of
the upstream advisory list is unreachable from the panel. Files you write by
hand under **Sites → nginx files** are the exception: `nginx -t` checks those for
syntax, never for advisories.

## Environment

Everything is set in the systemd unit. The installer carries an existing
`DASH_PASSWORD` and `DASH_TOTP_SECRET` across a re-run; the rest come from the
shipped unit file.

| Variable | Default | What it does |
|---|---|---|
| `DASH_PASSWORD` | — | the login password; required, and refused if it is the unit's own `change-me` or another published placeholder |
| `DASH_DEMO` | unset | `1` allows a placeholder password and nothing else. `npm run demo` sets it; never set it here |
| `DASH_HOST` / `DASH_PORT` | `127.0.0.1` / `7412` | what the dashboard itself binds |
| `DASH_SELF_NAME` | `nxd` | name of the dashboard's own managed vhost; unset pins nothing |
| `DASH_MAX_UPLOAD_MB` | `2048` | upload cap for the file manager, and the default for the self vhost's `client_max_body_size` |
| `DASH_TOTP_SECRET` | unset | base32 TOTP secret. Unset = the second factor is managed from Settings; set = required at login, and the Settings controls are disabled rather than ignored |
| `DASH_DRY` | unset | `1` writes config but skips `nginx -t`, reloads and certbot |

The second factor is normally enrolled in the UI: Settings → **Set up the second
factor** shows a QR (and the same secret as a key and an `otpauth://` URL) and
writes the secret only after a code from the phone is accepted. It is stored in
`/var/lib/nginx-dashboard/settings.json`, mode 0600, and deliberately not in the
manifest — history snapshots restore whole site objects, and a revert would
otherwise be able to drop it.

`npm run totp:new` on the server prints a fresh secret, the `otpauth://` URI to
scan, and the exact `Environment=` line to paste into the unit. Both routes work,
and this one wins: it is what the installer carries across a re-run, and it keeps
a unit-owned factor out of reach of the panel.

## Access

The dashboard binds to `127.0.0.1:7412` only. Two options:

- **SSH tunnel:** `ssh -L 7412:localhost:7412 server` → open http://localhost:7412
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
whatever the vhost says. `ssh -N -L 7412:127.0.0.1:7412 user@server` and open
http://localhost:7412. From there, Control → **Reaching this dashboard** fixes it: it
rewrites `/etc/nginx/sites-available/$DASH_SELF_NAME.conf` from what the dashboard has
saved, which is also what happens by itself at the next write or on restart if the file
was deleted by hand. **Repair it now** is for when the file and its `sites-enabled` entry
are both gone.

Editing the file over SSH is not a fix — the dashboard renders that file from its own
saved settings, so the next save discards the edit. Change the settings in the UI
instead. The one exception is `sites-enabled`: removing the symlink *is* how you
unpublish it, and a vhost with no entry left is never resurrected.

- **Lost the authenticator:** Settings → **Turn the second factor off** — the
  password alone, no code, so this needs no SSH. If the unit owns it instead,
  delete the `DASH_TOTP_SECRET` line and
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