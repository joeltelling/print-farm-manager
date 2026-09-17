// Minimal local authentication for CoMa.
//
// A single operator account gates entry to the whole app (single farm, single shared
// login, no roles). No new dependency: password hashing uses Node's built-in
// crypto.scrypt, and sessions are random tokens stored in the `auth_sessions` table and
// read back from an HttpOnly cookie. There is no password reset flow: recovery is
// "delete the account" via the documented operator action, which requires the current
// password and starts the account/onboarding flow over.
//
// This is intentionally basic. It stops a stranger on the LAN from opening the app and
// touching the fleet without logging in; it is not a hardened multi-user auth system
// (no CSRF token, no rate limiting, no audit log). See docs/api.md and
// docs/installation.md for the documented scope.

const crypto = require('crypto');

const COOKIE_NAME = 'coma_session';
// Sessions outlive a shift and a weekend so an operator is not re-logging into a shop
// floor kiosk every morning. This is a convenience window for a shared device, not a
// security boundary tied to the scheduler's process lifetime.
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const SCRYPT_KEYLEN = 64;

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, SCRYPT_KEYLEN).toString('hex');
  return { hash, salt };
}

function verifyPassword(password, hash, salt) {
  const candidate = crypto.scryptSync(password, salt, SCRYPT_KEYLEN);
  const stored = Buffer.from(hash, 'hex');
  if (candidate.length !== stored.length) return false;
  return crypto.timingSafeEqual(candidate, stored);
}

function generateToken() {
  return crypto.randomBytes(32).toString('hex');
}

function parseCookies(req) {
  const header = req.headers.cookie;
  const out = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    const key = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    if (key) out[key] = decodeURIComponent(value);
  }
  return out;
}

// No `Secure` attribute: this app is documented as a LAN-only, typically-http install
// (see docs/installation.md). Adding `Secure` would silently break the cookie there.
function setSessionCookie(res, token) {
  const maxAgeSeconds = Math.floor(SESSION_TTL_MS / 1000);
  res.setHeader('Set-Cookie', `${COOKIE_NAME}=${encodeURIComponent(token)}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${maxAgeSeconds}`);
}

function clearSessionCookie(res) {
  res.setHeader('Set-Cookie', `${COOKIE_NAME}=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0`);
}

function getSessionToken(req) {
  return parseCookies(req)[COOKIE_NAME] || null;
}

// Creates a session row and returns the token. Callers set the cookie separately.
function createSession(db) {
  const token = generateToken();
  const now = Date.now();
  db.prepare('INSERT INTO auth_sessions (token, created_at, expires_at) VALUES (?, ?, ?)')
    .run(token, now, now + SESSION_TTL_MS);
  return token;
}

// Looks up a session by token; returns the row if valid, else null. Expired sessions
// are deleted lazily on lookup (the row count is always tiny: one per login) rather
// than through a background sweep, since this app has no cron-style job runner.
function getValidSession(db, token) {
  if (!token) return null;
  const row = db.prepare('SELECT * FROM auth_sessions WHERE token = ?').get(token);
  if (!row) return null;
  if (row.expires_at < Date.now()) {
    db.prepare('DELETE FROM auth_sessions WHERE token = ?').run(token);
    return null;
  }
  return row;
}

function deleteSession(db, token) {
  if (!token) return;
  db.prepare('DELETE FROM auth_sessions WHERE token = ?').run(token);
}

function deleteAllSessions(db) {
  db.prepare('DELETE FROM auth_sessions').run();
}

// Express middleware: 401s any request without a valid session cookie.
function requireAuth(db) {
  return (req, res, next) => {
    const session = getValidSession(db, getSessionToken(req));
    if (!session) return res.status(401).json({ error: 'Not authenticated' });
    next();
  };
}

module.exports = {
  COOKIE_NAME,
  SESSION_TTL_MS,
  hashPassword,
  verifyPassword,
  generateToken,
  parseCookies,
  setSessionCookie,
  clearSessionCookie,
  getSessionToken,
  createSession,
  getValidSession,
  deleteSession,
  deleteAllSessions,
  requireAuth,
};
