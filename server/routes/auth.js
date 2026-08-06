const express = require('express');
const auth = require('../auth');

// Auth endpoints: login, logout, me, and first-run setup. These are always
// reachable (the main middleware exempts /api/auth/*), so each one enforces its
// own rules. See docs/auth.md.
module.exports = (db) => {
  const router = express.Router();

  // Build the Set-Cookie value for the session. Secure is set only when the
  // request arrived over https (directly or via a trusted proxy's
  // X-Forwarded-Proto), so a direct-LAN http install still works.
  function sessionCookie(req, token, maxAgeMs) {
    const isHttps = req.secure || req.headers['x-forwarded-proto'] === 'https';
    const attrs = [
      `${auth.SESSION_COOKIE}=${token}`,
      'HttpOnly',
      'SameSite=Lax',
      'Path=/',
      `Max-Age=${Math.floor(maxAgeMs / 1000)}`,
    ];
    if (isHttps) attrs.push('Secure');
    return attrs.join('; ');
  }

  function clearedCookie() {
    return `${auth.SESSION_COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`;
  }

  function issueSession(req, res, user) {
    const now = Date.now();
    const raw = auth.generateSecret('pfms_');
    db.prepare(
      'INSERT INTO sessions (user_id, token_hash, created_at, expires_at, last_seen_at) VALUES (?, ?, ?, ?, ?)'
    ).run(user.id, auth.hashToken(raw), now, now + auth.SESSION_TTL_MS, now);
    db.prepare('UPDATE users SET last_login_at = ? WHERE id = ?').run(now, user.id);
    res.setHeader('Set-Cookie', sessionCookie(req, raw, auth.SESSION_TTL_MS));
  }

  // GET /api/auth/me: the client calls this on load to decide what to render.
  router.get('/me', (req, res) => {
    const authRequired = auth.authEnabled(db);
    const userCount = db.prepare('SELECT COUNT(*) AS c FROM users').get().c;
    const identity = auth.resolveIdentity(db, req);
    res.json({
      authRequired,
      needsSetup: authRequired && userCount === 0,
      authenticated: !!identity || !authRequired,
      role: identity ? identity.role : (authRequired ? null : 'admin'),
      username: identity ? (identity.username || null) : null,
      type: identity ? identity.type : (authRequired ? 'anonymous' : 'disabled'),
      must_change_password: identity ? !!identity.mustChange : false,
    });
  });

  // POST /api/auth/change-password: the signed-in user sets a new password.
  // Also the exit from a one-time/recovery password (clears must_change_password).
  router.post('/change-password', (req, res) => {
    const identity = auth.resolveIdentity(db, req);
    if (!identity || !identity.userId) return res.status(401).json({ error: 'Not signed in' });
    const { current_password, new_password } = req.body || {};
    if (!new_password || String(new_password).length < 8) {
      return res.status(400).json({ error: 'new_password must be at least 8 characters' });
    }
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(identity.userId);
    if (!user) return res.status(404).json({ error: 'User not found' });
    if (!auth.verifyPassword(current_password || '', user.password_hash, user.password_salt)) {
      return res.status(401).json({ error: 'Current password is incorrect' });
    }
    const { hash, salt } = auth.hashPassword(new_password);
    db.prepare('UPDATE users SET password_hash = ?, password_salt = ?, must_change_password = 0 WHERE id = ?')
      .run(hash, salt, user.id);
    // Invalidate all existing sessions (including this one) and issue a fresh one.
    db.prepare('DELETE FROM sessions WHERE user_id = ?').run(user.id);
    issueSession(req, res, db.prepare('SELECT * FROM users WHERE id = ?').get(user.id));
    res.json({ ok: true });
  });

  // POST /api/auth/login: username + password, sets the session cookie.
  router.post('/login', (req, res) => {
    const { username, password } = req.body || {};
    if (!username || !password) {
      return res.status(400).json({ error: 'username and password are required' });
    }
    const user = db.prepare('SELECT * FROM users WHERE username = ? AND is_active = 1').get(String(username).trim());
    // Same response for unknown user and wrong password (no account enumeration).
    if (!user || !auth.verifyPassword(password, user.password_hash, user.password_salt)) {
      return res.status(401).json({ error: 'Invalid username or password' });
    }
    issueSession(req, res, user);
    res.json({ user: { id: user.id, username: user.username, role: user.role } });
  });

  // POST /api/auth/logout: invalidates the current session.
  router.post('/logout', (req, res) => {
    const cookies = auth.parseCookies(req.headers['cookie']);
    const token = cookies[auth.SESSION_COOKIE];
    if (token) {
      try { db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(auth.hashToken(token)); } catch (_) {}
    }
    res.setHeader('Set-Cookie', clearedCookie());
    res.json({ ok: true });
  });

  // POST /api/auth/setup: creates the first admin. Only works while zero users
  // exist, so it closes itself after bootstrap and cannot be used to hijack an
  // install that already has accounts.
  router.post('/setup', (req, res) => {
    const userCount = db.prepare('SELECT COUNT(*) AS c FROM users').get().c;
    if (userCount > 0) {
      return res.status(409).json({ error: 'Setup already complete: an admin account exists' });
    }
    const { username, password } = req.body || {};
    if (!username || !password) {
      return res.status(400).json({ error: 'username and password are required' });
    }
    if (String(password).length < 8) {
      return res.status(400).json({ error: 'password must be at least 8 characters' });
    }
    const { hash, salt } = auth.hashPassword(password);
    const now = Date.now();
    const info = db.prepare(
      'INSERT INTO users (username, password_hash, password_salt, role, is_active, created_at) VALUES (?, ?, ?, ?, 1, ?)'
    ).run(String(username).trim(), hash, salt, 'admin', now);
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(info.lastInsertRowid);
    issueSession(req, res, user);
    res.status(201).json({ user: { id: user.id, username: user.username, role: user.role } });
  });

  return router;
};
