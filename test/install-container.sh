#!/bin/bash
# deploy/install.sh as a fresh Debian or Ubuntu box would run it, and then the thing it installed,
# booted and logged into. test/Dockerfile.e2e already proves the app works against a real nginx;
# this proves the *installer* works on a distribution that is not the runner's — which is the gap
# that let install.sh call rsync and curl without ever installing either.
#
# Runs inside the container, as root, with the checkout mounted at /src (SRC overrides).
set -euo pipefail

SRC=${SRC:-/src}
APP=/opt/nginx-dashboard
UNIT=/etc/systemd/system/nginx-dashboard.service
LOG=/tmp/app.log

say() { echo -e "\033[1;35m[check]\033[0m $*"; }
fail() {
  echo "[check] FAILED: $*" >&2
  [ -f "$LOG" ] && sed 's/^/    app: /' "$LOG" >&2
  exit 1
}

# ---------- the one thing a container has not got ----------
# systemd is not running here and on these images `systemctl` is not even installed, so the installer
# would die at `systemctl daemon-reload` having done everything else right. Stub it, then check the
# unit file it was handed instead: that the service starts is the one claim this cannot make, and
# pretending otherwise would be a green run that proves nothing about systemd.
printf '#!/bin/sh\necho "[stub] systemctl $*"\n' > /usr/local/bin/systemctl
chmod +x /usr/local/bin/systemctl

# ---------- 1. install ----------
say "install.sh on $(. /etc/os-release && echo "$PRETTY_NAME")"
bash "$SRC/deploy/install.sh"

[ -f "$APP/server.js" ] || fail "installer left no $APP/server.js"
[ -d "$APP/dist" ] || fail "installer left no $APP/dist — the page would 404"
[ -f "$APP/node_modules/express/package.json" ] || fail "npm install --omit=dev left no express"
[ -f "$UNIT" ] || fail "no systemd unit at $UNIT"

# node >= the floor the installer itself declares, whether node was already here or came from
# NodeSource. Read out of install.sh rather than written here: a second copy of the number is a
# second thing to forget, and test/version-floor.mjs checks that this one still has a matrix leg.
NODE_MIN=$(sed -n 's/^NODE_MIN=//p' "$SRC/deploy/install.sh")
[ -n "$NODE_MIN" ] || fail "no NODE_MIN in deploy/install.sh — cannot tell what node the installer promises"
NODE_MAJOR=$(node -v | sed 's/^v\([0-9]*\).*/\1/')
[ "$NODE_MAJOR" -ge "$NODE_MIN" ] || fail "node $(node -v) is below the $NODE_MIN install.sh installs"

# The generated password is the whole point of the unit-writing branch: a placeholder that ships in
# this repository is refused by the app at startup, so an installer that leaves one installs a
# service that never comes up.
PW=$(sed -n 's/^Environment=DASH_PASSWORD=//p' "$UNIT")
[ -n "$PW" ] || fail "unit has no DASH_PASSWORD"
case "$PW" in
  change-me|changeme|demo|password|admin) fail "unit still carries the placeholder password" ;;
esac
say "unit carries a generated password (not the shipped placeholder)"

# ---------- 2. re-run, which the README calls idempotent ----------
say "install.sh again — a re-run must not reset the password it already generated"
bash "$SRC/deploy/install.sh"
[ "$(sed -n 's/^Environment=DASH_PASSWORD=//p' "$UNIT")" = "$PW" ] ||
  fail "the second run changed DASH_PASSWORD — every re-run would lock the operator out"

# ---------- 3. boot what it installed ----------
# nginx first: the master has to exist or `nginx -s reload` has nothing to signal. It daemonises.
nginx || fail "nginx would not start"
cd "$APP"
# The unit's own Environment= lines, which is the environment this app is meant to run under.
eval "$(sed -n 's/^Environment=\(.*\)$/export \1/p' "$UNIT")"
node server.js >"$LOG" 2>&1 &
APP_PID=$!
trap 'kill $APP_PID 2>/dev/null || true' EXIT

for _ in $(seq 1 30); do
  curl -sf -o /dev/null "http://127.0.0.1:7412/api/login" && break
  kill -0 $APP_PID 2>/dev/null || fail "the app exited during startup"
  sleep 1
done
curl -sf -o /dev/null "http://127.0.0.1:7412/api/login" || fail "the app never answered on 7412"

# ---------- 4. the installer's password actually logs in ----------
CODE=$(curl -s -o /tmp/login.json -w '%{http_code}' -c /tmp/cookies \
  -X POST -H 'Content-Type: application/json' -d "{\"password\":\"$DASH_PASSWORD\"}" \
  "http://127.0.0.1:7412/api/login")
[ "$CODE" = 200 ] || fail "login with the generated password: $CODE $(cat /tmp/login.json)"
say "logged in with the generated password"

# Signed out, the same route is a 401 rather than an empty 200 — this is root-equivalent on the box.
CODE=$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:7412/api/sites")
[ "$CODE" = 401 ] || fail "unauthenticated /api/sites returned $CODE, expected 401"

# The one authed call worth making here: it reads the sites directory the installer's nginx created,
# so a 200 means the app is serving real state off this distribution rather than an empty fallback.
CODE=$(curl -s -o /tmp/sites.json -w '%{http_code}' -b /tmp/cookies "http://127.0.0.1:7412/api/sites")
[ "$CODE" = 200 ] || fail "/api/sites: $CODE $(cat /tmp/sites.json)"
grep -q '"sites"' /tmp/sites.json || fail "/api/sites answered without a sites list"
say "served $(grep -o '"name"' /tmp/sites.json | wc -l) site row(s) off $APP"

say "ok — installer and app both work on this distribution"
