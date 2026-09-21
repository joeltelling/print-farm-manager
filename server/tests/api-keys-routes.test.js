// Tests for server/routes/api-keys.js. Like users.js, this router trusts
// req.user to already be set by the auth middleware chain in server/index.js,
// so these tests inject it directly via a stand-in middleware.

const request  = require('supertest');
const express  = require('express');
const Database = require('better-sqlite3');

let db;
let app;
let currentUser;

beforeAll(() => {
  db = new Database(':memory:');
  db.exec(`
    CREATE TABLE users (
      id INTEGER PRIMARY KEY AUTOINCREMENT, email TEXT UNIQUE, name TEXT,
      password_hash TEXT, role TEXT DEFAULT 'operator', oidc_subject TEXT UNIQUE,
      created_at INTEGER, last_login_at INTEGER
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

  const apiKeysRouter = require('../routes/api-keys')(db);
  app = express();
  app.use(express.json());
  app.use((req, res, next) => { req.user = currentUser; next(); });
  app.use('/api/api-keys', apiKeysRouter);
});

function insertUser(email, role = 'operator') {
  const result = db.prepare('INSERT INTO users (email, name, role, created_at) VALUES (?, ?, ?, ?)').run(email, email, role, Date.now());
  return db.prepare('SELECT * FROM users WHERE id = ?').get(result.lastInsertRowid);
}

beforeEach(() => {
  db.prepare('DELETE FROM api_keys').run();
  db.prepare('DELETE FROM users').run();
  currentUser = insertUser('user@farm.local');
});

describe('POST /api/api-keys', () => {
  test('creates a key and returns the plaintext exactly once', async () => {
    const res = await request(app).post('/api/api-keys').send({ name: 'OrcaSlicer' });
    expect(res.status).toBe(201);
    expect(res.body.key).toMatch(/^pfm_/);
    expect(res.body.name).toBe('OrcaSlicer');
  });

  test('rejects a missing name', async () => {
    const res = await request(app).post('/api/api-keys').send({});
    expect(res.status).toBe(400);
  });
});

describe('GET /api/api-keys', () => {
  test('lists only the current user\'s keys, never key_hash', async () => {
    await request(app).post('/api/api-keys').send({ name: 'Mine' });
    const other = insertUser('other@farm.local');
    db.prepare('INSERT INTO api_keys (user_id, name, key_prefix, key_hash, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(other.id, 'Not mine', 'pfm_zz', 'hash', Date.now());

    const res = await request(app).get('/api/api-keys');
    expect(res.status).toBe(200);
    expect(res.body.length).toBe(1);
    expect(res.body[0].name).toBe('Mine');
    expect(res.body[0].key_hash).toBeUndefined();
  });
});

describe('DELETE /api/api-keys/:id', () => {
  test('404s for an unknown id', async () => {
    const res = await request(app).delete('/api/api-keys/999');
    expect(res.status).toBe(404);
  });

  test('the owner can revoke their own key', async () => {
    const created = await request(app).post('/api/api-keys').send({ name: 'Mine' });
    const res = await request(app).delete(`/api/api-keys/${created.body.id}`);
    expect(res.status).toBe(200);
    const row = db.prepare('SELECT * FROM api_keys WHERE id = ?').get(created.body.id);
    expect(row.revoked_at).not.toBeNull();
  });

  test('a different non-admin user cannot revoke someone else\'s key', async () => {
    const created = await request(app).post('/api/api-keys').send({ name: 'Mine' });
    currentUser = insertUser('intruder@farm.local');
    const res = await request(app).delete(`/api/api-keys/${created.body.id}`);
    expect(res.status).toBe(403);
  });

  test('an admin can revoke someone else\'s key', async () => {
    const created = await request(app).post('/api/api-keys').send({ name: 'Mine' });
    currentUser = insertUser('admin@farm.local', 'admin');
    const res = await request(app).delete(`/api/api-keys/${created.body.id}`);
    expect(res.status).toBe(200);
  });
});
