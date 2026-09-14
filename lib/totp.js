import crypto from 'node:crypto'

// RFC 6238 TOTP over RFC 4226 HOTP — SHA-1, 30-second step, 6 digits, which is what every
// authenticator app assumes when the otpauth URI says nothing else. Written out rather than
// pulled in: it is forty lines of HMAC and the only dependency would be for the base32 layer.
const STEP = 30
const DIGITS = 6
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567' // RFC 4648 base32, no padding character

export function b32encode(buf) {
  let bits = ''
  for (const b of buf) bits += b.toString(2).padStart(8, '0')
  let out = ''
  for (let i = 0; i < bits.length; i += 5) out += ALPHABET[parseInt(bits.slice(i, i + 5).padEnd(5, '0'), 2)]
  return out
}

/** Throws on a secret that is not base32 — the caller turns that into a startup failure. */
export function b32decode(s) {
  const clean = String(s || '').toUpperCase().replace(/[\s=-]/g, '')
  if (!clean) throw new Error('empty')
  if (!/^[A-Z2-7]+$/.test(clean)) throw new Error('not base32 (A-Z and 2-7 only)')
  let bits = ''
  for (const c of clean) bits += ALPHABET.indexOf(c).toString(2).padStart(5, '0')
  const bytes = []
  for (let i = 0; i + 8 <= bits.length; i += 8) bytes.push(parseInt(bits.slice(i, i + 8), 2))
  return Buffer.from(bytes)
}

/** The code for the step containing `at` (ms since epoch). */
export function totp(secret, at = Date.now()) {
  const key = Buffer.isBuffer(secret) ? secret : b32decode(secret)
  const buf = Buffer.alloc(8)
  buf.writeBigUInt64BE(BigInt(Math.floor(at / 1000 / STEP)))
  const h = crypto.createHmac('sha1', key).update(buf).digest()
  const off = h[h.length - 1] & 0x0f // dynamic truncation, RFC 4226 §5.3
  const n = (((h[off] & 0x7f) << 24) | (h[off + 1] << 16) | (h[off + 2] << 8) | h[off + 3]) % 10 ** DIGITS
  return String(n).padStart(DIGITS, '0')
}

/**
 * ±1 step, because the phone's clock and the server's are not the same clock and a code typed
 * at the boundary of a step is otherwise rejected through no fault of the user.
 */
export function totpValid(secret, given, at = Date.now()) {
  const g = String(given || '').trim()
  // Checked before timingSafeEqual, which throws on buffers of different lengths.
  if (!new RegExp(`^[0-9]{${DIGITS}}$`).test(g)) return false
  for (const drift of [-1, 0, 1]) {
    const want = totp(secret, at + drift * STEP * 1000)
    if (crypto.timingSafeEqual(Buffer.from(want), Buffer.from(g))) return true
  }
  return false
}

// 20 bytes / 160 bits, the length RFC 4226 §4 recommends for HMAC-SHA-1, and an exact multiple
// of 5 so base32 needs no padding.
export const newSecret = () => b32encode(crypto.randomBytes(20))

export const otpauth = (secret, label = 'nginx-dashboard') =>
  `otpauth://totp/${encodeURIComponent(label)}?secret=${secret}&issuer=${encodeURIComponent(label)}&algorithm=SHA1&digits=${DIGITS}&period=${STEP}`
