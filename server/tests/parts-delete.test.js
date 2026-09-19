const request  = require('supertest');
const express  = require('express');
const Database = require('better-sqlite3');
const path     = require('path');
const fs       = require('fs');

const GCODE_DIR = require('../paths').gcodeDir;

// ── Single DB + app for the whole suite; data is reset between tests ──────────

let db;
let app;

beforeAll(() => {
  if (!fs.existsSync(GCODE_DIR)) fs.mkdirSync(GCODE_DIR, { recursive: true });

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

  const now = Date.now();
  db.prepare('INSERT INTO projects (name, created_at, updated_at) VALUES (?, ?, ?)').run('Test Project', now, now);
  db.prepare('INSERT INTO printers (name, ip, api_key, model, created_at) VALUES (?, ?, ?, ?, ?)').run('Test Printer', '192.168.1.1', 'key', 'mk4s', now);

  app = express();
  app.use(express.json());
  app.use('/api/parts', require('../routes/parts')(db));
});

// Wipe mutable tables between tests so IDs are predictable and tests are isolated.
// Projects and printers are stable seed data — leave them.
beforeEach(() => {
  db.exec(`
    DELETE FROM jobs;
    DELETE FROM gcodes;
    DELETE FROM parts;
  `);
  // Reset autoincrement counters so part IDs start at 1 each test
  db.exec(`
    DELETE FROM sqlite_sequence WHERE name IN ('jobs', 'gcodes', 'parts');
  `);
});

// ── Helpers ──────────────────────────────────────────────────────────────────

function insertPart(name = 'Widget', targetQty = 10) {
  const now = Date.now();
  const row = db.prepare(
    'INSERT INTO parts (project_id, name, target_qty, sort_order, created_at, updated_at) VALUES (1, ?, ?, 0, ?, ?)'
  ).run(name, targetQty, now, now);
  return row.lastInsertRowid;
}

function insertGcode(partId, filename) {
  const now = Date.now();
  const row = db.prepare(
    'INSERT INTO gcodes (part_id, printer_model, filename, filepath, parts_per_plate, created_at) VALUES (?, ?, ?, ?, 1, ?)'
  ).run(partId, 'mk4s', filename, filename, now);
  return row.lastInsertRowid;
}

function insertJob(partId, gcodeId, status) {
  const now = Date.now();
  const row = db.prepare(
    'INSERT INTO jobs (part_id, printer_id, gcode_id, parts_per_plate, status, created_at) VALUES (?, 1, ?, 1, ?, ?)'
  ).run(partId, gcodeId, status, now);
  return row.lastInsertRowid;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('DELETE /api/parts/:id', () => {
  test('returns 404 for an unknown id', async () => {
    const res = await request(app).delete('/api/parts/99999');
    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/not found/i);
  });

  test('returns 409 when an uploading job is in progress', async () => {
    const partId  = insertPart();
    const gcodeId = insertGcode(partId, 'test.bgcode');
    insertJob(partId, gcodeId, 'uploading');

    const res = await request(app).delete(`/api/parts/${partId}`);
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/active job/i);
    // Part must still exist
    expect(db.prepare('SELECT id FROM parts WHERE id = ?').get(partId)).toBeDefined();
  });

  test('returns 409 when a printing job is in progress', async () => {
    const partId  = insertPart();
    const gcodeId = insertGcode(partId, 'test2.bgcode');
    insertJob(partId, gcodeId, 'printing');

    const res = await request(app).delete(`/api/parts/${partId}`);
    expect(res.status).toBe(409);
    expect(db.prepare('SELECT id FROM parts WHERE id = ?').get(partId)).toBeDefined();
  });

  test('deletes the part successfully when no active jobs exist', async () => {
    const partId = insertPart();

    const res = await request(app).delete(`/api/parts/${partId}`);
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(db.prepare('SELECT id FROM parts WHERE id = ?').get(partId)).toBeUndefined();
  });

  test('deletes associated gcode DB records', async () => {
    const partId   = insertPart();
    const gcodeId1 = insertGcode(partId, 'a.bgcode');
    const gcodeId2 = insertGcode(partId, 'b.bgcode');

    await request(app).delete(`/api/parts/${partId}`);

    expect(db.prepare('SELECT id FROM gcodes WHERE id = ?').get(gcodeId1)).toBeUndefined();
    expect(db.prepare('SELECT id FROM gcodes WHERE id = ?').get(gcodeId2)).toBeUndefined();
  });

  test('removes gcode physical files from disk', async () => {
    const partId   = insertPart();
    const filename = `del_part_file_${Date.now()}.bgcode`;
    const filePath = path.join(GCODE_DIR, filename);
    fs.writeFileSync(filePath, 'fake gcode');
    insertGcode(partId, filename);

    await request(app).delete(`/api/parts/${partId}`);

    expect(fs.existsSync(filePath)).toBe(false);
  });

  test('succeeds even when gcode file is missing from disk', async () => {
    const partId = insertPart();
    insertGcode(partId, `ghost_${Date.now()}.bgcode`); // no file written

    const res = await request(app).delete(`/api/parts/${partId}`);
    expect(res.status).toBe(200);
    expect(db.prepare('SELECT id FROM parts WHERE id = ?').get(partId)).toBeUndefined();
  });

  test('deletes finished, cancelled, and failed jobs for the part', async () => {
    const partId       = insertPart();
    const gcodeId      = insertGcode(partId, 'hist.bgcode');
    const finishedId   = insertJob(partId, gcodeId, 'finished');
    const cancelledId  = insertJob(partId, gcodeId, 'cancelled');
    const failedId     = insertJob(partId, gcodeId, 'failed');

    await request(app).delete(`/api/parts/${partId}`);

    expect(db.prepare('SELECT id FROM jobs WHERE id = ?').get(finishedId)).toBeUndefined();
    expect(db.prepare('SELECT id FROM jobs WHERE id = ?').get(cancelledId)).toBeUndefined();
    expect(db.prepare('SELECT id FROM jobs WHERE id = ?').get(failedId)).toBeUndefined();
  });

  test('does not touch parts or jobs belonging to other parts', async () => {
    const partId1  = insertPart('Part 1');
    const partId2  = insertPart('Part 2');
    const gcodeId2 = insertGcode(partId2, 'p2.bgcode');
    const jobId2   = insertJob(partId2, gcodeId2, 'finished');

    await request(app).delete(`/api/parts/${partId1}`);

    expect(db.prepare('SELECT id FROM parts WHERE id = ?').get(partId2)).toBeDefined();
    expect(db.prepare('SELECT id FROM jobs  WHERE id = ?').get(jobId2)).toBeDefined();
    expect(db.prepare('SELECT id FROM gcodes WHERE id = ?').get(gcodeId2)).toBeDefined();
  });

  test('only deletes gcode files belonging to the deleted part', async () => {
    const partId1  = insertPart('Part 1');
    const partId2  = insertPart('Part 2');

    const filename1 = `p1_${Date.now()}.bgcode`;
    const filename2 = `p2_${Date.now()}.bgcode`;
    const filePath1 = path.join(GCODE_DIR, filename1);
    const filePath2 = path.join(GCODE_DIR, filename2);
    fs.writeFileSync(filePath1, 'fake');
    fs.writeFileSync(filePath2, 'fake');

    insertGcode(partId1, filename1);
    insertGcode(partId2, filename2);

    await request(app).delete(`/api/parts/${partId1}`);

    expect(fs.existsSync(filePath1)).toBe(false); // deleted
    expect(fs.existsSync(filePath2)).toBe(true);  // untouched

    // Clean up
    fs.unlinkSync(filePath2);
  });
});
