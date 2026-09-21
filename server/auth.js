// Authentication core: password hashing, session cookies, and API key
// verification. No framework (no express-session, no passport): sessions are
// a random opaque token in an httpOnly cookie, looked up against the sessions
// table on every request, matching this repo's hand-rolled, synchronous,
// better-sqlite3-only conventions.
//
// Two ways a request authenticates, checked in this order by requireAuth:
//   1. Authorization: Bearer <api_key>  : for scripts, OrcaSlicer, automation
//   2. Cookie: pfm_session=<token>      : for the browser client

const crypto = require('crypto');
const bcrypt = require('bcryptjs');

const SESSION_COOKIE = 'pfm_session';
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const BCRYPT_ROUNDS = 12;
const API_KEY_PREFIX = 'pfm_';
const API_KEY_DISPLAY_PREFIX_LEN = 12; // "pfm_" + 8 hex chars, shown in the UI to tell keys apart

// ─── Passwords ──────────────────────────────────────────────────────────────

function hashPassword(password) {
  return bcrypt.hashSync(password, BCRYPT_ROUNDS);
}

function verifyPassword(password, hash) {
  if (!hash) return false; // OIDC-only user has no password_hash
  return bcrypt.compareSync(password, hash);
}

// ─── Sessions ───────────────────────────────────────────────────────────────

function createSession(db, userId) {
  const token = crypto.randomBytes(32).toString('hex');
  const now = Date.now();
  db.prepare('INSERT INTO sessions (token, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)')
    .run(token, userId, now, now + SESSION_TTL_MS);
  return token;
}

function destroySession(db, token) {
  if (!token) return;
  db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
}

// Deletes rows past expiry. Called opportunistically on login/session lookup
// rather than on a timer: this app has no background job runner beyond the
// poller, and sessions are looked up on nearly every request anyway.
function pruneExpiredSessions(db) {
  db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(Date.now());
}

function getUserBySession(db, token) {
  if (!token) return null;
  const row = db.prepare(`
    SELECT u.* FROM sessions s
    JOIN users u ON u.id = s.user_id
    WHERE s.token = ? AND s.expires_at > ?
  `).get(token, Date.now());
  return row || null;
}

// ─── API keys ───────────────────────────────────────────────────────────────

// Returns { plaintext, prefix, hash }: plaintext is shown to the operator
// exactly once (at creation time); only hash is ever persisted.
function generateApiKey() {
  const plaintext = API_KEY_PREFIX + crypto.randomBytes(24).toString('hex');
  return {
    plaintext,
    prefix: plaintext.slice(0, API_KEY_DISPLAY_PREFIX_LEN),
    hash: bcrypt.hashSync(plaintext, BCRYPT_ROUNDS),
  };
}

// API keys act as their owning user (full-access automation keys, not scoped).
// bcrypt has no lookup-by-value, so every non-revoked key sharing this
// plaintext's display prefix is compared in turn: the prefix keeps this list
// short (collisions are unlikely, and impossible without also brute-forcing
// the rest of the key) without ever storing the plaintext key itself.
function getUserByApiKey(db, plaintext) {
  if (!plaintext || !plaintext.startsWith(API_KEY_PREFIX)) return null;
  const prefix = plaintext.slice(0, API_KEY_DISPLAY_PREFIX_LEN);
  const candidates = db.prepare(
    'SELECT * FROM api_keys WHERE key_prefix = ? AND revoked_at IS NULL'
  ).all(prefix);

  for (const key of candidates) {
    if (bcrypt.compareSync(plaintext, key.key_hash)) {
      db.prepare('UPDATE api_keys SET last_used_at = ? WHERE id = ?').run(Date.now(), key.id);
      return db.prepare('SELECT * FROM users WHERE id = ?').get(key.user_id) || null;
    }
  }
  return null;
}

// ─── Cookies ────────────────────────────────────────────────────────────────

// Minimal hand-rolled cookie handling: this app has exactly one cookie, so a
// dependency (cookie-parser) buys nothing but another package to keep patched.
function parseCookies(req) {
  const header = req.headers.cookie;
  if (!header) return {};
  const out = {};
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    const key = part.slice(0, eq).trim();
    const val = part.slice(eq + 1).trim();
    if (key) out[key] = decodeURIComponent(val);
  }
  return out;
}

function setSessionCookie(req, res, token) {
  const secure = req.protocol === 'https' ? ' Secure;' : '';
  res.setHeader('Set-Cookie',
    `${SESSION_COOKIE}=${encodeURIComponent(token)}; HttpOnly;${secure} SameSite=Lax; Path=/; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`
  );
}

function clearSessionCookie(req, res) {
  const secure = req.protocol === 'https' ? ' Secure;' : '';
  res.setHeader('Set-Cookie', `${SESSION_COOKIE}=; HttpOnly;${secure} SameSite=Lax; Path=/; Max-Age=0`);
}

// ─── Middleware ─────────────────────────────────────────────────────────────

function publicUser(user) {
  if (!user) return null;
  const { password_hash, ...rest } = user;
  return rest;
}

// Mounted ahead of every /api route except the public ones listed in
// server/index.js (auth status/bootstrap/login, OIDC start/callback, health).
// Resolves req.user from an API key or a session cookie, in that order, and
// responds 401 if neither resolves to a live user.
function requireAuth(db) {
  return (req, res, next) => {
    const authHeader = req.headers.authorization || '';
    const bearerMatch = authHeader.match(/^Bearer\s+(.+)$/i);
    if (bearerMatch) {
      const user = getUserByApiKey(db, bearerMatch[1].trim());
      if (user) {
        req.user = publicUser(user);
        req.authMethod = 'api_key';
        return next();
      }
      return res.status(401).json({ error: 'Invalid API key' });
    }

    const token = parseCookies(req)[SESSION_COOKIE];
    const user = getUserBySession(db, token);
    if (user) {
      req.user = publicUser(user);
      req.authMethod = 'session';
      return next();
    }
    return res.status(401).json({ error: 'Not authenticated' });
  };
}

function requireRole(role) {
  return (req, res, next) => {
    if (!req.user || req.user.role !== role) {
      return res.status(403).json({ error: `Requires ${role} role` });
    }
    next();
  };
}

module.exports = {
  SESSION_COOKIE,
  hashPassword,
  verifyPassword,
  createSession,
  destroySession,
  pruneExpiredSessions,
  getUserBySession,
  generateApiKey,
  getUserByApiKey,
  parseCookies,
  setSessionCookie,
  clearSessionCookie,
  publicUser,
  requireAuth,
  requireRole,
};
