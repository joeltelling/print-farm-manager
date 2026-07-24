// Tests for DELETE /api/jobs/:id — queued cancel (existing behavior) and the
// ?force=true escape hatch for stuck uploading/printing jobs.
//
// Regression context: a Bambu printer silently ignored a print-start command
// (latched FINISH state), leaving its job 'printing' forever against an idle
// machine. The stuck row blocked part deletion (parts refuse to delete with an
// active job) and nothing in the UI could clear it: the cancel endpoint only
// accepted queued jobs, and mark-job-failure would have decommissioned the
// printer as a side effect. force=true cancels just the job row: it never
// credits parts, never clears a printer hold, and never contacts the printer.

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
    CREATE TABLE projects (id INTEGER PRIMARY KEY, name TEXT, status TEXT DEFAULT 'active',
      created_at INTEGER, updated_at INTEGER);
    CREATE TABLE parts (id INTEGER PRIMARY KEY, project_id INTEGER, name TEXT,
      target_qty INTEGER, completed_qty INTEGER DEFAULT 0, status TEXT DEFAULT 'open',
      created_at INTEGER, updated_at INTEGER);
    CREATE TABLE jobs (id INTEGER PRIMARY KEY, part_id INTEGER, printer_id INTEGER,
      gcode_id INTEGER, parts_per_plate INTEGER, status TEXT DEFAULT 'queued',
      started_at INTEGER, finished_at INTEGER, created_at INTEGER);
  `);

  app = express();
  app.use(express.json());
  app.use('/api/jobs', require('../routes/jobs')(db));
});

beforeEach(() => {
  const now = Date.now();
  db.prepare('DELETE FROM jobs').run();
  db.prepare('DELETE FROM parts').run();
  db.prepare('DELETE FROM projects').run();
  db.prepare('DELETE FROM printers').run();
  db.prepare(`INSERT INTO printers (id, name, ip, model, status, is_held, created_at)
    VALUES (1, 'P1', '192.168.1.1', 'p1s', 'FINISHED', 1, ?)`).run(now);
  db.prepare(`INSERT INTO projects (id, name, created_at, updated_at) VALUES (1, 'Proj', ?, ?)`).run(now, now);
  db.prepare(`INSERT INTO parts (id, project_id, name, target_qty, completed_qty, created_at, updated_at)
    VALUES (1, 1, 'Part', 10, 3, ?, ?)`).run(now, now);
});

function insertJob(status, { startedAt = Date.now() } = {}) {
  const result = db.prepare(`
    INSERT INTO jobs (part_id, printer_id, parts_per_plate, status, started_at, created_at)
    VALUES (1, 1, 2, ?, ?, ?)
  `).run(status, startedAt, Date.now());
  return result.lastInsertRowid;
}

describe('DELETE /api/jobs/:id without force (existing behavior)', () => {
  test('cancels a queued job', async () => {
    const id = insertJob('queued');
    const res = await request(app).delete(`/api/jobs/${id}`);
    expect(res.status).toBe(200);
    expect(db.prepare('SELECT status FROM jobs WHERE id = ?').get(id).status).toBe('cancelled');
  });

  test('queued cancel does not stamp finished_at (unchanged behavior)', async () => {
    const id = insertJob('queued');
    await request(app).delete(`/api/jobs/${id}`);
    expect(db.prepare('SELECT finished_at FROM jobs WHERE id = ?').get(id).finished_at).toBeNull();
  });

  test('409 for a printing job, with a hint about force', async () => {
    const id = insertJob('printing');
    const res = await request(app).delete(`/api/jobs/${id}`);
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/force=true/);
    expect(db.prepare('SELECT status FROM jobs WHERE id = ?').get(id).status).toBe('printing');
  });

  test('404 for unknown job', async () => {
    const res = await request(app).delete('/api/jobs/999');
    expect(res.status).toBe(404);
  });
});

describe('DELETE /api/jobs/:id?force=true', () => {
  test('cancels a printing job and stamps finished_at', async () => {
    const id = insertJob('printing');
    const res = await request(app).delete(`/api/jobs/${id}?force=true`);
    expect(res.status).toBe(200);
    const job = db.prepare('SELECT status, finished_at FROM jobs WHERE id = ?').get(id);
    expect(job.status).toBe('cancelled');
    expect(job.finished_at).not.toBeNull();
  });

  test('cancels an uploading job', async () => {
    const id = insertJob('uploading');
    const res = await request(app).delete(`/api/jobs/${id}?force=true`);
    expect(res.status).toBe(200);
    expect(db.prepare('SELECT status FROM jobs WHERE id = ?').get(id).status).toBe('cancelled');
  });

  test('force=1 is accepted as well', async () => {
    const id = insertJob('printing');
    const res = await request(app).delete(`/api/jobs/${id}?force=1`);
    expect(res.status).toBe(200);
  });

  test('never touches completed_qty (part counts are sacred)', async () => {
    const id = insertJob('printing');
    await request(app).delete(`/api/jobs/${id}?force=true`);
    expect(db.prepare('SELECT completed_qty FROM parts WHERE id = 1').get().completed_qty).toBe(3);
  });

  test('never clears the printer hold (holds are resolved via Fleet)', async () => {
    const id = insertJob('printing');
    await request(app).delete(`/api/jobs/${id}?force=true`);
    expect(db.prepare('SELECT is_held FROM printers WHERE id = 1').get().is_held).toBe(1);
  });

  test('409 even with force for a finished job', async () => {
    const id = insertJob('finished');
    const res = await request(app).delete(`/api/jobs/${id}?force=true`);
    expect(res.status).toBe(409);
    expect(db.prepare('SELECT status FROM jobs WHERE id = ?').get(id).status).toBe('finished');
  });

  test('409 even with force for a failed job', async () => {
    const id = insertJob('failed');
    const res = await request(app).delete(`/api/jobs/${id}?force=true`);
    expect(res.status).toBe(409);
  });
});
