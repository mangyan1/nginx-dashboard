<p align="center">
  <img src="branding/logo-banner.png" alt="NXD — NGINX DASHBOARD — observe · configure · deploy" width="640">
</p>

<h1 align="center">nginx-dashboard</h1>

<p align="center">
  A web dashboard that controls NGINX entirely via buttons — no command line.<br>
  Runs next to nginx on your Ubuntu/Debian server.
</p>

## Modules

| Tab | What it does |
|---|---|
| **sites** | create / edit / delete / enable / disable server blocks; per-site form covering: reverse-proxy rules, load-balancer upstreams (round robin / least connections / IP hash, http & https backends, passive health checks), **PHP / FastCGI backends**, HTTPS on any port (self-signed / Let's Encrypt / existing certs, force-redirect, TLS-only vhosts, **HSTS**), static sites incl. `.html`-per-page generators, request-body limit, rate limiting, IP allow/deny lists, basic auth, gzip, HTTP/2 & HTTP/3 (+ reuseport), browser caching; built-in file manager with multi-upload and **deploy-folder-as-zip** |
| **control** | start / stop / restart nginx, reload config (`nginx -s reload`), test config (`nginx -t`) |
| **logs** | live tail of access.log & error.log (SSE), rotate, purge old rotated logs |
| **metrics** | stub_status stats + live active-connections chart |
| **settings** | the second factor (enrol, or turn off with the password), sign-in lockouts and clearing them, what a new site is created from, undo-history maintenance, dark/light, a dependency-version check, and a read-only view of where this install lives |

Every editable control in the site form carries a **use default** chip naming the
value the server would apply if the field were left alone. Clicking it writes that
value; the chip greys out and reads "this is the default" when the field already
holds it, so the same chip answers *what is the default* and *is this it*. The
values come from `GET /api/site-defaults`, not from a copy in the browser, so the
chip cannot drift from the conf. A save that produces a warning or a refusal says
so in a snackbar as well as in the panel — the panel scrolls, the snackbar does not.

The interface is a dark instrument panel in the NXD palette, with every number
set in IBM Plex Mono. Archivo and IBM Plex Mono come from Google Fonts, so on a
host with no outbound internet the browser falls back to system fonts — the
layout does not depend on them.

## The bell

The header carries a bell that counts what is currently wrong, worst first:
nginx not running, a conf deleted or edited by hand, a dangling `sites-enabled`
symlink, an address locked out of sign-in, a pending kernel update that wants a
reboot, an installed package the running process has not loaded yet, and a
dependency the registry has moved on. Each item names the tab the fix lives on
and takes you there; a reboot has nowhere to send you and so has no button.

**Nothing is stored and nothing is acknowledged.** An item is a fact about right
now, so it stops being an item when the fact is fixed rather than when you press
something — a remembered "read" flag would be a way to hide a broken conf, which
is the one thing a notification must never do. The count is recomputed on every
poll, and asking again over the same state gives the same list.

It is deliberately not a log. Nothing here is timestamped, nothing accumulates,
and there is no history to scroll: the Logs tab has the access and error logs,
and Settings → Undo history has what changed.

The bell rings — a slow swing, resting for the second half of each cycle —
whenever it has anything to report, and is still when it does not.
`prefers-reduced-motion` drops the swing and keeps the badge and the colour,
which is where the signal actually is.

## How it works

- Every site the dashboard creates is stored in a JSON manifest
  (`/var/lib/nginx-dashboard/manifest.json`) and its `.conf` is **generated**
  from it — never parsed back. Foreign sites in `sites-available` are listed
  read-only.
- **Sites → `nginx files` reads the two config directories as they are**, which
  is the one view the manifest cannot give: a conf enabled but never written, a
  symlink whose target was deleted by hand (`nginx` will not start on one), a
  file in `sites-enabled` that is not a symlink at all. Read-only, and the only
  place a conf's text is shown — a managed site is edited in its form, because
  the next save rewrites the file anyway. Clicking a site the manifest does not
  know lands here rather than in a form whose Save could only answer 404.
- **Basic-auth passwords are not in the manifest.** nginx reads an apr1 hash, so
  that is what is stored (`{ user, hash }`); the password exists only for the
  moment it takes to hash it, and the field in the form is write-only — leaving
  it blank means "unchanged", not "no password". A manifest written by an older
  version is hashed once at startup, so upgrading is what removes the plaintext
  rather than the next time you happen to edit that site. This matters less for
  the protected site than for everywhere else: an operator's basic-auth password
  is often one they have used before, and a root-readable file holding it in the
  clear is a leak of that password *for every other service it opens*.
- The dashboard's own settings live beside it in `settings.json` (mode 0600):
  the second-factor secret and what a new site is created from. Kept out of the
  manifest on purpose — the undo history restores whole site objects, and a
  revert must not be able to drop a second factor.
- New sites start from a hardened base: rate limiting on at 50 r/s with a burst
  of 100, HSTS **off** (it is a one-way door, and defaulting it on would arm
  itself the moment a new site is pointed at a self-signed certificate). The
  whole base is visible in the site form through the **use default** chips, and
  editable in Settings → *New-site defaults*. Overrides apply **only when a site
  is created**, so changing one can never reinterpret a vhost that is already
  serving traffic. Upgrading is likewise a no-op for sites this dashboard already
  manages: their values are stored in the manifest and are what get rendered. The
  one thing that can change is a hand-written manifest entry that omits a field
  altogether — the read side fills the gap, which shows up as a red **drift** chip
  on that site the next time you open it.
- **Deleting a site can take its document root with it**, opt-in. The dialog names
  the path and offers a checkbox; unticked, the delete is what it always was —
  conf and symlink removed, files left alone. Ticked, `DELETE /api/sites/:name?root=1`
  removes the directory *after* the conf change has been applied and tested, never
  inside that transaction: the rollback restores files byte-for-byte and a directory
  cannot be one of them, so a removal in there would bring the site back with no
  files — the exact state the pipeline exists to prevent. If the removal itself
  fails the site is still deleted and the toast says the files remain.
- **A recursive delete needs a guard, because the document root is free text.**
  `ROOT_RE` accepts `/`, `/etc` and `/var/www` and creating a site will `mkdirSync`
  any of them, so `rm -rf` on that validation alone is one typo away. Refused: a
  blank or relative path; anything that is a symlink or sits under one (it would
  delete whatever it points at); the filesystem root or one step below it; anything
  overlapping nginx's own directories, the dashboard's state, or the dashboard
  itself, in either direction; and any path that is another site's root, in either
  direction — `/var/www` holding `/var/www/b` is refused both ways round. The
  refusals are a 400 that writes nothing.
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

### WordPress

A new site can start **blank** or as **WordPress**, and any site with PHP on can
be given one later with the **Download WordPress** button. Either way it is
`POST /api/sites/:name/wordpress`, which fetches the current release from
`api.wordpress.org`, creates a database and user, writes `wp-config.php` with the
credentials and salts from WordPress's own endpoint, and extracts the tree into
the document root.

- **The credentials live only in `wp-config.php`** (mode 0640). Nothing about
  them is written to the manifest or to settings.
- **All of it happens outside the config pipeline and outside the manifest**, in
  a scratch directory first — the document root is touched only once the
  download, the database and the config have all succeeded. A failure leaves a
  working site with nothing half-written in it.
- **It refuses a document root that already holds anything**, unless that is only
  the placeholder page this dashboard itself wrote. Extracting over an operator's
  files is the one irreversible thing here, so it is a 409 naming what is in the
  way rather than a question.
- **It refuses a site that is not configured to serve PHP**, and the refusal names
  all three facts at once: with PHP off the emitter falls back to a static
  `try_files`, which serves `wp-config.php` as *plain text*; without the front
  controller every permalink 404s; and without `index.php` in the index list a
  request for `/` resolves to nothing and 403s.
- The download URL arrives over the network and becomes files in a served
  directory, so it is checked to be `https` on `wordpress.org` before it is
  fetched, and capped in size both by `content-length` and by what actually
  arrived. The SQL goes to the client as a single argument, never a shell string.

Hardening emitted for every site: dotfiles denied (`location ~ /\.(?!well-known)`)
in both blocks, TLS 1.2+ only, `ssl_session_tickets off`, and a shared session
cache.

Two more are opt-in per site, both off by default:

- **HSTS** — a one-way door. A browser that has seen the header refuses plain
  HTTP to the domain for the whole `max-age`, and that outlives turning the
  toggle back off, so it is offered only once a certificate is configured and
  the form says so. `includeSubDomains` and `preload` are separate switches;
  preload asks for a year *and* subdomains because hstspreload.org rejects
  anything less, and the dashboard refuses to save that combination.
- **Max request body** — in MB, `0` leaving nginx's own 1m default. nginx
  answers 413 before the body ever reaches PHP or the proxy target, so a
  WordPress upload over 1 MB needs this raised.

## Static sites

A site with no proxy rule and no front controller gets
`try_files $uri $uri/ $uri.html =404`. That is what serves `/about` from
`about.html` — the shape Astro (`build.format: 'file'`, `trailingSlash:
'never'`), Next's static export and any per-page `.html` generator emit. A bare
`root` + `index` 404s those URLs, because `$uri` is not a directory and `$uri/`
does not exist. It costs nothing where no such file is present and cannot reach
a `.php`, since the suffix is fixed — `/wp-config` looks for `wp-config.html`.

A rule on `/` replaces it: the fallback, the PHP front controller and a root
proxy rule are all `location /`, and nginx refuses a duplicate, so the explicit
proxy rule wins and the fallback stands down.

## Security model

- One password (`DASH_PASSWORD` env), session cookie, `HttpOnly SameSite=Strict`,
  `Secure` once the request arrives over TLS.
- Login is throttled: five failures from one address lock it out for fifteen
  minutes (`429` + `Retry-After`). In memory, so restarting the service clears it.
- Optional TOTP second factor, off by default. Enrol it in the UI — Settings →
  **Set up the second factor** shows a QR and the same secret as a key, and the
  secret is written only once a code from the phone has been accepted, so a
  mistyped one cannot lock you out. `npm run totp:new` plus a line in the unit
  still works and still wins: `DASH_TOTP_SECRET` outranks anything saved in the
  panel, and while it is set the panel says so instead of offering controls that
  would be ignored. The sign-in form **asks** (`GET /api/login`) and draws the
  code field only when there is a second factor to satisfy — so a box without one
  shows a password box and nothing else. That answer is not a secret from someone
  who can already reach the port, and the alternative — revealing the field only
  after a refusal — would spend one of the five failures that lock an address out
  on every legitimate sign-in. A refusal still reveals it, so a factor enrolled
  from another session cannot leave this page asking for a password alone.
- Binds to `127.0.0.1:7412` — reach it via SSH tunnel, or publish its own vhost.
- **Dependencies can be updated from Settings → Updates**, checked against the
  npm registry when that tab is opened, and cached for six hours so the bell can
  read the same answer without asking again. Only the two packages the server itself
  loads are installable there; the rest are compiled into `dist/` when the page
  is built, so npm moving one on the server would change nothing that is served
  and those rows are marked `build-time`. An install is verified before it is
  offered: the new version is imported in a child process, and one that will not
  load is put back rather than left to break the dashboard on its next restart.
  Applying it needs **Restart dashboard**, which is only offered when systemd is
  supervising the process (`INVOCATION_ID`) — it signs you out, because sessions
  are in memory.
- **A placeholder password refuses to start.** `change-me` (the shipped unit's own
  value), `changeme`, `demo`, `password` and `admin` are refused at boot with the
  command that fixes them, because the install that ends up with one is the one
  whose unit file was copied and never edited — and its operator is reading
  `systemctl status`, not a log. `DASH_DEMO=1` is the deliberate way past it and
  nothing in `deploy/` sets it; `npm run demo` does.
- Anyone with the password effectively has root: keep it strong.

### Reaching it from the LAN

This dashboard is the LAN-only tool; the sites it manages are the WAN-facing part.
Control → **Reaching this dashboard** writes a vhost for the dashboard itself,
prefilled to bind one specific LAN address, allow to private ranges only, rate
limit, and proxy `/` back at this process. One click publishes *and* enables it;
**Manage** opens it as the same editor form, which is where it gets a certificate.

It is not listed under Sites — it is not one of the sites you serve, so it stays out
of that list and its count and lives on the Control tab instead.

That site is pinned by `DASH_SELF_NAME`: the dashboard recognises its own vhost and
**refuses to disable or delete it**. Publishing it is what turns the guards on; with
the variable unset nothing is pinned, so an existing install cannot become
undeletable just by upgrading.

It also puts itself back. `sites-enabled/*` is a bare glob, so a conf deleted by hand
leaves a dangling entry that fails `nginx -t` — which would refuse *every* save on
*every* site. The dashboard notices its own conf is gone at the next write and on
restart, and rewrites it from what it has saved; that rewrite is not an operator
action, so it stays out of the undo history. A vhost you unpublished on purpose has no
entry left and is never resurrected — Control offers **Repair it now** for that case
instead, and only ever for the pinned name.

Every save of it is still validated — a change that would stop `/` reaching this
process is refused before anything is written, including one that leaves it
disabled (a disabled site is invisible to `nginx -t`, so that would otherwise pass
and cost you the browser). Everything else about it — domains, HSTS, the allowlist,
the certificate — only produces a warning.

### If you lock yourself out

**The dashboard process does not depend on nginx.** It is still listening on
`DASH_HOST:DASH_PORT` whatever the vhost says, so a broken vhost costs you the
browser, not the tool:

```bash
ssh -N -L 7412:127.0.0.1:7412 user@server   # then open http://localhost:7412
```

Lost the phone with the authenticator? Settings → **Turn the second factor off**
asks for the password and nothing else, so this needs no SSH. If the factor is
owned by the unit instead, remove `DASH_TOTP_SECRET` from
`/etc/systemd/system/nginx-dashboard.service`, `systemctl daemon-reload &&
systemctl restart nginx-dashboard`; login falls back to password only.

Locked out by the vhost's allowlist or a bad `listen`? The same route works. Fix it in
the UI over the tunnel — over the tunnel `req.ip` is loopback, so the allowlist cannot
lock you out of your own repair. Control → **Reaching this dashboard** saves it, or
**Repair it now** if the file is missing entirely — but note that Save rewrites the conf
from what the dashboard has saved, so a hand-edit made over SSH is lost the next time it
is saved from the UI.

If you have lost the password too, set a new `DASH_PASSWORD` in the unit and restart.

## Dev & deploy

```bash
npm install
npm run build   # build the frontend
npm run dev     # or: Vite dev server at :5173, proxies /api to :7412 (or $DASH_PORT)
npm run demo    # the whole dashboard on this machine, nothing to configure: http://127.0.0.1:7412, password `demo`
```

`npm run demo` is DRY mode against its own `.demo/` tree, so it never touches nginx,
systemctl, certbot or a real install's manifest. It is the only thing that sets
`DASH_DEMO=1`, which is what lets a placeholder password start at all — see below.

See `deploy/README.md` for deployment (installer script, systemd unit, dev/dry
mode).