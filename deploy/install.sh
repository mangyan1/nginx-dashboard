#!/bin/bash
# nginx-dashboard installer — idempotent: safe to re-run.
# Checks every dependency; installs missing ones, upgrades outdated ones, then installs the app.
set -euo pipefail

APP_DIR=/opt/nginx-dashboard
SRC_DIR="$(cd "$(dirname "$0")/.." && pwd)"
NODE_MIN=18

say() { echo -e "\033[1;34m[install]\033[0m $*"; }

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
ensure_node
ensure_apt_pkg nginx nginx
ensure_apt_pkg certbot certbot
ensure_apt_pkg unzip unzip
command -v openssl >/dev/null || apt_install openssl

# ---------- 2. app files + node deps ----------
say "installing app to $APP_DIR…"
mkdir -p "$APP_DIR"
rsync -a --delete --exclude node_modules "$SRC_DIR"/ "$APP_DIR"/
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
  cp "$SRC_DIR/deploy/nginx-dashboard.service" /etc/systemd/system/nginx-dashboard.service
  say "kept existing DASH_PASSWORD"
fi
systemctl daemon-reload
systemctl enable --now nginx-dashboard

say "done. dashboard listens on 127.0.0.1:3000 — reach it with: ssh -L 3000:localhost:3000 <server>"