// Tests for server/partLedger.js: the audit trail behind parts.completed_qty.
//
// Covers:
//   - adjustPartQty: delta, clamped delta (records the change that actually happened),
//     absolute setTo, printer name snapshot, unknown source, missing part
//   - The ledger always sums to completed_qty
//   - rebuildMissingLedgers: rebuilt job rows, baseline row, failed jobs not deducted,
//     never changes completed_qty, idempotent across restarts
//   - PUT /api/parts/:id records manual edits (and only real changes)
//   - Part and project deletes remove the part's ledger rows

const request  = require('supertest');
const express  = require('express');
const Database = require('better-sqlite3');
const partLedger = require('../partLedger');

const { SOURCES } = partLedger;

let db;

function makeDb() {
  const d = new Database(':memory:');
  d.pragma('foreign_keys = ON');
  d.exec(`
    CREATE TABLE printers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL, ip TEXT NOT NULL DEFAULT '', api_key TEXT NOT NULL DEFAULT '',
      model TEXT NOT NULL DEFAULT 'mk4s', created_at INTEGER NOT NULL
    );
    CREATE TABLE projects (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL, status TEXT DEFAULT 'draft',
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
    CREATE TABLE parts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id INTEGER NOT NULL REFERENCES projects(id),
      name TEXT NOT NULL, target_qty INTEGER NOT NULL, completed_qty INTEGER DEFAULT 0,
      status TEXT DEFAULT 'open', sort_order INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
    CREATE TABLE gcodes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      part_id INTEGER NOT NULL REFERENCES parts(id),
      printer_model TEXT NOT NULL, filename TEXT NOT NULL, filepath TEXT NOT NULL,
      parts_per_plate INTEGER NOT NULL, created_at INTEGER NOT NULL
    );
    CREATE TABLE jobs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      part_id INTEGER NOT NULL REFERENCES parts(id), printer_id INTEGER NOT NULL,
      gcode_id INTEGER, parts_per_plate INTEGER NOT NULL, status TEXT DEFAULT 'queued',
      started_at INTEGER, finished_at INTEGER, created_at INTEGER NOT NULL
    );
  `);
  partLedger.ensureSchema(d);
  return d;
}

function seedPrinter(name = 'Prusa_01') {
  return db.prepare('INSERT INTO printers (name, created_at) VALUES (?, ?)').run(name, Date.now()).lastInsertRowid;
}

function seedProject(status = 'active') {
  const now = Date.now();
  return db.prepare('INSERT INTO projects (name, status, created_at, updated_at) VALUES (?, ?, ?, ?)')
    .run('Project', status, now, now).lastInsertRowid;
}

function seedPart(projectId, { target = 10, completed = 0 } = {}) {
  const now = Date.now();
  return db.prepare(`
    INSERT INTO parts (project_id, name, target_qty, completed_qty, status, created_at, updated_at)
    VALUES (?, 'Bracket', ?, ?, 'open', ?, ?)
  `).run(projectId, target, completed, now, now).lastInsertRowid;
}

function seedJob(partId, printerId, { status = 'finished', ppp = 4, finishedAt = Date.now(), gcodeId = null } = {}) {
  return db.prepare(`
    INSERT INTO jobs (part_id, printer_id, gcode_id, parts_per_plate, status, started_at, finished_at, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(partId, printerId, gcodeId, ppp, status, finishedAt - 1000, finishedAt, finishedAt - 2000).lastInsertRowid;
}

function ledger(partId) {
  return db.prepare('SELECT * FROM part_qty_ledger WHERE part_id = ? ORDER BY id').all(partId);
}

function completed(partId) {
  return db.prepare('SELECT completed_qty FROM parts WHERE id = ?').get(partId).completed_qty;
}

function ledgerSum(partId) {
  return ledger(partId).reduce((s, r) => s + r.delta, 0);
}

beforeEach(() => { db = makeDb(); });

// ── adjustPartQty ─────────────────────────────────────────────────────────────

describe('adjustPartQty', () => {
  test('applies a delta, records one row with job, printer snapshot, and running total', () => {
    const printerId = seedPrinter('Bambu_07');
    const partId = seedPart(seedProject());
    const jobId = seedJob(partId, printerId, { status: 'printing', gcodeId: 3 });
    const job = db.prepare('SELECT * FROM jobs WHERE id = ?').get(jobId);

    const part = partLedger.adjustPartQty(db, {
      partId, delta: 4, source: SOURCES.PRINT_FINISHED, job, now: 1000,
    });

    expect(part.completed_qty).toBe(4);
    const rows = ledger(partId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      job_id: jobId, printer_id: printerId, printer_name: 'Bambu_07', gcode_id: 3,
      delta: 4, balance_after: 4, source: 'print_finished', created_at: 1000,
    });
  });

  test('clamped delta records the change that actually happened, not the requested one', () => {
    const partId = seedPart(seedProject(), { completed: 2 });
    partLedger.adjustPartQty(db, { partId, delta: -5, clamp: true, source: SOURCES.MARKED_FAILED });

    expect(completed(partId)).toBe(0);
    expect(ledger(partId)[0]).toMatchObject({ delta: -2, balance_after: 0 });
  });

  test('unclamped delta behaves like the old completed_qty + ? SQL', () => {
    const partId = seedPart(seedProject(), { completed: 1 });
    partLedger.adjustPartQty(db, { partId, delta: 3, source: SOURCES.OPERATOR_CONFIRM });
    expect(completed(partId)).toBe(4);
  });

  test('setTo records the difference from the previous value', () => {
    const partId = seedPart(seedProject(), { completed: 7 });
    partLedger.adjustPartQty(db, { partId, setTo: 3, source: SOURCES.MANUAL_EDIT });
    expect(completed(partId)).toBe(3);
    expect(ledger(partId)[0]).toMatchObject({ delta: -4, balance_after: 3, source: 'manual_edit' });
  });

  test('ledger sum equals completed_qty after a mixed sequence of changes', () => {
    const partId = seedPart(seedProject());
    partLedger.adjustPartQty(db, { partId, delta: 4, source: SOURCES.PRINT_FINISHED });
    partLedger.adjustPartQty(db, { partId, delta: -1, clamp: true, source: SOURCES.OPERATOR_ADJUST });
    partLedger.adjustPartQty(db, { partId, delta: -10, clamp: true, source: SOURCES.MARKED_FAILED });
    partLedger.adjustPartQty(db, { partId, setTo: 6, source: SOURCES.MANUAL_EDIT });
    partLedger.adjustPartQty(db, { partId, delta: 2, source: SOURCES.OPERATOR_CONFIRM });
    expect(completed(partId)).toBe(8);
    expect(ledgerSum(partId)).toBe(8);
    expect(ledger(partId).map(r => r.balance_after)).toEqual([4, 3, 0, 6, 8]);
  });

  test('rejects an unknown source without touching the part', () => {
    const partId = seedPart(seedProject(), { completed: 2 });
    expect(() => partLedger.adjustPartQty(db, { partId, delta: 1, source: 'guess' })).toThrow(/unknown source/);
    expect(completed(partId)).toBe(2);
  });

  test('requires exactly one of delta or setTo', () => {
    const partId = seedPart(seedProject());
    expect(() => partLedger.adjustPartQty(db, { partId, source: SOURCES.MANUAL_EDIT })).toThrow();
    expect(() => partLedger.adjustPartQty(db, { partId, delta: 1, setTo: 1, source: SOURCES.MANUAL_EDIT })).toThrow();
  });

  test('returns null and writes nothing for a missing part', () => {
    expect(partLedger.adjustPartQty(db, { partId: 999, delta: 1, source: SOURCES.PRINT_FINISHED })).toBeNull();
    expect(db.prepare('SELECT COUNT(*) AS n FROM part_qty_ledger').get().n).toBe(0);
  });
});

// ── rebuildMissingLedgers ─────────────────────────────────────────────────────

describe('rebuildMissingLedgers', () => {
  test('rebuilds finished jobs in finish order and needs no baseline when they add up', () => {
    const printerId = seedPrinter('Prusa_02');
    const partId = seedPart(seedProject(), { completed: 8 });
    seedJob(partId, printerId, { finishedAt: 2000 });
    seedJob(partId, printerId, { finishedAt: 1000 });

    const result = partLedger.rebuildMissingLedgers(db, { now: 5000 });

    expect(result).toEqual({ parts: 1, rebuiltRows: 2, baselineRows: 0 });
    const rows = ledger(partId);
    expect(rows.map(r => [r.source, r.delta, r.balance_after, r.created_at])).toEqual([
      ['rebuilt_job', 4, 4, 1000],
      ['rebuilt_job', 4, 8, 2000],
    ]);
    expect(rows[0].printer_name).toBe('Prusa_02');
  });

  test('adds one baseline row for the unrecorded difference', () => {
    const printerId = seedPrinter();
    const partId = seedPart(seedProject(), { completed: 7 }); // one 4-plate confirmed as 3
    seedJob(partId, printerId, { ppp: 4 });
    seedJob(partId, printerId, { ppp: 4 });

    partLedger.rebuildMissingLedgers(db, { now: 9000 });

    const rows = ledger(partId);
    expect(rows[rows.length - 1]).toMatchObject({
      source: 'baseline', delta: -1, balance_after: 7, created_at: 9000, job_id: null,
    });
    expect(ledgerSum(partId)).toBe(7);
  });

  test('a manually entered count with no jobs becomes a single baseline row', () => {
    const partId = seedPart(seedProject(), { completed: 12 });
    partLedger.rebuildMissingLedgers(db);
    expect(ledger(partId).map(r => [r.source, r.delta])).toEqual([['baseline', 12]]);
  });

  test('legacy done jobs count as finished', () => {
    const printerId = seedPrinter();
    const partId = seedPart(seedProject(), { completed: 8 });
    seedJob(partId, printerId, { status: 'done', finishedAt: 1000 });
    seedJob(partId, printerId, { status: 'finished', finishedAt: 2000 });

    partLedger.rebuildMissingLedgers(db);
    expect(ledger(partId).map(r => [r.source, r.delta])).toEqual([['rebuilt_job', 4], ['rebuilt_job', 4]]);
  });

  test('failed and cancelled jobs are not rebuilt as deductions', () => {
    const printerId = seedPrinter();
    const partId = seedPart(seedProject(), { completed: 4 });
    seedJob(partId, printerId, { status: 'finished' });
    seedJob(partId, printerId, { status: 'failed' });
    seedJob(partId, printerId, { status: 'cancelled' });

    partLedger.rebuildMissingLedgers(db);
    expect(ledger(partId).map(r => r.source)).toEqual(['rebuilt_job']);
  });

  test('never changes completed_qty', () => {
    const printerId = seedPrinter();
    const partId = seedPart(seedProject(), { completed: 1 });
    seedJob(partId, printerId, { ppp: 10 });
    partLedger.rebuildMissingLedgers(db);
    expect(completed(partId)).toBe(1);
    expect(ledgerSum(partId)).toBe(1);
  });

  test('parts at zero with no jobs get no rows', () => {
    const partId = seedPart(seedProject());
    expect(partLedger.rebuildMissingLedgers(db).parts).toBe(0);
    expect(ledger(partId)).toHaveLength(0);
  });

  test('is idempotent: a second run (next server start) adds nothing', () => {
    const printerId = seedPrinter();
    const partId = seedPart(seedProject(), { completed: 5 });
    seedJob(partId, printerId);
    partLedger.rebuildMissingLedgers(db);
    const first = ledger(partId);

    const again = partLedger.rebuildMissingLedgers(db);
    expect(again).toEqual({ parts: 0, rebuiltRows: 0, baselineRows: 0 });
    expect(ledger(partId)).toEqual(first);
  });

  test('skips parts already tracked by the ledger, even with finished jobs', () => {
    const printerId = seedPrinter();
    const partId = seedPart(seedProject());
    const jobId = seedJob(partId, printerId, { status: 'printing' });
    const job = db.prepare('SELECT * FROM jobs WHERE id = ?').get(jobId);
    partLedger.adjustPartQty(db, { partId, delta: 4, source: SOURCES.PRINT_FINISHED, job });
    db.prepare("UPDATE jobs SET status = 'finished' WHERE id = ?").run(jobId);

    partLedger.rebuildMissingLedgers(db);
    expect(ledger(partId)).toHaveLength(1);
    expect(ledgerSum(partId)).toBe(completed(partId));
  });
});

// ── Routes ────────────────────────────────────────────────────────────────────

function buildApp(factoryPath, mount) {
  jest.resetModules();
  const app = express();
  app.use(express.json());
  app.use(mount, require(factoryPath)(db));
  return app;
}

describe('PUT /api/parts/:id records manual edits', () => {
  test('a changed completed_qty writes one manual_edit row', async () => {
    const partId = seedPart(seedProject(), { completed: 2 });
    const app = buildApp('../routes/parts', '/api/parts');

    const res = await request(app).put(`/api/parts/${partId}`).send({ completed_qty: 6, target_qty: 10 });

    expect(res.status).toBe(200);
    expect(res.body.completed_qty).toBe(6);
    expect(ledger(partId)).toHaveLength(1);
    expect(ledger(partId)[0]).toMatchObject({
      source: 'manual_edit', delta: 4, balance_after: 6, job_id: null, printer_id: null,
      note: 'Completed count edited from 2 to 6',
    });
  });

  test('saving only the target (same completed_qty) writes no row', async () => {
    const partId = seedPart(seedProject(), { completed: 2 });
    const app = buildApp('../routes/parts', '/api/parts');

    const res = await request(app).put(`/api/parts/${partId}`).send({ completed_qty: 2, target_qty: 20 });

    expect(res.status).toBe(200);
    expect(res.body.target_qty).toBe(20);
    expect(ledger(partId)).toHaveLength(0);
  });

  test('omitting completed_qty keeps it and writes no row', async () => {
    const partId = seedPart(seedProject(), { completed: 3 });
    const app = buildApp('../routes/parts', '/api/parts');

    const res = await request(app).put(`/api/parts/${partId}`).send({ name: 'Renamed' });

    expect(res.status).toBe(200);
    expect(res.body.completed_qty).toBe(3);
    expect(ledger(partId)).toHaveLength(0);
  });
});

describe('deletes remove ledger rows', () => {
  test('DELETE /api/parts/:id removes the part ledger', async () => {
    const partId = seedPart(seedProject(), { completed: 0 });
    const otherId = seedPart(seedProject());
    partLedger.adjustPartQty(db, { partId, delta: 2, source: SOURCES.MANUAL_EDIT });
    partLedger.adjustPartQty(db, { partId: otherId, delta: 1, source: SOURCES.MANUAL_EDIT });
    const app = buildApp('../routes/parts', '/api/parts');

    const res = await request(app).delete(`/api/parts/${partId}`);

    expect(res.status).toBe(200);
    expect(ledger(partId)).toHaveLength(0);
    expect(ledger(otherId)).toHaveLength(1);
  });

  test('DELETE /api/projects/:id removes the ledger of every part in the draft project', async () => {
    const projectId = seedProject('draft');
    const partId = seedPart(projectId);
    partLedger.adjustPartQty(db, { partId, delta: 2, source: SOURCES.MANUAL_EDIT });
    const app = buildApp('../routes/projects', '/api/projects');

    const res = await request(app).delete(`/api/projects/${projectId}`);

    expect(res.status).toBe(200);
    expect(ledger(partId)).toHaveLength(0);
  });
});
