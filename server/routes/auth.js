const express = require('express');
const router = express.Router();

const {
  hashPassword,
  verifyPassword,
  createSession,
  setSessionCookie,
  clearSessionCookie,
  getSessionToken,
  getValidSession,
  deleteSession,
  deleteAllSessions,
} = require('../auth');

const MIN_PASSWORD_LENGTH = 8;

module.exports = (db) => {
  function getAccount() {
    return db.prepare('SELECT * FROM auth_account WHERE id = 1').get();
  }

  // GET /api/auth/status: tells the client which screen to show: create-account,
  // login, the one-time setup guide, or the app itself. Deliberately not gated by
  // requireAuth: this is what decides whether to ask for a session at all.
  router.get('/status', (req, res) => {
    const account = getAccount();
    const session = getValidSession(db, getSessionToken(req));
    res.json({
      hasAccount: !!account,
      authenticated: !!session,
      onboardingCompleted: !!(account && account.onboarding_completed_at),
      username: session && account ? account.username : undefined,
    });
  });

  // POST /api/auth/register: creates the single operator account. Only allowed once;
  // an existing account must go through /delete-account (password required) before a
  // new one can be created.
  router.post('/register', (req, res) => {
    if (getAccount()) {
      return res.status(409).json({ error: 'An account already exists' });
    }
    const { username, password } = req.body || {};
    if (!username || !String(username).trim()) {
      return res.status(400).json({ error: 'username is required' });
    }
    if (!password || String(password).length < MIN_PASSWORD_LENGTH) {
      return res.status(400).json({ error: `password must be at least ${MIN_PASSWORD_LENGTH} characters` });
    }

    const { hash, salt } = hashPassword(String(password));
    const now = Date.now();
    db.prepare(`
      INSERT INTO auth_account (id, username, password_hash, password_salt, created_at)
      VALUES (1, ?, ?, ?, ?)
    `).run(String(username).trim(), hash, salt, now);

    const token = createSession(db);
    setSessionCookie(res, token);
    res.status(201).json({ ok: true, onboardingCompleted: false });
  });

  // POST /api/auth/login
  router.post('/login', (req, res) => {
    const account = getAccount();
    const { username, password } = req.body || {};
    if (!account || !username || !password) {
      return res.status(401).json({ error: 'Invalid username or password' });
    }
    const usernameMatches = String(username).trim() === account.username;
    const passwordMatches = verifyPassword(String(password), account.password_hash, account.password_salt);
    if (!usernameMatches || !passwordMatches) {
      return res.status(401).json({ error: 'Invalid username or password' });
    }

    const token = createSession(db);
    setSessionCookie(res, token);
    res.json({ ok: true, onboardingCompleted: !!account.onboarding_completed_at });
  });

  // POST /api/auth/logout
  router.post('/logout', (req, res) => {
    deleteSession(db, getSessionToken(req));
    clearSessionCookie(res);
    res.json({ ok: true });
  });

  // POST /api/auth/complete-onboarding: marks the one-time setup guide as done. This
  // is the only non-destructive way it stops reappearing; deleting the account is the
  // only way to bring it back.
  router.post('/complete-onboarding', (req, res) => {
    if (!getValidSession(db, getSessionToken(req))) {
      return res.status(401).json({ error: 'Not authenticated' });
    }
    const account = getAccount();
    if (!account) return res.status(404).json({ error: 'Account not found' });
    db.prepare('UPDATE auth_account SET onboarding_completed_at = ? WHERE id = 1').run(Date.now());
    res.json({ ok: true });
  });

  // POST /api/auth/delete-account: the only way the setup guide reappears. Requires
  // the current password even though the caller already holds a valid session, since
  // this is destructive: it removes the account, invalidates every session (including
  // the caller's), and forces account creation again on next load.
  router.post('/delete-account', (req, res) => {
    if (!getValidSession(db, getSessionToken(req))) {
      return res.status(401).json({ error: 'Not authenticated' });
    }
    const account = getAccount();
    if (!account) return res.status(404).json({ error: 'Account not found' });

    const { password } = req.body || {};
    if (!password || !verifyPassword(String(password), account.password_hash, account.password_salt)) {
      return res.status(401).json({ error: 'Incorrect password' });
    }

    db.prepare('DELETE FROM auth_account WHERE id = 1').run();
    deleteAllSessions(db);
    clearSessionCookie(res);
    res.json({ ok: true });
  });

  return router;
};
