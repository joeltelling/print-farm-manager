// Verifies the printer API never returns the stored api_key, and that an update with a
// blank/absent key leaves the stored one intact (write-only key handling).

const request  = require('supertest');
const express  = require('express');
const Database = require('better-sqlite3');

let db;
let app;

beforeAll(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE printers (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      name              TEXT NOT NULL UNIQUE,
      ip                TEXT NOT NULL,
      api_key           TEXT NOT NULL DEFAULT '',
      serial_number     TEXT DEFAULT '',
      group_name        TEXT,
      type              TEXT DEFAULT 'prusa',
      model             TEXT NOT NULL,
      status            TEXT DEFAULT 'UNKNOWN',
      is_held           INTEGER DEFAULT 1,
      is_active         INTEGER DEFAULT 1,
      decommissioned_at INTEGER,
      decommission_note TEXT,
      loaded_material   TEXT,
      loaded_color      TEXT,
      created_at        INTEGER NOT NULL
    );
    CREATE TABLE jobs (
      id INTEGER PRIMARY KEY AUTOINCREMENT, printer_id INTEGER, gcode_id INTEGER,
      parts_per_plate INTEGER, status TEXT, started_at INTEGER, finished_at INTEGER, created_at INTEGER
    );
    CREATE TABLE gcodes (id INTEGER PRIMARY KEY AUTOINCREMENT, filename TEXT);
    CREATE TABLE printer_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT, printer_id INTEGER, event_type TEXT, note TEXT, created_at INTEGER
    );
    CREATE TABLE printer_models (model_id TEXT PRIMARY KEY, label TEXT NOT NULL, connector TEXT NOT NULL);
    CREATE TABLE printer_groups (name TEXT PRIMARY KEY, created_at INTEGER NOT NULL);
    INSERT INTO printer_models VALUES ('mk4s', 'MK4S', 'prusa');
  `);

  app = express();
  app.use(express.json());
  app.use('/api/printers', require('../routes/printers')(db));
});

function seedPrinter(apiKey = 'SECRET_KEY') {
  return db.prepare(
    `INSERT INTO printers (name, ip, api_key, model, is_active, created_at) VALUES (?, ?, ?, 'mk4s', 1, ?)`
  ).run(`P_${Date.now()}_${Math.round(Math.random() * 1e6)}`, '10.0.0.5', apiKey, Date.now()).lastInsertRowid;
}

const storedKey = (id) => db.prepare('SELECT api_key FROM printers WHERE id = ?').get(id).api_key;

describe('printer API key exposure', () => {
  test('GET /api/printers omits api_key and reports has_api_key', async () => {
    seedPrinter('LIST_KEY');
    const res = await request(app).get('/api/printers');
    expect(res.status).toBe(200);
    expect(res.body.length).toBeGreaterThan(0);
    for (const p of res.body) {
      expect(p).not.toHaveProperty('api_key');
      expect(p).toHaveProperty('has_api_key');
    }
    expect(res.body.some(p => p.has_api_key === true)).toBe(true);
  });

  test('GET /api/printers/:id omits api_key', async () => {
    const id = seedPrinter('DETAIL_KEY');
    const res = await request(app).get(`/api/printers/${id}`);
    expect(res.status).toBe(200);
    expect(res.body).not.toHaveProperty('api_key');
    expect(res.body.has_api_key).toBe(true);
  });

  test('has_api_key is false when no key is stored', async () => {
    const id = seedPrinter('');
    const res = await request(app).get(`/api/printers/${id}`);
    expect(res.body.has_api_key).toBe(false);
  });

  test('PUT without api_key keeps the stored key', async () => {
    const id = seedPrinter('KEEP_ME');
    const res = await request(app).put(`/api/printers/${id}`).send({ ip: '10.0.0.9' });
    expect(res.status).toBe(200);
    expect(res.body).not.toHaveProperty('api_key');
    expect(storedKey(id)).toBe('KEEP_ME');
  });

  test('PUT with a new api_key updates it', async () => {
    const id = seedPrinter('OLD_KEY');
    const res = await request(app).put(`/api/printers/${id}`).send({ api_key: 'NEW_KEY' });
    expect(res.status).toBe(200);
    expect(storedKey(id)).toBe('NEW_KEY');
  });

  test('POST response omits api_key', async () => {
    const res = await request(app)
      .post('/api/printers')
      .send({ name: `New_${Date.now()}`, ip: '10.0.0.10', api_key: 'CREATE_KEY', model: 'mk4s' });
    expect(res.status).toBe(201);
    expect(res.body).not.toHaveProperty('api_key');
    expect(res.body.has_api_key).toBe(true);
  });
});
