// Tests for GET /api/jobs and GET /api/jobs/:id — specifically the joined
// printer_is_held / printer_status fields added to fix cross-page status
// disagreement after a missed-finish hold (printer goes PRINTING -> IDLE
// directly, skipping an observable FINISHED/STOPPED tick). The job row
// stays 'printing' until the operator resolves it, but the printer is
// already held; clients need both facts to avoid showing a stale "Printing"
// badge for a job that is actually awaiting operator sign-off.

const request  = require('supertest');
const express  = require('express');
const Database = require('better-sqlite3');

let db;
let app;

beforeAll(() => {
  db = new Database(':memory:');
  db.exec(`
    CREATE TABLE printers (id INTEGER PRIMARY KEY, name TEXT, ip TEXT, api_key TEXT DEFAULT '',
      model TEXT, status TEXT DEFAULT 'UNKNOWN', is_held INTEGER DEFAULT 0,
      is_active INTEGER DEFAULT 1, created_at INTEGER);
    CREATE TABLE projects (id INTEGER PRIMARY KEY, name TEXT, status TEXT DEFAULT 'draft',
      created_at INTEGER, updated_at INTEGER);
    CREATE TABLE parts (id INTEGER PRIMARY KEY, project_id INTEGER, name TEXT,
      target_qty INTEGER, completed_qty INTEGER DEFAULT 0, status TEXT DEFAULT 'open',
      created_at INTEGER, updated_at INTEGER);
    CREATE TABLE jobs (id INTEGER PRIMARY KEY, part_id INTEGER, printer_id INTEGER,
      gcode_id INTEGER, parts_per_plate INTEGER, status TEXT DEFAULT 'queued',
      started_at INTEGER, finished_at INTEGER, created_at INTEGER);
  `);

  const now = Date.now();
  db.prepare(`INSERT INTO printers (id, name, ip, model, status, is_held, created_at)
    VALUES (1, 'P1', '192.168.1.1', 'mk4s', 'IDLE', 1, ?)`).run(now);
  db.prepare(`INSERT INTO printers (id, name, ip, model, status, is_held, created_at)
    VALUES (2, 'P2', '192.168.1.2', 'mk4s', 'PRINTING', 0, ?)`).run(now);

  db.prepare(`INSERT INTO projects (id, name, status, created_at, updated_at)
    VALUES (1, 'Proj', 'active', ?, ?)`).run(now, now);
  db.prepare(`INSERT INTO parts (id, project_id, name, target_qty, created_at, updated_at)
    VALUES (1, 1, 'Part', 10, ?, ?)`).run(now, now);

  // Job 1: on the held-but-IDLE printer — a missed-finish hold. The job row
  // is still 'printing' because nothing in the scheduler resolved it yet.
  db.prepare(`INSERT INTO jobs (id, part_id, printer_id, parts_per_plate, status, started_at, created_at)
    VALUES (1, 1, 1, 4, 'printing', ?, ?)`).run(now, now);

  // Job 2: on the genuinely-printing, unheld printer.
  db.prepare(`INSERT INTO jobs (id, part_id, printer_id, parts_per_plate, status, started_at, created_at)
    VALUES (2, 1, 2, 4, 'printing', ?, ?)`).run(now, now);

  app = express();
  app.use(express.json());
  app.use('/api/jobs', require('../routes/jobs')(db));
});

describe('GET /api/jobs', () => {
  test('joins printer_is_held and printer_status for every job', async () => {
    const res = await request(app).get('/api/jobs');
    expect(res.status).toBe(200);
    const job1 = res.body.find(j => j.id === 1);
    const job2 = res.body.find(j => j.id === 2);

    expect(job1.printer_is_held).toBe(1);
    expect(job1.printer_status).toBe('IDLE');

    expect(job2.printer_is_held).toBe(0);
    expect(job2.printer_status).toBe('PRINTING');
  });

  test('a missed-finish job is still status printing at the data layer', async () => {
    // The fix is display-only (Jobs.jsx derives "Awaiting Sign-off" from
    // printer_is_held + printer_status); the underlying jobs.status must be
    // left untouched until the operator resolves it via Set Ready/Bad Print.
    const res = await request(app).get('/api/jobs?printer_id=1');
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].status).toBe('printing');
    expect(res.body[0].printer_is_held).toBe(1);
  });
});

describe('GET /api/jobs/:id', () => {
  test('includes printer_is_held and printer_status on a single job', async () => {
    const res = await request(app).get('/api/jobs/1');
    expect(res.status).toBe(200);
    expect(res.body.printer_is_held).toBe(1);
    expect(res.body.printer_status).toBe('IDLE');
  });

  test('404 for unknown job', async () => {
    const res = await request(app).get('/api/jobs/999');
    expect(res.status).toBe(404);
  });
});
