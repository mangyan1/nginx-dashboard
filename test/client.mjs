// The client's framework-free modules: the chip's answer to "is this the default?" (which decides
// whether it offers to write a value or greys out and says the field already holds it), the snackbar
// store, and the one line each route reports when it succeeds. Plain node: none of them imports
// React.
//   node test/client.mjs
import assert from 'node:assert/strict'
import { at, isDefault, fmt, short } from '../src/defaults.js'
import * as toast from '../src/toast.js'
import { said } from '../src/api.js'

let n = 0
const check = (name, fn) => { fn(); n++; console.log(`  ok  ${name}`) }

check('a path reads out of the server object', () => {
  assert.equal(at({ a: { b: 2 } }, 'a.b'), 2)
  assert.equal(at({ a: {} }, 'a.b.c'), undefined)
})

check('a blank field is at its default', () => {
  // not a convenience: sanitizeSite fills a blank docroot, index or body limit from this very
  // object, so an emptied field really does mean "whatever the server says"
  assert.ok(isDefault('', '/var/www/myapp'))
  assert.ok(!isDefault('/srv/www', '/var/www/myapp'))
  assert.ok(isDefault('/var/www/myapp', '/var/www/myapp'))
})

check('...unless the default is blank too, or every empty text box would read as untouched', () => {
  assert.ok(isDefault('', ''))
  assert.ok(!isDefault('192.168.1.10', ''))
})

check('numbers, booleans and selects compare by value', () => {
  assert.ok(isDefault(0, 0))
  assert.ok(!isDefault(1, 0))
  assert.ok(isDefault(false, false))
  assert.ok(!isDefault(true, false))
  assert.ok(isDefault('none', 'none'))
  assert.ok(!isDefault('allowlist', 'none'))
})

check('a checkbox grid is compared by membership, not by order', () => {
  // unticking and reticking a type leaves the same set in a different order
  assert.ok(isDefault(['a', 'b'], ['b', 'a']))
  assert.ok(!isDefault(['a'], ['a', 'b']))
  assert.ok(!isDefault(['a', 'a'], ['a', 'b']))
  assert.ok(isDefault([], []))
})

check('a row is compared on the fields the chip governs', () => {
  const def = { path: '/', target: 'http://127.0.0.1:8080' }
  // `verify` is carried by a proxy rule and is not on screen — a reset must not make the row read
  // as non-default, nor the chip write over it
  assert.ok(isDefault({ ...def, verify: true }, def))
  assert.ok(!isDefault({ path: '/api', target: def.target }, def))
  assert.ok(!isDefault(undefined, def))
})

check('the chip prints a short value and falls back to the bare word', () => {
  assert.equal(short('index.html index.htm'), 'index.html index.htm')
  assert.equal(short(80), '80')
  assert.equal(short(''), 'blank')
  assert.equal(short([]), 'none')
  assert.equal(short(['css', 'js']), 'css js')
  assert.equal(short('x'.repeat(30)), '')
  assert.equal(short({ path: '/' }), '')
  assert.equal(fmt(['text/css']), 'text/css')
  assert.equal(fmt([]), 'none')
  // a toggle's default reads as the switch it is
  assert.equal(short(true), 'on')
  assert.equal(short(false), 'off')
})

check('a toast is announced, and replaced rather than mutated', () => {
  // the same reference back while nothing has changed: useSyncExternalStore re-renders in a loop
  // if a snapshot that is only read looks like a change
  assert.equal(toast.snapshot(), toast.snapshot())
  const before = toast.snapshot()
  const seen = []
  const off = toast.subscribe(() => seen.push(toast.snapshot().length))
  const first = toast.ok('site shop saved and applied')
  assert.notEqual(toast.snapshot(), before)
  toast.err('site shop rejected — an allowlist with no address')
  assert.deepEqual(toast.snapshot().map(t => t.kind), ['ok', 'err'])
  assert.notEqual(toast.snapshot()[0].id, toast.snapshot()[1].id)
  assert.deepEqual(seen, [1, 2])
  toast.dismiss(first)
  assert.deepEqual(toast.snapshot().map(t => t.kind), ['err'])
  off()
  toast.dismiss(toast.snapshot()[0].id)
  assert.equal(seen.length, 3)      // unsubscribed, so the last dismissal was not announced
  assert.equal(toast.snapshot().length, 0)
})

check('a toast with nothing to say is never pushed', () => {
  // a route with no message must not leave an empty box on screen for five seconds
  assert.equal(toast.ok(''), undefined)
  assert.equal(toast.snapshot().length, 0)
})

check('an action is reported as what happened, not as the button that was pressed', () => {
  // every one of these is a button whose label is the verb, so echoing the route name back is the
  // click reporting itself — which reads as it having failed to register
  for (const [act, line] of [
    ['start', 'nginx started'], ['stop', 'nginx stopped'], ['restart', 'nginx restarted'],
    ['reload', 'nginx reloaded'], ['test', 'config is valid'],
  ]) assert.equal(said('POST', `/api/nginx/${act}`), line, act)
  // a site's verbs already read this way, and they are the shape the rest are matched against
  assert.equal(said('PUT', '/api/sites/shop', { site: { name: 'shop' } }), 'site shop saved and applied')
  assert.equal(said('POST', '/api/sites/shop/enable'), 'site shop enabled')
  assert.equal(said('POST', '/api/logs/rotate'), 'logs rotated')
  // Without its own branch this falls through to "site shop saved and applied", which is a
  // different action entirely — so the version in the line is the point, not decoration.
  assert.equal(said('POST', '/api/sites/shop/wordpress', { version: '6.7.1' }), 'WordPress 6.7.1 is in the document root')
  // The stack install says nothing: the panel streams apt's own output and shows the verdict
  // beneath it, so a toast would be the same news a third time.
  assert.equal(said('POST', '/api/stack/install', { ok: true }), '')
  // A plain delete is byte-identical to before — this is the assertion that keeps the `?root=1`
  // clause from leaking into every delete's toast.
  assert.equal(said('DELETE', '/api/sites/shop'), 'site shop deleted')
  // The query string is stripped before the route is matched, so `?root=1` does not change which
  // branch answers — and the clause rides on `output`, which only the removal sets.
  assert.equal(said('DELETE', '/api/sites/shop?root=1', { ok: true, output: 'the document root /var/www/shop was removed' }),
    'site shop deleted, the document root /var/www/shop was removed')
  assert.equal(said('DELETE', '/api/sites/shop?root=1', { ok: true, output: 'dry mode — the document root /var/www/shop was not removed' }),
    'site shop deleted, dry mode — the document root /var/www/shop was not removed')
})

check('dismissing one that is already gone changes nothing', () => {
  const before = toast.snapshot()
  toast.dismiss(99999)
  assert.equal(toast.snapshot(), before)
})

console.log(`\nall ${n} checks passed`)
