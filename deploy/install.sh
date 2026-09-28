#!/bin/bash
# nginx-dashboard installer — idempotent: safe to re-run.
# Checks every dependency; installs missing ones, upgrades outdated ones, then installs the app.
#
#   install.sh          the dashboard and what it needs (nginx, certbot, unzip, node, curl, rsync)
#   install.sh --lemp   the above, plus MariaDB and PHP-FPM — see deploy/lemp.sh
#   install.sh --lan    also answer on the LAN: binds 0.0.0.0 and, when ufw is active, opens
#                       7412 and the web ports 80/443 to the box's private subnet
set -euo pipefail

APP_DIR=/opt/nginx-dashboard
SRC_DIR="$(cd "$(dirname "$0")/.." && pwd)"
NODE_MIN=24

say() { echo -e "\033[1;34m[install]\033[0m $*"; }

# The stack is opt-in. Without the flag this script behaves exactly as it always has, and re-running
# it never touches the package set on a box whose operator chose their own database.
WITH_LEMP=0
WITH_LAN=0
for arg in "$@"; do
  case "$arg" in
    --lemp) WITH_LEMP=1 ;;
    --lan) WITH_LAN=1 ;;
    -h|--help) echo "usage: install.sh [--lemp] [--lan]   --lemp: MariaDB + PHP-FPM; --lan: serve the dashboard to your LAN"; exit 0 ;;
    *) echo "unknown option: $arg" >&2; exit 2 ;;
  esac
done

# ---------- helpers ----------
ver() { echo "$@" | awk -F '[^0-9]+' '{ printf "%d%03d%03d\n", $1, $2, $3 }'; }

apt_has() { command -v "$1" >/dev/null 2>&1; }

apt_install() { DEBIAN_FRONTEND=noninteractive apt-get install -y "$@"; }

ensure_node() {
  if ! apt_has node; then
    say "node not found — installing NodeSource Node ${NODE_MIN}.x"
    apt-get update -qq
    curl -fsSL "https://deb.nodesource.com/setup_${NODE_MIN}.x" | bash -
    apt_install nodejs
    return
  fi
  NODE_VER=$(node -v | sed 's/v//')
  if [ "$(ver "$NODE_VER" 0)" -lt "$(ver "$NODE_MIN" 0)" ]; then
    say "node $NODE_VER is older than ${NODE_MIN} — upgrading via NodeSource"
    curl -fsSL "https://deb.nodesource.com/setup_${NODE_MIN}.x" | bash -
    apt_install --only-upgrade nodejs
  else
    say "node $NODE_VER ok"
  fi
}

ensure_apt_pkg() {
  local pkg=$1 bin=$2
  if ! apt_has "$bin"; then
    say "$pkg missing — installing"
    apt-get update -qq
    apt_install "$pkg"
  else
    # upgrade if the apt candidate is newer than what's installed
    CAND=$(apt-cache policy "$pkg" | awk '/Candidate:/ {print $2}')
    CUR=$(dpkg-query -W -f '${Version}' "$pkg" 2>/dev/null || echo none)
    if [ "$CAND" != "$CUR" ] && [ "$CAND" != "(none)" ]; then
      say "$pkg $CUR is outdated (candidate $CAND) — upgrading"
      apt-get update -qq
      apt_install --only-upgrade "$pkg"
    else
      say "$pkg $CUR ok"
    fi
  fi
}

# ---------- 1. system deps ----------
say "checking system dependencies…"
# curl and rsync are checked first because this script *uses* both before anything else installs
# them: curl to fetch NodeSource, rsync to copy the tree in. On a server that has neither — a bare
# Debian image has neither — the old order failed on line 37 with "curl: command not found", which
# reads as a broken installer rather than a missing package.
ensure_apt_pkg curl curl
ensure_apt_pkg rsync rsync
ensure_node
ensure_apt_pkg nginx nginx
ensure_apt_pkg certbot certbot
ensure_apt_pkg unzip unzip
# logrotate only ever runs from the dashboard's own rotate endpoint, so nothing here needs it —
# but it is priority:important rather than a dependency of nginx, which means a minimal image has
# nginx, a working rotate button and no logrotate behind it.
ensure_apt_pkg logrotate logrotate
command -v openssl >/dev/null || apt_install openssl

# ---------- 1b. the stack (opt-in) ----------
# Shares one implementation with the dashboard's Settings → Stack button, which runs this same
# script — so a package added here is a package the button installs too.
if [ "$WITH_LEMP" = 1 ]; then
  bash "$SRC_DIR/deploy/lemp.sh"
else
  say "skipping MariaDB and PHP-FPM — re-run with --lemp to install the stack"
fi

# ---------- 2. app files + node deps ----------
say "installing app to $APP_DIR…"
mkdir -p "$APP_DIR"
# The excludes are the tree a server does not need and would otherwise receive: the git history,
# the test suites, and the branding kit with its zip — none of which the dashboard or its unit
# file reads. The .conf-era leftovers of a previous rsync are removed by --delete, as always.
rsync -a --delete --exclude node_modules --exclude .git --exclude test \
  --exclude NXD-Branding-icons --exclude NXD-Branding-icons.zip \
  "$SRC_DIR"/ "$APP_DIR"/
if [ ! -d "$APP_DIR/dist" ]; then
  echo "ERROR: dist/ is missing — run 'npm run build' on your dev machine and re-copy." >&2
  exit 1
fi
cd "$APP_DIR"
say "installing/updating app npm dependencies…"
npm install --omit=dev
npm outdated --omit=dev || true   # report only; semver ranges keep this deterministic

# ---------- 3. systemd unit ----------
say "installing systemd unit…"
if ! grep -q '^Environment=DASH_PASSWORD' /etc/systemd/system/nginx-dashboard.service 2>/dev/null; then
  GENERATED_PASSWORD=$(openssl rand -hex 12)
  sed "s/^Environment=DASH_PASSWORD=.*/Environment=DASH_PASSWORD=$GENERATED_PASSWORD/" \
    "$SRC_DIR/deploy/nginx-dashboard.service" > /etc/systemd/system/nginx-dashboard.service
  say "generated dashboard password: $GENERATED_PASSWORD (change it in the unit file)"
else
  # carry both secrets across the refresh: the shipped unit carries the whole environment, so a
  # plain copy drops a hand-added DASH_TOTP_SECRET (downgrading login to password-only without
  # saying so) and resets DASH_PASSWORD to the placeholder the template ships with — which is a
  # published password on a dashboard that is root-equivalent. Read both before the copy.
  KEEP_TOTP=$(grep -h '^Environment=DASH_TOTP_SECRET=' /etc/systemd/system/nginx-dashboard.service || true)
  KEEP_PASSWORD=$(grep -h '^Environment=DASH_PASSWORD=' /etc/systemd/system/nginx-dashboard.service || true)
  KEEP_HOST=$(grep -h '^Environment=DASH_HOST=' /etc/systemd/system/nginx-dashboard.service || true)
  cp "$SRC_DIR/deploy/nginx-dashboard.service" /etc/systemd/system/nginx-dashboard.service
  if [ -n "$KEEP_PASSWORD" ]; then
    sed -i "s|^Environment=DASH_PASSWORD=.*|$KEEP_PASSWORD|" /etc/systemd/system/nginx-dashboard.service
    say "kept existing DASH_PASSWORD"
  else
    GENERATED_PASSWORD=$(openssl rand -hex 12)
    sed -i "s|^Environment=DASH_PASSWORD=.*|Environment=DASH_PASSWORD=$GENERATED_PASSWORD|" /etc/systemd/system/nginx-dashboard.service
    say "generated dashboard password: $GENERATED_PASSWORD (change it in the unit file)"
  fi
  if [ -n "$KEEP_TOTP" ]; then
    sed -i "s|^#Environment=DASH_TOTP_SECRET=.*|$KEEP_TOTP|" /etc/systemd/system/nginx-dashboard.service
    say "kept existing DASH_TOTP_SECRET"
  fi
  # A hand-set DASH_HOST (or one from a previous --lan) is the same class of operator choice as
  # the password above: the template's 127.0.0.1 would silently take the dashboard off the
  # network it was put on.
  if [ -n "$KEEP_HOST" ]; then
    sed -i "s|^Environment=DASH_HOST=.*|$KEEP_HOST|" /etc/systemd/system/nginx-dashboard.service
    say "kept existing DASH_HOST"
  fi
fi
# ---------- 3b. nightly backup timer ----------
say "installing nightly backup timer…"
cp "$SRC_DIR/deploy/nginx-dashboard-backup.service" /etc/systemd/system/
cp "$SRC_DIR/deploy/nginx-dashboard-backup.timer" /etc/systemd/system/
systemctl enable --now nginx-dashboard-backup.timer

# ---------- 3c. LAN access (opt-in) ----------
if [ "$WITH_LAN" = 1 ]; then
  # 0.0.0.0 rather than the box's LAN address on purpose: loopback keeps answering, so the SSH
  # tunnel and the app's own plumbing survive; the network side is the firewall's job. With ufw
  # active the rule is opened here — without one the operator gets a warning, not a silent 0.0.0.0.
  sed -i "s/^Environment=DASH_HOST=.*/Environment=DASH_HOST=0.0.0.0/" /etc/systemd/system/nginx-dashboard.service
  systemctl restart nginx-dashboard 2>/dev/null || true   # a re-run needs this to pick up the bind
  LAN_IP=$(hostname -I 2>/dev/null | awk '{for (i=1; i<=NF; i++) if ($i ~ /^(10\.|172\.(1[6-9]|2[0-9]|3[01])\.|192\.168\.)/) {print $i; exit}}' || true)
  if [ -z "$LAN_IP" ]; then
    say "no private address on this box — bind is 0.0.0.0, so firewall it yourself"
  elif command -v ufw >/dev/null 2>&1 && ufw status | grep -q "Status: active"; then
    LAN_SUBNET=$(ip -4 route 2>/dev/null | awk -v ip="$LAN_IP" '$0 ~ "src " ip {print $1; exit}' || true)
    if [ -n "$LAN_SUBNET" ]; then
      ufw allow from "$LAN_SUBNET" to any port 7412,80,443 proto tcp
      say "LAN access: http://$LAN_IP:7412 — allowed $LAN_SUBNET on 7412, 80 and 443"
    else
      say "could not work out the subnet of $LAN_IP — open port 7412 in your firewall yourself"
    fi
  else
    say "no active ufw — enable it and allow 7412 from your subnet, or the dashboard answers on every network"
  fi
fi

# The unit carries DASH_PASSWORD, and systemd's default unit mode is world-readable — every
# local user could read a root-equivalent credential off it. Everything else holding a secret
# here is already 0600 (settings.json) or 0640 (htpasswd); the unit is the odd one out.
chmod 600 /etc/systemd/system/nginx-dashboard.service
systemctl daemon-reload
systemctl enable --now nginx-dashboard

if [ "$WITH_LAN" = 1 ] && [ -n "${LAN_IP:-}" ]; then
  say "done. open http://$LAN_IP:7412 from any machine on your LAN"
else
  say "done. dashboard listens on 127.0.0.1:7412 — reach it with: ssh -L 7412:localhost:7412 <server>"
fi
say "a nightly snapshot of its state and nginx's config lands in /var/backups/nginx-dashboard"
say "to reach it from another machine on the LAN, open the dashboard and use Control → 'Reaching this dashboard' → Publish: it writes a vhost bound to one LAN address and allowlisted to private ranges, then enable it under Sites."