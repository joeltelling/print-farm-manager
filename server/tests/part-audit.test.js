// Tests for GET /api/parts/:id/audit (partLedger.getPartAudit): the data behind the
// part audit page.
//
// Covers: 404, ledger entries joined to job/gcode/printer details in time order,
// uncredited failures (and what must NOT count as one), the per-printer summary,
// deleted printers and gcodes, and the reconciliation flag.

const request  = require('supertest');
const express  = require('express');
const Database = require('better-sqlite3');
const partLedger = require('../partLedger');

const { SOURCES } = partLedger;

let db;
let app;

beforeEach(() => {
  db = new Database(':memory:');
  db.exec(`
    CREATE TABLE printers (
      id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, created_at INTEGER NOT NULL
    );
    CREATE TABLE projects (
      id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, status TEXT DEFAULT 'active',
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
    CREATE TABLE parts (
      id INTEGER PRIMARY KEY AUTOINCREMENT, project_id INTEGER NOT NULL, name TEXT NOT NULL,
      target_qty INTEGER NOT NULL, completed_qty INTEGER DEFAULT 0, status TEXT DEFAULT 'open',
      sort_order INTEGER DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
    CREATE TABLE gcodes (
      id INTEGER PRIMARY KEY AUTOINCREMENT, part_id INTEGER NOT NULL, printer_model TEXT NOT NULL,
      filename TEXT NOT NULL, filepath TEXT NOT NULL, parts_per_plate INTEGER NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE jobs (
      id INTEGER PRIMARY KEY AUTOINCREMENT, part_id INTEGER NOT NULL, printer_id INTEGER NOT NULL,
      gcode_id INTEGER, parts_per_plate INTEGER NOT NULL, status TEXT DEFAULT 'queued',
      started_at INTEGER, finished_at INTEGER, created_at INTEGER NOT NULL
    );
  `);
  partLedger.ensureSchema(db);

  jest.resetModules();
  app = express();
  app.use(express.json());
  app.use('/api/parts', require('../routes/parts')(db));
});

function seedPrinter(name) {
  return db.prepare('INSERT INTO printers (name, created_at) VALUES (?, 0)').run(name).lastInsertRowid;
}

function seedPart(completed = 0) {
  db.prepare("INSERT INTO projects (name, created_at, updated_at) VALUES ('Organizer Set', 0, 0)").run();
  const projectId = db.prepare('SELECT MAX(id) AS id FROM projects').get().id;
  return db.prepare(`
    INSERT INTO parts (project_id, name, target_qty, completed_qty, created_at, updated_at)
    VALUES (?, '2x4 Bin', 20, ?, 0, 0)
  `).run(projectId, completed).lastInsertRowid;
}

function seedGcode(partId, filename = 'bin_2x4.bgcode') {
  return db.prepare(`
    INSERT INTO gcodes (part_id, printer_model, filename, filepath, parts_per_plate, created_at)
    VALUES (?, 'mk4s', ?, ?, 4, 0)
  `).run(partId, filename, filename).lastInsertRowid;
}

function seedJob(partId, printerId, gcodeId, status, { startedAt = 100, finishedAt = 200, ppp = 4 } = {}) {
  const id = db.prepare(`
    INSERT INTO jobs (part_id, printer_id, gcode_id, parts_per_plate, status, started_at, finished_at, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 0)
  `).run(partId, printerId, gcodeId, ppp, status, startedAt, finishedAt).lastInsertRowid;
  return db.prepare('SELECT * FROM jobs WHERE id = ?').get(id);
}

function credit(partId, job, delta, source, now) {
  partLedger.adjustPartQty(db, { partId, delta, source, job, clamp: delta < 0, now });
}

describe('GET /api/parts/:id/audit', () => {
  test('returns 404 for an unknown part', async () => {
    const res = await request(app).get('/api/parts/999/audit');
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('Part not found');
  });

  test('returns the part, project, and entries in time order with job and gcode details', async () => {
    const partId = seedPart();
    const gcodeId = seedGcode(partId);
    const p1 = seedPrinter('MK4S_01');
    const p2 = seedPrinter('MK4S_02');
    const jobB = seedJob(partId, p2, gcodeId, 'printing', { finishedAt: null });
    const jobA = seedJob(partId, p1, gcodeId, 'printing', { finishedAt: null });
    credit(partId, jobB, 4, SOURCES.PRINT_FINISHED, 2000);
    credit(partId, jobA, 4, SOURCES.PRINT_FINISHED, 1000);

    const res = await request(app).get(`/api/parts/${partId}/audit`);

    expect(res.status).toBe(200);
    expect(res.body.part).toMatchObject({ id: partId, name: '2x4 Bin', target_qty: 20, completed_qty: 8 });
    expect(res.body.project).toMatchObject({ name: 'Organizer Set', status: 'active' });
    expect(res.body.entries.map(e => [e.created_at, e.printer_name])).toEqual([[1000, 'MK4S_01'], [2000, 'MK4S_02']]);
    expect(res.body.entries[0]).toMatchObject({
      source: 'print_finished', delta: 4, job_id: jobA.id, gcode_filename: 'bin_2x4.bgcode',
      parts_per_plate: 4, printer_exists: true, printer_current_name: 'MK4S_01',
    });
    // balance_after reflects write order, which is what actually happened to the count.
    expect(res.body.entries.map(e => e.balance_after)).toEqual([8, 4]);
  });

  test('lists uncredited failures, excluding never-started and already-ledgered jobs', async () => {
    const partId = seedPart();
    const gcodeId = seedGcode(partId);
    const printer = seedPrinter('Bambu_03');

    const failedPrinting = seedJob(partId, printer, gcodeId, 'failed', { startedAt: 100, finishedAt: null });
    const stopped = seedJob(partId, printer, gcodeId, 'cancelled', { startedAt: 300, finishedAt: 400 });
    seedJob(partId, printer, gcodeId, 'cancelled', { startedAt: null, finishedAt: null }); // queued, part closed
    const creditedThenFailed = seedJob(partId, printer, gcodeId, 'printing');
    credit(partId, creditedThenFailed, 4, SOURCES.PRINT_FINISHED, 500);
    credit(partId, creditedThenFailed, -4, SOURCES.MARKED_FAILED, 600);
    db.prepare("UPDATE jobs SET status = 'failed' WHERE id = ?").run(creditedThenFailed.id);

    const res = await request(app).get(`/api/parts/${partId}/audit`);

    expect(res.body.uncredited_failures.map(f => [f.job_id, f.status, f.created_at])).toEqual([
      [failedPrinting.id, 'failed', 100],
      [stopped.id, 'cancelled', 400],
    ]);
    expect(res.body.uncredited_failures[0]).toMatchObject({
      printer_name: 'Bambu_03', gcode_filename: 'bin_2x4.bgcode', parts_per_plate: 4, printer_exists: true,
    });
  });

  test('summarizes by printer: plates, added, removed, net, failed plates; manual rows grouped last', async () => {
    const partId = seedPart();
    const gcodeId = seedGcode(partId);
    const p1 = seedPrinter('MK4S_01');
    const p2 = seedPrinter('MK4S_02');

    credit(partId, seedJob(partId, p1, gcodeId, 'printing'), 4, SOURCES.PRINT_FINISHED, 1);
    const j2 = seedJob(partId, p1, gcodeId, 'printing');
    credit(partId, j2, 4, SOURCES.PRINT_FINISHED, 2);
    credit(partId, j2, -1, SOURCES.OPERATOR_ADJUST, 3);
    const j3 = seedJob(partId, p2, gcodeId, 'printing');
    credit(partId, j3, 4, SOURCES.PRINT_FINISHED, 4);
    credit(partId, j3, -4, SOURCES.MARKED_FAILED, 5);
    seedJob(partId, p2, gcodeId, 'failed', { startedAt: 6, finishedAt: 7 });
    partLedger.adjustPartQty(db, { partId, delta: 2, source: SOURCES.MANUAL_EDIT, now: 8 });

    const res = await request(app).get(`/api/parts/${partId}/audit`);

    expect(res.body.printers).toEqual([
      { printer_id: p1, printer_name: 'MK4S_01', printer_exists: true, plates: 2, added: 8, removed: 1, net: 7, failed_plates: 0 },
      { printer_id: p2, printer_name: 'MK4S_02', printer_exists: true, plates: 1, added: 4, removed: 4, net: 0, failed_plates: 2 },
      { printer_id: null, printer_name: null, printer_exists: false, plates: 0, added: 2, removed: 0, net: 2, failed_plates: 0 },
    ]);
  });

  test('keeps the snapshot name and flags a deleted printer; tolerates a deleted gcode', async () => {
    const partId = seedPart();
    const gcodeId = seedGcode(partId);
    const printer = seedPrinter('Old_Voron');
    credit(partId, seedJob(partId, printer, gcodeId, 'printing'), 4, SOURCES.PRINT_FINISHED, 1);
    db.prepare('DELETE FROM printers WHERE id = ?').run(printer);
    db.prepare('DELETE FROM gcodes WHERE id = ?').run(gcodeId);

    const res = await request(app).get(`/api/parts/${partId}/audit`);

    expect(res.body.entries[0]).toMatchObject({
      printer_name: 'Old_Voron', printer_exists: false, printer_current_name: null, gcode_filename: null,
    });
    expect(res.body.printers[0]).toMatchObject({ printer_name: 'Old_Voron', printer_exists: false });
  });

  test('uses the printer current name in the summary after a rename', async () => {
    const partId = seedPart();
    const printer = seedPrinter('MK4S_09');
    credit(partId, seedJob(partId, printer, null, 'printing'), 4, SOURCES.PRINT_FINISHED, 1);
    db.prepare("UPDATE printers SET name = 'MK4S_09 (bay 3)' WHERE id = ?").run(printer);

    const res = await request(app).get(`/api/parts/${partId}/audit`);

    expect(res.body.entries[0].printer_name).toBe('MK4S_09');
    expect(res.body.entries[0].printer_current_name).toBe('MK4S_09 (bay 3)');
    expect(res.body.printers[0].printer_name).toBe('MK4S_09 (bay 3)');
  });

  test('reconciliation matches when the ledger adds up and flags a drift', async () => {
    const partId = seedPart();
    partLedger.adjustPartQty(db, { partId, delta: 5, source: SOURCES.MANUAL_EDIT });

    let res = await request(app).get(`/api/parts/${partId}/audit`);
    expect(res.body.reconciliation).toEqual({ ledger_sum: 5, completed_qty: 5, matches: true });

    // Simulate a write that bypassed the ledger.
    db.prepare('UPDATE parts SET completed_qty = 7 WHERE id = ?').run(partId);
    res = await request(app).get(`/api/parts/${partId}/audit`);
    expect(res.body.reconciliation).toEqual({ ledger_sum: 5, completed_qty: 7, matches: false });
  });

  test('a part with no history returns empty lists', async () => {
    const partId = seedPart();
    const res = await request(app).get(`/api/parts/${partId}/audit`);
    expect(res.status).toBe(200);
    expect(res.body.entries).toEqual([]);
    expect(res.body.uncredited_failures).toEqual([]);
    expect(res.body.printers).toEqual([]);
    expect(res.body.reconciliation.matches).toBe(true);
  });
});
