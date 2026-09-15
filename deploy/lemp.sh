#!/bin/bash
# The LEMP half of this box: nginx, MariaDB (or the MySQL already here), PHP-FPM.
#
# Idempotent — installs only what is missing and starts only what is not running, so it is safe to
# re-run. Three ways in, all the same code: on its own, as `install.sh --lemp`, or from the
# dashboard's Settings → Stack button. The dashboard runs *this script* rather than reimplementing
# the package list, so what you get over SSH and what you get from the button cannot drift apart.
#
#   lemp.sh            install and start whatever is missing
#   lemp.sh --detect   install nothing, change nothing; print only the summary line
#
# `--detect` is what the dashboard's Stack panel reads. It needs no root and is safe to call on a
# box with none of this installed — which is why the PHP endpoint is parsed here, once, instead of
# being re-derived in JavaScript.
#
# stdout is the monitoring channel — the dashboard streams it line by line to the browser, so
# everything worth knowing is echoed as it happens rather than collected for the end.
set -euo pipefail

DETECT_ONLY=0
[ "${1:-}" = '--detect' ] && DETECT_ONLY=1

# Test seam, the same idiom as DASH_NGINX_DIR and friends: point this at a fixture to exercise the
# detection below without a real PHP install.
PHP_ETC=${NXD_PHP_ETC:-/etc/php}

say() { echo -e "\033[1;34m[lemp]\033[0m $*"; }
apt_has() { command -v "$1" >/dev/null 2>&1; }
apt_install() { DEBIAN_FRONTEND=noninteractive apt-get install -y "$@"; }

# ---------- detection ----------
# Everything the dashboard needs, derived from what is actually on disk rather than assumed. The
# PHP version is never guessed: it changes with every Ubuntu release, and a wrong socket path in a
# generated conf serves .php files as text.

detect_db() {
  # mariadbd first — MariaDB ships a mysqld compatibility symlink, so testing mysqld alone would
  # report an existing MariaDB as MySQL.
  if apt_has mariadbd; then DB_KIND=mariadb
  elif apt_has mysqld; then DB_KIND=mysql
  else DB_KIND=''
  fi
  DB_VER=''
  # `if`, not `[ ] && …`: under `set -e` a false test would abort the script, and "no database
  # installed" is a normal answer here, not a failure.
  if [ -n "$DB_KIND" ]; then
    DB_VER=$( (mariadb --version 2>/dev/null || mysql --version 2>/dev/null) \
      | awk 'match($0, /[0-9]+\.[0-9]+\.[0-9]+/) {print substr($0, RSTART, RLENGTH); exit}') || true
  fi
  return 0
}

detect_php() {
  # nullglob so an unmatched glob yields an empty array rather than the literal pattern — and globs
  # rather than `ls | head`, which under `pipefail` would turn ls's SIGPIPE into a failed install.
  shopt -s nullglob
  local svcs=(/lib/systemd/system/php*-fpm.service /etc/systemd/system/php*-fpm.service)
  local dirs=("$PHP_ETC"/*/fpm)
  shopt -u nullglob

  if [ ${#svcs[@]} -gt 0 ]; then
    FPM_SVC=$(basename "${svcs[0]}" .service)
  else
    # not where we looked; ask systemd. awk, not head, for the same SIGPIPE reason.
    FPM_SVC=$(systemctl list-units --type=service --all --no-legend 'php*-fpm.service' 2>/dev/null \
      | awk 'NR==1{print $1}') || true
  fi

  PHP_VER=''
  if [ ${#dirs[@]} -gt 0 ]; then PHP_VER=$(basename "$(dirname "${dirs[0]}")"); fi

  # The pool's own listen directive is the truth — it may have been moved, or switched to a TCP
  # port. Only when it cannot be read do we fall back to what PHP's packaging does by default.
  # The regex requires `=` straight after `listen`, so `listen.allowed_clients` never matches.
  local conf="${dirs[0]:-$PHP_ETC/nonexistent}/pool.d/www.conf"
  local listen
  listen=$(awk -F= '/^[[:space:]]*listen[[:space:]]*=/ {gsub(/[ \t]/,"",$2); print $2; exit}' "$conf" 2>/dev/null) || true

  case "$listen" in
    # the dashboard's PHP field wants the unix: form; a bare path is what php-fpm writes
    /*) ENDPOINT="unix:$listen" ;;
    '') ENDPOINT='' ;;
    *)  ENDPOINT="$listen" ;;  # already host:port
  esac
  if [ -z "$ENDPOINT" ] && [ -n "$PHP_VER" ]; then ENDPOINT="unix:/run/php/php${PHP_VER}-fpm.sock"; fi
  if [ -z "$FPM_SVC" ] && [ -n "$PHP_VER" ]; then FPM_SVC="php${PHP_VER}-fpm"; fi
  return 0
}

summary() {
  echo "NXD-LEMP socket=$ENDPOINT php=$PHP_VER db=$DB_KIND/$DB_VER svc=$FPM_SVC"
}

detect_db
detect_php
if [ "$DETECT_ONLY" = 1 ]; then summary; exit 0; fi

# ---------- 1. database ----------
# Only if there is none. MariaDB beside an existing MySQL means two servers on one socket, and the
# stack the operator already chose is not ours to replace.
if [ -z "$DB_KIND" ]; then
  say "no database server installed — installing mariadb-server"
  apt-get update -qq
  apt_install mariadb-server
  detect_db # the binary and its version exist only now
else
  say "$DB_KIND is already installed — leaving it alone"
fi

# ---------- 2. php ----------
# Unversioned metapackages on purpose: php8.3-fpm is a name that changes with every Ubuntu release.
# dpkg-query rather than a binary name, because these are metapackages and several ship no binary.
PHP_PKGS="php-fpm php-mysql php-gd php-mbstring php-xml php-curl php-zip php-intl"
MISSING=
for p in $PHP_PKGS; do
  dpkg-query -W -f '${Status}' "$p" 2>/dev/null | grep -q 'install ok installed' || MISSING="$MISSING $p"
done
if [ -n "$MISSING" ]; then
  say "installing:$MISSING"
  apt-get update -qq
  apt_install $MISSING
else
  say "the php packages are already installed"
fi

# unzip is what the dashboard extracts a WordPress release with; the installer asks for it too.
if ! apt_has unzip; then say "unzip missing — installing"; apt_install unzip; fi

# ---------- 3. start them ----------
say "enabling $DB_KIND…"
systemctl enable --now "$DB_KIND"

# re-detect: php-fpm did not exist until a moment ago, so its unit file and pool config are new
detect_php
if [ -n "$FPM_SVC" ]; then
  say "enabling $FPM_SVC…"
  systemctl enable --now "$FPM_SVC" || say "could not start $FPM_SVC — start it by hand and re-run"
fi

# ---------- 4. the line the dashboard reads ----------
# One machine-readable summary, so the UI parses the result instead of re-deriving it — and so a
# socket this script got wrong is visible in the output rather than hidden in a generated conf.
echo
say "php ${PHP_VER:-unknown}   ${DB_KIND:-none} ${DB_VER:-unknown}"
if [ -n "$ENDPOINT" ]; then say "fastcgi endpoint: $ENDPOINT"; fi
summary
