// Auth routes: first-run bootstrap, password login/logout, session check, and
// generic OIDC login. Mounted in server/index.js ahead of the global
// requireAuth gate (see the PUBLIC_PATHS list there) since these are exactly
// the routes an unauthenticated visitor must be able to reach.

const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const auth = require('../auth');
const oidc = require('../oidc');

// In-memory only: the state/codeVerifier pair for an OIDC flow in progress.
// Lives seconds to minutes (redirect to the IdP and back), single Express
// process per farm (see CLAUDE.md architecture notes), so this needs neither
// a DB table nor to survive a restart. Swept lazily on each new flow start.
const OIDC_FLOW_TTL_MS = 10 * 60 * 1000;
const oidcFlows = new Map();

function sweepOidcFlows() {
  const now = Date.now();
  for (const [id, flow] of oidcFlows) {
    if (flow.expiresAt < now) oidcFlows.delete(id);
  }
}

module.exports = (db) => {
  // GET /api/auth/status: tells the client whether to show the bootstrap
  // form or the normal login form, whether to offer the SSO button, and
  // whether to skip the form entirely and redirect straight to the IdP.
  // autoSsoRedirect is gated on oidc.isConfigured() here (not just the raw
  // setting) so an admin who enables it before finishing OIDC setup, or a
  // farm whose OIDC env vars later go missing, can never end up redirecting
  // a visitor into a login flow that 404s instead of falling back to the
  // password form.
  router.get('/status', (req, res) => {
    const userCount = db.prepare('SELECT COUNT(*) AS count FROM users').get().count;
    const autoSsoSetting = db.prepare("SELECT value FROM settings WHERE key = 'auto_sso_redirect'").get();
    res.json({
      needsBootstrap: userCount === 0,
      oidcEnabled: oidc.isConfigured(),
      autoSsoRedirect: autoSsoSetting?.value === '1' && oidc.isConfigured(),
    });
  });

  // POST /api/auth/bootstrap: creates the first user (always role 'admin').
  // Locked out the instant any user exists; this is a one-time setup step,
  // never a general "create account" endpoint.
  router.post('/bootstrap', (req, res) => {
    const userCount = db.prepare('SELECT COUNT(*) AS count FROM users').get().count;
    if (userCount > 0) {
      return res.status(403).json({ error: 'Setup already complete' });
    }
    const { email, name, password } = req.body || {};
    if (!email || !name || !password) {
      return res.status(400).json({ error: 'email, name, and password are required' });
    }
    if (password.length < 8) {
      return res.status(400).json({ error: 'Password must be at least 8 characters' });
    }
    const now = Date.now();
    const result = db.prepare(`
      INSERT INTO users (email, name, password_hash, role, created_at, last_login_at)
      VALUES (?, ?, ?, 'admin', ?, ?)
    `).run(email.trim().toLowerCase(), name.trim(), auth.hashPassword(password), now, now);

    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(result.lastInsertRowid);
    const token = auth.createSession(db, user.id);
    auth.setSessionCookie(req, res, token);
    console.log(`[auth] First admin account created: ${user.email}`);
    res.status(201).json(auth.publicUser(user));
  });

  // POST /api/auth/login
  router.post('/login', (req, res) => {
    const { email, password } = req.body || {};
    if (!email || !password) {
      return res.status(400).json({ error: 'email and password are required' });
    }
    auth.pruneExpiredSessions(db);
    const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email.trim().toLowerCase());
    if (!user || !auth.verifyPassword(password, user.password_hash)) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }
    db.prepare('UPDATE users SET last_login_at = ? WHERE id = ?').run(Date.now(), user.id);
    const token = auth.createSession(db, user.id);
    auth.setSessionCookie(req, res, token);
    res.json(auth.publicUser(user));
  });

  // POST /api/auth/logout
  router.post('/logout', (req, res) => {
    const token = auth.parseCookies(req)[auth.SESSION_COOKIE];
    auth.destroySession(db, token);
    auth.clearSessionCookie(req, res);
    res.json({ ok: true });
  });

  // GET /api/auth/me: this router is mounted ahead of the global auth gate
  // in server/index.js (every other route here must be reachable while
  // logged out), so this is the one route in this file that applies
  // requireAuth itself rather than relying on that gate.
  router.get('/me', auth.requireAuth(db), (req, res) => {
    res.json(req.user);
  });

  // GET /api/auth/oidc/login: redirects to the IdP. 404s cleanly if OIDC
  // isn't configured rather than a confusing mid-flow failure.
  router.get('/oidc/login', async (req, res) => {
    if (!oidc.isConfigured()) {
      return res.status(404).json({ error: 'OIDC is not configured on this server' });
    }
    try {
      sweepOidcFlows();
      const { url, state, codeVerifier } = await oidc.getAuthorizationUrl();
      const flowId = crypto.randomBytes(16).toString('hex');
      oidcFlows.set(flowId, { state, codeVerifier, expiresAt: Date.now() + OIDC_FLOW_TTL_MS });
      const secure = req.protocol === 'https' ? ' Secure;' : '';
      res.setHeader('Set-Cookie', `pfm_oidc_flow=${flowId}; HttpOnly;${secure} SameSite=Lax; Path=/api/auth/oidc; Max-Age=600`);
      res.redirect(url);
    } catch (err) {
      console.error('[auth] OIDC login start failed:', err.message);
      res.status(502).json({ error: 'Could not reach the identity provider' });
    }
  });

  // GET /api/auth/oidc/callback: exchanges the code, resolves or provisions
  // a local user, and starts a normal session (same session mechanism as
  // password login from here on).
  router.get('/oidc/callback', async (req, res) => {
    const flowId = auth.parseCookies(req).pfm_oidc_flow;
    const flow = flowId && oidcFlows.get(flowId);
    if (!flow) {
      return res.status(400).send('OIDC login expired or was not started here. Please try signing in again.');
    }
    oidcFlows.delete(flowId);

    try {
      const fullUrl = `${req.protocol}://${req.get('host')}${req.originalUrl}`;
      const claims = await oidc.handleCallback(fullUrl, flow);
      if (!claims.sub) {
        return res.status(502).send('Identity provider did not return a subject claim.');
      }

      let user = db.prepare('SELECT * FROM users WHERE oidc_subject = ?').get(claims.sub);
      if (!user && claims.email) {
        // Link an existing password account with the same email instead of
        // creating a duplicate: the operator only ever sees one account.
        user = db.prepare('SELECT * FROM users WHERE email = ?').get(claims.email.toLowerCase());
        if (user) {
          db.prepare('UPDATE users SET oidc_subject = ? WHERE id = ?').run(claims.sub, user.id);
        }
      }
      if (!user) {
        // New identity, never seen before: auto-provision at the lowest
        // privilege. An admin must promote the account to grant more access;
        // OIDC login is never allowed to hand out admin by itself.
        const now = Date.now();
        const email = (claims.email || `${claims.sub}@oidc.local`).toLowerCase();
        const result = db.prepare(`
          INSERT INTO users (email, name, role, oidc_subject, created_at, last_login_at)
          VALUES (?, ?, 'operator', ?, ?, ?)
        `).run(email, claims.name || email, claims.sub, now, now);
        user = db.prepare('SELECT * FROM users WHERE id = ?').get(result.lastInsertRowid);
        console.log(`[auth] Provisioned new operator account via OIDC: ${user.email}`);
      } else {
        db.prepare('UPDATE users SET last_login_at = ? WHERE id = ?').run(Date.now(), user.id);
      }

      const token = auth.createSession(db, user.id);
      auth.setSessionCookie(req, res, token);
      res.redirect('/');
    } catch (err) {
      console.error('[auth] OIDC callback failed:', err.message);
      res.status(502).send('Sign-in with your identity provider failed. Please try again.');
    }
  });

  return router;
};
