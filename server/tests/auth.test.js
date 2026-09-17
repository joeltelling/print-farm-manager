// Coverage for the local login patch: server/auth.js (hashing, sessions, cookie helpers,
// requireAuth middleware) and server/routes/auth.js (register/login/logout/status/
// complete-onboarding/delete-account).
//
// Real-world trigger: CoMa had no authentication at all, so anyone on the LAN who could
// reach the web UI could dispatch jobs, delete parts, or wipe the fleet via restore. This
// adds a single operator account that gates the whole app on first run, plus a one-time
// setup guide that only reappears if the account is deleted (password required).

const request  = require('supertest');
const express  = require('express');
const Database = require('better-sqlite3');

const { requireAuth } = require('../auth');

let db;
let app;

beforeEach(() => {
  db = new Database(':memory:');
  db.exec(`
    CREATE TABLE auth_account (
      id                      INTEGER PRIMARY KEY CHECK (id = 1),
      username                TEXT NOT NULL,
      password_hash           TEXT NOT NULL,
      password_salt           TEXT NOT NULL,
      onboarding_completed_at INTEGER,
      created_at              INTEGER NOT NULL
    );
    CREATE TABLE auth_sessions (
      token       TEXT PRIMARY KEY,
      created_at  INTEGER NOT NULL,
      expires_at  INTEGER NOT NULL
    );
  `);

  // server/routes/auth.js declares its Express router at module scope, like every route
  // file in this codebase (see the identical note in backup-restore.test.js). Without
  // resetting the module registry, a second require() in this same process would reuse
  // that router object (and every route handler already added to it, closing over a
  // previous test's now-stale db) instead of building fresh ones around this test's db.
  jest.resetModules();
  app = express();
  app.use(express.json());
  app.use('/api/auth', require('../routes/auth')(db));

  // A dummy protected route, mounted the same way server/index.js gates every other
  // /api/* route, to exercise requireAuth() itself against a real cookie round trip.
  app.get('/api/protected', requireAuth(db), (req, res) => res.json({ ok: true }));
});

describe('GET /api/auth/status', () => {
  test('reports no account on a fresh install', async () => {
    const res = await request(app).get('/api/auth/status');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ hasAccount: false, authenticated: false, onboardingCompleted: false });
  });
});

describe('POST /api/auth/register', () => {
  test('creates the account, logs the caller in, and blocks a second registration', async () => {
    const agent = request.agent(app);

    const res = await agent
      .post('/api/auth/register')
      .send({ username: 'operator', password: 'supersecret1' });
    expect(res.status).toBe(201);
    expect(res.body).toEqual({ ok: true, onboardingCompleted: false });

    const status = await agent.get('/api/auth/status');
    expect(status.body).toEqual({
      hasAccount: true,
      authenticated: true,
      onboardingCompleted: false,
      username: 'operator',
    });

    const second = await request(app)
      .post('/api/auth/register')
      .send({ username: 'someone-else', password: 'anotherpassword' });
    expect(second.status).toBe(409);
  });

  test('rejects a missing username', async () => {
    const res = await request(app).post('/api/auth/register').send({ password: 'supersecret1' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/username/i);
  });

  test('rejects a password shorter than 8 characters', async () => {
    const res = await request(app)
      .post('/api/auth/register')
      .send({ username: 'operator', password: 'short' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/at least 8 characters/i);
  });
});

describe('POST /api/auth/login', () => {
  beforeEach(async () => {
    await request(app).post('/api/auth/register').send({ username: 'operator', password: 'supersecret1' });
  });

  test('rejects a wrong password', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .send({ username: 'operator', password: 'wrongpassword' });
    expect(res.status).toBe(401);
  });

  test('rejects a wrong username', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .send({ username: 'someone-else', password: 'supersecret1' });
    expect(res.status).toBe(401);
  });

  test('logs in with the right credentials and sets a session cookie', async () => {
    const agent = request.agent(app);
    const res = await agent
      .post('/api/auth/login')
      .send({ username: 'operator', password: 'supersecret1' });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);

    const protectedRes = await agent.get('/api/protected');
    expect(protectedRes.status).toBe(200);
  });
});

describe('requireAuth middleware', () => {
  test('401s a request with no session cookie', async () => {
    const res = await request(app).get('/api/protected');
    expect(res.status).toBe(401);
  });

  test('401s a request with a garbage cookie', async () => {
    const res = await request(app).get('/api/protected').set('Cookie', 'coma_session=not-a-real-token');
    expect(res.status).toBe(401);
  });
});

describe('POST /api/auth/complete-onboarding', () => {
  test('requires an active session', async () => {
    const res = await request(app).post('/api/auth/complete-onboarding');
    expect(res.status).toBe(401);
  });

  test('marks onboarding complete for the logged-in account, and it stays complete on the next login', async () => {
    const agent = request.agent(app);
    await agent.post('/api/auth/register').send({ username: 'operator', password: 'supersecret1' });

    const complete = await agent.post('/api/auth/complete-onboarding');
    expect(complete.status).toBe(200);

    const status = await agent.get('/api/auth/status');
    expect(status.body.onboardingCompleted).toBe(true);

    // A brand new session (e.g. a different browser tab, or after logout) must still see
    // onboarding as complete. This is what "does not come back unless the account is
    // deleted" actually means at the data level.
    const freshAgent = request.agent(app);
    const freshLogin = await freshAgent.post('/api/auth/login').send({ username: 'operator', password: 'supersecret1' });
    expect(freshLogin.body.onboardingCompleted).toBe(true);
  });
});

describe('POST /api/auth/delete-account', () => {
  test('requires an active session', async () => {
    const res = await request(app).post('/api/auth/delete-account').send({ password: 'supersecret1' });
    expect(res.status).toBe(401);
  });

  test('rejects the wrong password and leaves the account intact', async () => {
    const agent = request.agent(app);
    await agent.post('/api/auth/register').send({ username: 'operator', password: 'supersecret1' });

    const res = await agent.post('/api/auth/delete-account').send({ password: 'wrongpassword' });
    expect(res.status).toBe(401);

    const status = await agent.get('/api/auth/status');
    expect(status.body.hasAccount).toBe(true);
  });

  test('with the right password, removes the account, logs the caller out, and re-arms onboarding', async () => {
    const agent = request.agent(app);
    await agent.post('/api/auth/register').send({ username: 'operator', password: 'supersecret1' });
    await agent.post('/api/auth/complete-onboarding');

    const del = await agent.post('/api/auth/delete-account').send({ password: 'supersecret1' });
    expect(del.status).toBe(200);
    expect(del.body.ok).toBe(true);

    const status = await agent.get('/api/auth/status');
    expect(status.body).toEqual({ hasAccount: false, authenticated: false, onboardingCompleted: false });

    // The old session must no longer work even against a protected route.
    const protectedRes = await agent.get('/api/protected');
    expect(protectedRes.status).toBe(401);

    // Registering again starts a brand new onboarding cycle.
    const reRegister = await agent.post('/api/auth/register').send({ username: 'operator', password: 'newpassword1' });
    expect(reRegister.status).toBe(201);
    expect(reRegister.body.onboardingCompleted).toBe(false);
  });

  test('invalidates every open session, not just the caller\'s', async () => {
    const agentA = request.agent(app);
    await agentA.post('/api/auth/register').send({ username: 'operator', password: 'supersecret1' });

    const agentB = request.agent(app);
    await agentB.post('/api/auth/login').send({ username: 'operator', password: 'supersecret1' });
    expect((await agentB.get('/api/protected')).status).toBe(200);

    await agentA.post('/api/auth/delete-account').send({ password: 'supersecret1' });

    expect((await agentB.get('/api/protected')).status).toBe(401);
  });
});

describe('POST /api/auth/logout', () => {
  test('clears the session so the same cookie no longer authenticates', async () => {
    const agent = request.agent(app);
    await agent.post('/api/auth/register').send({ username: 'operator', password: 'supersecret1' });
    expect((await agent.get('/api/protected')).status).toBe(200);

    const logout = await agent.post('/api/auth/logout');
    expect(logout.status).toBe(200);

    expect((await agent.get('/api/protected')).status).toBe(401);
    const status = await agent.get('/api/auth/status');
    expect(status.body.authenticated).toBe(false);
    // The account itself is untouched by logout.
    expect(status.body.hasAccount).toBe(true);
  });
});
