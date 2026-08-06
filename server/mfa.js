// Multi-factor auth primitives: TOTP (RFC 6238, the authenticator-app standard)
// and single-use recovery codes. Dependency-free (Node crypto). TOTP is simple
// and well specified, so it is hand-rolled here and checked against the RFC 6238
// test vectors in server/tests/mfa.test.js rather than guessed. See docs/auth.md.

const crypto = require('crypto');

// ---- Base32 (RFC 4648), the encoding authenticator apps expect for secrets ----
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function base32Encode(buf) {
  let bits = 0, value = 0, out = '';
  for (const b of buf) {
    value = (value << 8) | b; bits += 8;
    while (bits >= 5) { out += B32[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

function base32Decode(str) {
  const clean = String(str).toUpperCase().replace(/[^A-Z2-7]/g, '');
  let bits = 0, value = 0; const out = [];
  for (const c of clean) {
    value = (value << 5) | B32.indexOf(c); bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 0xff); bits -= 8; }
  }
  return Buffer.from(out);
}

function generateTotpSecret() {
  return base32Encode(crypto.randomBytes(20));
}

// HOTP (RFC 4226): HMAC-SHA1 of an 8-byte big-endian counter, dynamically truncated to 6 digits.
function hotp(secretBuf, counter) {
  const buf = Buffer.alloc(8);
  buf.writeUInt32BE(Math.floor(counter / 0x100000000), 0);
  buf.writeUInt32BE(counter >>> 0, 4);
  const h = crypto.createHmac('sha1', secretBuf).update(buf).digest();
  const off = h[h.length - 1] & 0x0f;
  const bin = ((h[off] & 0x7f) << 24) | (h[off + 1] << 16) | (h[off + 2] << 8) | h[off + 3];
  return (bin % 1000000).toString().padStart(6, '0');
}

function totpAt(secretB32, timeMs, step = 30) {
  return hotp(base32Decode(secretB32), Math.floor((timeMs / 1000) / step));
}

// Accept the current code plus one step either side (clock skew). Constant-time compare.
function verifyTotp(secretB32, token, timeMs = Date.now(), window = 1) {
  if (!/^\d{6}$/.test(String(token || ''))) return false;
  const secret = base32Decode(secretB32);
  const counter = Math.floor((timeMs / 1000) / 30);
  const given = Buffer.from(String(token));
  for (let w = -window; w <= window; w++) {
    if (crypto.timingSafeEqual(Buffer.from(hotp(secret, counter + w)), given)) return true;
  }
  return false;
}

function otpauthURI(secretB32, label, issuer) {
  const acct = encodeURIComponent(`${issuer}:${label}`);
  const iss = encodeURIComponent(issuer);
  return `otpauth://totp/${acct}?secret=${secretB32}&issuer=${iss}&algorithm=SHA1&digits=6&period=30`;
}

// ---- Recovery codes: single-use, shown once, stored only as sha256 hashes ----
function generateRecoveryCodes(n = 10) {
  const codes = [];
  for (let i = 0; i < n; i++) {
    const raw = crypto.randomBytes(5).toString('hex'); // 10 hex chars
    codes.push(`${raw.slice(0, 5)}-${raw.slice(5)}`);
  }
  return codes;
}

// Normalize (strip spaces/dashes, lowercase) before hashing so display formatting does not matter.
function hashRecoveryCode(code) {
  return crypto.createHash('sha256').update(String(code).replace(/[\s-]/g, '').toLowerCase()).digest('hex');
}

module.exports = {
  base32Encode, base32Decode, generateTotpSecret,
  hotp, totpAt, verifyTotp, otpauthURI,
  generateRecoveryCodes, hashRecoveryCode,
};
