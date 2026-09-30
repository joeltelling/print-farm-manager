// Tests for the optional estimated-time-to-print field on parts.
//
// This is the operator's up-front estimate, used as the schedule's block length until a
// sliced G-code supplies a real per-model figure. It is optional on purpose: a part with no
// estimate is scheduled at the documented two-hour default and labelled as unknown, which
// is honest, whereas storing a silent zero would collapse the block.

const request  = require('supertest');
const express  = require('express');
const Database = require('better-sqlite3');

let db;
let app;

beforeEach(() => {
  jest.resetModules();
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE projects (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL, status TEXT DEFAULT 'active',
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
    CREATE TABLE parts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id INTEGER NOT NULL REFERENCES projects(id),
      name TEXT NOT NULL, target_qty INTEGER NOT NULL, completed_qty INTEGER DEFAULT 0,
      status TEXT DEFAULT 'open', sort_order INTEGER NOT NULL DEFAULT 0,
      print_time_seconds INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
    CREATE TABLE gcodes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      part_id INTEGER NOT NULL REFERENCES parts(id),
      printer_model TEXT NOT NULL, filename TEXT NOT NULL, filepath TEXT NOT NULL,
      parts_per_plate INTEGER NOT NULL, est_print_secs INTEGER, created_at INTEGER NOT NULL
    );
    CREATE TABLE jobs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      part_id INTEGER NOT NULL REFERENCES parts(id), printer_id INTEGER,
      gcode_id INTEGER, parts_per_plate INTEGER NOT NULL,
      status TEXT DEFAULT 'queued', started_at INTEGER, finished_at INTEGER,
      created_at INTEGER NOT NULL
    );
    INSERT INTO projects (name, status, created_at, updated_at) VALUES ('Proj', 'active', 1, 1);
  `);

  app = express();
  app.use(express.json());
  app.use('/api/parts', require('../routes/parts')(db, null));
});

describe('POST /api/parts with print_time', () => {
  test.each([
    ['2h15m',   8100],
    ['90m',     5400],
    ['1:30:00', 5400],
    ['2:30',    9000],
    ['3600',    3600],
  ])('accepts %s and stores %i seconds', async (input, expected) => {
    const res = await request(app)
      .post('/api/parts')
      .send({ project_id: 1, name: 'Bracket', target_qty: 5, print_time: input });
    expect(res.status).toBe(201);
    expect(res.body.print_time_seconds).toBe(expected);
  });

  test('the field is optional: an omitted estimate stores null', async () => {
    const res = await request(app)
      .post('/api/parts')
      .send({ project_id: 1, name: 'Bracket', target_qty: 5 });
    expect(res.status).toBe(201);
    expect(res.body.print_time_seconds).toBeNull();
  });

  test('an empty string is treated as no estimate, not as an error', async () => {
    const res = await request(app)
      .post('/api/parts')
      .send({ project_id: 1, name: 'Bracket', target_qty: 5, print_time: '' });
    expect(res.status).toBe(201);
    expect(res.body.print_time_seconds).toBeNull();
  });

  test('rejects an unparseable estimate with a format hint', async () => {
    const res = await request(app)
      .post('/api/parts')
      .send({ project_id: 1, name: 'Bracket', target_qty: 5, print_time: 'a while' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/2h15m/);
    expect(db.prepare('SELECT COUNT(*) AS n FROM parts').get().n).toBe(0);
  });

  test('rejects a zero-length estimate', async () => {
    const res = await request(app)
      .post('/api/parts')
      .send({ project_id: 1, name: 'Bracket', target_qty: 5, print_time: '0' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/greater than zero/);
  });

  test('still requires the mandatory fields', async () => {
    const res = await request(app).post('/api/parts').send({ project_id: 1, print_time: '2h' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/name/);
  });
});

describe('PUT /api/parts/:id with print_time', () => {
  let partId;
  beforeEach(() => {
    partId = db.prepare(`
      INSERT INTO parts (project_id, name, target_qty, print_time_seconds, created_at, updated_at)
      VALUES (1, 'Bracket', 5, 7200, 1, 1)
    `).run().lastInsertRowid;
  });

  test('updates the estimate', async () => {
    const res = await request(app).put(`/api/parts/${partId}`).send({ print_time: '45m' });
    expect(res.status).toBe(200);
    expect(res.body.print_time_seconds).toBe(2700);
  });

  test('an empty value clears the estimate', async () => {
    const res = await request(app).put(`/api/parts/${partId}`).send({ print_time: '' });
    expect(res.status).toBe(200);
    expect(res.body.print_time_seconds).toBeNull();
  });

  test('omitting the field leaves the stored estimate alone', async () => {
    const res = await request(app).put(`/api/parts/${partId}`).send({ name: 'Renamed' });
    expect(res.status).toBe(200);
    expect(res.body.name).toBe('Renamed');
    expect(res.body.print_time_seconds).toBe(7200);
  });

  test('an unparseable value is rejected and changes nothing', async () => {
    const res = await request(app)
      .put(`/api/parts/${partId}`)
      .send({ name: 'Renamed', print_time: 'ages' });
    expect(res.status).toBe(400);
    const row = db.prepare('SELECT * FROM parts WHERE id = ?').get(partId);
    expect(row.print_time_seconds).toBe(7200);
    expect(row.name).toBe('Bracket');
  });

  test('404 for a part that does not exist', async () => {
    const res = await request(app).put('/api/parts/9999').send({ print_time: '1h' });
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('Part not found');
  });

  test('editing quantities does not wipe the estimate', async () => {
    // The estimate is written on every PUT, so a quantity-only edit from the Projects UI
    // must not blank it as a side effect.
    const res = await request(app)
      .put(`/api/parts/${partId}`)
      .send({ completed_qty: 2, target_qty: 6 });
    expect(res.status).toBe(200);
    expect(res.body.print_time_seconds).toBe(7200);
    expect(res.body.completed_qty).toBe(2);
  });
});
