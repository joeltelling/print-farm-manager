// Tests for server/confirmCount.js and its use by POST /api/printers/:id/complete-and-decommission
// and GET /api/printers.
//
// Real trigger: an operator could apply the same "N good" correction twice. The server
// compared confirmed_qty to parts_per_plate, and the Fleet page pre-filled the full
// plate, so a printer held again against the same finished job subtracted the
// correction a second time when the operator retyped it. The fix makes confirmed_qty
// the plate's TOTAL good count when the request carries the job_id the page
// pre-filled for, and refuses (409) when that job is no longer the one being corrected.
//
// Set Ready (server/index.js) uses the same finishedConfirmTarget / applyConfirmedCount
// pair; it cannot be driven end to end here without importing the server, so its
// behavior rests on the unit cases below plus the part-ledger guard test.

const request  = require('supertest');
const express  = require('express');
const Database = require('better-sqlite3');
const partLedger   = require('../partLedger');
const confirmCount = require('../confirmCount');

jest.mock('../events', () => ({ insert: jest.fn() }));

let db;
let app;

beforeEach(() => {
  db = new Database(':memory:');
  db.exec(`
    CREATE TABLE printers (
      id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE, ip TEXT NOT NULL DEFAULT '',
      api_key TEXT NOT NULL DEFAULT '', group_name TEXT, type TEXT DEFAULT 'prusa', model TEXT NOT NULL DEFAULT 'mk4s',
      status TEXT DEFAULT 'FINISHED', is_held INTEGER DEFAULT 1, is_active INTEGER DEFAULT 1,
      decommissioned_at INTEGER, decommission_note TEXT, created_at INTEGER NOT NULL
    );
    CREATE TABLE projects (
      id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, status TEXT DEFAULT 'active',
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
    CREATE TABLE parts (
      id INTEGER PRIMARY KEY AUTOINCREMENT, project_id INTEGER NOT NULL, name TEXT NOT NULL,
      target_qty INTEGER NOT NULL, completed_qty INTEGER DEFAULT 0, status TEXT DEFAULT 'open',
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
    CREATE TABLE gcodes (
      id INTEGER PRIMARY KEY AUTOINCREMENT, part_id INTEGER NOT NULL, printer_model TEXT NOT NULL,
      filename TEXT NOT NULL, filepath TEXT NOT NULL, parts_per_plate INTEGER NOT NULL, created_at INTEGER NOT NULL
    );
    CREATE TABLE jobs (
      id INTEGER PRIMARY KEY AUTOINCREMENT, part_id INTEGER NOT NULL, printer_id INTEGER NOT NULL,
      gcode_id INTEGER, parts_per_plate INTEGER NOT NULL, status TEXT DEFAULT 'queued',
      started_at INTEGER, finished_at INTEGER, created_at INTEGER NOT NULL
    );
    CREATE TABLE printer_models (model_id TEXT PRIMARY KEY, label TEXT NOT NULL, connector TEXT NOT NULL);
    CREATE TABLE printer_groups (name TEXT PRIMARY KEY, created_at INTEGER NOT NULL);
  `);
  partLedger.ensureSchema(db);

  jest.resetModules();
  app = express();
  app.use(express.json());
  app.use('/api/printers', require('../routes/printers')(db));
});

// A part at `before + 25` with a finished 25-part plate credited through the ledger,
// on a held FINISHED printer: the state _handleFinished leaves behind.
function seedFinishedPlate({ name = 'MK4S_01', before = 0, ppp = 25 } = {}) {
  db.prepare("INSERT INTO projects (name, created_at, updated_at) VALUES ('P', 0, 0)").run();
  const projectId = db.prepare('SELECT MAX(id) AS id FROM projects').get().id;
  const partId = db.prepare(`
    INSERT INTO parts (project_id, name, target_qty, completed_qty, created_at, updated_at)
    VALUES (?, 'Bracket', 1000, ?, 0, 0)
  `).run(projectId, before).lastInsertRowid;
  const printerId = db.prepare('INSERT INTO printers (name, created_at) VALUES (?, 0)').run(name).lastInsertRowid;
  const jobId = seedJob(printerId, partId, 'finished', { ppp, finishedAt: 5000 });
  const job = db.prepare('SELECT * FROM jobs WHERE id = ?').get(jobId);
  partLedger.adjustPartQty(db, { partId, delta: ppp, source: partLedger.SOURCES.PRINT_FINISHED, job, now: 5000 });
  return { partId, printerId, jobId, job };
}

function seedJob(printerId, partId, status, { ppp = 25, startedAt = 1000, finishedAt = null } = {}) {
  return db.prepare(`
    INSERT INTO jobs (part_id, printer_id, parts_per_plate, status, started_at, finished_at, created_at)
    VALUES (?, ?, ?, ?, ?, ?, 0)
  `).run(partId, printerId, ppp, status, startedAt, finishedAt).lastInsertRowid;
}

const count = partId => db.prepare('SELECT completed_qty FROM parts WHERE id = ?').get(partId).completed_qty;
const ledgerRows = partId => db.prepare('SELECT source, delta FROM part_qty_ledger WHERE part_id = ? ORDER BY id').all(partId);

// ── finishedConfirmTarget ────────────────────────────────────────────────────

describe('finishedConfirmTarget (set-ready normal-case job rule)', () => {
  test('is the latest finished job', () => {
    const { printerId, partId } = seedFinishedPlate();
    const newer = seedJob(printerId, partId, 'finished', { finishedAt: 9000 });
    expect(confirmCount.finishedConfirmTarget(db, printerId).id).toBe(newer);
  });

  test('is null while an uploading or printing job is pending', () => {
    const { printerId, partId } = seedFinishedPlate();
    seedJob(printerId, partId, 'printing');
    expect(confirmCount.finishedConfirmTarget(db, printerId)).toBeNull();
  });

  test('is null when a job was stopped on the printer after the last finish', () => {
    const { printerId, partId } = seedFinishedPlate();
    seedJob(printerId, partId, 'cancelled', { finishedAt: 9000 });
    expect(confirmCount.finishedConfirmTarget(db, printerId)).toBeNull();
  });

  test('is null with no finished job', () => {
    const printerId = db.prepare("INSERT INTO printers (name, created_at) VALUES ('Empty', 0)").run().lastInsertRowid;
    expect(confirmCount.finishedConfirmTarget(db, printerId)).toBeNull();
  });
});

// ── applyConfirmedCount ──────────────────────────────────────────────────────

describe('applyConfirmedCount', () => {
  test('total: 24 of 25 subtracts 1, like before', () => {
    const { partId, job } = seedFinishedPlate({ before: 100 });
    const r = confirmCount.applyConfirmedCount(db, { job, confirmedQty: 24, total: true, via: 'Set Ready' });
    expect(r.delta).toBe(-1);
    expect(count(partId)).toBe(124);
  });

  test('total: confirming the same count twice applies it once', () => {
    const { partId, job } = seedFinishedPlate({ before: 100 });
    confirmCount.applyConfirmedCount(db, { job, confirmedQty: 24, total: true, via: 'Set Ready' });
    expect(confirmCount.applyConfirmedCount(db, { job, confirmedQty: 24, total: true, via: 'Set Ready' })).toBeNull();
    expect(count(partId)).toBe(124);
  });

  test('total: raising a correction back up credits only the difference', () => {
    const { partId, job } = seedFinishedPlate({ before: 100 });
    confirmCount.applyConfirmedCount(db, { job, confirmedQty: 20, total: true, via: 'Set Ready' });
    confirmCount.applyConfirmedCount(db, { job, confirmedQty: 23, total: true, via: 'Set Ready' });
    expect(count(partId)).toBe(123);
    expect(ledgerRows(partId).map(r => r.delta)).toEqual([25, -5, 3]);
  });

  test('total: the full plate on an uncorrected job changes nothing', () => {
    const { partId, job } = seedFinishedPlate({ before: 100 });
    expect(confirmCount.applyConfirmedCount(db, { job, confirmedQty: 25, total: true, via: 'Set Ready' })).toBeNull();
    expect(count(partId)).toBe(125);
  });

  test('legacy (no job_id): still compares to parts_per_plate', () => {
    const { partId, job } = seedFinishedPlate({ before: 100 });
    confirmCount.applyConfirmedCount(db, { job, confirmedQty: 24, total: false, via: 'Set Ready' });
    confirmCount.applyConfirmedCount(db, { job, confirmedQty: 24, total: false, via: 'Set Ready' });
    expect(count(partId)).toBe(123); // the old double-apply, kept for clients that send no job_id
  });

  test('ignores a missing or non-numeric count', () => {
    const { partId, job } = seedFinishedPlate();
    expect(confirmCount.applyConfirmedCount(db, { job, confirmedQty: null, total: true, via: 'x' })).toBeNull();
    expect(confirmCount.applyConfirmedCount(db, { job, confirmedQty: NaN, total: true, via: 'x' })).toBeNull();
    expect(count(partId)).toBe(25);
  });
});

// ── GET /api/printers confirm fields ─────────────────────────────────────────

describe('GET /api/printers confirm fields', () => {
  test('a held printer reports its confirm target, plate size, and current credit', async () => {
    const { printerId, partId, jobId, job } = seedFinishedPlate();
    partLedger.adjustPartQty(db, { partId, delta: -1, clamp: true, source: partLedger.SOURCES.OPERATOR_ADJUST, job });

    const res = await request(app).get('/api/printers');
    const p = res.body.find(x => x.id === printerId);
    expect(p).toMatchObject({ confirm_job_id: jobId, confirm_parts_per_plate: 25, confirm_credited: 24 });
  });

  test('an unheld printer, or one with a pending job, reports nulls', async () => {
    const a = seedFinishedPlate({ name: 'Unheld' });
    db.prepare('UPDATE printers SET is_held = 0 WHERE id = ?').run(a.printerId);
    const b = seedFinishedPlate({ name: 'Printing' });
    seedJob(b.printerId, b.partId, 'printing');

    const res = await request(app).get('/api/printers');
    for (const id of [a.printerId, b.printerId]) {
      expect(res.body.find(x => x.id === id)).toMatchObject({
        confirm_job_id: null, confirm_parts_per_plate: null, confirm_credited: null,
      });
    }
  });
});

// ── POST /api/printers/:id/complete-and-decommission with job_id ─────────────

describe('complete-and-decommission with job_id (total count)', () => {
  test('24 of 25 subtracts 1', async () => {
    const { printerId, partId, jobId } = seedFinishedPlate({ before: 100 });
    const res = await request(app).post(`/api/printers/${printerId}/complete-and-decommission`)
      .send({ confirmed_qty: 24, job_id: jobId });
    expect(res.status).toBe(200);
    expect(count(partId)).toBe(124);
  });

  test('the pre-filled count after an earlier correction changes nothing', async () => {
    const { printerId, partId, jobId, job } = seedFinishedPlate({ before: 100 });
    partLedger.adjustPartQty(db, { partId, delta: -1, clamp: true, source: partLedger.SOURCES.OPERATOR_ADJUST, job });

    const listed = (await request(app).get('/api/printers')).body.find(x => x.id === printerId);
    await request(app).post(`/api/printers/${printerId}/complete-and-decommission`)
      .send({ confirmed_qty: listed.confirm_credited, job_id: listed.confirm_job_id });

    expect(count(partId)).toBe(124);
    expect(ledgerRows(partId).map(r => r.source)).toEqual(['print_finished', 'operator_adjust']);
  });

  test('retyping the same correction does not apply it twice', async () => {
    const { printerId, partId, jobId, job } = seedFinishedPlate({ before: 100 });
    confirmCount.applyConfirmedCount(db, { job, confirmedQty: 24, total: true, via: 'Set Ready' }); // first confirm

    await request(app).post(`/api/printers/${printerId}/complete-and-decommission`)
      .send({ confirmed_qty: 24, job_id: jobId });

    expect(count(partId)).toBe(124);
  });

  test('a job_id that is no longer the target is refused with 409 and changes nothing', async () => {
    const { printerId, partId, jobId } = seedFinishedPlate({ before: 100 });
    seedJob(printerId, partId, 'finished', { finishedAt: 9000 }); // a newer finish since the page loaded

    const res = await request(app).post(`/api/printers/${printerId}/complete-and-decommission`)
      .send({ confirmed_qty: 20, job_id: jobId });

    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/Refresh/);
    expect(count(partId)).toBe(125);
    expect(db.prepare('SELECT is_active FROM printers WHERE id = ?').get(printerId).is_active).toBe(1);
  });

  test('a job_id sent while a print is pending is refused with 409', async () => {
    const { printerId, partId, jobId } = seedFinishedPlate({ before: 100 });
    seedJob(printerId, partId, 'printing');

    const res = await request(app).post(`/api/printers/${printerId}/complete-and-decommission`)
      .send({ confirmed_qty: 25, job_id: jobId });

    expect(res.status).toBe(409);
    expect(count(partId)).toBe(125);
  });

  test('without job_id the legacy behavior is unchanged', async () => {
    const { printerId, partId, job } = seedFinishedPlate({ before: 100 });
    partLedger.adjustPartQty(db, { partId, delta: -1, clamp: true, source: partLedger.SOURCES.OPERATOR_ADJUST, job });

    await request(app).post(`/api/printers/${printerId}/complete-and-decommission`).send({ confirmed_qty: 25 });

    expect(count(partId)).toBe(124); // 25 == parts_per_plate: no change, as before
  });
});
