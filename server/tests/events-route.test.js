// Tests for GET/POST /api/printers/:id/events
// Uses an in-memory SQLite DB wired to a minimal Express app.

const request  = require('supertest');
const express  = require('express');
const Database = require('better-sqlite3');

let db;
let app;
let currentUser = { id: 1, name: 'Maeve', role: 'operator' };

beforeAll(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE printers (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      name             TEXT NOT NULL UNIQUE,
      ip               TEXT NOT NULL,
      api_key          TEXT NOT NULL DEFAULT '',
      group_name       TEXT,
      type             TEXT DEFAULT 'prusa',
      model            TEXT NOT NULL,
      status           TEXT DEFAULT 'UNKNOWN',
      is_held          INTEGER DEFAULT 1,
      is_active        INTEGER DEFAULT 1,
      decommissioned_at INTEGER,
      decommission_note TEXT,
      serial_number    TEXT DEFAULT '',
      created_at       INTEGER NOT NULL
    );
    CREATE TABLE printer_events (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      printer_id  INTEGER NOT NULL,
      event_type  TEXT NOT NULL,
      note        TEXT,
      created_at  INTEGER NOT NULL,
      user_id     INTEGER,
      user_name   TEXT
    );
    CREATE TABLE printer_models (
      model_id  TEXT PRIMARY KEY,
      label     TEXT NOT NULL,
      connector TEXT NOT NULL
    );
    CREATE TABLE projects (id INTEGER PRIMARY KEY, name TEXT, status TEXT, priority INTEGER, created_at INTEGER, updated_at INTEGER);
    CREATE TABLE parts (id INTEGER PRIMARY KEY, project_id INTEGER, name TEXT, target_qty INTEGER, completed_qty INTEGER DEFAULT 0, status TEXT DEFAULT 'open', sort_order INTEGER DEFAULT 0, created_at INTEGER, updated_at INTEGER);
    CREATE TABLE gcodes (id INTEGER PRIMARY KEY, part_id INTEGER, printer_model TEXT, filename TEXT, filepath TEXT, parts_per_plate INTEGER, est_print_secs INTEGER, created_at INTEGER);
    CREATE TABLE jobs (id INTEGER PRIMARY KEY, part_id INTEGER, printer_id INTEGER, gcode_id INTEGER, parts_per_plate INTEGER, status TEXT, started_at INTEGER, finished_at INTEGER, created_at INTEGER);
    CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  `);

  // Wire the full printers router (which mounts the events sub-router inside it)
  app = express();
  app.use(express.json());
  // Stand-in for the real requireAuth gate (see server/index.js): every route
  // here is mounted behind it in production, so req.user is always populated.
  // Mutated per test to simulate "who is making this request".
  app.use((req, res, next) => { req.user = currentUser; next(); });

  // events.js requires('./db') at module load — override with in-memory db
  // by manually wiring the events route here using the same pattern as the router
  const eventsRouter = require('../routes/events')(db);
  const printersRouter = express.Router();
  printersRouter.get('/:id', (req, res) => {
    const p = db.prepare('SELECT * FROM printers WHERE id = ?').get(req.params.id);
    if (!p) return res.status(404).json({ error: 'Printer not found' });
    res.json(p);
  });
  printersRouter.use('/:id/events', eventsRouter);
  app.use('/api/printers', printersRouter);
});

function seedPrinter(name = `Printer_${Date.now()}`) {
  const now = Date.now();
  return db.prepare(
    `INSERT INTO printers (name, ip, model, created_at) VALUES (?, '10.0.0.1', 'mk4s', ?)`
  ).run(name, now).lastInsertRowid;
}

function seedEvent(printerId, type = 'note', note = 'test note') {
  return db.prepare(
    `INSERT INTO printer_events (printer_id, event_type, note, created_at) VALUES (?, ?, ?, ?)`
  ).run(printerId, type, note, Date.now()).lastInsertRowid;
}

// ── GET /api/printers/:id/events ─────────────────────────────────────────────

describe('GET /api/printers/:id/events', () => {
  test('returns 404 for unknown printer', async () => {
    const res = await request(app).get('/api/printers/99999/events');
    expect(res.status).toBe(404);
  });

  test('returns empty array when no events exist', async () => {
    const id = seedPrinter(`EventsPrinter_empty_${Date.now()}`);
    const res = await request(app).get(`/api/printers/${id}/events`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  test('returns events for the correct printer only', async () => {
    const idA = seedPrinter(`EventsPrinter_A_${Date.now()}`);
    const idB = seedPrinter(`EventsPrinter_B_${Date.now()}`);
    seedEvent(idA, 'note', 'note for A');
    seedEvent(idB, 'note', 'note for B');

    const res = await request(app).get(`/api/printers/${idA}/events`);
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].note).toBe('note for A');
  });

  test('returns events newest first', async () => {
    const id = seedPrinter(`EventsPrinter_order_${Date.now()}`);
    // Insert with slightly different created_at to ensure ordering
    db.prepare(`INSERT INTO printer_events (printer_id, event_type, note, created_at) VALUES (?, 'note', 'first', ?)`).run(id, 1000);
    db.prepare(`INSERT INTO printer_events (printer_id, event_type, note, created_at) VALUES (?, 'note', 'second', ?)`).run(id, 2000);
    db.prepare(`INSERT INTO printer_events (printer_id, event_type, note, created_at) VALUES (?, 'note', 'third', ?)`).run(id, 3000);

    const res = await request(app).get(`/api/printers/${id}/events`);
    expect(res.body[0].note).toBe('third');
    expect(res.body[1].note).toBe('second');
    expect(res.body[2].note).toBe('first');
  });

  test('returns all event fields', async () => {
    const id = seedPrinter(`EventsPrinter_fields_${Date.now()}`);
    seedEvent(id, 'job_finished', 'Job 42 — Widget (4 parts)');

    const res = await request(app).get(`/api/printers/${id}/events`);
    const ev = res.body[0];
    expect(ev).toHaveProperty('id');
    expect(ev).toHaveProperty('printer_id', id);
    expect(ev).toHaveProperty('event_type', 'job_finished');
    expect(ev).toHaveProperty('note', 'Job 42 — Widget (4 parts)');
    expect(ev).toHaveProperty('created_at');
  });
});

// ── POST /api/printers/:id/events ─────────────────────────────────────────────

describe('POST /api/printers/:id/events', () => {
  test('returns 404 for unknown printer', async () => {
    const res = await request(app)
      .post('/api/printers/99999/events')
      .send({ note: 'hello' });
    expect(res.status).toBe(404);
  });

  test('returns 400 when note is missing', async () => {
    const id = seedPrinter(`EventsPrinter_badreq_${Date.now()}`);
    const res = await request(app).post(`/api/printers/${id}/events`).send({});
    expect(res.status).toBe(400);
  });

  test('returns 400 when note is blank', async () => {
    const id = seedPrinter(`EventsPrinter_blank_${Date.now()}`);
    const res = await request(app)
      .post(`/api/printers/${id}/events`)
      .send({ note: '   ' });
    expect(res.status).toBe(400);
  });

  test('creates a note event and returns it', async () => {
    const id = seedPrinter(`EventsPrinter_create_${Date.now()}`);
    const res = await request(app)
      .post(`/api/printers/${id}/events`)
      .send({ note: 'Belt tension checked — nominal' });

    expect(res.status).toBe(201);
    expect(res.body.event_type).toBe('note');
    expect(res.body.note).toBe('Belt tension checked — nominal');
    expect(res.body.printer_id).toBe(id);
    expect(res.body.created_at).toBeGreaterThan(0);
  });

  test('trims whitespace from note', async () => {
    const id = seedPrinter(`EventsPrinter_trim_${Date.now()}`);
    const res = await request(app)
      .post(`/api/printers/${id}/events`)
      .send({ note: '  nozzle replaced  ' });

    expect(res.status).toBe(201);
    expect(res.body.note).toBe('nozzle replaced');
  });

  test('created event appears in subsequent GET', async () => {
    const id = seedPrinter(`EventsPrinter_roundtrip_${Date.now()}`);
    await request(app)
      .post(`/api/printers/${id}/events`)
      .send({ note: 'Hotend cleaned' });

    const getRes = await request(app).get(`/api/printers/${id}/events`);
    expect(getRes.body).toHaveLength(1);
    expect(getRes.body[0].note).toBe('Hotend cleaned');
  });

  // Attribution: who added this note, not just what it says.
  test('attributes the event to the signed-in user', async () => {
    currentUser = { id: 7, name: 'Joel', role: 'admin' };
    const id = seedPrinter(`EventsPrinter_attrib_${Date.now()}`);
    const res = await request(app)
      .post(`/api/printers/${id}/events`)
      .send({ note: 'Bed leveled' });

    expect(res.status).toBe(201);
    expect(res.body.user_id).toBe(7);
    expect(res.body.user_name).toBe('Joel');
    currentUser = { id: 1, name: 'Maeve', role: 'operator' };
  });
});
