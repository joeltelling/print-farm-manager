const express = require('express');
const crypto = require('crypto');
const {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
} = require('@simplewebauthn/server');
const auth = require('../auth');

// WebAuthn passkeys. Mounted under /api/auth/passkey (before the RBAC guard, so
// login options/verify are reachable without a session). Implemented from the
// @simplewebauthn v13 API. Not yet validated against a physical authenticator.
// See docs/auth.md.

// Short-lived challenge store. In-memory and single-process, so it does not
// survive a restart; an interrupted ceremony is simply restarted.
const challenges = new Map(); // id -> { challenge, userId|null, expires }
const CHAL_TTL_MS = 5 * 60 * 1000;
const CHAL_COOKIE = 'pfm_pk_chal';

function putChallenge(userId, challenge) {
  const id = crypto.randomBytes(16).toString('hex');
  challenges.set(id, { challenge, userId, expires: Date.now() + CHAL_TTL_MS });
  return id;
}
function takeChallenge(id) {
  if (!id) return null;
  const e = challenges.get(id);
  if (!e) return null;
  challenges.delete(id);
  return e.expires < Date.now() ? null : e;
}
function setChalCookie(req, res, id) {
  const isHttps = req.secure || req.headers['x-forwarded-proto'] === 'https';
  const attrs = [`${CHAL_COOKIE}=${id}`, 'HttpOnly', 'SameSite=Lax', 'Path=/', 'Max-Age=300'];
  if (isHttps) attrs.push('Secure');
  res.setHeader('Set-Cookie', attrs.join('; '));
}
function clearChalCookie(res) {
  res.setHeader('Set-Cookie', `${CHAL_COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`);
}

// Relying-party config: explicit settings win, else derive from the request.
// rpID is the bare hostname (no port); origin is the full scheme+host.
function rp(db, req) {
  const host = req.headers['x-forwarded-host'] || req.headers['host'] || 'localhost';
  const hostname = String(host).split(':')[0];
  const proto = req.headers['x-forwarded-proto'] || (req.secure ? 'https' : 'http');
  return {
    rpID: auth.getSetting(db, 'passkey_rp_id') || hostname,
    origin: auth.getSetting(db, 'passkey_origin') || `${proto}://${host}`,
    rpName: auth.getSetting(db, 'farm_name') || 'Print Farm Manager',
  };
}

const toB64 = (u8) => Buffer.from(u8).toString('base64url');
const fromB64 = (s) => new Uint8Array(Buffer.from(s, 'base64url'));

module.exports = (db) => {
  const router = express.Router();

  function currentUser(req) {
    const id = auth.resolveIdentity(db, req);
    if (!id || !id.userId || id.type !== 'session') return null;
    return db.prepare('SELECT * FROM users WHERE id = ?').get(id.userId);
  }

  // Add a passkey to the signed-in account.
  router.post('/register/options', async (req, res) => {
    const user = currentUser(req);
    if (!user) return res.status(401).json({ error: 'Sign in first' });
    const { rpID, rpName } = rp(db, req);
    const existing = db.prepare('SELECT credential_id, transports FROM webauthn_credentials WHERE user_id = ?').all(user.id);
    const options = await generateRegistrationOptions({
      rpName,
      rpID,
      userName: user.username,
      userDisplayName: user.display_name || user.username,
      userID: new Uint8Array(Buffer.from(String(user.id))),
      attestationType: 'none',
      excludeCredentials: existing.map(c => ({ id: c.credential_id, transports: c.transports ? JSON.parse(c.transports) : undefined })),
      authenticatorSelection: { residentKey: 'preferred', userVerification: 'preferred' },
    });
    setChalCookie(req, res, putChallenge(user.id, options.challenge));
    res.json(options);
  });

  router.post('/register/verify', async (req, res) => {
    const user = currentUser(req);
    if (!user) return res.status(401).json({ error: 'Sign in first' });
    const entry = takeChallenge(auth.parseCookies(req.headers['cookie'])[CHAL_COOKIE]);
    clearChalCookie(res);
    if (!entry || entry.userId !== user.id) return res.status(400).json({ error: 'Challenge expired, try again' });
    const { rpID, origin } = rp(db, req);
    let v;
    try {
      v = await verifyRegistrationResponse({
        response: req.body.credential,
        expectedChallenge: entry.challenge,
        expectedOrigin: origin,
        expectedRPID: rpID,
        requireUserVerification: false,
      });
    } catch (e) {
      return res.status(400).json({ error: 'Registration failed: ' + e.message });
    }
    if (!v.verified || !v.registrationInfo) return res.status(400).json({ error: 'Passkey not verified' });
    const cred = v.registrationInfo.credential;
    try {
      db.prepare(`INSERT INTO webauthn_credentials (user_id, credential_id, public_key, counter, transports, name, created_at)
                  VALUES (?, ?, ?, ?, ?, ?, ?)`).run(
        user.id, cred.id, toB64(cred.publicKey), cred.counter || 0,
        cred.transports ? JSON.stringify(cred.transports) : null,
        (req.body.name || 'Passkey').toString().slice(0, 40), Date.now(),
      );
    } catch (e) {
      if (String(e.message).includes('UNIQUE')) return res.status(409).json({ error: 'This passkey is already registered' });
      throw e;
    }
    res.json({ ok: true });
  });

  // Sign in with a passkey (no session required).
  router.post('/login/options', async (req, res) => {
    const { rpID } = rp(db, req);
    const options = await generateAuthenticationOptions({ rpID, userVerification: 'preferred' });
    setChalCookie(req, res, putChallenge(null, options.challenge));
    res.json(options);
  });

  router.post('/login/verify', async (req, res) => {
    const entry = takeChallenge(auth.parseCookies(req.headers['cookie'])[CHAL_COOKIE]);
    clearChalCookie(res);
    if (!entry) return res.status(400).json({ error: 'Challenge expired, try again' });
    const credential = req.body.credential;
    if (!credential || !credential.id) return res.status(400).json({ error: 'No credential' });
    const stored = db.prepare('SELECT * FROM webauthn_credentials WHERE credential_id = ?').get(credential.id);
    if (!stored) return res.status(400).json({ error: 'Unknown passkey' });
    const user = db.prepare('SELECT * FROM users WHERE id = ? AND is_active = 1').get(stored.user_id);
    if (!user) return res.status(401).json({ error: 'Account disabled' });
    const { rpID, origin } = rp(db, req);
    let v;
    try {
      v = await verifyAuthenticationResponse({
        response: credential,
        expectedChallenge: entry.challenge,
        expectedOrigin: origin,
        expectedRPID: rpID,
        credential: {
          id: stored.credential_id,
          publicKey: fromB64(stored.public_key),
          counter: stored.counter,
          transports: stored.transports ? JSON.parse(stored.transports) : undefined,
        },
        requireUserVerification: false,
      });
    } catch (e) {
      return res.status(400).json({ error: 'Authentication failed: ' + e.message });
    }
    if (!v.verified) return res.status(401).json({ error: 'Passkey not verified' });
    db.prepare('UPDATE webauthn_credentials SET counter = ?, last_used_at = ? WHERE id = ?')
      .run(v.authenticationInfo.newCounter, Date.now(), stored.id);
    auth.issueSession(db, req, res, user);
    res.json({ user: { id: user.id, username: user.username, role: user.role } });
  });

  // Manage the signed-in user's passkeys.
  router.get('/', (req, res) => {
    const user = currentUser(req);
    if (!user) return res.status(401).json({ error: 'Sign in first' });
    res.json(db.prepare('SELECT id, name, created_at, last_used_at FROM webauthn_credentials WHERE user_id = ? ORDER BY created_at').all(user.id));
  });

  router.delete('/:id', (req, res) => {
    const user = currentUser(req);
    if (!user) return res.status(401).json({ error: 'Sign in first' });
    const info = db.prepare('DELETE FROM webauthn_credentials WHERE id = ? AND user_id = ?').run(req.params.id, user.id);
    if (info.changes === 0) return res.status(404).json({ error: 'Passkey not found' });
    res.json({ ok: true });
  });

  return router;
};
