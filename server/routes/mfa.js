const express = require('express');
const crypto = require('crypto');
const auth = require('../auth');
const mfa = require('../mfa');

// Multi-factor auth (TOTP authenticator app + recovery codes). Mounted at
// /api/auth/mfa before the RBAC guard. Enrollment endpoints need a session;
// /verify is the second step of a password login and runs with only a
// short-lived pending-login cookie. See docs/auth.md.

const MFA_COOKIE = 'pfm_mfa';
const pendingSetup = new Map(); // userId -> { secret, expires }  (enrollment, pre-verify)
const pendingLogin = new Map(); // id -> { userId, expires }      (between password and code)
const SETUP_TTL = 10 * 60 * 1000;
const LOGIN_TTL = 5 * 60 * 1000;

function reap(m) { const now = Date.now(); for (const [k, v] of m) if (v.expires < now) m.delete(k); }
function setCookie(req, res, id) {
  const isHttps = req.secure || req.headers['x-forwarded-proto'] === 'https';
  const a = [`${MFA_COOKIE}=${id}`, 'HttpOnly', 'SameSite=Lax', 'Path=/', 'Max-Age=300'];
  if (isHttps) a.push('Secure');
  res.setHeader('Set-Cookie', a.join('; '));
}

// Called by the password-login handler (routes/auth.js) when the user has MFA on.
function beginLoginChallenge(req, res, userId) {
  reap(pendingLogin);
  const id = crypto.randomBytes(16).toString('hex');
  pendingLogin.set(id, { userId, expires: Date.now() + LOGIN_TTL });
  setCookie(req, res, id);
}

function replaceRecoveryCodes(db, userId, codes) {
  db.prepare('DELETE FROM recovery_codes WHERE user_id = ?').run(userId);
  const ins = db.prepare('INSERT INTO recovery_codes (user_id, code_hash, used, created_at) VALUES (?, ?, 0, ?)');
  const now = Date.now();
  for (const c of codes) ins.run(userId, mfa.hashRecoveryCode(c), now);
}

module.exports = (db) => {
  const router = express.Router();
  const requireMfa = () => auth.getSetting(db, 'require_mfa') === '1';

  function sessionUser(req) {
    const id = auth.resolveIdentity(db, req);
    if (!id || !id.userId || id.type !== 'session') return null;
    return db.prepare('SELECT * FROM users WHERE id = ?').get(id.userId);
  }

  // Status for the signed-in user.
  router.get('/', (req, res) => {
    const user = sessionUser(req);
    if (!user) return res.status(401).json({ error: 'Sign in first' });
    const remaining = db.prepare('SELECT COUNT(*) AS c FROM recovery_codes WHERE user_id = ? AND used = 0').get(user.id).c;
    res.json({ enabled: !!user.mfa_enabled, required: requireMfa(), recovery_codes_remaining: remaining });
  });

  // Begin enrollment: return a fresh secret + otpauth URI. Nothing persisted yet.
  router.post('/setup', (req, res) => {
    const user = sessionUser(req);
    if (!user) return res.status(401).json({ error: 'Sign in first' });
    reap(pendingSetup);
    const secret = mfa.generateTotpSecret();
    pendingSetup.set(user.id, { secret, expires: Date.now() + SETUP_TTL });
    const issuer = auth.getSetting(db, 'farm_name') || 'Print Farm Manager';
    res.json({ secret, otpauth_uri: mfa.otpauthURI(secret, user.username, issuer) });
  });

  // Confirm enrollment: verify a code against the pending secret, enable, return recovery codes once.
  router.post('/enable', (req, res) => {
    const user = sessionUser(req);
    if (!user) return res.status(401).json({ error: 'Sign in first' });
    const pend = pendingSetup.get(user.id);
    if (!pend || pend.expires < Date.now()) return res.status(400).json({ error: 'Setup expired, start again' });
    if (!mfa.verifyTotp(pend.secret, (req.body || {}).code)) return res.status(400).json({ error: 'Incorrect code' });
    const codes = mfa.generateRecoveryCodes(10);
    db.transaction(() => {
      db.prepare('UPDATE users SET totp_secret = ?, mfa_enabled = 1 WHERE id = ?').run(pend.secret, user.id);
      replaceRecoveryCodes(db, user.id, codes);
    })();
    pendingSetup.delete(user.id);
    res.json({ ok: true, recovery_codes: codes });
  });

  // Turn MFA off (needs a current code). Blocked while require_mfa is on.
  router.post('/disable', (req, res) => {
    const user = sessionUser(req);
    if (!user) return res.status(401).json({ error: 'Sign in first' });
    if (!user.mfa_enabled) return res.json({ ok: true });
    if (requireMfa()) return res.status(409).json({ error: 'MFA is required by policy and cannot be disabled' });
    if (!mfa.verifyTotp(user.totp_secret, (req.body || {}).code)) return res.status(400).json({ error: 'Incorrect code' });
    db.transaction(() => {
      db.prepare('UPDATE users SET totp_secret = NULL, mfa_enabled = 0 WHERE id = ?').run(user.id);
      db.prepare('DELETE FROM recovery_codes WHERE user_id = ?').run(user.id);
    })();
    res.json({ ok: true });
  });

  // New recovery codes (needs a current code), invalidating the old set.
  router.post('/recovery/regenerate', (req, res) => {
    const user = sessionUser(req);
    if (!user) return res.status(401).json({ error: 'Sign in first' });
    if (!user.mfa_enabled) return res.status(400).json({ error: 'MFA is not enabled' });
    if (!mfa.verifyTotp(user.totp_secret, (req.body || {}).code)) return res.status(400).json({ error: 'Incorrect code' });
    const codes = mfa.generateRecoveryCodes(10);
    db.transaction(() => replaceRecoveryCodes(db, user.id, codes))();
    res.json({ ok: true, recovery_codes: codes });
  });

  // Second login step: a TOTP code or a single-use recovery code, then issue the session.
  router.post('/verify', (req, res) => {
    reap(pendingLogin);
    const id = auth.parseCookies(req.headers['cookie'])[MFA_COOKIE];
    const pend = pendingLogin.get(id);
    if (!pend) return res.status(400).json({ error: 'Login expired, sign in again' });
    const user = db.prepare('SELECT * FROM users WHERE id = ? AND is_active = 1').get(pend.userId);
    if (!user) return res.status(401).json({ error: 'Account unavailable' });

    const { code, recovery_code } = req.body || {};
    let ok = false;
    if (recovery_code) {
      const row = db.prepare('SELECT * FROM recovery_codes WHERE user_id = ? AND code_hash = ? AND used = 0')
        .get(user.id, mfa.hashRecoveryCode(recovery_code));
      if (row) { db.prepare('UPDATE recovery_codes SET used = 1 WHERE id = ?').run(row.id); ok = true; }
    } else if (code) {
      ok = mfa.verifyTotp(user.totp_secret, code);
    }
    if (!ok) return res.status(400).json({ error: 'Incorrect code' });

    pendingLogin.delete(id);
    auth.issueSession(db, req, res, user);
    res.json({ user: { id: user.id, username: user.username, role: user.role } });
  });

  return router;
};

// Exposed so the password-login handler can start the MFA step.
module.exports.beginLoginChallenge = beginLoginChallenge;
