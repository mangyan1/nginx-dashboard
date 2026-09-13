import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { MANIFEST, HTTP_CONF, PATHS, safeApply, shell } from './nginx.js'

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
    index: 'index.html index.htm',   // document-root index order; dynamic apps want index.php first
    https: { mode: 'none', forceRedirect: false, manualCert: '', manualKey: '' },
    listen: { http2: false, http3: false, reuseport: false },   // reuseport must match across listeners on one port
    // FastCGI backend: PHP-FPM, or anything else that speaks FastCGI. This is the second half of
    // "any backend" — an HTTP app (node, python, a container) is a proxy rule instead.
    //   endpoint: 'unix:/run/php/php8.3-fpm.sock' | '127.0.0.1:9000'
    //   frontController: unmatched paths go to /index.php (WordPress, Laravel, Drupal)
    php: { enabled: false, endpoint: '', frontController: false },
    proxy: [],            // { path: '/api', target: 'http://host:port' | 'https://host:port' | 'upstream:name' }
    upstreams: [],         // { name, algorithm: 'round_robin'|'least_conn'|'ip_hash', servers: [{scheme, host, port}], healthCheck }
    rateLimit: { enabled: false, rps: 10, burst: 20 },
    ipRules: { mode: 'none', ips: [] },   // mode: 'none' | 'allowlist' | 'denylist'
    basicAuth: { enabled: false, users: [] }, // { user, password } — plain in manifest (root-only 0600), hashed into htpasswd
    gzip: { enabled: true, types: ['text/css', 'application/javascript', 'application/json', 'image/svg+xml', 'text/plain'] },
    staticCache: { enabled: true, extensions: ['css', 'js', 'png', 'jpg', 'jpeg', 'gif', 'svg', 'ico', 'woff', 'woff2'], expiresDays: 30 },
  }
}

const NESTED = ['https', 'listen', 'php', 'rateLimit', 'ipRules', 'basicAuth', 'gzip', 'staticCache']

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
  return s
}

export function readManifest() {
  try {
    const m = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'))
    return { ...m, sites: (m.sites || []).map(normalizeSite) }
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
  const days = site.staticCache.expiresDays
  if (!Number.isInteger(days) || days < 1 || days > 3650) errs.push(`invalid cache expiry: ${days} (1-3650 days)`)
  if (!isPort(site.rateLimit.rps)) errs.push(`invalid requests/sec: ${site.rateLimit.rps}`)
  if (!Number.isInteger(site.rateLimit.burst) || site.rateLimit.burst < 1) errs.push(`invalid burst: ${site.rateLimit.burst}`)
  if (!['none', 'allowlist', 'denylist'].includes(site.ipRules.mode)) errs.push(`invalid ip rule mode: ${site.ipRules.mode}`)

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

function renderDirectives(site, ind) {
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

  // Dotfiles are never content. `.git` (a full source checkout, clonable), `.env`, `.htpasswd`
  // and editor backups all end up under a docroot sooner or later. `well-known` stays open or
  // ACME http-01 renewals start failing.
  lines.push(`${ind}location ~ /\\.(?!well-known) {`)
  lines.push(`${ind}    deny all;`)
  lines.push(`${ind}}`)

  for (const loc of site.proxy.filter(p => LOCPATH_RE.test(String(p.path || '')))) {
    lines.push(...renderLocation(loc, site, ind))
  }

  const php = site.php || {}
  if (php.enabled && isFpmEndpoint(php.endpoint)) {
    // A proxy rule already claiming `/` would make this a duplicate location — nginx -t
    // rejects the whole file, so the proxy rule wins and the front controller is skipped.
    if (php.frontController && !site.proxy.some(p => String(p.path || '') === '/')) {
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
    const b80 = ['server {', `    listen ${site.port};`, ...v6(site.port), `    server_name ${domains};`]
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
    const b = ['server {', `    listen ${tlsPort}${tls};`, ...v6(tlsPort, tls)]
    if (site.listen.http3) {
      // reuseport has to be on every listener sharing the address:port, not just the QUIC one,
      // or nginx warns and the workers stop balancing accepts across the pair
      b.push(`    listen ${tlsPort} quic${rp};`, ...v6(tlsPort, ` quic${rp}`),
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
    b.push(...renderDirectives(site, '    '), '}')
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

export async function writeHtpasswd(site) {
  if (!site.basicAuth.enabled || !site.basicAuth.users.length) return
  fs.mkdirSync(PATHS.htpasswdDir, { recursive: true })
  const entries = []
  for (const u of site.basicAuth.users) {
    if (!u.user || !u.password) continue
    const r = await shell('openssl', ['passwd', '-apr1', u.password])
    if (r.status !== 0) throw new Error(`openssl passwd failed: ${r.stderr.trim()}`)
    entries.push(`${u.user}:${r.stdout.trim()}`)
  }
  fs.writeFileSync(htpasswdPath(site.name), entries.join('\n') + '\n', { mode: 0o640 })
}
