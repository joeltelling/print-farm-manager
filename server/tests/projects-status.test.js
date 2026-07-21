const request  = require('supertest');
const express  = require('express');
const Database = require('better-sqlite3');

let db;
let app;

// IDs seeded in beforeEach
let projectId;
let openPartId;
let closedFullPartId;   // completed_qty === target_qty — not eligible for reactivate
let closedPartialId;    // completed_qty < target_qty  — eligible for reactivate

beforeAll(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE projects (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      status TEXT DEFAULT 'draft',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE parts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id INTEGER NOT NULL REFERENCES projects(id),
      name TEXT NOT NULL,
      target_qty INTEGER NOT NULL,
      completed_qty INTEGER DEFAULT 0,
      status TEXT DEFAULT 'open',
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE printers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      ip TEXT NOT NULL,
      api_key TEXT NOT NULL,
      model TEXT NOT NULL,
      status TEXT DEFAULT 'UNKNOWN',
      is_held INTEGER DEFAULT 1,
      is_active INTEGER DEFAULT 1,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE gcodes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      part_id INTEGER NOT NULL REFERENCES parts(id),
      printer_model TEXT NOT NULL,
      filename TEXT NOT NULL,
      filepath TEXT NOT NULL,
      parts_per_plate INTEGER NOT NULL,
      est_print_secs INTEGER,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE jobs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      part_id INTEGER NOT NULL REFERENCES parts(id),
      printer_id INTEGER NOT NULL REFERENCES printers(id),
      gcode_id INTEGER REFERENCES gcodes(id),
      parts_per_plate INTEGER NOT NULL,
      status TEXT DEFAULT 'queued',
      started_at INTEGER,
      finished_at INTEGER,
      created_at INTEGER NOT NULL
    );
  `);

  // scheduler = null — no sweep needed in tests
  app = express();
  app.use(express.json());
  app.use('/api/projects', require('../routes/projects')(db, null));
});

beforeEach(() => {
  // Clear data and re-seed for each test so tests don't bleed into each other
  db.exec(`
    DELETE FROM jobs;
    DELETE FROM gcodes;
    DELETE FROM parts;
    DELETE FROM projects;
  `);

  const now = Date.now();

  const projRow = db.prepare(
    "INSERT INTO projects (name, status, created_at, updated_at) VALUES ('Test Project', 'active', ?, ?)"
  ).run(now, now);
  projectId = projRow.lastInsertRowid;

  const openRow = db.prepare(
    'INSERT INTO parts (project_id, name, target_qty, completed_qty, status, sort_order, created_at, updated_at) VALUES (?, ?, 100, 40, \'open\', 0, ?, ?)'
  ).run(projectId, 'Open Part', now, now);
  openPartId = openRow.lastInsertRowid;

  const closedFullRow = db.prepare(
    'INSERT INTO parts (project_id, name, target_qty, completed_qty, status, sort_order, created_at, updated_at) VALUES (?, ?, 50, 50, \'closed\', 1, ?, ?)'
  ).run(projectId, 'Done Part', now, now);
  closedFullPartId = closedFullRow.lastInsertRowid;

  const closedPartialRow = db.prepare(
    'INSERT INTO parts (project_id, name, target_qty, completed_qty, status, sort_order, created_at, updated_at) VALUES (?, ?, 200, 80, \'closed\', 2, ?, ?)'
  ).run(projectId, 'Partial Part', now, now);
  closedPartialId = closedPartialRow.lastInsertRowid;
});

// ─── /complete ───────────────────────────────────────────────────────────────

describe('POST /api/projects/:id/complete', () => {
  test('returns 404 for unknown project', async () => {
    const res = await request(app).post('/api/projects/99999/complete');
    expect(res.status).toBe(404);
  });

  test('returns 400 when project is already completed', async () => {
    db.prepare("UPDATE projects SET status = 'completed' WHERE id = ?").run(projectId);
    const res = await request(app).post(`/api/projects/${projectId}/complete`);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/already completed/i);
  });

  test('sets project status to completed', async () => {
    await request(app).post(`/api/projects/${projectId}/complete`);
    const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(projectId);
    expect(project.status).toBe('completed');
  });

  test('closes all open parts', async () => {
    await request(app).post(`/api/projects/${projectId}/complete`);
    const open = db.prepare("SELECT * FROM parts WHERE project_id = ? AND status = 'open'").all(projectId);
    expect(open.length).toBe(0);
  });

  test('reports closed_parts count correctly', async () => {
    const res = await request(app).post(`/api/projects/${projectId}/complete`);
    expect(res.status).toBe(200);
    expect(res.body.closed_parts).toBe(1); // only openPartId was open
  });

  test('cancels queued and uploading jobs for open parts', async () => {
    const now = Date.now();
    const printerRow = db.prepare(
      "INSERT INTO printers (name, ip, api_key, model, created_at) VALUES ('P1', '1.1.1.1', 'k', 'mk4s', ?)"
    ).run(now);
    const printerId = printerRow.lastInsertRowid;

    // queued job — should be cancelled
    db.prepare(
      "INSERT INTO jobs (part_id, printer_id, parts_per_plate, status, created_at) VALUES (?, ?, 4, 'queued', ?)"
    ).run(openPartId, printerId, now);

    // already-finished job — should NOT be cancelled
    db.prepare(
      "INSERT INTO jobs (part_id, printer_id, parts_per_plate, status, created_at) VALUES (?, ?, 4, 'finished', ?)"
    ).run(openPartId, printerId, now);

    const res = await request(app).post(`/api/projects/${projectId}/complete`);
    expect(res.body.cancelled_jobs).toBe(1);

    // Verify finished job was untouched
    const finishedJobs = db.prepare(
      "SELECT * FROM jobs WHERE part_id = ? AND status = 'finished'"
    ).all(openPartId);
    expect(finishedJobs.length).toBe(1);
  });

  test('does not cancel jobs for already-closed parts', async () => {
    const now = Date.now();
    const printerRow = db.prepare(
      "INSERT INTO printers (name, ip, api_key, model, created_at) VALUES ('P2', '1.1.1.2', 'k', 'mk4s', ?)"
    ).run(now);
    const printerId = printerRow.lastInsertRowid;

    // Queued job on a CLOSED part — should not be touched
    db.prepare(
      "INSERT INTO jobs (part_id, printer_id, parts_per_plate, status, created_at) VALUES (?, ?, 4, 'queued', ?)"
    ).run(closedFullPartId, printerId, now);

    const res = await request(app).post(`/api/projects/${projectId}/complete`);
    expect(res.body.cancelled_jobs).toBe(0);
  });
});

// ─── /reactivate ─────────────────────────────────────────────────────────────

describe('POST /api/projects/:id/reactivate', () => {
  beforeEach(() => {
    // Set project to completed for reactivate tests
    db.prepare("UPDATE projects SET status = 'completed' WHERE id = ?").run(projectId);
  });

  test('returns 404 for unknown project', async () => {
    const res = await request(app).post('/api/projects/99999/reactivate');
    expect(res.status).toBe(404);
  });

  test('sets project status to active', async () => {
    await request(app).post(`/api/projects/${projectId}/reactivate`);
    const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(projectId);
    expect(project.status).toBe('active');
  });

  test('reopens closed parts that have remaining qty', async () => {
    const res = await request(app).post(`/api/projects/${projectId}/reactivate`);
    expect(res.status).toBe(200);
    expect(res.body.reopened_parts).toBe(1); // only closedPartialId qualifies

    const part = db.prepare('SELECT * FROM parts WHERE id = ?').get(closedPartialId);
    expect(part.status).toBe('open');
  });

  test('does not reopen parts that are already at target qty', async () => {
    await request(app).post(`/api/projects/${projectId}/reactivate`);
    const part = db.prepare('SELECT * FROM parts WHERE id = ?').get(closedFullPartId);
    expect(part.status).toBe('closed');
  });

  test('returns nothing_to_reopen when all closed parts are at target', async () => {
    // Bring the partial part up to target so nothing qualifies
    db.prepare('UPDATE parts SET completed_qty = target_qty WHERE id = ?').run(closedPartialId);
    // Also close the open part at its target
    db.prepare('UPDATE parts SET completed_qty = target_qty, status = \'closed\' WHERE id = ?').run(openPartId);

    const res = await request(app).post(`/api/projects/${projectId}/reactivate`);
    expect(res.status).toBe(200);
    expect(res.body.nothing_to_reopen).toBe(true);
    // Project status should NOT have changed
    const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(projectId);
    expect(project.status).toBe('completed');
  });

  test('does not reopen parts that are currently open', async () => {
    await request(app).post(`/api/projects/${projectId}/reactivate`);
    // openPartId was already open — should remain open, not duplicated
    const open = db.prepare("SELECT * FROM parts WHERE id = ? AND status = 'open'").get(openPartId);
    expect(open).toBeDefined();
  });

  test('reactivates when only an already-open part has remaining qty (no closed part qualifies)', async () => {
    // Simulate: every closed part is already at target, but a part is open (e.g. newly
    // added after completion) and still has remaining qty. Reactivate must not report
    // nothing_to_reopen here — this was the bug where adding a part to a completed
    // project left the project stuck reporting "all parts at target".
    db.prepare('UPDATE parts SET completed_qty = target_qty WHERE id = ?').run(closedFullPartId);
    db.prepare('UPDATE parts SET completed_qty = target_qty WHERE id = ?').run(closedPartialId);
    // openPartId stays open at 40/100 — real remaining work

    const res = await request(app).post(`/api/projects/${projectId}/reactivate`);
    expect(res.status).toBe(200);
    expect(res.body.nothing_to_reopen).toBeFalsy();

    const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(projectId);
    expect(project.status).toBe('active');
  });
});
