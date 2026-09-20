#!/bin/bash
# One nightly tar of everything the dashboard owns: its state directory (the manifest,
# settings.json, the htpasswd files, the undo history) and the nginx config it generates.
# The undo history is config-only and capped at 20 — it is a way back one click, not a
# backup — so this is the thing that survives `rm -rf` on either directory.
#
# Installed by deploy/install.sh as nginx-dashboard-backup.timer (daily, Persistent, so a
# server that was off at the scheduled minute is caught up on the next boot). Restore is
# the tar's own one-liner, run as root:
#   tar -xzf <snapshot> -C /
set -euo pipefail

STATE_DIR=${DASH_STATE_DIR:-/var/lib/nginx-dashboard}
NGINX_DIR=${DASH_NGINX_DIR:-/etc/nginx}
KEEP_DAYS=14
DEST=/var/backups/nginx-dashboard

say() { echo -e "\033[1;34m[backup]\033[0m $*"; }

[ -d "$STATE_DIR" ] || { say "no state at $STATE_DIR — nothing to snapshot"; exit 0; }

mkdir -p "$DEST"
chmod 700 "$DEST"
STAMP=$(date +%Y%m%d-%H%M%S)
OUT=$DEST/nxd-$STAMP.tar.gz
# Absolute paths as tar members: tar strips the leading slash, so the excludes and this
# rotation search both use the stripped form.
tar -czf "$OUT" -C / --exclude "${STATE_DIR#/}/uploads" "${NGINX_DIR#/}" "${STATE_DIR#/}"
# Certificates and password hashes ride along, so the snapshot is as root-only as what it holds.
chmod 600 "$OUT"
find "$DEST" -name 'nxd-*.tar.gz' -mtime +"$KEEP_DAYS" -delete
say "snapshot: $OUT ($(du -h "$OUT" | cut -f1)), keeping the newest $KEEP_DAYS days"