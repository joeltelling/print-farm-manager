// Tests for POST /api/printers/:id/mark-job-failure and POST /api/printers/:id/decommission
// Uses an in-memory SQLite DB — no real printers or network calls needed.

const request  = require('supertest');
const express  = require('express');
const Database = require('better-sqlite3');

// ── In-memory DB setup ────────────────────────────────────────────────────────

let db;
let app;

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
    CREATE TABLE projects (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      status TEXT DEFAULT 'active',
      priority INTEGER DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE parts (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id    INTEGER NOT NULL REFERENCES projects(id),
      name          TEXT NOT NULL,
      target_qty    INTEGER NOT NULL,
      completed_qty INTEGER DEFAULT 0,
      status        TEXT DEFAULT 'open',
      sort_order    INTEGER DEFAULT 0,
      created_at    INTEGER NOT NULL,
      updated_at    INTEGER NOT NULL
    );
    CREATE TABLE gcodes (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      part_id         INTEGER NOT NULL REFERENCES parts(id),
      printer_model   TEXT NOT NULL,
      filename        TEXT NOT NULL,
      filepath        TEXT NOT NULL,
      parts_per_plate INTEGER NOT NULL,
      est_print_secs  INTEGER,
      created_at      INTEGER NOT NULL
    );
    CREATE TABLE jobs (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      part_id         INTEGER NOT NULL REFERENCES parts(id),
      printer_id      INTEGER NOT NULL REFERENCES printers(id),
      gcode_id        INTEGER NOT NULL REFERENCES gcodes(id),
      parts_per_plate INTEGER NOT NULL,
      status          TEXT DEFAULT 'queued',
      started_at      INTEGER,
      finished_at     INTEGER,
      created_at      INTEGER NOT NULL
    );
    CREATE TABLE printer_models (
      model_id  TEXT PRIMARY KEY,
      label     TEXT NOT NULL,
      connector TEXT NOT NULL
    );
    CREATE TABLE printer_groups (
      name       TEXT PRIMARY KEY,
      created_at INTEGER NOT NULL
    );
  `);

  app = express();
  app.use(express.json());
  app.use('/api/printers', require('../routes/printers')(db));
});

// ── Seed helpers ──────────────────────────────────────────────────────────────

function seedPrinter(overrides = {}) {
  const now = Date.now();
  const r = db.prepare(`
    INSERT INTO printers (name, ip, model, status, is_held, is_active, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    overrides.name    ?? `Printer_${now}`,
    overrides.ip      ?? '10.0.0.1',
    overrides.model   ?? 'mk4s',
    overrides.status  ?? 'FINISHED',
    overrides.is_held  ?? 1,
    overrides.is_active ?? 1,
    now
  );
  return r.lastInsertRowid;
}

function seedProject() {
  const now = Date.now();
  return db.prepare(
    `INSERT INTO projects (name, status, created_at, updated_at) VALUES ('Test Project', 'active', ?, ?)`
  ).run(now, now).lastInsertRowid;
}

function seedPart(projectId, targetQty = 10, completedQty = 0) {
  const now = Date.now();
  return db.prepare(
    `INSERT INTO parts (project_id, name, target_qty, completed_qty, status, created_at, updated_at)
     VALUES (?, 'Test Part', ?, ?, 'open', ?, ?)`
  ).run(projectId, targetQty, completedQty, now, now).lastInsertRowid;
}

function seedGcode(partId) {
  const now = Date.now();
  return db.prepare(
    `INSERT INTO gcodes (part_id, printer_model, filename, filepath, parts_per_plate, created_at)
     VALUES (?, 'mk4s', 'part.bgcode', '/fake/path/part.bgcode', 4, ?)`
  ).run(partId, now).lastInsertRowid;
}

function seedJob(printerId, partId, gcodeId, status = 'finished', partsPerPlate = 4) {
  const now = Date.now();
  return db.prepare(
    `INSERT INTO jobs (printer_id, part_id, gcode_id, parts_per_plate, status, started_at, finished_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(printerId, partId, gcodeId, partsPerPlate, status, now - 3600000, status === 'finished' ? now : null, now - 3600000)
    .lastInsertRowid;
}

// ── POST /api/printers/:id/mark-job-failure ───────────────────────────────────

describe('POST /api/printers/:id/mark-job-failure', () => {
  test('returns 404 for unknown printer id', async () => {
    const res = await request(app).post('/api/printers/99999/mark-job-failure');
    expect(res.status).toBe(404);
  });

  test('decommissions printer and marks finished job as failed', async () => {
    const projectId = seedProject();
    const partId    = seedPart(projectId, 10, 4);
    const gcodeId   = seedGcode(partId);
    const printerId = seedPrinter();
    seedJob(printerId, partId, gcodeId, 'finished', 4);

    const res = await request(app).post(`/api/printers/${printerId}/mark-job-failure`);
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);

    const printer = db.prepare('SELECT * FROM printers WHERE id = ?').get(printerId);
    expect(printer.is_active).toBe(0);
    expect(printer.decommissioned_at).toBeGreaterThan(0);
  });

  test('undoes completed_qty increment when finished job is marked failed', async () => {
    const projectId = seedProject();
    const partId    = seedPart(projectId, 10, 4); // 4 already counted
    const gcodeId   = seedGcode(partId);
    const printerId = seedPrinter({ name: `Printer_undo_${Date.now()}` });
    seedJob(printerId, partId, gcodeId, 'finished', 4);

    await request(app).post(`/api/printers/${printerId}/mark-job-failure`);

    const part = db.prepare('SELECT * FROM parts WHERE id = ?').get(partId);
    expect(part.completed_qty).toBe(0); // 4 - 4 = 0
  });

  test('reopens a closed part when bad print undoes the completion', async () => {
    const projectId = seedProject();
    const partId    = seedPart(projectId, 4, 4); // exactly at target
    db.prepare("UPDATE parts SET status = 'closed' WHERE id = ?").run(partId);
    const gcodeId   = seedGcode(partId);
    const printerId = seedPrinter({ name: `Printer_reopen_${Date.now()}` });
    seedJob(printerId, partId, gcodeId, 'finished', 4);

    await request(app).post(`/api/printers/${printerId}/mark-job-failure`);

    const part = db.prepare('SELECT * FROM parts WHERE id = ?').get(partId);
    expect(part.status).toBe('open');
    expect(part.completed_qty).toBe(0);
  });

  test('marks a still-printing job as failed and decommissions', async () => {
    const projectId = seedProject();
    const partId    = seedPart(projectId, 10, 0);
    const gcodeId   = seedGcode(partId);
    const printerId = seedPrinter({ name: `Printer_printing_${Date.now()}`, status: 'UNKNOWN' });
    const jobId     = seedJob(printerId, partId, gcodeId, 'printing', 4);

    const res = await request(app).post(`/api/printers/${printerId}/mark-job-failure`);
    expect(res.status).toBe(200);

    const job = db.prepare('SELECT * FROM jobs WHERE id = ?').get(jobId);
    expect(job.status).toBe('failed');

    const printer = db.prepare('SELECT * FROM printers WHERE id = ?').get(printerId);
    expect(printer.is_active).toBe(0);
  });

  test('still-printing job failure does not change completed_qty (nothing was credited)', async () => {
    const projectId = seedProject();
    const partId    = seedPart(projectId, 10, 0);
    const gcodeId   = seedGcode(partId);
    const printerId = seedPrinter({ name: `Printer_noCred_${Date.now()}`, status: 'UNKNOWN' });
    seedJob(printerId, partId, gcodeId, 'printing', 4);

    await request(app).post(`/api/printers/${printerId}/mark-job-failure`);

    const part = db.prepare('SELECT * FROM parts WHERE id = ?').get(partId);
    expect(part.completed_qty).toBe(0); // unchanged — was never incremented
  });

  test('marks an uploading job as failed and decommissions the printer', async () => {
    // Upload stalled — operator pressed Upload Failed. The job never ran, so no qty
    // was ever credited. The job should be marked failed and printer decommissioned.
    const projectId = seedProject();
    const partId    = seedPart(projectId, 10, 0);
    const gcodeId   = seedGcode(partId);
    const printerId = seedPrinter({ name: `Printer_upfail_${Date.now()}`, status: 'IDLE' });
    const jobId     = seedJob(printerId, partId, gcodeId, 'uploading', 4);

    const res = await request(app).post(`/api/printers/${printerId}/mark-job-failure`);
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);

    const job = db.prepare('SELECT status FROM jobs WHERE id = ?').get(jobId);
    expect(job.status).toBe('failed');

    const printer = db.prepare('SELECT is_active FROM printers WHERE id = ?').get(printerId);
    expect(printer.is_active).toBe(0);
  });

  test('does not change completed_qty when an uploading job is marked failed', async () => {
    // Upload stalled jobs never ran, so completed_qty was never incremented.
    // Marking them failed must not subtract anything.
    const projectId = seedProject();
    const partId    = seedPart(projectId, 10, 6); // 6 already counted from prior runs
    const gcodeId   = seedGcode(partId);
    const printerId = seedPrinter({ name: `Printer_upnoCred_${Date.now()}`, status: 'IDLE' });
    seedJob(printerId, partId, gcodeId, 'uploading', 4);

    await request(app).post(`/api/printers/${printerId}/mark-job-failure`);

    const part = db.prepare('SELECT completed_qty FROM parts WHERE id = ?').get(partId);
    expect(part.completed_qty).toBe(6); // unchanged — nothing to undo
  });

  test('decommissions even when no tracked job exists', async () => {
    // This covers the case where a print ran to completion but the status mapped
    // to UNKNOWN (e.g. status code 9 before it was correctly mapped), so
    // _handleFinished never fired and no job record was created/transitioned.
    const printerId = seedPrinter({ name: `Printer_noJob_${Date.now()}` });
    // No job seeded

    const res = await request(app).post(`/api/printers/${printerId}/mark-job-failure`);
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.job_id).toBeNull();

    const printer = db.prepare('SELECT * FROM printers WHERE id = ?').get(printerId);
    expect(printer.is_active).toBe(0);
  });
});

// ── POST /api/printers/:id/decommission ───────────────────────────────────────

describe('POST /api/printers/:id/decommission', () => {
  test('returns 404 for unknown printer id', async () => {
    const res = await request(app).post('/api/printers/99999/decommission');
    expect(res.status).toBe(404);
  });

  test('sets is_active=0 and records decommissioned_at', async () => {
    const printerId = seedPrinter({ name: `Printer_decomm_${Date.now()}` });

    const res = await request(app).post(`/api/printers/${printerId}/decommission`);
    expect(res.status).toBe(200);

    const printer = db.prepare('SELECT * FROM printers WHERE id = ?').get(printerId);
    expect(printer.is_active).toBe(0);
    expect(printer.decommissioned_at).toBeGreaterThan(0);
  });

  test('decommissioned printer does not appear in GET /api/printers', async () => {
    const printerId = seedPrinter({ name: `Printer_gone_${Date.now()}` });
    await request(app).post(`/api/printers/${printerId}/decommission`);

    const res = await request(app).get('/api/printers');
    const ids = res.body.map(p => p.id);
    expect(ids).not.toContain(printerId);
  });

  test('decommissioned printer appears in GET /api/printers/decommissioned', async () => {
    const printerId = seedPrinter({ name: `Printer_list_${Date.now()}` });
    await request(app).post(`/api/printers/${printerId}/decommission`);

    const res = await request(app).get('/api/printers/decommissioned');
    const ids = res.body.map(p => p.id);
    expect(ids).toContain(printerId);
  });
});

// ── POST /api/printers/:id/complete-and-decommission ──────────────────────────

describe('POST /api/printers/:id/complete-and-decommission', () => {
  test('returns 404 for unknown printer id', async () => {
    const res = await request(app).post('/api/printers/99999/complete-and-decommission');
    expect(res.status).toBe(404);
  });

  test('normal finished job: decommissions, clears hold, leaves credit untouched', async () => {
    const projectId = seedProject();
    const partId    = seedPart(projectId, 10, 4); // 4 already credited at finish
    const gcodeId   = seedGcode(partId);
    const printerId = seedPrinter({ name: `Printer_cad_normal_${Date.now()}` });
    seedJob(printerId, partId, gcodeId, 'finished', 4);

    const res = await request(app).post(`/api/printers/${printerId}/complete-and-decommission`)
      .send({ note: 'swap filament' });
    expect(res.status).toBe(200);

    const printer = db.prepare('SELECT * FROM printers WHERE id = ?').get(printerId);
    expect(printer.is_active).toBe(0);
    expect(printer.is_held).toBe(0);
    const part = db.prepare('SELECT completed_qty FROM parts WHERE id = ?').get(partId);
    expect(part.completed_qty).toBe(4); // unchanged
  });

  test('partial good count on a finished job applies the delta against the booked plate', async () => {
    // _handleFinished credited the full plate (4). Operator reports 3 good of 4.
    const projectId = seedProject();
    const partId    = seedPart(projectId, 10, 4);
    const gcodeId   = seedGcode(partId);
    const printerId = seedPrinter({ name: `Printer_cad_partial_${Date.now()}` });
    seedJob(printerId, partId, gcodeId, 'finished', 4);

    const res = await request(app).post(`/api/printers/${printerId}/complete-and-decommission`)
      .send({ note: 'one warped', confirmed_qty: 3 });
    expect(res.status).toBe(200);

    const part = db.prepare('SELECT completed_qty FROM parts WHERE id = ?').get(partId);
    expect(part.completed_qty).toBe(3); // 4 + (3 - 4)
    const printer = db.prepare('SELECT is_active FROM printers WHERE id = ?').get(printerId);
    expect(printer.is_active).toBe(0);
  });

  test('reduced count reopens a closed part and reactivates its completed project', async () => {
    const projectId = seedProject();
    const partId    = seedPart(projectId, 4, 4); // exactly at target
    db.prepare("UPDATE parts SET status = 'closed' WHERE id = ?").run(partId);
    db.prepare("UPDATE projects SET status = 'completed' WHERE id = ?").run(projectId);
    const gcodeId   = seedGcode(partId);
    const printerId = seedPrinter({ name: `Printer_cad_reopen_${Date.now()}` });
    seedJob(printerId, partId, gcodeId, 'finished', 4);

    await request(app).post(`/api/printers/${printerId}/complete-and-decommission`)
      .send({ confirmed_qty: 3 });

    const part = db.prepare('SELECT * FROM parts WHERE id = ?').get(partId);
    expect(part.completed_qty).toBe(3);
    expect(part.status).toBe('open');
    const project = db.prepare('SELECT status FROM projects WHERE id = ?').get(projectId);
    expect(project.status).toBe('active');
  });

  test('missed-finish (printing job) credits the confirmed count and marks the job finished', async () => {
    const projectId = seedProject();
    const partId    = seedPart(projectId, 10, 0);
    const gcodeId   = seedGcode(partId);
    const printerId = seedPrinter({ name: `Printer_cad_missed_${Date.now()}`, status: 'IDLE' });
    const jobId     = seedJob(printerId, partId, gcodeId, 'printing', 4);

    await request(app).post(`/api/printers/${printerId}/complete-and-decommission`)
      .send({ confirmed_qty: 3 });

    const job = db.prepare('SELECT status FROM jobs WHERE id = ?').get(jobId);
    expect(job.status).toBe('finished');
    const part = db.prepare('SELECT completed_qty FROM parts WHERE id = ?').get(partId);
    expect(part.completed_qty).toBe(3); // partial plate credited
  });

  test('missed-finish with no confirmed_qty credits the full plate', async () => {
    const projectId = seedProject();
    const partId    = seedPart(projectId, 10, 0);
    const gcodeId   = seedGcode(partId);
    const printerId = seedPrinter({ name: `Printer_cad_missedfull_${Date.now()}`, status: 'IDLE' });
    seedJob(printerId, partId, gcodeId, 'printing', 4);

    await request(app).post(`/api/printers/${printerId}/complete-and-decommission`).send({});

    const part = db.prepare('SELECT completed_qty FROM parts WHERE id = ?').get(partId);
    expect(part.completed_qty).toBe(4);
  });
});
