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

## Access

The dashboard binds to `127.0.0.1:3000` only. Two options:

- **SSH tunnel (default):** `ssh -L 3000:localhost:3000 server` → open http://localhost:3000
- **TLS vhost:** proxy it through nginx itself:

```nginx
server {
    listen 443 ssl;
    server_name dash.example.com;
    ssl_certificate     /etc/letsencrypt/live/dash.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/dash.example.com/privkey.pem;
    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host $host;
    }
}
```

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