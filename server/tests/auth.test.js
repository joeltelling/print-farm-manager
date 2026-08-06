const express = require('express');
const request = require('supertest');
const Database = require('better-sqlite3');
const auth = require('../auth');

// Minimal in-memory schema (auth tables + settings) plus the seeded settings the
// middleware and routes read. Mirrors the additive schema in db.js.
function freshDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE users (
      id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL, password_salt TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'viewer', is_active INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL, last_login_at INTEGER,
      email TEXT, display_name TEXT, sso_subject TEXT, sso_provider TEXT,
      must_change_password INTEGER NOT NULL DEFAULT 0,
      totp_secret TEXT, mfa_enabled INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE recovery_codes (
      id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL,
      code_hash TEXT NOT NULL, used INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL
    );
    CREATE TABLE api_tokens (
      id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE,
      token_prefix TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'device', printer_ids TEXT,
      created_at INTEGER NOT NULL, last_used_at INTEGER, revoked INTEGER NOT NULL DEFAULT 0, created_by INTEGER
    );
    CREATE TABLE sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, token_hash TEXT NOT NULL UNIQUE,
      created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, last_seen_at INTEGER NOT NULL
    );
    CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE webauthn_credentials (
      id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, credential_id TEXT NOT NULL UNIQUE,
      public_key TEXT NOT NULL, counter INTEGER NOT NULL DEFAULT 0, transports TEXT, name TEXT,
      created_at INTEGER NOT NULL, last_used_at INTEGER
    );
  `);
  const seed = db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)');
  const defaults = {
    auth_enabled: '0', dashboard_ip_allowlist: '', trusted_proxies: '',
    sso_header_enabled: '0', sso_header_user: 'Remote-User', sso_header_email: 'Remote-Email',
    sso_header_name: 'Remote-Name', sso_header_groups: 'Remote-Groups', sso_group_role_map: '',
    sso_default_role: 'viewer',
  };
  for (const [k, v] of Object.entries(defaults)) seed.run(k, v);
  return db;
}

// Build a fresh app that reads current settings (trust proxy is static per app,
// so tests that change trusted_proxies rebuild via makeApp()).
function makeApp(db) {
  const app = express();
  app.use(express.json());
  app.set('trust proxy', auth.trustProxyValue(db));
  app.use('/api/auth/passkey', require('../routes/webauthn')(db));
  app.use('/api/auth/mfa', require('../routes/mfa')(db));
  app.use('/api/auth', require('../routes/auth')(db));
  app.use(auth.createAuthMiddleware(db));
  app.use('/api/users', require('../routes/users')(db));
  app.use('/api/tokens', require('../routes/tokens')(db));
  app.use('/api/settings', require('../routes/settings')(db));
  // Stubs standing in for real resource routes, to exercise the policy middleware.
  app.get('/api/printers', (_req, res) => res.json([]));
  app.post('/api/printers', (_req, res) => res.status(201).json({ ok: true }));
  app.post('/api/printers/:id/set-ready', (_req, res) => res.json({ ok: true }));
  app.post('/api/printers/:id/recommission', (_req, res) => res.json({ ok: true }));
  app.get('/api/dashboard', (_req, res) => res.json({ stats: {} }));
  app.get('/api/health', (_req, res) => res.json({ status: 'ok' }));
  return app;
}

function setSetting(db, k, v) { db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(k, v); }
function cookie(res) { return (res.headers['set-cookie'] || [])[0].split(';')[0]; }

// Create an admin via setup and enable auth. Returns the session cookie.
async function bootstrapAdmin(app, db) {
  const res = await request(app).post('/api/auth/setup').send({ username: 'admin', password: 'supersecret1' });
  expect(res.status).toBe(201);
  setSetting(db, 'auth_enabled', '1');
  return cookie(res);
}

describe('auth is mandatory (always on)', () => {
  test('a fresh install requires setup, and unauthenticated requests are blocked', async () => {
    const db = freshDb();
    const app = makeApp(db);
    const me = await request(app).get('/api/auth/me');
    expect(me.body).toMatchObject({ authRequired: true, needsSetup: true, authenticated: false });
    expect((await request(app).get('/api/printers')).status).toBe(401);
  });
});

describe('setup + login + session', () => {
  test('setup creates the first admin and sets a cookie; second setup is blocked', async () => {
    const db = freshDb();
    const app = makeApp(db);
    const res = await request(app).post('/api/auth/setup').send({ username: 'admin', password: 'supersecret1' });
    expect(res.status).toBe(201);
    expect(res.headers['set-cookie'][0]).toMatch(/pfm_session=/);
    expect(db.prepare('SELECT role FROM users WHERE username = ?').get('admin').role).toBe('admin');
    const again = await request(app).post('/api/auth/setup').send({ username: 'x', password: 'supersecret1' });
    expect(again.status).toBe(409);
  });

  test('login rejects bad credentials and accepts good ones', async () => {
    const db = freshDb();
    const app = makeApp(db);
    await bootstrapAdmin(app, db);
    expect((await request(app).post('/api/auth/login').send({ username: 'admin', password: 'wrong' })).status).toBe(401);
    const ok = await request(app).post('/api/auth/login').send({ username: 'admin', password: 'supersecret1' });
    expect(ok.status).toBe(200);
    expect(ok.body.user.role).toBe('admin');
  });

  test('me reports identity; logout ends the session', async () => {
    const db = freshDb();
    const app = makeApp(db);
    const c = await bootstrapAdmin(app, db);
    const me = await request(app).get('/api/auth/me').set('Cookie', c);
    expect(me.body).toMatchObject({ authRequired: true, authenticated: true, role: 'admin' });
    await request(app).post('/api/auth/logout').set('Cookie', c);
    const after = await request(app).get('/api/printers').set('Cookie', c);
    expect(after.status).toBe(401);
  });
});

describe('RBAC enforcement', () => {
  async function makeUser(db, app, adminCookie, role) {
    await request(app).post('/api/users').set('Cookie', adminCookie)
      .send({ username: role + 'u', password: 'supersecret1', role });
    const res = await request(app).post('/api/auth/login').send({ username: role + 'u', password: 'supersecret1' });
    return cookie(res);
  }

  test('viewer reads but cannot write; operator writes actions but not config; admin does all', async () => {
    const db = freshDb();
    const app = makeApp(db);
    const admin = await bootstrapAdmin(app, db);
    const viewer = await makeUser(db, app, admin, 'viewer');
    const operator = await makeUser(db, app, admin, 'operator');

    // viewer
    expect((await request(app).get('/api/printers').set('Cookie', viewer)).status).toBe(200);
    expect((await request(app).post('/api/printers/1/set-ready').set('Cookie', viewer)).status).toBe(403);

    // operator: operator action allowed, printer config (create) denied
    expect((await request(app).post('/api/printers/1/set-ready').set('Cookie', operator)).status).toBe(200);
    expect((await request(app).post('/api/printers').set('Cookie', operator).send({})).status).toBe(403);
    // operator can read settings but NOT the sensitive auth keys
    const opSettings = await request(app).get('/api/settings').set('Cookie', operator);
    expect(opSettings.status).toBe(200);
    expect(opSettings.body).not.toHaveProperty('trusted_proxies');
    expect(opSettings.body).not.toHaveProperty('auth_enabled');
    // ...and cannot change settings, or list users/tokens
    expect((await request(app).put('/api/settings/farm_name').set('Cookie', operator).send({ value: 'x' })).status).toBe(403);
    expect((await request(app).get('/api/users').set('Cookie', operator)).status).toBe(403);

    // admin: everything, including the sensitive settings
    expect((await request(app).post('/api/printers').set('Cookie', admin).send({})).status).toBe(201);
    const adminSettings = await request(app).get('/api/settings').set('Cookie', admin);
    expect(adminSettings.status).toBe(200);
    expect(adminSettings.body).toHaveProperty('trusted_proxies');
    expect((await request(app).get('/api/users').set('Cookie', admin)).status).toBe(200);
    // authentication cannot be turned off: auth_enabled is not a writable setting
    expect((await request(app).put('/api/settings/auth_enabled').set('Cookie', admin).send({ value: '0' })).status).toBe(400);
  });

  test('unauthenticated request is 401 when auth is on', async () => {
    const db = freshDb();
    const app = makeApp(db);
    await bootstrapAdmin(app, db);
    expect((await request(app).get('/api/printers')).status).toBe(401);
    expect((await request(app).get('/api/health')).status).toBe(200); // health always open
  });
});

describe('API tokens and the device allowlist', () => {
  test('device token can set-ready but not create printers or read settings', async () => {
    const db = freshDb();
    const app = makeApp(db);
    const admin = await bootstrapAdmin(app, db);
    const created = await request(app).post('/api/tokens').set('Cookie', admin)
      .send({ name: 'CYD-bench-1', role: 'device' });
    expect(created.status).toBe(201);
    const token = created.body.token;
    expect(token).toMatch(/^pfm_/);
    // listing never leaks the secret
    const list = await request(app).get('/api/tokens').set('Cookie', admin);
    expect(JSON.stringify(list.body)).not.toContain(token);

    const bearer = { Authorization: `Bearer ${token}` };
    expect((await request(app).post('/api/printers/2/set-ready').set(bearer)).status).toBe(200);
    expect((await request(app).get('/api/printers').set(bearer)).status).toBe(200);
    expect((await request(app).post('/api/printers').set(bearer).send({})).status).toBe(403);
    expect((await request(app).get('/api/settings').set(bearer)).status).toBe(403);
  });

  test('an operator token behaves as operator', async () => {
    const db = freshDb();
    const app = makeApp(db);
    const admin = await bootstrapAdmin(app, db);
    const created = await request(app).post('/api/tokens').set('Cookie', admin).send({ name: 't', role: 'operator' });
    const bearer = { Authorization: `Bearer ${created.body.token}` };
    expect((await request(app).post('/api/printers/1/recommission').set(bearer)).status).toBe(200);
    expect((await request(app).post('/api/printers').set(bearer).send({})).status).toBe(403);
  });

  test('a device token bound to specific printers can only act on those printers', async () => {
    const db = freshDb();
    const app = makeApp(db);
    const admin = await bootstrapAdmin(app, db);
    const created = await request(app).post('/api/tokens').set('Cookie', admin)
      .send({ name: 'CYD-rack-A', role: 'device', printer_ids: [2, 3] });
    expect(created.status).toBe(201);
    expect(created.body.printer_ids).toEqual([2, 3]);
    const bearer = { Authorization: `Bearer ${created.body.token}` };
    expect((await request(app).post('/api/printers/2/set-ready').set(bearer)).status).toBe(200); // in scope
    expect((await request(app).post('/api/printers/9/set-ready').set(bearer)).status).toBe(403); // out of scope
  });

  test('a display token is a read-only dashboard viewport, nothing else', async () => {
    const db = freshDb();
    const app = makeApp(db);
    const admin = await bootstrapAdmin(app, db);
    const created = await request(app).post('/api/tokens').set('Cookie', admin)
      .send({ name: 'Lounge AppleTV', role: 'display' });
    expect(created.status).toBe(201);
    const bearer = { Authorization: `Bearer ${created.body.token}` };
    expect((await request(app).get('/api/dashboard').set(bearer)).status).toBe(200);
    expect((await request(app).get('/api/printers').set(bearer)).status).toBe(200);
    expect((await request(app).post('/api/printers/1/set-ready').set(bearer)).status).toBe(403);
    expect((await request(app).get('/api/settings').set(bearer)).status).toBe(403);
  });
});

describe('dashboard IP allowlist (behind a trusted proxy)', () => {
  test('allowlisted forwarded IP reaches the dashboard with no login; others do not', async () => {
    const db = freshDb();
    await bootstrapAdminNoApp(db);
    setSetting(db, 'trusted_proxies', '127.0.0.1');
    setSetting(db, 'dashboard_ip_allowlist', '192.168.50.10');
    const app = makeApp(db); // rebuild so trust proxy picks up 127.0.0.1

    const allowed = await request(app).get('/api/dashboard').set('X-Forwarded-For', '192.168.50.10');
    expect(allowed.status).toBe(200);
    const denied = await request(app).get('/api/dashboard').set('X-Forwarded-For', '10.0.0.99');
    expect(denied.status).toBe(401);
    // the allowlist is dashboard-only: it does not open other endpoints
    const other = await request(app).get('/api/printers').set('X-Forwarded-For', '192.168.50.10');
    expect(other.status).toBe(401);
  });
});

describe('SSO forward-auth header', () => {
  test('trusted-proxy Remote-User provisions a user and authenticates; spoof from untrusted peer is ignored', async () => {
    const db = freshDb();
    await bootstrapAdminNoApp(db);
    setSetting(db, 'trusted_proxies', '127.0.0.1');
    setSetting(db, 'sso_header_enabled', '1');
    setSetting(db, 'sso_group_role_map', JSON.stringify({ printadmins: 'admin' }));
    const app = makeApp(db);

    // supertest connects from 127.0.0.1 (a trusted proxy here), so the header is believed
    const res = await request(app).get('/api/printers')
      .set('Remote-User', 'alice').set('Remote-Groups', 'printadmins');
    expect(res.status).toBe(200);
    const u = db.prepare("SELECT * FROM users WHERE sso_subject = 'alice'").get();
    expect(u.role).toBe('admin'); // mapped from the group
    expect(u.sso_provider).toBe('header');

    // With SSO off, the same header is ignored
    setSetting(db, 'sso_header_enabled', '0');
    const app2 = makeApp(db);
    expect((await request(app2).get('/api/printers').set('Remote-User', 'bob')).status).toBe(401);
  });
});

describe('forced password change (one-time / recovery passwords)', () => {
  test('a must-change user is blocked until they change the password, then allowed', async () => {
    const db = freshDb();
    // A recovery/temporary account flagged must_change_password (as the CLI would set).
    const { hash, salt } = auth.hashPassword('temp12345');
    db.prepare("INSERT INTO users (username, password_hash, password_salt, role, is_active, created_at, must_change_password) VALUES ('admin', ?, ?, 'admin', 1, ?, 1)")
      .run(hash, salt, 1);
    const app = makeApp(db);

    const login = await request(app).post('/api/auth/login').send({ username: 'admin', password: 'temp12345' });
    expect(login.status).toBe(200);
    const c = cookie(login);

    // blocked everywhere except the auth endpoints, and /me advertises the requirement
    expect((await request(app).get('/api/printers').set('Cookie', c)).status).toBe(403);
    expect((await request(app).get('/api/auth/me').set('Cookie', c)).body.must_change_password).toBe(true);

    // wrong current password is rejected
    expect((await request(app).post('/api/auth/change-password').set('Cookie', c)
      .send({ current_password: 'nope', new_password: 'brandnew123' })).status).toBe(401);

    // change it -> new session issued, old one invalidated, access granted
    const chg = await request(app).post('/api/auth/change-password').set('Cookie', c)
      .send({ current_password: 'temp12345', new_password: 'brandnew123' });
    expect(chg.status).toBe(200);
    const c2 = cookie(chg);
    expect((await request(app).get('/api/printers').set('Cookie', c2)).status).toBe(200);
    expect((await request(app).get('/api/printers').set('Cookie', c)).status).toBe(401);
  });
});

describe('passkeys (WebAuthn) plumbing', () => {
  test('login options are public and carry a challenge; register/list require a session', async () => {
    const db = freshDb();
    const app = makeApp(db);
    const opt = await request(app).post('/api/auth/passkey/login/options').send({});
    expect(opt.status).toBe(200);
    expect(opt.body.challenge).toBeTruthy();
    expect(opt.headers['set-cookie'][0]).toMatch(/pfm_pk_chal=/);
    expect((await request(app).post('/api/auth/passkey/register/options').send({})).status).toBe(401);
    expect((await request(app).get('/api/auth/passkey')).status).toBe(401);
  });

  test('login verify rejects an unknown credential', async () => {
    const db = freshDb();
    const app = makeApp(db);
    const opt = await request(app).post('/api/auth/passkey/login/options').send({});
    const res = await request(app).post('/api/auth/passkey/login/verify').set('Cookie', cookie(opt))
      .send({ credential: { id: 'does-not-exist', response: {} } });
    expect([400, 401]).toContain(res.status);
  });
});

describe('MFA (TOTP + recovery codes + two-step login)', () => {
  const mfaLib = require('../mfa');
  async function adminSession(app, db) {
    const res = await request(app).post('/api/auth/setup').send({ username: 'admin', password: 'supersecret1' });
    setSetting(db, 'auth_enabled', '1');
    return cookie(res);
  }

  test('enroll and enable, then password login becomes two-step', async () => {
    const db = freshDb();
    const app = makeApp(db);
    const c = await adminSession(app, db);
    const setup = await request(app).post('/api/auth/mfa/setup').set('Cookie', c).send({});
    expect(setup.status).toBe(200);
    expect(setup.body.secret).toBeTruthy();
    const en = await request(app).post('/api/auth/mfa/enable').set('Cookie', c)
      .send({ code: mfaLib.totpAt(setup.body.secret, Date.now()) });
    expect(en.status).toBe(200);
    expect(en.body.recovery_codes).toHaveLength(10);

    const login = await request(app).post('/api/auth/login').send({ username: 'admin', password: 'supersecret1' });
    expect(login.body.mfa_required).toBe(true);
    const mfaCookie = cookie(login);
    expect((await request(app).post('/api/auth/mfa/verify').set('Cookie', mfaCookie).send({ code: '000000' })).status).toBe(400);
    const verify = await request(app).post('/api/auth/mfa/verify').set('Cookie', mfaCookie)
      .send({ code: mfaLib.totpAt(setup.body.secret, Date.now()) });
    expect(verify.status).toBe(200);
    expect((await request(app).get('/api/printers').set('Cookie', cookie(verify))).status).toBe(200);
  });

  test('a recovery code works once then is spent', async () => {
    const db = freshDb();
    const app = makeApp(db);
    const c = await adminSession(app, db);
    const setup = await request(app).post('/api/auth/mfa/setup').set('Cookie', c).send({});
    const en = await request(app).post('/api/auth/mfa/enable').set('Cookie', c).send({ code: mfaLib.totpAt(setup.body.secret, Date.now()) });
    const recovery = en.body.recovery_codes[0];
    const l1 = await request(app).post('/api/auth/login').send({ username: 'admin', password: 'supersecret1' });
    expect((await request(app).post('/api/auth/mfa/verify').set('Cookie', cookie(l1)).send({ recovery_code: recovery })).status).toBe(200);
    const l2 = await request(app).post('/api/auth/login').send({ username: 'admin', password: 'supersecret1' });
    expect((await request(app).post('/api/auth/mfa/verify').set('Cookie', cookie(l2)).send({ recovery_code: recovery })).status).toBe(400);
  });

  test('require_mfa gates a user without MFA into setup', async () => {
    const db = freshDb();
    const app = makeApp(db);
    const c = await adminSession(app, db);
    setSetting(db, 'require_mfa', '1');
    const r = await request(app).get('/api/printers').set('Cookie', c);
    expect(r.status).toBe(403);
    expect(r.body.code).toBe('MFA_SETUP_REQUIRED');
    expect((await request(app).get('/api/auth/me').set('Cookie', c)).body).toMatchObject({ mfa_required: true, mfa_enabled: false });
    // the setup endpoint stays reachable so the user can comply
    expect((await request(app).post('/api/auth/mfa/setup').set('Cookie', c).send({})).status).toBe(200);
  });
});

// bootstrap an admin directly (no app) then flip auth on, for tests that build the app afterwards
async function bootstrapAdminNoApp(db) {
  const { hash, salt } = auth.hashPassword('supersecret1');
  db.prepare('INSERT INTO users (username, password_hash, password_salt, role, is_active, created_at) VALUES (?,?,?,?,1,?)')
    .run('admin', hash, salt, 'admin', Date.now());
  setSetting(db, 'auth_enabled', '1');
}
