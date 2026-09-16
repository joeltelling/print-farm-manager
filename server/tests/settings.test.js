const request  = require('supertest');
const express  = require('express');
const Database = require('better-sqlite3');

let db;
let app;

beforeAll(() => {
  db = new Database(':memory:');
  db.exec(`CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
  db.prepare("INSERT INTO settings (key, value) VALUES ('dispatch_batch_size', '10')").run();

  app = express();
  app.use(express.json());
  app.use('/api/settings', require('../routes/settings')(db));
});

describe('GET /api/settings', () => {
  test('returns all settings as a key/value object', async () => {
    const res = await request(app).get('/api/settings');
    expect(res.status).toBe(200);
    expect(res.body.dispatch_batch_size).toBe('10');
  });
});

describe('PUT /api/settings/dispatch_batch_size', () => {
  test('saves a valid value and returns it', async () => {
    const res = await request(app)
      .put('/api/settings/dispatch_batch_size')
      .send({ value: 5 });
    expect(res.status).toBe(200);
    expect(res.body.key).toBe('dispatch_batch_size');
    expect(res.body.value).toBe('5');
    // Persisted in DB
    expect(db.prepare("SELECT value FROM settings WHERE key = 'dispatch_batch_size'").get().value).toBe('5');
  });

  test('rejects a value below 1', async () => {
    const res = await request(app)
      .put('/api/settings/dispatch_batch_size')
      .send({ value: 0 });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/between 1 and 100/i);
  });

  test('rejects a value above 100', async () => {
    const res = await request(app)
      .put('/api/settings/dispatch_batch_size')
      .send({ value: 101 });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/between 1 and 100/i);
  });

  test('rejects a non-numeric value', async () => {
    const res = await request(app)
      .put('/api/settings/dispatch_batch_size')
      .send({ value: 'banana' });
    expect(res.status).toBe(400);
  });

  test('rejects an empty value', async () => {
    const res = await request(app)
      .put('/api/settings/dispatch_batch_size')
      .send({ value: '' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/value is required/i);
  });

  test('rejects an unknown settings key', async () => {
    const res = await request(app)
      .put('/api/settings/unknown_key')
      .send({ value: '5' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/unknown setting key/i);
  });
});

describe('PUT /api/settings/camera_mode', () => {
  test('saves stream or snapshot', async () => {
    const res = await request(app)
      .put('/api/settings/camera_mode')
      .send({ value: 'stream' });
    expect(res.status).toBe(200);
    expect(res.body.value).toBe('stream');
  });

  test('rejects an unknown mode', async () => {
    const res = await request(app)
      .put('/api/settings/camera_mode')
      .send({ value: 'rtsp' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/stream or snapshot/i);
  });
});
