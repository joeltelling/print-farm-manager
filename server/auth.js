// Authentication, API tokens, and role-based access control.
//
// Dependency-free by design (matches this project's minimalism): password and
// token hashing use Node's built-in crypto, storage is the existing SQLite db.
// See docs/auth.md for the full spec.
//
// The whole system is gated by the 'auth_enabled' setting. When it is not '1'
// the middleware is a pass-through and the app behaves exactly as it always
// has: no login, every request allowed. This keeps existing installs working
// unchanged after a git pull.

const crypto = require('crypto');

// ---------------------------------------------------------------------------
// Password hashing (scrypt) and token hashing (sha256)
// ---------------------------------------------------------------------------

function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.scryptSync(String(password), salt, 64).toString('hex');
  return { hash, salt };
}

// Constant-time comparison so a wrong password can't be timed. timingSafeEqual
// requires equal-length buffers, so hash the candidate with the stored salt
// first and compare the two fixed-length digests.
function verifyPassword(password, storedHash, salt) {
  const candidate = crypto.scryptSync(String(password), salt, 64).toString('hex');
  const a = Buffer.from(candidate, 'hex');
  const b = Buffer.from(storedHash, 'hex');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

// Opaque secrets shown to the caller once. The 'pfm_' prefix makes them easy to
// spot (and to scan for in leaked configs); only the sha256 hash is ever stored.
function generateSecret(prefix = 'pfm_') {
  return prefix + crypto.randomBytes(30).toString('hex');
}

function hashToken(raw) {
  return crypto.createHash('sha256').update(String(raw)).digest('hex');
}

// ---------------------------------------------------------------------------
// Roles
// ---------------------------------------------------------------------------

const ROLE_RANK = { viewer: 1, operator: 2, admin: 3 };
// viewer/operator/admin form a hierarchy; device and display are special
// token-only roles with fixed allowlists (see deviceAllowed / displayAllowed).
const ROLES = ['viewer', 'operator', 'admin', 'device', 'display'];

function roleAtLeast(role, minRole) {
  return (ROLE_RANK[role] || 0) >= (ROLE_RANK[minRole] || 99);
}

// The minimum hierarchy role required for a (method, path). 'device' tokens are
// handled separately (see deviceAllowed) and never flow through here.
function requiredRoleFor(method, path) {
  const isGet = method === 'GET';

  // Admin-only areas (config, accounts, tokens, full backup/restore)
  if (/^\/api\/(users|tokens|backup)(\/|$)/.test(path)) return 'admin';

  // Config the UI must read (models/groups/filaments/settings) but only admins change
  if (/^\/api\/(settings|models|groups|filaments)(\/|$)/.test(path)) {
    return isGet ? 'viewer' : 'admin';
  }

  // Printers: reads are viewer; per-printer operator actions are operator;
  // creating/editing/deleting/importing printers is admin (that is config).
  if (/^\/api\/printers(\/|$)/.test(path)) {
    if (isGet) return 'viewer';
    if (path === '/api/printers/set-ready-batch') return 'operator';
    if (/\/(set-ready|recommission|mark-job-failure|decommission|complete-and-decommission|link-job|events)$/.test(path)) {
      return 'operator';
    }
    return 'admin';
  }

  // Everything else: read = viewer, write = operator (projects, parts, gcodes,
  // jobs, scheduler dispatch, notifications).
  return isGet ? 'viewer' : 'operator';
}

// The fixed endpoint allowlist for 'device' tokens (the CYD wall box). A leaked
// device token can do nothing but read printer/dashboard state and confirm or
// fail plates. Kept deliberately tiny.
function deviceAllowed(method, path) {
  if (method === 'GET' && /^\/api\/printers(\/\d+)?$/.test(path)) return true;
  if (method === 'GET' && path === '/api/dashboard') return true;
  if (method === 'POST' && /^\/api\/printers\/\d+\/set-ready$/.test(path)) return true;
  if (method === 'POST' && /^\/api\/printers\/\d+\/mark-job-failure$/.test(path)) return true;
  return false;
}

// A device token may be bound to specific printers (the ones next to that CYD).
// An empty/absent binding means all printers. Only per-printer paths are constrained.
function deviceCanTarget(printerIds, path) {
  if (!printerIds || printerIds.length === 0) return true;
  const m = path.match(/^\/api\/printers\/(\d+)(?:\/|$)/);
  if (!m) return true; // list/dashboard endpoints are not printer-specific
  return printerIds.includes(Number(m[1]));
}

// The fixed allowlist for 'display' tokens: a read-only dashboard viewport (an
// Apple TV or Android app adopted as a device, not a user, like a UniFi
// Protect Viewport). Dashboard plus printer status, nothing else.
function displayAllowed(method, path) {
  if (method !== 'GET') return false;
  if (path === '/api/dashboard') return true;
  if (/^\/api\/printers(\/\d+)?$/.test(path)) return true;
  return false;
}

// Endpoints reachable via the dashboard IP allowlist (no login). Exactly what
// the read-only dashboard page loads, nothing else.
function dashboardEndpoint(method, path) {
  return method === 'GET' && path === '/api/dashboard';
}

// ---------------------------------------------------------------------------
// IP allowlist matching (IPv4 + CIDR, plus exact IPv6). Dependency-free.
// ---------------------------------------------------------------------------

function normalizeIp(ip) {
  if (!ip) return '';
  // Express/Node give IPv4-mapped IPv6 for IPv4 clients behind some stacks.
  return ip.replace(/^::ffff:/, '').trim();
}

function ipv4ToInt(ip) {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let n = 0;
  for (const p of parts) {
    const o = Number(p);
    if (!Number.isInteger(o) || o < 0 || o > 255) return null;
    n = (n << 8) | o;
  }
  return n >>> 0;
}

function ipMatches(ip, entry) {
  const addr = normalizeIp(ip);
  const rule = entry.trim();
  if (!rule) return false;
  if (rule.includes('/')) {
    const [net, bitsRaw] = rule.split('/');
    const bits = Number(bitsRaw);
    const a = ipv4ToInt(addr);
    const n = ipv4ToInt(net);
    if (a === null || n === null || !Number.isInteger(bits) || bits < 0 || bits > 32) return false;
    if (bits === 0) return true;
    const mask = (0xffffffff << (32 - bits)) >>> 0;
    return (a & mask) === (n & mask);
  }
  // Exact match (covers IPv4 and IPv6 literals)
  return addr === normalizeIp(rule);
}

// Parse a comma/space separated allowlist string into entries.
function parseList(str) {
  return String(str || '')
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function ipInList(ip, listStr) {
  const entries = parseList(listStr);
  return entries.some((e) => ipMatches(ip, e));
}

// ---------------------------------------------------------------------------
// Cookie parsing (no cookie-parser dependency)
// ---------------------------------------------------------------------------

function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    const k = part.slice(0, idx).trim();
    const v = part.slice(idx + 1).trim();
    if (k) out[k] = decodeURIComponent(v);
  }
  return out;
}

const SESSION_COOKIE = 'pfm_session';
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

// ---------------------------------------------------------------------------
// Settings helpers
// ---------------------------------------------------------------------------

function getSetting(db, key) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : null;
}

// Authentication is mandatory in this build: always on, no off switch. A fresh
// or migrated install with no users is stepped through creating the primary
// admin (the setup flow). The auth_enabled setting is retained for backward
// compatibility but no longer gates anything.
function authEnabled(_db) {
  return true;
}

// The immediate TCP peer (the box directly connected to us). For SSO header
// trust we check THIS, not req.ip: the forward-auth header is injected by the
// proxy directly in front, so only that peer may be believed.
function immediatePeer(req) {
  return normalizeIp((req.socket && req.socket.remoteAddress) || (req.connection && req.connection.remoteAddress) || '');
}

function isFromTrustedProxy(db, req) {
  const list = getSetting(db, 'trusted_proxies');
  if (!list || !list.trim()) return false;
  return ipInList(immediatePeer(req), list);
}

// Map a groups-header value to a role via sso_group_role_map (JSON object of
// group -> role), taking the highest matching role; falls back to sso_default_role.
function roleFromGroups(db, groupsHeaderVal) {
  let map = {};
  try { const raw = getSetting(db, 'sso_group_role_map'); map = raw ? JSON.parse(raw) : {}; } catch (_) { map = {}; }
  const groups = parseList(groupsHeaderVal).map((g) => g.toLowerCase());
  let best = null;
  for (const [group, role] of Object.entries(map)) {
    if (groups.includes(String(group).toLowerCase()) && ROLE_RANK[role]) {
      if (!best || ROLE_RANK[role] > ROLE_RANK[best]) best = role;
    }
  }
  return best || getSetting(db, 'sso_default_role') || 'viewer';
}

// Look up or auto-provision the user behind a trusted SSO header. Returns the
// user row or null. Never hijacks an existing local (password) account of the
// same username: linking those must be done deliberately by an admin.
function provisionSsoUser(db, req, subject) {
  const provider = 'header';
  const groupsHeader = getSetting(db, 'sso_header_groups');
  const role = roleFromGroups(db, groupsHeader ? req.headers[groupsHeader.toLowerCase()] : '');

  const existing = db.prepare('SELECT * FROM users WHERE sso_provider = ? AND sso_subject = ?').get(provider, subject);
  if (existing) {
    if (!existing.is_active) return null;
    if (existing.role !== role) {
      try { db.prepare('UPDATE users SET role = ? WHERE id = ?').run(role, existing.id); existing.role = role; } catch (_) {}
    }
    return existing;
  }

  const localClash = db.prepare('SELECT 1 FROM users WHERE username = ?').get(subject);
  if (localClash) return null; // do not silently take over an existing local account

  const emailHeader = getSetting(db, 'sso_header_email');
  const nameHeader = getSetting(db, 'sso_header_name');
  const email = emailHeader ? (req.headers[emailHeader.toLowerCase()] || null) : null;
  const name = nameHeader ? (req.headers[nameHeader.toLowerCase()] || null) : null;
  // SSO accounts have no usable password; store a random unusable hash.
  const { hash, salt } = hashPassword(generateSecret('nologin_'));
  try {
    const info = db.prepare(
      `INSERT INTO users (username, password_hash, password_salt, role, is_active, created_at, email, display_name, sso_subject, sso_provider)
       VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?, ?)`
    ).run(subject, hash, salt, role, Date.now(), email, name, subject, provider);
    return db.prepare('SELECT * FROM users WHERE id = ?').get(info.lastInsertRowid);
  } catch (_) {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Identity resolution
// ---------------------------------------------------------------------------

// Resolve the caller's identity from an API token or a session cookie. Returns
// { type, role, userId?, tokenId?, username? } or null. Never throws.
function resolveIdentity(db, req) {
  // 1. Bearer token / X-API-Key
  const authHeader = req.headers['authorization'] || '';
  const bearer = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : null;
  const rawToken = bearer || req.headers['x-api-key'] || null;
  if (rawToken) {
    const row = db.prepare(
      'SELECT * FROM api_tokens WHERE token_hash = ? AND revoked = 0'
    ).get(hashToken(rawToken));
    if (row) {
      // Throttle last_used writes to at most once a minute to avoid a write per request.
      const now = Date.now();
      if (!row.last_used_at || now - row.last_used_at > 60000) {
        try { db.prepare('UPDATE api_tokens SET last_used_at = ? WHERE id = ?').run(now, row.id); } catch (_) {}
      }
      let printerIds = null;
      if (row.printer_ids) {
        try { const a = JSON.parse(row.printer_ids); if (Array.isArray(a)) printerIds = a.map(Number).filter(Number.isFinite); } catch (_) {}
      }
      return { type: 'token', role: row.role, tokenId: row.id, name: row.name, printerIds };
    }
    // A token was presented but did not match: fall through to unauthenticated.
    return null;
  }

  // 2. Session cookie
  const cookies = parseCookies(req.headers['cookie']);
  const sessionToken = cookies[SESSION_COOKIE];
  if (sessionToken) {
    const row = db.prepare('SELECT * FROM sessions WHERE token_hash = ?').get(hashToken(sessionToken));
    if (row) {
      const now = Date.now();
      if (row.expires_at < now) {
        try { db.prepare('DELETE FROM sessions WHERE id = ?').run(row.id); } catch (_) {}
        return null;
      }
      const user = db.prepare('SELECT * FROM users WHERE id = ? AND is_active = 1').get(row.user_id);
      if (!user) return null;
      try { db.prepare('UPDATE sessions SET last_seen_at = ? WHERE id = ?').run(now, row.id); } catch (_) {}
      return {
        type: 'session', role: user.role, userId: user.id, username: user.username,
        mustChange: !!user.must_change_password,
        mfaEnabled: !!user.mfa_enabled,
      };
    }
  }

  // 3. SSO forward-auth header, believed only when the immediate peer is a
  // trusted proxy (so a client cannot spoof the header). The proxy must be
  // configured to overwrite, not pass through, client-supplied identity headers.
  if (getSetting(db, 'sso_header_enabled') === '1' && isFromTrustedProxy(db, req)) {
    const userHeaderName = getSetting(db, 'sso_header_user') || 'Remote-User';
    const subject = req.headers[userHeaderName.toLowerCase()];
    if (subject) {
      const user = provisionSsoUser(db, req, String(subject));
      if (user) return { type: 'sso', role: user.role, userId: user.id, username: user.username };
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// The middleware
// ---------------------------------------------------------------------------

// Paths always reachable regardless of auth: health and the auth endpoints that
// bootstrap a session. /api/auth/me and /logout run too (they read identity).
function isAlwaysOpen(path) {
  return path === '/api/health' || /^\/api\/auth(\/|$)/.test(path);
}

function createAuthMiddleware(db) {
  return function authMiddleware(req, res, next) {
    // Only guard the API. Static assets and the SPA shell are always served;
    // the client itself gates what it shows based on GET /api/auth/me.
    if (!req.path.startsWith('/api/')) return next();

    // Master switch off -> behave exactly as before (full access).
    if (!authEnabled(db)) {
      req.auth = { type: 'disabled', role: 'admin', authenticated: true };
      return next();
    }

    if (isAlwaysOpen(req.path)) {
      req.auth = resolveIdentity(db, req) || { type: 'anonymous', role: null, authenticated: false };
      return next();
    }

    const identity = resolveIdentity(db, req);

    if (identity) {
      req.auth = { ...identity, authenticated: true };
      // A user on a one-time/recovery password may reach nothing but the auth
      // endpoints (mounted before this guard) until they change it.
      if (identity.mustChange) {
        return res.status(403).json({ error: 'Password change required', code: 'MUST_CHANGE_PASSWORD' });
      }
      // Global MFA policy: a session user without MFA must enrol before proceeding.
      // The auth endpoints (mounted before this guard) stay reachable so they can.
      if (identity.type === 'session' && getSetting(db, 'require_mfa') === '1' && !identity.mfaEnabled) {
        return res.status(403).json({ error: 'MFA setup required', code: 'MFA_SETUP_REQUIRED' });
      }
      // Device tokens: fixed allowlist plus optional per-printer binding.
      if (identity.role === 'device') {
        if (deviceAllowed(req.method, req.path) && deviceCanTarget(identity.printerIds, req.path)) return next();
        return res.status(403).json({ error: 'This device token is not permitted to use this endpoint' });
      }
      // Display tokens: read-only dashboard viewport, nothing else.
      if (identity.role === 'display') {
        if (displayAllowed(req.method, req.path)) return next();
        return res.status(403).json({ error: 'This display token is limited to the dashboard' });
      }
      const minRole = requiredRoleFor(req.method, req.path);
      if (!roleAtLeast(identity.role, minRole)) {
        return res.status(403).json({ error: `Requires ${minRole} role` });
      }
      return next();
    }

    // No identity. Allow the read-only dashboard from an allowlisted IP.
    if (dashboardEndpoint(req.method, req.path)) {
      const allow = getSetting(db, 'dashboard_ip_allowlist');
      if (allow && ipInList(req.ip, allow)) {
        req.auth = { type: 'dashboard-ip', role: 'viewer', authenticated: true, dashboardOnly: true };
        return next();
      }
    }

    return res.status(401).json({ error: 'Authentication required' });
  };
}

// Express 'trust proxy' value derived from the trusted_proxies setting. When set
// (e.g. the Traefik IP), req.ip reflects X-Forwarded-For; when empty, the raw
// socket IP is used so a direct-LAN install cannot be spoofed via XFF.
function trustProxyValue(db) {
  const list = parseList(getSetting(db, 'trusted_proxies'));
  return list.length ? list : false;
}

// Create a session for `user` and set the session cookie on `res`. Shared by
// password login/setup/change-password (routes/auth.js) and passkey login
// (routes/webauthn.js). Secure is set only over https so a direct-LAN http
// install still works.
function issueSession(db, req, res, user) {
  const now = Date.now();
  const raw = generateSecret('pfms_');
  db.prepare('INSERT INTO sessions (user_id, token_hash, created_at, expires_at, last_seen_at) VALUES (?, ?, ?, ?, ?)')
    .run(user.id, hashToken(raw), now, now + SESSION_TTL_MS, now);
  db.prepare('UPDATE users SET last_login_at = ? WHERE id = ?').run(now, user.id);
  const isHttps = req.secure || req.headers['x-forwarded-proto'] === 'https';
  const attrs = [`${SESSION_COOKIE}=${raw}`, 'HttpOnly', 'SameSite=Lax', 'Path=/', `Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`];
  if (isHttps) attrs.push('Secure');
  res.setHeader('Set-Cookie', attrs.join('; '));
}

module.exports = {
  hashPassword,
  verifyPassword,
  generateSecret,
  hashToken,
  issueSession,
  ROLE_RANK,
  ROLES,
  roleAtLeast,
  requiredRoleFor,
  deviceAllowed,
  deviceCanTarget,
  displayAllowed,
  dashboardEndpoint,
  normalizeIp,
  ipMatches,
  ipInList,
  parseList,
  parseCookies,
  resolveIdentity,
  createAuthMiddleware,
  trustProxyValue,
  authEnabled,
  getSetting,
  SESSION_COOKIE,
  SESSION_TTL_MS,
};
