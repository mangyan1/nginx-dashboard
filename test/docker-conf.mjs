// Round-trip: generate a full-featured site config with the real generator,
// then validate it with `nginx -t` inside the official nginx image.
// Usage: node test/docker-conf.mjs   (docker required)
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const CONF_D = path.join(root, 'test', 'fixtures', 'docker', 'conf.d')

fs.rmSync(path.dirname(CONF_D), { recursive: true, force: true })
fs.mkdirSync(CONF_D, { recursive: true })

process.env.DASH_NGINX_DIR = '/etc/nginx' // paths baked into conf must be the server's, not the dev machine's
const { defaultSite, renderSiteConf, renderHttpConf } = await import(`file://${path.join(root, 'lib', 'manifest.js').replace(/\\/g, '/')}`)

const site = {
  ...defaultSite('myapp'),
  domains: ['myapp.test'],
  root: '/var/www/myapp',
  https: { mode: 'selfsigned', forceRedirect: true, manualCert: '', manualKey: '' },
  listen: { http2: true, http3: true },
  proxy: [{ path: '/api', target: 'upstream:myapp_backends' }, { path: '/ext', target: 'https://203.0.113.10:8443', verify: true, ca: '/etc/ssl/certs/ca-certificates.crt' }],
  upstreams: [{ name: 'myapp_backends', algorithm: 'least_conn', healthCheck: true,
    servers: [{ scheme: 'https', host: '10.0.0.5', port: 8443 }, { scheme: 'http', host: '127.0.0.1', port: 3001 }] }],
  rateLimit: { enabled: true, rps: 5, burst: 10 },
  ipRules: { mode: 'denylist', ips: ['1.2.3.4'] },
  gzip: { enabled: true, types: ['text/css', 'application/javascript'] },
  staticCache: { enabled: true, extensions: ['css', 'js'], expiresDays: 30 },
}

// second site deliberately reuses the pool name "myapp_backends": nginx upstreams are global,
// so the generated names must be namespaced or nginx -t fails with "duplicate upstream"
const twin = {
  ...defaultSite('twin'),
  domains: ['twin.test'],
  proxy: [{ path: '/', target: 'upstream:myapp_backends' }],
  upstreams: [{ name: 'myapp_backends', algorithm: 'ip_hash', healthCheck: false,
    servers: [{ scheme: 'http', host: '10.0.0.7', port: 9000 }] }],
}
const sites = [site, twin]

fs.writeFileSync(path.join(CONF_D, '00-dashboard.conf'), renderHttpConf(sites))
fs.writeFileSync(path.join(CONF_D, 'myapp.conf'), renderSiteConf(site))
fs.writeFileSync(path.join(CONF_D, 'twin.conf'), renderSiteConf(twin))

// assertions the docker run below can only confirm if the generator got these right
const http = renderHttpConf(sites)
const errs = []
if (!http.includes('upstream myapp_myapp_backends {')) errs.push('missing namespaced upstream for myapp')
if (!http.includes('upstream twin_myapp_backends {')) errs.push('missing namespaced upstream for twin')
if (http.match(/^upstream myapp_backends \{/m)) errs.push('leaked an un-namespaced upstream name')
// myapp's pool has an https backend so it proxies over https; twin's is http-only
if (!renderSiteConf(site).includes('proxy_pass https://myapp_myapp_backends;')) errs.push('myapp proxy_pass not namespaced or wrong scheme')
if (!renderSiteConf(twin).includes('proxy_pass http://twin_myapp_backends;')) errs.push('twin inherited the wrong upstream or scheme')
if (errs.length) { console.error('GENERATOR FAILED:\n  ' + errs.join('\n  ')); process.exit(1) }
console.log('namespacing assertions passed (2 sites, same pool name)')
fs.writeFileSync(path.join(CONF_D, '00-dashboard-status.conf'),
  `server { listen 127.0.0.1:8099; location /nginx_status { stub_status; allow 127.0.0.1; deny all; } }\n`)

console.log('conf generated — now validate inside nginx:stable (needs a real cert for nginx -t):')
console.log(`  docker run --rm -v "${CONF_D.replace(/\\/g, '/')}:/etc/nginx/conf.d" nginx:stable sh -c "mkdir -p /etc/nginx/dashboard-certs/myapp && openssl req -x509 -newkey rsa:2048 -nodes -days 1 -keyout /etc/nginx/dashboard-certs/myapp/privkey.pem -out /etc/nginx/dashboard-certs/myapp/fullchain.pem -subj /CN=myapp.test && nginx -t"`)