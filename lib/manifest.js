import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import net from 'node:net'
import { MANIFEST, HTTP_CONF, PATHS, safeApply, shell } from './nginx.js'

/**
 * The dashboard's own vhost is an ordinary managed site — one whose absence locks the operator
 * out of the UI that manages every other site. It is identified by *name from the environment*
 * rather than by a flag in the manifest: history snapshots carry whole manifests and
 * revertHistory restores them wholesale, so a stored flag could be forged by an old snapshot and
 * dropped by one taken before the site existed. A name cannot.
 *
 * Empty by default. An install predating this feature must not find a site of its own suddenly
 * undeletable, so nothing is pinned until something opts in — `deploy/install.sh` writes
 * DASH_SELF_NAME into the unit of a fresh install.
 */
export const SELF_NAME = process.env.DASH_SELF_NAME || ''
export const isSelf = name => !!SELF_NAME && name === SELF_NAME

// Where the dashboard itself answers. A proxy rule on `/` has to land on one of these, since a
// vhost fronting the dashboard that points somewhere else is a vhost that does not front it.
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1'])

/** The host and port a proxy target names, or null when it names none (e.g. `upstream:pool`). */
export function targetHostPort(target) {
  try {
    const u = new URL(String(target))
    // URL keeps the brackets on a literal IPv6 host; net.isIP and the conf do not want them.
    return {
      scheme: u.protocol.replace(':', ''),
      host: u.hostname.replace(/^\[|\]$/g, ''),
      port: Number(u.port || (u.protocol === 'https:' ? 443 : 80)),
    }
  } catch { return null }
}

export function defaultSite(name) {
  return {
    name,
    domains: [],
    root: `/var/www/${name}`,
    port: 80,
    // serveHttp:false drops the plain-HTTP block entirely, for a vhost that is TLS-only.
    // httpsPort is the TLS listener — 443 normally, something else when the host is behind a
    // port-forward or shares the box with another TLS terminator.
    serveHttp: true,
    httpsPort: 443,
    // Blank = every interface, which is what a WAN-facing site wants. Naming one address binds
    // the vhost to it and nowhere else — for a site that must not be reachable off-LAN, binding
    // is the enforcement that survives a mistyped allow/deny rule.
    listenAddress: '',
    index: 'index.html index.htm',   // document-root index order; dynamic apps want index.php first
    // 0 leaves nginx's own 1m default in place. Set it in MB when an upload has to get through:
    // nginx answers 413 before PHP or the proxy target ever sees the request body.
    clientMaxBodySize: 0,
    https: { mode: 'none', forceRedirect: false, manualCert: '', manualKey: '' },
    // A one-way door — a browser that has seen this header refuses plain HTTP to the domain
    // until max-age runs out, and a cached redirect outlives the config that caused it. Off
    // until it is deliberately turned on.
    hsts: { enabled: false, maxAge: 31536000, includeSubDomains: false, preload: false },
    listen: { http2: false, http3: false, reuseport: false },   // reuseport must match across listeners on one port
    // FastCGI backend: PHP-FPM, or anything else that speaks FastCGI. This is the second half of
    // "any backend" — an HTTP app (node, python, a container) is a proxy rule instead.
    //   endpoint: 'unix:/run/php/php8.3-fpm.sock' | '127.0.0.1:9000'
    //   frontController: unmatched paths go to /index.php (WordPress, Laravel, Drupal)
    php: { enabled: false, endpoint: '', frontController: false },
    proxy: [],            // { path: '/api', target: 'http://host:port' | 'https://host:port' | 'upstream:name' }
    upstreams: [],         // { name, algorithm: 'round_robin'|'least_conn'|'ip_hash', servers: [{scheme, host, port}], healthCheck }
    // On by default, and deliberately not tighter. The zone keys on $binary_remote_addr, so an
    // office behind one NAT address — or a site behind a CDN — shares this single bucket rather
    // than getting one per visitor, and `nodelay` *rejects* the excess with a 503 instead of
    // queueing it. At 30 r/s ten people browsing a page of forty assets trip it, and the symptom
    // is a site that intermittently fails for no reason visible from here. 50/100 still cuts a
    // 1000 r/s flood twentyfold, and it is one toggle away from anything else.
    rateLimit: { enabled: true, rps: 50, burst: 100 },
    ipRules: { mode: 'none', ips: [] },   // mode: 'none' | 'allowlist' | 'denylist'
    // A row is { user, hash } as stored, and { user, password } as the form sends it. The password
    // never reaches the manifest: nginx reads the hash, and a hash is not a password anyone can
    // reuse on another service the way a plaintext one would be.
    basicAuth: { enabled: false, users: [] },
    gzip: { enabled: true, types: ['text/css', 'application/javascript', 'application/json', 'image/svg+xml', 'text/plain'] },
    staticCache: { enabled: true, extensions: ['css', 'js', 'png', 'jpg', 'jpeg', 'gif', 'svg', 'ico', 'woff', 'woff2'], expiresDays: 30 },
  }
}

const NESTED = ['https', 'hsts', 'listen', 'php', 'rateLimit', 'ipRules', 'basicAuth', 'gzip', 'staticCache']

/**
 * A manifest written before a field existed has no value for it, and the renderer dereferences
 * these directly — an old manifest would emit `listen undefined ssl;`. Fill every gap from the
 * defaults once, here, because every caller reads through this function. Guarding each render
 * site instead would be the same fix written five times, and the sixth caller would miss it.
 */
function normalizeSite(site) {
  const d = defaultSite(site.name)
  const s = { ...d, ...site }
  for (const k of NESTED) s[k] = { ...d[k], ...(site[k] || {}) }
  s.domains = (site.domains || []).map(String).filter(Boolean)
  s.proxy = Array.isArray(site.proxy) ? site.proxy : []
  s.upstreams = Array.isArray(site.upstreams) ? site.upstreams : []
  s.listenAddress = String(site.listenAddress || '')
  // For the UI's benefit only. Every guard asks isSelf(name) instead — this flag is derived on
  // read, so it can neither be forged by a request body nor survive in a stale snapshot.
  s.self = isSelf(s.name)
  return s
}

/** Manifest text → manifest, with every site normalized. Used for snapshots as well as disk. */
export function parseManifest(text) {
  try {
    const m = JSON.parse(text)
    return { ...m, sites: (m.sites || []).map(normalizeSite) }
  } catch { return { sites: [] } }
}

export function readManifest() {
  try {
    return parseManifest(fs.readFileSync(MANIFEST, 'utf8'))
  } catch { return { sites: [] } }
}

export function writeManifest(m) {
  fs.mkdirSync(PATHS.stateDir, { recursive: true })
  fs.writeFileSync(MANIFEST, JSON.stringify(m, null, 2), { mode: 0o600 })
}

export function siteConfPath(name) { return path.join(PATHS.sitesAvail, `${name}.conf`) }
export function enabledConfPath(name) { return path.join(PATHS.sitesEn, `${name}.conf`) }
export function htpasswdPath(name) { return path.join(PATHS.htpasswdDir, name) }
export function certDir(name) { return path.join(PATHS.certsDir, name) }

// paths baked into conf files must be forward-slash regardless of host OS
const toConf = p => p.replace(/\\/g, '/')

const esc = s => String(s).replace(/([;{}"\\])/g, '\\$1')

// ---------- validators: everything that reaches a conf file is allowlisted here ----------
// Allowlists, not escaping — `$` cannot be backslash-escaped portably in nginx, so the
// fix is to never let a variable-looking string through in the first place.
// `_` is nginx's "nothing else matched" name — the only way to give a port a vhost before it
// has DNS (a bare IP, an internal box), which is why an empty domain list is allowed at all.
const DOMAIN_RE = /^(_|(\*\.)?[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*)$/
const INDEX_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/
// A unix socket path, deliberately narrower than "no metacharacters": a FastCGI endpoint is
// not escaped on the way out, so the charset is the whole guarantee.
const FPM_UNIX_RE = /^unix:\/[A-Za-z0-9._/-]+$/
const HOST_RE = /^(\[[0-9a-fA-F:]+\]|[a-zA-Z0-9]([a-zA-Z0-9._-]*[a-zA-Z0-9])?)$/ // hostname or [ipv6]
const UPNAME_RE = /^[a-zA-Z_][a-zA-Z0-9_-]{0,63}$/
const LOCPATH_RE = /^\/[A-Za-z0-9._~/-]*$/
const TARGET_RE = /^https?:\/\/[^\s;{}"'\\]+$/
const MIME_RE = /^[a-zA-Z0-9.+-]+\/[a-zA-Z0-9.+-]+$/
const EXT_RE = /^[a-zA-Z0-9]{1,12}$/
const CA_PATH_RE = /^\/[^\s;{}"'\\]+$/
// A docroot, never escaped into the conf — block anything that could close the directive.
// Backslashes are allowed because a dev machine's DRY-mode path has them and toConf()
// normalises them to forward slashes before anything is written.
const ROOT_RE = /^[^\s;{}"'`$]+$/

const isIp = s => /^[0-9a-fA-F.:\/]+$/.test(s)
const isPort = p => Number.isInteger(p) && p >= 1 && p <= 65535

// Both FastCGI transports: a unix socket, or host:port (HOST_RE is what keeps `[::1]:9000`
// working and `127.0.0.1:9000; }` out).
const isFpmEndpoint = v => {
  const s = String(v || '')
  if (FPM_UNIX_RE.test(s)) return true
  const m = s.match(/^(.+):(\d{1,5})$/)
  return !!m && HOST_RE.test(m[1]) && isPort(Number(m[2]))
}

export const validators = { DOMAIN_RE, HOST_RE, UPNAME_RE, LOCPATH_RE, TARGET_RE, MIME_RE, EXT_RE, INDEX_RE, isIp, isPort, isFpmEndpoint }

// nginx upstreams live in the http context and are global, so the generated name is
// namespaced by site — two sites may both call a pool "backends".
export const upstreamRef = (siteName, upName) => `${siteName}_${upName}`

// A v4-only `listen 80;` leaves IPv6 clients reaching whichever server is the default for
// [::]:80 — the wrong site. But the second listen binds at *reload*, and `nginx -t` only
// checks syntax, so on a host with IPv6 disabled it would take nginx down without warning.
// Emit it only where the host actually has IPv6.
export const hasIpv6 = Object.values(os.networkInterfaces()).flat().some(i => i?.family === 'IPv6')
const v6 = (port, rest = '') => (hasIpv6 ? [`    listen [::]:${port}${rest};`] : [])

/**
 * The listen lines for a port. An address-bound site gets exactly one listener, on that address
 * only — emitting the `[::]` wildcard alongside it would put the vhost back on every interface,
 * which is the very thing listenAddress exists to prevent.
 */
function bind(site, port, rest = '') {
  const addr = String(site.listenAddress || '')
  const fam = addr ? net.isIP(addr) : 0
  if (fam) return [`    listen ${fam === 6 ? `[${addr}]` : addr}:${port}${rest};`]
  return [`    listen ${port}${rest};`, ...v6(port, rest)]
}

/**
 * Whether a document root may be recursively deleted: `null` if it may, else a sentence saying why
 * not. The same shape `driftOf` answers in.
 *
 * This is the load-bearing check of `DELETE /api/sites/:name?root=1`, because nothing upstream of it
 * is. `ROOT_RE` lets `/`, `/etc` and `/var/www` through, and POST /api/sites will `mkdirSync` any of
 * them — so a recursive delete on that validation alone is `rm -rf /` behind one typo.
 *
 * `sites` and `self` are injectable so this is unit-testable without writing a manifest; `self` is
 * the site being deleted, which is the one root that is *not* somebody else's.
 */
export function docrootRemovalRefusal(root, sites = readManifest().sites, self = '') {
  const raw = String(root ?? '').trim()
  if (!raw || !path.isAbsolute(raw)) {
    return `"${raw}" is not an absolute path, and resolving a relative document root against wherever the dashboard happens to be running is not something to guess at`
  }
  const p = path.normalize(raw)

  // A path that is not on disk has no symlink to resolve — but that is a reason to skip *this* rule,
  // not to return early. Returning here would let a docroot that simply does not exist yet skip the
  // sibling and overlap checks below, which are the ones standing between a typo and `rm -rf /`.
  let real = null
  try { real = fs.realpathSync(p) } catch { /* absent: the route reports nothing to remove */ }

  // Covers the docroot and anything above it: with /var/www a symlink elsewhere, rmSync on the
  // lexical path recurses into whatever it points at. Closes the same gap `safeJoin` leaves open by
  // resolving lexically, and refusing on doubt costs a real box nothing.
  if (real && real !== p) {
    return `${p} resolves to ${real}, so it is a symlink or sits beneath one — deleting it would remove whatever that points at instead`
  }

  const parts = p.split(path.sep).filter(Boolean)
  if (parts.length < 2) return `"${p}" is the filesystem root itself, or one step below it — not a directory this will delete recursively`

  const overlaps = (a, b) => a === b || a.startsWith(b + path.sep) || b.startsWith(a + path.sep)
  // Iterated rather than listed by hand, so a directory added to PATHS later is protected without
  // anyone remembering to come back here. Both directions matter, and the one that is easy to miss
  // is `b.startsWith(a)`: a document root of /var/lib would take the dashboard's state with it.
  const reserved = [...Object.entries(PATHS), ['the dashboard itself', path.dirname(import.meta.dirname)]]
  for (const [what, dir] of reserved) {
    const d = path.normalize(String(dir))
    if (overlaps(p, d)) return `${p} overlaps ${what} (${d}) — deleting it would take part of nginx or of the dashboard with it`
  }

  const clash = (sites || []).find(s => s?.name !== self && overlaps(p, path.normalize(String(s?.root || ''))))
  if (clash) return `${p} is also where the site "${clash.name}" keeps its files — deleting it would take both`

  return null
}

/**
 * Every reason this site cannot be rendered into a valid conf. Returned to the UI as a
 * 400 before anything is written, so users get a sentence instead of an nginx error.
 */
export function validateSite(site) {
  const errs = []
  // No "at least one domain" rule: an empty list is a valid vhost, it just answers to `_`.
  for (const d of site.domains) if (!DOMAIN_RE.test(d)) errs.push(`invalid domain: ${d}`)
  if (!isPort(site.port)) errs.push(`invalid port: ${site.port}`)
  if (!isPort(site.httpsPort)) errs.push(`invalid https port: ${site.httpsPort}`)
  else if (site.https.mode !== 'none' && site.httpsPort === site.port) errs.push(`https port must differ from the http port (${site.port})`)
  if (site.serveHttp === false && site.https.mode === 'none') errs.push('nothing to serve: plain HTTP is off and HTTPS is off')
  if (!ROOT_RE.test(String(site.root || ''))) errs.push(`invalid document root: ${site.root}`)

  const index = String(site.index || '').trim().split(/\s+/).filter(Boolean)
  if (!index.length) errs.push('index needs at least one file name')
  for (const f of index) if (!INDEX_RE.test(f)) errs.push(`invalid index entry: ${f}`)

  if (site.php?.enabled && !isFpmEndpoint(site.php.endpoint)) {
    errs.push(`invalid fastcgi endpoint: ${site.php.endpoint || '(empty)'} — use unix:/path/to.sock or host:port`)
  }

  for (const u of site.upstreams) {
    if (!UPNAME_RE.test(String(u.name || ''))) errs.push(`invalid upstream name: ${u.name} (letters, digits, _ and - only)`)
    if (!['round_robin', 'least_conn', 'ip_hash'].includes(u.algorithm)) errs.push(`invalid algorithm for ${u.name}: ${u.algorithm}`)
    if (!u.servers?.length) errs.push(`upstream ${u.name} has no backend servers`)
    for (const s of u.servers || []) {
      if (!HOST_RE.test(String(s.host || ''))) errs.push(`invalid backend host in ${u.name}: ${s.host}`)
      if (!isPort(s.port)) errs.push(`invalid backend port in ${u.name}: ${s.port}`)
      if (!['http', 'https'].includes(s.scheme)) errs.push(`invalid backend scheme in ${u.name}: ${s.scheme}`)
    }
  }

  for (const p of site.proxy) {
    if (!LOCPATH_RE.test(String(p.path || ''))) errs.push(`invalid proxy path: ${p.path} (must start with / and contain no spaces)`)
    const t = String(p.target || '')
    if (t.startsWith('upstream:')) {
      const ref = t.slice(9)
      if (!site.upstreams.some(u => u.name === ref)) errs.push(`proxy ${p.path} points at unknown upstream "${ref}"`)
    } else if (!TARGET_RE.test(t)) {
      errs.push(`invalid proxy target: ${t} (use http://host:port, https://host:port or upstream:name)`)
    }
    if (p.verify === true && (!p.ca || !CA_PATH_RE.test(String(p.ca)))) {
      errs.push(`proxy ${p.path}: verification needs a CA file path (proxy_ssl_verify on requires it)`)
    }
  }

  if (site.https.mode === 'manual') {
    if (!CA_PATH_RE.test(String(site.https.manualCert || ''))) errs.push('manual cert path must be an absolute path')
    if (!CA_PATH_RE.test(String(site.https.manualKey || ''))) errs.push('manual key path must be an absolute path')
  }
  if (site.https.mode === 'certbot' && !site.domains.length) errs.push('certbot mode needs a domain')
  if (!['none', 'selfsigned', 'certbot', 'manual'].includes(site.https.mode)) errs.push(`invalid https mode: ${site.https.mode}`)

  for (const t of site.gzip.types || []) if (!MIME_RE.test(t)) errs.push(`invalid gzip type: ${t}`)
  for (const e of site.staticCache.extensions || []) if (!EXT_RE.test(e)) errs.push(`invalid cache extension: ${e}`)

  // A list the operator asked for and then emptied emits nothing: the toggle reads "on" while
  // nginx sees no directive at all. Refused rather than saved, because the alternative is finding
  // out from a browser. Both predicates are the renderer's own, so each rule fires exactly when
  // renderDirectives would emit nothing.
  if (site.gzip.enabled && !(site.gzip.types || []).some(t => MIME_RE.test(t))) {
    errs.push('gzip is on with no types: nothing would be compressed — tick a type, or turn it off')
  }
  if (site.staticCache.enabled && !(site.staticCache.extensions || []).some(e => EXT_RE.test(e))) {
    errs.push('static caching is on with no extensions: no cache location would be emitted, so the toggle would do nothing — tick an extension, or turn it off')
  }
  const days = site.staticCache.expiresDays
  if (!Number.isInteger(days) || days < 1 || days > 3650) errs.push(`invalid cache expiry: ${days} (1-3650 days)`)
  if (!isPort(site.rateLimit.rps)) errs.push(`invalid requests/sec: ${site.rateLimit.rps}`)
  if (!Number.isInteger(site.rateLimit.burst) || site.rateLimit.burst < 1) errs.push(`invalid burst: ${site.rateLimit.burst}`)
  if (!['none', 'allowlist', 'denylist'].includes(site.ipRules.mode)) errs.push(`invalid ip rule mode: ${site.ipRules.mode}`)
  // A blank entry is an "+ IP" row nobody filled in — skipped, not an error. A *typo'd* one used
  // to be skipped too, silently, which on an allowlist is a rule that looks present and is not.
  for (const ip of (site.ipRules.ips || []).map(String)) {
    if (ip && !isIp(ip)) errs.push(`invalid ip rule: ${ip} (a bare IPv4 or IPv6 address, or a CIDR block)`)
  }

  // An allowlist is the one rule that fails *open*, and it does it from both directions: with an
  // empty list the whole ipRules block is skipped, so no `allow` and no `deny all` are emitted and
  // the vhost serves everyone; with nothing but a blank row the block does run, so `deny all` is
  // emitted with no `allow` above it and the vhost serves nobody — including the operator. The
  // form read "only these IPs" in both cases. A denylist with an empty list is honest ("block
  // nothing") and stays valid.
  if (site.ipRules.mode === 'allowlist' && !(site.ipRules.ips || []).some(ip => isIp(String(ip)))) {
    errs.push('an allowlist with no address emits no allow at all — open to everyone if the list is empty, 403 for everyone if the rows are blank — add an address, or set IP rules to none')
  }

  // Basic auth fails in two opposite directions from the same toggle, and neither is visible from
  // it. No users at all means no `auth_basic` directive is emitted, so the site is open. A row
  // that is missing either half still emits the directive, but writeHtpasswd skips that row and
  // writes an empty password file, which answers 401 to every request, the operator's included.
  // A row saved before this version carries `password`, a row saved after carries `hash` — both are
  // complete rows, and writing one over the other is how an existing user gets locked out.
  const users = site.basicAuth.users || []
  const complete = u => !!u?.user && !!(u.password || u.hash)
  if (site.basicAuth.enabled && !users.length) {
    errs.push('basic auth is on with no users: no auth_basic directive would be emitted at all, so the site would be open to everyone — add a user, or turn it off')
  } else if (site.basicAuth.enabled && !users.some(complete)) {
    errs.push('basic auth has no complete user row: a username and a password are both needed, or every request answers 401 — yours included')
  }

  // net.isIP, not a regex: it is the same parser the kernel uses, so anything it accepts is
  // something `listen` will take.
  const addr = String(site.listenAddress || '')
  if (addr && !net.isIP(addr)) {
    errs.push(`invalid listen address: ${addr} (a bare address like 192.168.1.10, or blank for every interface)`)
  }

  const body = site.clientMaxBodySize
  if (!Number.isInteger(body) || body < 0 || body > 10240) errs.push(`invalid max request body: ${body} MB (0-10240; 0 leaves nginx's 1m default)`)

  const hsts = site.hsts || {}
  if (!Number.isInteger(hsts.maxAge) || hsts.maxAge < 0 || hsts.maxAge > 63072000) errs.push(`invalid hsts max-age: ${hsts.maxAge} (0-63072000 seconds)`)
  // These two are hstspreload.org's own submission rules, not a preference of ours: a preload
  // entry that is shorter than a year or that skips subdomains is rejected by the browsers
  // that ship the list, and being on it is the only reason to set `preload` at all.
  if (hsts.preload && !hsts.includeSubDomains) errs.push('hsts preload requires includeSubDomains')
  if (hsts.preload && hsts.maxAge < 31536000) errs.push('hsts preload requires a max-age of at least 31536000 (one year)')

  return errs
}

/**
 * The dashboard's own vhost, checked on intent rather than on fields. Everything here asks
 * whether the vhost still *reaches* the dashboard: a save that satisfies `nginx -t` while
 * pointing `/` somewhere else returns 200 and cannot be undone from the browser, because the
 * browser is the thing that stopped working.
 *
 * `enabled` is the state on disk and is optional. Creating the site is the one moment a site is
 * legitimately disabled — every site is created disabled — so POST omits it. Update passes it,
 * because `testLinkFor` symlinks a *disabled* site in for `nginx -t` alone: a save that left the
 * self site disabled would otherwise pass the test, return 200, and leave nginx serving nothing.
 */
export function selfSiteErrors(site, { host = '', port, enabled } = {}) {
  const root = site.proxy.find(p => String(p.path || '') === '/')
  if (!root) {
    // Always alone, so it reads as a sentence rather than as a clause in a '; '-joined list
    return ["This is the dashboard's own vhost and it has no proxy rule on / — every /api call would fall through to the static fallback, so the page would load and then nothing would ever answer"]
  }
  const errs = []
  const target = String(root.target || '')
  // Tested before parsing: `upstream:pool` is a *valid* URL as far as the URL parser is
  // concerned — `upstream` is just a scheme — so it would otherwise be reported as a bad scheme
  // rather than as the thing it actually is.
  const isPool = target.startsWith('upstream:')
  const t = isPool ? null : targetHostPort(target)
  if (isPool) {
    errs.push(`the / rule points at the upstream pool "${target.slice(9)}" — a pool cannot be used here, since balancing this UI across backends takes it down along with any one of them`)
  } else if (!t) {
    errs.push(`the / rule points at "${target}", which is not a URL this can read. It has to be http://host:port, pointing straight at the dashboard`)
  } else if (t.scheme !== 'http') {
    errs.push(`the / rule uses ${t.scheme}://, but the dashboard speaks plain HTTP — nginx would be making a TLS request to itself that it has no certificate to verify`)
  } else if (!LOOPBACK.has(t.host) && t.host !== String(host)) {
    errs.push(`the / rule points at ${t.host}, but this dashboard listens on ${host} — nginx would proxy to a different host and the vhost would not reach it`)
  } else if (t.port !== Number(port)) {
    errs.push(`the / rule points at port ${t.port}, but this dashboard listens on port ${port}`)
  }
  if (enabled === false) {
    errs.push(`"${site.name}" is disabled, and it is how this dashboard is reached — enable it first, with the Enable button on this form`)
  }
  return errs
}

/**
 * Not refusals: the operator may mean every one of these. But each is a way the vhost ends up
 * more exposed or more fragile than "the dashboard, reachable on the LAN" implies, and the save
 * that sets it is the moment it is worth saying so.
 */
export function selfSiteWarnings(site) {
  const w = []
  if (!String(site.listenAddress || '')) {
    w.push('no listen address — this vhost answers on every interface, including any that face the WAN. Set one to bind it to the LAN')
  }
  if (site.ipRules.mode !== 'allowlist') {
    w.push('no IP allowlist — every host that can reach this port gets the login form')
  }
  if (site.https.mode === 'none') {
    w.push('no TLS on this vhost — over plain HTTP the dashboard password crosses the network in clear text')
  }
  if (site.basicAuth.enabled) {
    w.push('basic auth on top of the dashboard login means two prompts, and its password is a second credential to keep')
  }
  if (site.rateLimit.enabled && site.rateLimit.rps < 20) {
    w.push(`rate limiting at ${site.rateLimit.rps} r/s is tight for a UI that fetches many assets at once — 20 or more if pages load slowly`)
  }
  return w
}

/**
 * A revert restores the manifest wholesale, and `revertHistory` is a file restorer that consults
 * nothing — so reverting an unrelated old change can roll the dashboard's own vhost back to a
 * state that no longer reaches it. The check has to run before the restore does.
 *
 * It asks "would the result still reach the dashboard", never "is this the self site", so
 * reverting a change *to* the self site keeps working: that snapshot is the pre-change state,
 * which passed these same checks when it was saved.
 *
 * Empty whenever DASH_SELF_NAME is unset, so installs that never opted in are unaffected.
 */
export function selfRevertErrors(entry, { host = '', port, enabled = true } = {}) {
  if (!SELF_NAME) return []
  const files = entry?.files || []
  const errs = []

  // Only when the snapshot holds the manifest: a snapshot of a symlink toggle does not, and
  // restoring it cannot change which site the manifest describes.
  const manifestFile = files.find(f => f.path === MANIFEST)
  if (manifestFile?.content) {
    const site = parseManifest(manifestFile.content).sites.find(s => isSelf(s.name))
    // Only a threat when a vhost is published *now*. Before that there is nothing for the restore
    // to take away, and refusing would block undoing unrelated old changes forever.
    const live = readManifest().sites.some(s => isSelf(s.name))
    if (site) {
      errs.push(...selfSiteErrors(site, { host, port, enabled }))
    } else if (live) {
      errs.push(`that snapshot predates "${SELF_NAME}" — the dashboard's own vhost — so restoring it would drop it from the list this dashboard manages`)
    }
  }

  // A snapshot that never mentions the symlink is harmless — the link on disk is left alone and
  // the current state, which `enabled` above already described, stands.
  const link = files.find(f => f.path === enabledConfPath(SELF_NAME))
  if (link && !link.link) {
    errs.push(`that snapshot has "${SELF_NAME}" disabled, so restoring it would leave the dashboard's own vhost unwritten`)
  }
  return errs
}

function sslPaths(site) {
  if (site.https.mode === 'selfsigned') {
    return { cert: toConf(path.join(certDir(site.name), 'fullchain.pem')), key: toConf(path.join(certDir(site.name), 'privkey.pem')) }
  }
  if (site.https.mode === 'certbot') {
    return { cert: `/etc/letsencrypt/live/${site.domains[0]}/fullchain.pem`, key: `/etc/letsencrypt/live/${site.domains[0]}/privkey.pem` }
  }
  return { cert: site.https.manualCert, key: site.https.manualKey }
}

function isHttpsTarget(upstream) {
  return upstream.servers.some(s => s.scheme === 'https')
}

// The header value, or null when it must not be emitted. Only ever set on a TLS listener: the
// header is ignored on a plain-HTTP response, so emitting it there would just be a lie in the
// config that reads as if the site were protected.
function hstsValue(site) {
  const h = site.hsts || {}
  if (!h.enabled || site.https.mode === 'none') return null
  return `max-age=${h.maxAge}`
    + (h.includeSubDomains ? '; includeSubDomains' : '')
    + (h.preload ? '; preload' : '')
}

function renderLocation(loc, site, ind) {
  const ref = loc.target.startsWith('upstream:') ? loc.target.slice(9) : null
  // scoped to this site — the name is namespaced, so a same-named pool on another site is not ours
  const upstream = ref ? site.upstreams.find(u => u.name === ref) : null

  let pass
  if (upstream) pass = `${isHttpsTarget(upstream) ? 'https' : 'http'}://${upstreamRef(site.name, upstream.name)}`
  else if (ref) pass = loc.target  // dangling ref — leave it; nginx -t rejects it loudly instead of silently 502ing
  else pass = loc.target

  const lines = [
    `${ind}location ${loc.path} {`,
    `${ind}    proxy_pass ${pass};`,
    `${ind}    proxy_set_header Host $host;`,
    `${ind}    proxy_set_header X-Real-IP $remote_addr;`,
    `${ind}    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;`,
    `${ind}    proxy_set_header X-Forwarded-Proto $scheme;`,
    // Unconditional, because buffering is the classic reason *any* backend behind a proxy looks
    // frozen: nginx answers the browser immediately and dribbles the body out of its own buffer,
    // so a stream (the log tail, an SSE feed, a slow download) arrives in one lump at the end.
    // HTTP/1.1 plus an empty Connection is what lets the upstream keep the response open at all.
    `${ind}    proxy_http_version 1.1;`,
    `${ind}    proxy_set_header Connection "";`,
    `${ind}    proxy_buffering off;`,
  ]
  if (upstream && isHttpsTarget(upstream)) {
    // only verify with a CA file — `on` without proxy_ssl_trusted_certificate is a config error
    if (loc.verify === true && loc.ca) {
      lines.push(`${ind}    proxy_ssl_verify on;`)
      lines.push(`${ind}    proxy_ssl_trusted_certificate ${toConf(loc.ca)};`)
    } else {
      lines.push(`${ind}    proxy_ssl_verify off;`)
    }
  }
  lines.push(`${ind}}`)
  return lines
}

// `tls` says whether this body is going into the TLS server block. Only HSTS cares: it is
// meaningless on the plain-HTTP listener, and the two blocks otherwise render identically.
function renderDirectives(site, ind, tls = false) {
  const lines = []

  if (site.ipRules.mode !== 'none' && site.ipRules.ips.length) {
    for (const ip of site.ipRules.ips) {
      if (!isIp(ip)) continue
      lines.push(`${ind}${site.ipRules.mode === 'allowlist' ? 'allow' : 'deny'} ${ip};`)
    }
    if (site.ipRules.mode === 'allowlist') lines.push(`${ind}deny all;`)
  }

  if (site.basicAuth.enabled && site.basicAuth.users.length) {
    lines.push(`${ind}auth_basic "Restricted";`)
    lines.push(`${ind}auth_basic_user_file ${toConf(htpasswdPath(site.name))};`)
  }

  if (site.rateLimit.enabled) {
    lines.push(`${ind}limit_req zone=${site.name}_rl burst=${site.rateLimit.burst} nodelay;`)
  }

  if (site.gzip.enabled && site.gzip.types.length) {
    const types = site.gzip.types.filter(t => MIME_RE.test(t))
    if (types.length) {
      lines.push(`${ind}gzip on;`)
      lines.push(`${ind}gzip_types ${types.map(esc).join(' ')};`)
      lines.push(`${ind}gzip_vary on;`)
    }
  }

  // The docroot is always emitted, not only when there are no proxy rules: `proxy /api` plus
  // a static site is the common case, and without `root` those other paths fall through to
  // nginx's compiled-in default root — serving its stock welcome page from the user's domain.
  lines.push(`${ind}root ${site.root};`)
  const index = String(site.index || '').trim().split(/\s+/).filter(f => INDEX_RE.test(f))
  lines.push(`${ind}index ${index.length ? index.join(' ') : 'index.html index.htm'};`)

  // Per-site rather than in nginx.conf: the limit is really a property of the app behind the
  // vhost. Emitted only when set, so the default stays nginx's to change.
  if (Number.isInteger(site.clientMaxBodySize) && site.clientMaxBodySize > 0) {
    lines.push(`${ind}client_max_body_size ${site.clientMaxBodySize}m;`)
  }

  // Dotfiles are never content. `.git` (a full source checkout, clonable), `.env`, `.htpasswd`
  // and editor backups all end up under a docroot sooner or later. `well-known` stays open or
  // ACME http-01 renewals start failing.
  lines.push(`${ind}location ~ /\\.(?!well-known) {`)
  lines.push(`${ind}    deny all;`)
  lines.push(`${ind}}`)

  // Only one block may claim `location /`, and a proxy rule the user typed is the more explicit
  // intent — so it wins, and both the front controller and the static fallback stand down.
  const rootProxy = site.proxy.some(p => String(p.path || '') === '/')

  for (const loc of site.proxy.filter(p => LOCPATH_RE.test(String(p.path || '')))) {
    lines.push(...renderLocation(loc, site, ind))
  }

  const php = site.php || {}
  const phpOn = php.enabled && isFpmEndpoint(php.endpoint)
  const frontController = phpOn && php.frontController && !rootProxy
  if (phpOn) {
    if (frontController) {
      lines.push(`${ind}location / {`)
      lines.push(`${ind}    try_files $uri $uri/ /index.php?$query_string;`)
      lines.push(`${ind}}`)
    }
    lines.push(`${ind}location ~ [^/]\\.php(/|$) {`)
    lines.push(`${ind}    fastcgi_split_path_info ^(.+?\\.php)(/.*)$;`)
    lines.push(`${ind}    set $path_info $fastcgi_path_info;`)
    // The *script* has to exist, not the request URI. This is what stops
    // /uploads/avatar.jpg/x.php — the classic nginx+PHP upload-execution hole.
    lines.push(`${ind}    try_files $fastcgi_script_name =404;`)
    lines.push(`${ind}    fastcgi_pass ${php.endpoint};`)
    lines.push(`${ind}    fastcgi_index index.php;`)
    // `include fastcgi_params` is shipped by both Debian and RHEL; snippets/fastcgi-php.conf
    // is Debian-only, and it is the file that would otherwise duplicate all of the below.
    lines.push(`${ind}    include fastcgi_params;`)
    lines.push(`${ind}    fastcgi_param SCRIPT_FILENAME $document_root$fastcgi_script_name;`)
    lines.push(`${ind}    fastcgi_param PATH_INFO $path_info;`)
    lines.push(`${ind}}`)
  }

  const exts = (site.staticCache.extensions || []).filter(e => EXT_RE.test(e))
  if (site.staticCache.enabled && exts.length) {
    lines.push(`${ind}location ~* \\.(${exts.join('|')})$ {`)
    lines.push(`${ind}    expires ${site.staticCache.expiresDays}d;`)
    lines.push(`${ind}    add_header Cache-Control "public";`)
    // add_header does not merge: this location declaring one of its own drops every header set
    // on the server block above, HSTS included. Re-emitted here by hand for that reason alone.
    const hsts = hstsValue(site)
    if (tls && hsts) lines.push(`${ind}    add_header Strict-Transport-Security "${hsts}" always;`)
    lines.push(`${ind}}`)
  }

  // The static fallback, last so it settles after the regex locations above it win. A generator
  // that writes `about.html` for `/about` — Astro with build.format:'file' or trailingSlash
  // 'never', any per-page .html exporter — 404s on the extensionless URL under a bare root +
  // index, because `$uri` is not a directory and `$uri/` does not exist. `$uri.html` costs
  // nothing where no such file exists, and cannot reach a .php: the suffix is fixed, so
  // `/wp-config` looks for wp-config.html.
  if (!rootProxy && !frontController) {
    lines.push(`${ind}location / {`)
    lines.push(`${ind}    try_files $uri $uri/ $uri.html =404;`)
    lines.push(`${ind}}`)
  }
  return lines
}

function renderServers(site) {
  const domains = site.domains.filter(d => DOMAIN_RE.test(d)).map(esc).join(' ') || '_'
  const isHttps = site.https.mode !== 'none'
  const tlsPort = site.httpsPort
  const rp = site.listen.reuseport ? ' reuseport' : ''
  const blocks = []

  // ---- plain HTTP ----
  if (site.serveHttp !== false) {
    const b80 = ['server {', ...bind(site, site.port), `    server_name ${domains};`]
    if (isHttps && site.https.forceRedirect) {
      // The redirect has to name the TLS port. On anything but 443 the browser's default would
      // send it to a port this host is not listening on.
      const to = tlsPort === 443 ? 'https://$host$request_uri' : `https://$host:${tlsPort}$request_uri`
      b80.push(`    return 301 ${to};`, '}')
    } else {
      b80.push(...renderDirectives(site, '    '), '}')
    }
    blocks.push(b80)
  }

  // ---- TLS ----
  if (isHttps) {
    const { cert, key } = sslPaths(site)
    // `listen ... http2` is the deprecated-but-works syntax on both 1.18 and 1.27
    const tls = ` ssl${site.listen.http2 ? ' http2' : ''}${rp}`
    const b = ['server {', ...bind(site, tlsPort, tls)]
    if (site.listen.http3) {
      // reuseport has to be on every listener sharing the address:port, not just the QUIC one,
      // or nginx warns and the workers stop balancing accepts across the pair
      b.push(...bind(site, tlsPort, ` quic${rp}`),
        `    add_header Alt-Svc 'h3=":${tlsPort}"; ma=86400';`)
    }
    b.push(`    server_name ${domains};`,
      `    ssl_certificate ${cert};`,
      `    ssl_certificate_key ${key};`,
      '    ssl_protocols TLSv1.2 TLSv1.3;',
      '    ssl_prefer_server_ciphers off;',
      // One zone for every site this dashboard writes, so twenty sites do not reserve twenty.
      '    ssl_session_cache shared:dash_ssl:10m;',
      '    ssl_session_timeout 1d;',
      // Without this a stolen ticket stays valid for its full lifetime regardless of key rotation.
      '    ssl_session_tickets off;')
    const hsts = hstsValue(site)
    // `always` so it rides on error responses too — a 404 is exactly where a downgrade gets
    // attempted. Coexists with the Alt-Svc header above; both are server-scope.
    if (hsts) b.push(`    add_header Strict-Transport-Security "${hsts}" always;`)
    b.push(...renderDirectives(site, '    ', true), '}')
    blocks.push(b)
  }

  return blocks.map(x => x.join('\n')).join('\n\n')
}

// http-context directives for all sites: rate-limit zones + upstream pools.
export function renderHttpConf(sites) {
  const lines = ['# managed by nginx-dashboard — do not edit by hand']
  for (const s of sites) {
    if (s.rateLimit.enabled) {
      lines.push(`limit_req_zone $binary_remote_addr zone=${s.name}_rl:10m rate=${s.rateLimit.rps}r/s;`)
    }
    for (const u of s.upstreams) {
      if (!UPNAME_RE.test(String(u.name || ''))) continue
      lines.push(`upstream ${upstreamRef(s.name, u.name)} {`)
      if (u.algorithm === 'least_conn') lines.push('    least_conn;')
      if (u.algorithm === 'ip_hash') lines.push('    ip_hash;')
      for (const srv of u.servers) {
        if (!HOST_RE.test(String(srv.host || '')) || !isPort(srv.port)) continue
        lines.push(`    server ${srv.host}:${srv.port}${u.healthCheck ? ' max_fails=3 fail_timeout=10s' : ''};`)
      }
      lines.push('}')
    }
  }
  return lines.join('\n') + '\n'
}

export function renderSiteConf(site) {
  return `# managed by nginx-dashboard — do not edit by hand
${renderServers(site)}
`
}

/**
 * Is the conf on disk still the one we generated? The dashboard never parses a conf back —
 * the manifest is the only source of truth — so a hand-edit (or another tool, or you at 3am
 * over SSH) would be silently overwritten by the next button click. Cheaper to say so before
 * the click than after. Re-render and compare; no parsing involved.
 * Returns 'missing' | 'modified' | null.
 */
export function driftOf(site) {
  const f = siteConfPath(site.name)
  try {
    return fs.readFileSync(f, 'utf8') === renderSiteConf(site) ? null : 'modified'
  } catch {
    return 'missing' // the manifest has this site but its conf is not on disk
  }
}

/** Same question for the shared http-context file (upstreams, rate-limit zones). */
export function httpConfDrift(sites) {
  try {
    return fs.readFileSync(HTTP_CONF, 'utf8') !== renderHttpConf(sites)
  } catch {
    return true
  }
}

/**
 * Hash whatever plaintext a user list still carries. `{ user, hash }` in, `{ user, hash }` out: a
 * row arriving with a `password` is a new or changed one, and a row arriving with only its `hash`
 * is unchanged and keeps it — re-hashing a hash would store the hash as the password and lock that
 * user out.
 *
 * Split from writeHtpasswd because the undo history needs the hashing without the file write: a
 * snapshot can name a site that has since been deleted, and rewriting its password file would
 * leave litter behind for a vhost that no longer exists.
 */
export async function hashUserRows(users) {
  const out = []
  for (const u of users || []) {
    if (!u?.user) continue
    let hash = u.hash || ''
    if (u.password) {
      const r = await shell('openssl', ['passwd', '-apr1', u.password])
      if (r.status !== 0) throw new Error(`openssl passwd failed: ${r.stderr.trim()}`)
      hash = r.stdout.trim()
    }
    out.push({ user: u.user, hash })
  }
  return out
}

/**
 * Hash the user list, write nginx's password file, and return the rows to store. The return value
 * is the point: nginx only ever reads the hash, so the plaintext has no reason to outlive this
 * call, and the callers put the result in the manifest.
 */
export async function writeHtpasswd(site) {
  const users = await hashUserRows(site.basicAuth.users)
  // Enabled with no row carrying a hash is refused by validateSite before it gets here, so this
  // cannot write the empty file that answers 401 to everyone. Left alone when disabled, so turning
  // basic auth off does not delete the file that turning it back on would need.
  if (site.basicAuth.enabled && users.some(u => u.hash)) {
    fs.mkdirSync(PATHS.htpasswdDir, { recursive: true })
    fs.writeFileSync(htpasswdPath(site.name), users.filter(u => u.hash).map(u => `${u.user}:${u.hash}`).join('\n') + '\n', { mode: 0o640 })
  }
  return users
}
