// Tests for server/routes/users.js. This router assumes it is mounted behind
// requireAuth + requireRole('admin') (see server/index.js) and only reads
// req.user (it does not re-check the role itself), so these tests inject
// req.user directly via a stand-in middleware, the same way a real request
// would arrive already authenticated as an admin.

const request  = require('supertest');
const express  = require('express');
const Database = require('better-sqlite3');

let db;
let app;
let currentUser; // mutated per test to simulate "who is making this request"

beforeAll(() => {
  db = new Database(':memory:');
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
      token TEXT PRIMARY KEY, user_id INTEGER, created_at INTEGER, expires_at INTEGER
    );
    CREATE TABLE api_keys (
      id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER, name TEXT,
      key_prefix TEXT, key_hash TEXT, created_at INTEGER, last_used_at INTEGER, revoked_at INTEGER
    );
  `);

  const usersRouter = require('../routes/users')(db);
  app = express();
  app.use(express.json());
  app.use((req, res, next) => { req.user = currentUser; next(); });
  app.use('/api/users', usersRouter);
});

function insertUser({ email, name = 'Name', role = 'operator' }) {
  const now = Date.now();
  const result = db.prepare('INSERT INTO users (email, name, role, created_at) VALUES (?, ?, ?, ?)').run(email, name, role, now);
  return db.prepare('SELECT * FROM users WHERE id = ?').get(result.lastInsertRowid);
}

beforeEach(() => {
  db.prepare('DELETE FROM users').run();
  currentUser = insertUser({ email: 'admin@farm.local', name: 'Admin', role: 'admin' });
});

describe('GET /api/users', () => {
  test('lists users without password_hash', async () => {
    const res = await request(app).get('/api/users');
    expect(res.status).toBe(200);
    expect(res.body.length).toBe(1);
    expect(res.body[0].password_hash).toBeUndefined();
  });
});

describe('POST /api/users', () => {
  test('creates a user with a password', async () => {
    const res = await request(app).post('/api/users').send({ email: 'op@farm.local', name: 'Op', password: 'password123', role: 'operator' });
    expect(res.status).toBe(201);
    expect(res.body.role).toBe('operator');
  });

  test('creates an SSO-only user with no password', async () => {
    const res = await request(app).post('/api/users').send({ email: 'sso@farm.local', name: 'SSO User' });
    expect(res.status).toBe(201);
  });

  test('rejects a duplicate email with 409', async () => {
    await request(app).post('/api/users').send({ email: 'dupe@farm.local', name: 'A' });
    const res = await request(app).post('/api/users').send({ email: 'dupe@farm.local', name: 'B' });
    expect(res.status).toBe(409);
  });

  test('rejects an invalid role', async () => {
    const res = await request(app).post('/api/users').send({ email: 'x@farm.local', name: 'X', role: 'superuser' });
    expect(res.status).toBe(400);
  });

  test('rejects a password under 8 characters', async () => {
    const res = await request(app).post('/api/users').send({ email: 'x@farm.local', name: 'X', password: 'short' });
    expect(res.status).toBe(400);
  });
});

describe('PUT /api/users/:id', () => {
  test('404s for an unknown id', async () => {
    const res = await request(app).put('/api/users/999').send({ name: 'New' });
    expect(res.status).toBe(404);
  });

  test('updates name and role, leaving other fields unchanged (COALESCE)', async () => {
    const op = insertUser({ email: 'op@farm.local', role: 'operator' });
    const res = await request(app).put(`/api/users/${op.id}`).send({ name: 'Renamed' });
    expect(res.status).toBe(200);
    expect(res.body.name).toBe('Renamed');
    expect(res.body.role).toBe('operator');
    expect(res.body.email).toBe('op@farm.local');
  });

  test('refuses to demote the last admin', async () => {
    const res = await request(app).put(`/api/users/${currentUser.id}`).send({ role: 'operator' });
    expect(res.status).toBe(409);
  });

  test('allows demoting an admin when another admin exists', async () => {
    const secondAdmin = insertUser({ email: 'admin2@farm.local', role: 'admin' });
    const res = await request(app).put(`/api/users/${secondAdmin.id}`).send({ role: 'operator' });
    expect(res.status).toBe(200);
    expect(res.body.role).toBe('operator');
  });
});

describe('DELETE /api/users/:id', () => {
  test('404s for an unknown id', async () => {
    const res = await request(app).delete('/api/users/999');
    expect(res.status).toBe(404);
  });

  test('refuses to delete your own account', async () => {
    const res = await request(app).delete(`/api/users/${currentUser.id}`);
    expect(res.status).toBe(409);
  });

  test('refuses to delete the last admin, even when requested by someone else', async () => {
    // currentUser (the sole admin) is the delete target; an operator is the
    // one making the request, so the "can't delete yourself" guard doesn't
    // mask the "last admin" guard this test is actually checking.
    const operator = insertUser({ email: 'op@farm.local', role: 'operator' });
    const soleAdminId = currentUser.id;
    currentUser = operator;
    const res = await request(app).delete(`/api/users/${soleAdminId}`);
    expect(res.status).toBe(409);
  });

  test('deletes an operator and their sessions/keys', async () => {
    const op = insertUser({ email: 'op@farm.local', role: 'operator' });
    db.prepare('INSERT INTO sessions (token, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)').run('tok1', op.id, Date.now(), Date.now() + 1000);
    db.prepare('INSERT INTO api_keys (user_id, name, key_prefix, key_hash, created_at) VALUES (?, ?, ?, ?, ?)').run(op.id, 'k', 'pfm_ab', 'hash', Date.now());

    const res = await request(app).delete(`/api/users/${op.id}`);
    expect(res.status).toBe(200);
    expect(db.prepare('SELECT * FROM users WHERE id = ?').get(op.id)).toBeUndefined();
    expect(db.prepare('SELECT * FROM sessions WHERE user_id = ?').get(op.id)).toBeUndefined();
    expect(db.prepare('SELECT * FROM api_keys WHERE user_id = ?').get(op.id)).toBeUndefined();
  });
});
