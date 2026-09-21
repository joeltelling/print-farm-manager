// Tests for server/routes/auth.js: bootstrap, login, logout, and /me.
// Uses an in-memory SQLite DB and a real session cookie round-trip via
// supertest's agent (persists Set-Cookie between requests), matching the
// pattern in server/tests/printers-decommission.test.js.
//
// OIDC routes are not covered here (they need a live IdP to discover against);
// oidc.isConfigured() is false with no env vars set, which is exercised by
// the 404 case below.

const request  = require('supertest');
const express  = require('express');
const Database = require('better-sqlite3');

let db;
let app;

beforeAll(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE users (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      email         TEXT NOT NULL UNIQUE,
      name          TEXT NOT NULL,
      password_hash TEXT,
      role          TEXT NOT NULL DEFAULT 'operator',
      oidc_subject  TEXT UNIQUE,
      created_at    INTEGER NOT NULL,
      last_login_at INTEGER
    );
    CREATE TABLE sessions (
      token       TEXT PRIMARY KEY,
      user_id     INTEGER NOT NULL REFERENCES users(id),
      created_at  INTEGER NOT NULL,
      expires_at  INTEGER NOT NULL
    );
    CREATE TABLE api_keys (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id       INTEGER NOT NULL REFERENCES users(id),
      name          TEXT NOT NULL,
      key_prefix    TEXT NOT NULL,
      key_hash      TEXT NOT NULL,
      created_at    INTEGER NOT NULL,
      last_used_at  INTEGER,
      revoked_at    INTEGER
    );
  `);

  const authRouter = require('../routes/auth')(db);
  app = express();
  app.use(express.json());
  app.use('/api/auth', authRouter);
});

afterEach(() => {
  db.prepare('DELETE FROM sessions').run();
  db.prepare('DELETE FROM users').run();
});

describe('GET /api/auth/status', () => {
  test('needsBootstrap is true with zero users', async () => {
    const res = await request(app).get('/api/auth/status');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ needsBootstrap: true, oidcEnabled: false });
  });

  test('needsBootstrap is false once a user exists', async () => {
    await request(app).post('/api/auth/bootstrap').send({ email: 'a@b.com', name: 'A', password: 'password123' });
    const res = await request(app).get('/api/auth/status');
    expect(res.body.needsBootstrap).toBe(false);
  });
});

describe('POST /api/auth/bootstrap', () => {
  test('creates the first user as admin and sets a session cookie', async () => {
    const res = await request(app).post('/api/auth/bootstrap').send({ email: 'admin@farm.local', name: 'Admin', password: 'password123' });
    expect(res.status).toBe(201);
    expect(res.body.role).toBe('admin');
    expect(res.body.password_hash).toBeUndefined();
    expect(res.headers['set-cookie'][0]).toMatch(/^pfm_session=/);
  });

  test('rejects a second bootstrap once a user exists', async () => {
    await request(app).post('/api/auth/bootstrap').send({ email: 'a@b.com', name: 'A', password: 'password123' });
    const res = await request(app).post('/api/auth/bootstrap').send({ email: 'b@b.com', name: 'B', password: 'password123' });
    expect(res.status).toBe(403);
  });

  test('rejects a password under 8 characters', async () => {
    const res = await request(app).post('/api/auth/bootstrap').send({ email: 'a@b.com', name: 'A', password: 'short' });
    expect(res.status).toBe(400);
  });

  test('rejects a missing field', async () => {
    const res = await request(app).post('/api/auth/bootstrap').send({ email: 'a@b.com', password: 'password123' });
    expect(res.status).toBe(400);
  });
});

describe('POST /api/auth/login', () => {
  beforeEach(async () => {
    await request(app).post('/api/auth/bootstrap').send({ email: 'admin@farm.local', name: 'Admin', password: 'password123' });
  });

  test('logs in with the right password', async () => {
    const res = await request(app).post('/api/auth/login').send({ email: 'admin@farm.local', password: 'password123' });
    expect(res.status).toBe(200);
    expect(res.body.email).toBe('admin@farm.local');
    expect(res.headers['set-cookie'][0]).toMatch(/^pfm_session=/);
  });

  test('rejects the wrong password', async () => {
    const res = await request(app).post('/api/auth/login').send({ email: 'admin@farm.local', password: 'wrongpassword' });
    expect(res.status).toBe(401);
  });

  test('rejects an unknown email', async () => {
    const res = await request(app).post('/api/auth/login').send({ email: 'nobody@farm.local', password: 'password123' });
    expect(res.status).toBe(401);
  });

  test('email lookup is case-insensitive', async () => {
    const res = await request(app).post('/api/auth/login').send({ email: 'ADMIN@FARM.LOCAL', password: 'password123' });
    expect(res.status).toBe(200);
  });
});

describe('GET /api/auth/me and POST /api/auth/logout', () => {
  test('401s with no session', async () => {
    const res = await request(app).get('/api/auth/me');
    expect(res.status).toBe(401);
  });

  test('an agent that bootstraps stays authenticated for /me, and logout clears it', async () => {
    const agent = request.agent(app);
    await agent.post('/api/auth/bootstrap').send({ email: 'admin@farm.local', name: 'Admin', password: 'password123' });

    const me = await agent.get('/api/auth/me');
    expect(me.status).toBe(200);
    expect(me.body.email).toBe('admin@farm.local');

    await agent.post('/api/auth/logout');
    const meAfter = await agent.get('/api/auth/me');
    expect(meAfter.status).toBe(401);
  });
});

describe('GET /api/auth/oidc/login', () => {
  test('404s when OIDC is not configured', async () => {
    const res = await request(app).get('/api/auth/oidc/login');
    expect(res.status).toBe(404);
  });
});
