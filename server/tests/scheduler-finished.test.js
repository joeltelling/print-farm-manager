// Tests for scheduler._handleFinished
//
// Covers:
//   - Normal path: 'printing' job found → mark finished, increment qty, hold printer
//   - MQTT recovery: no 'printing' job but recent 'failed' job → recover + credit
//   - Session gating: a 'failed' job from a previous session is NOT recovered
//   - No job at all: warn and return cleanly
//   - Part closure: completed_qty reaching target closes the part
//   - Project completion: all parts closed → project marked completed
//   - getDriver called with printer.type (string), not the printer object

const Database    = require('better-sqlite3');
const JobScheduler = require('../scheduler');

// Mock the drivers module — _handleFinished calls getDriver for SD-card cleanup.
// mockDriver is referenced lazily inside the factory arrow function so the
// jest.mock hoisting doesn't hit the temporal dead zone for the const declaration.
const mockDriver = { deleteFile: jest.fn().mockResolvedValue(undefined) };
jest.mock('../drivers', () => ({ getDriver: jest.fn(() => mockDriver) }));
// Grab the mocked getDriver after the mock is registered so we can assert on it.
const { getDriver: mockGetDriver } = require('../drivers');

// Suppress event logging side-effects
jest.mock('../events', () => ({ insert: jest.fn() }));

afterEach(() => jest.clearAllMocks());

// ── DB + scheduler factory ────────────────────────────────────────────────────

function makeDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE printers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL, ip TEXT NOT NULL, api_key TEXT NOT NULL DEFAULT '',
      model TEXT NOT NULL, type TEXT DEFAULT 'prusa',
      status TEXT DEFAULT 'PRINTING', is_held INTEGER DEFAULT 0, is_active INTEGER DEFAULT 1,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE projects (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL, status TEXT DEFAULT 'active',
      priority INTEGER DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
    CREATE TABLE parts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id INTEGER NOT NULL, name TEXT NOT NULL,
      target_qty INTEGER NOT NULL, completed_qty INTEGER DEFAULT 0,
      status TEXT DEFAULT 'open', sort_order INTEGER DEFAULT 0,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
    CREATE TABLE gcodes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      part_id INTEGER NOT NULL, printer_model TEXT NOT NULL,
      filename TEXT NOT NULL, filepath TEXT NOT NULL,
      parts_per_plate INTEGER NOT NULL, ams_slot INTEGER, created_at INTEGER NOT NULL
    );
    CREATE TABLE jobs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      part_id INTEGER NOT NULL, printer_id INTEGER NOT NULL,
      gcode_id INTEGER, parts_per_plate INTEGER NOT NULL,
      status TEXT DEFAULT 'queued',
      started_at INTEGER, finished_at INTEGER, created_at INTEGER NOT NULL
    );
    CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    INSERT INTO settings (key, value) VALUES ('dispatch_batch_size', '10');
  `);
  return db;
}

function makeScheduler(db) {
  const scheduler = new JobScheduler(db, { on: () => {} });
  // Prevent the no-job fallback's dispatch attempt from running for real (it
  // requires a full DB candidate schema this test file's minimal tables don't have).
  scheduler.scheduleForPrinter = jest.fn();
  return scheduler;
}

// ── Seed helpers ──────────────────────────────────────────────────────────────

function seedPrinter(db, overrides = {}) {
  const now = Date.now();
  return db.prepare(`
    INSERT INTO printers (name, ip, model, type, status, is_held, is_active, created_at)
    VALUES (?, '10.0.0.1', ?, ?, 'PRINTING', 0, 1, ?)
  `).run(
    overrides.name  ?? `Printer_${now}`,
    overrides.model ?? 'mk4s',
    overrides.type  ?? 'bambu',
    now
  ).lastInsertRowid;
}

function seedProject(db) {
  const now = Date.now();
  return db.prepare(
    `INSERT INTO projects (name, status, priority, created_at, updated_at)
     VALUES ('Proj', 'active', 0, ?, ?)`
  ).run(now, now).lastInsertRowid;
}

function seedPart(db, projectId, { targetQty = 10, completedQty = 0 } = {}) {
  const now = Date.now();
  return db.prepare(
    `INSERT INTO parts (project_id, name, target_qty, completed_qty, status, sort_order, created_at, updated_at)
     VALUES (?, 'Part A', ?, ?, 'open', 0, ?, ?)`
  ).run(projectId, targetQty, completedQty, now, now).lastInsertRowid;
}

function seedGcode(db, partId) {
  const now = Date.now();
  return db.prepare(
    `INSERT INTO gcodes (part_id, printer_model, filename, filepath, parts_per_plate, created_at)
     VALUES (?, 'mk4s', 'test.bgcode', 'test.bgcode', 4, ?)`
  ).run(partId, now).lastInsertRowid;
}

function seedJob(db, printerId, partId, gcodeId, status = 'printing', { partsPerPlate = 4, startedAt, finishedAt } = {}) {
  const now = Date.now();
  // Mirror production: _handlePrinterUnavailable sets finished_at when marking
  // a job failed, and _handleFinished sets it on successful finish. Tests that
  // don't care about the precise value get "now" so the session gate is satisfied.
  const defaultFinishedAt = (status === 'finished' || status === 'failed') ? now : null;
  return db.prepare(
    `INSERT INTO jobs (printer_id, part_id, gcode_id, parts_per_plate, status, started_at, finished_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    printerId, partId, gcodeId, partsPerPlate, status,
    startedAt ?? now - 3600_000,
    finishedAt ?? defaultFinishedAt,
    now - 3600_000,
  ).lastInsertRowid;
}

function makePrinter(db, printerId) {
  return db.prepare('SELECT * FROM printers WHERE id = ?').get(printerId);
}

// ── Normal path: 'printing' job ───────────────────────────────────────────────

describe('_handleFinished — normal path (printing job)', () => {
  test('marks the job as finished', () => {
    const db         = makeDb();
    const scheduler  = makeScheduler(db);
    const projectId  = seedProject(db);
    const partId     = seedPart(db, projectId);
    const gcodeId    = seedGcode(db, partId);
    const printerId  = seedPrinter(db);
    const jobId      = seedJob(db, printerId, partId, gcodeId, 'printing');

    scheduler._handleFinished(makePrinter(db, printerId));

    const job = db.prepare('SELECT status FROM jobs WHERE id = ?').get(jobId);
    expect(job.status).toBe('finished');
  });

  test('increments completed_qty by parts_per_plate', () => {
    const db        = makeDb();
    const scheduler = makeScheduler(db);
    const projectId = seedProject(db);
    const partId    = seedPart(db, projectId, { completedQty: 2 });
    const gcodeId   = seedGcode(db, partId);
    const printerId = seedPrinter(db);
    seedJob(db, printerId, partId, gcodeId, 'printing', { partsPerPlate: 4 });

    scheduler._handleFinished(makePrinter(db, printerId));

    const part = db.prepare('SELECT completed_qty FROM parts WHERE id = ?').get(partId);
    expect(part.completed_qty).toBe(6); // 2 + 4
  });

  test('holds the printer after a successful finish', () => {
    const db        = makeDb();
    const scheduler = makeScheduler(db);
    const projectId = seedProject(db);
    const partId    = seedPart(db, projectId);
    const gcodeId   = seedGcode(db, partId);
    const printerId = seedPrinter(db);
    seedJob(db, printerId, partId, gcodeId, 'printing');

    scheduler._handleFinished(makePrinter(db, printerId));

    const printer = db.prepare('SELECT is_held FROM printers WHERE id = ?').get(printerId);
    expect(printer.is_held).toBe(1);
  });

  test('closes the part when completed_qty reaches target_qty', () => {
    const db        = makeDb();
    const scheduler = makeScheduler(db);
    const projectId = seedProject(db);
    // target = 4, completed = 0; parts_per_plate = 4 → exactly hits target
    const partId    = seedPart(db, projectId, { targetQty: 4, completedQty: 0 });
    const gcodeId   = seedGcode(db, partId);
    const printerId = seedPrinter(db);
    seedJob(db, printerId, partId, gcodeId, 'printing', { partsPerPlate: 4 });

    scheduler._handleFinished(makePrinter(db, printerId));

    const part = db.prepare('SELECT status FROM parts WHERE id = ?').get(partId);
    expect(part.status).toBe('closed');
  });

  test('marks the project completed when it is the last open part', () => {
    const db        = makeDb();
    const scheduler = makeScheduler(db);
    const projectId = seedProject(db);
    const partId    = seedPart(db, projectId, { targetQty: 4, completedQty: 0 });
    const gcodeId   = seedGcode(db, partId);
    const printerId = seedPrinter(db);
    seedJob(db, printerId, partId, gcodeId, 'printing', { partsPerPlate: 4 });

    scheduler._handleFinished(makePrinter(db, printerId));

    const project = db.prepare('SELECT status FROM projects WHERE id = ?').get(projectId);
    expect(project.status).toBe('completed');
  });

  test('does not close the project when other parts are still open', () => {
    const db        = makeDb();
    const scheduler = makeScheduler(db);
    const projectId = seedProject(db);
    const partId    = seedPart(db, projectId, { targetQty: 4, completedQty: 0 });
    // A second open part
    seedPart(db, projectId, { targetQty: 8, completedQty: 0 });
    const gcodeId   = seedGcode(db, partId);
    const printerId = seedPrinter(db);
    seedJob(db, printerId, partId, gcodeId, 'printing', { partsPerPlate: 4 });

    scheduler._handleFinished(makePrinter(db, printerId));

    const project = db.prepare('SELECT status FROM projects WHERE id = ?').get(projectId);
    expect(project.status).toBe('active');
  });

  test('calls getDriver with printer.type string, not the printer object', () => {
    const db        = makeDb();
    const scheduler = makeScheduler(db);
    const projectId = seedProject(db);
    const partId    = seedPart(db, projectId);
    const gcodeId   = seedGcode(db, partId);
    const printerId = seedPrinter(db, { type: 'bambu' });
    seedJob(db, printerId, partId, gcodeId, 'printing');

    scheduler._handleFinished(makePrinter(db, printerId));

    expect(mockGetDriver).toHaveBeenCalledWith('bambu');
    expect(mockGetDriver).not.toHaveBeenCalledWith(expect.objectContaining({ id: printerId }));
  });
});

// ── MQTT recovery: 'failed' job ───────────────────────────────────────────────
//
// Scenario: Bambu MQTT connection briefly drops during a print. The 'reconnect'
// event sets conn.connected = false, so the next getStatus() returns OFFLINE.
// _handlePrinterUnavailable marks the job 'failed'. The printer keeps printing.
// When it finishes, _handleFinished must recover the failed job and credit the count.

describe('_handleFinished — MQTT recovery (failed job, no printing job)', () => {
  test('credits completed_qty when the only recent job is failed', () => {
    const db        = makeDb();
    const scheduler = makeScheduler(db);
    const projectId = seedProject(db);
    const partId    = seedPart(db, projectId, { completedQty: 0 });
    const gcodeId   = seedGcode(db, partId);
    const printerId = seedPrinter(db);
    seedJob(db, printerId, partId, gcodeId, 'failed', { partsPerPlate: 4 });

    scheduler._handleFinished(makePrinter(db, printerId));

    const part = db.prepare('SELECT completed_qty FROM parts WHERE id = ?').get(partId);
    expect(part.completed_qty).toBe(4);
  });

  test('marks the recovered failed job as finished', () => {
    const db        = makeDb();
    const scheduler = makeScheduler(db);
    const projectId = seedProject(db);
    const partId    = seedPart(db, projectId);
    const gcodeId   = seedGcode(db, partId);
    const printerId = seedPrinter(db);
    const jobId     = seedJob(db, printerId, partId, gcodeId, 'failed');

    scheduler._handleFinished(makePrinter(db, printerId));

    const job = db.prepare('SELECT status FROM jobs WHERE id = ?').get(jobId);
    expect(job.status).toBe('finished');
  });

  test('holds the printer after recovering a failed job', () => {
    const db        = makeDb();
    const scheduler = makeScheduler(db);
    const projectId = seedProject(db);
    const partId    = seedPart(db, projectId);
    const gcodeId   = seedGcode(db, partId);
    const printerId = seedPrinter(db);
    seedJob(db, printerId, partId, gcodeId, 'failed');

    scheduler._handleFinished(makePrinter(db, printerId));

    const printer = db.prepare('SELECT is_held FROM printers WHERE id = ?').get(printerId);
    expect(printer.is_held).toBe(1);
  });

  test('closes the part when recovery pushes completed_qty to target', () => {
    const db        = makeDb();
    const scheduler = makeScheduler(db);
    const projectId = seedProject(db);
    const partId    = seedPart(db, projectId, { targetQty: 4, completedQty: 0 });
    const gcodeId   = seedGcode(db, partId);
    const printerId = seedPrinter(db);
    seedJob(db, printerId, partId, gcodeId, 'failed', { partsPerPlate: 4 });

    scheduler._handleFinished(makePrinter(db, printerId));

    const part = db.prepare('SELECT status FROM parts WHERE id = ?').get(partId);
    expect(part.status).toBe('closed');
  });

  test('prefers a printing job over a failed one when both exist', () => {
    // If somehow both exist, the printing job is the authoritative one.
    const db        = makeDb();
    const scheduler = makeScheduler(db);
    const projectId = seedProject(db);
    const partId    = seedPart(db, projectId, { completedQty: 0 });
    const gcodeId   = seedGcode(db, partId);
    const printerId = seedPrinter(db);

    const failedJobId   = seedJob(db, printerId, partId, gcodeId, 'failed',   { partsPerPlate: 4 });
    const printingJobId = seedJob(db, printerId, partId, gcodeId, 'printing', { partsPerPlate: 4 });

    scheduler._handleFinished(makePrinter(db, printerId));

    const printingJob = db.prepare('SELECT status FROM jobs WHERE id = ?').get(printingJobId);
    const failedJob   = db.prepare('SELECT status FROM jobs WHERE id = ?').get(failedJobId);
    expect(printingJob.status).toBe('finished'); // the printing job was resolved
    expect(failedJob.status).toBe('failed');     // the failed job was left alone
  });
});

// ── Session gating: stale failed jobs from prior runs are ignored ────────────
//
// Reproduces the bug: a Bambu printer in FINISHED + held state before a server
// restart reports OFFLINE on the first poll (MQTT not connected yet) and then
// FINISHED on the second poll. That OFFLINE → FINISHED transition used to fire
// _handleFinished's fallback and credit any stale 'failed' job sitting in the
// DB from an earlier session — a phantom completion.
//
// The fix gates the fallback on finished_at > scheduler.startedAt.

describe('_handleFinished — session gating (stale failed jobs must NOT credit)', () => {
  test('does not recover a failed job finished before the session started', () => {
    const db        = makeDb();
    const scheduler = makeScheduler(db);
    const projectId = seedProject(db);
    const partId    = seedPart(db, projectId, { completedQty: 0 });
    const gcodeId   = seedGcode(db, partId);
    const printerId = seedPrinter(db);

    // Session started "now"; the failed job was marked failed 1 minute earlier
    // (i.e. in a previous server run).
    const sessionStart = Date.now();
    scheduler.startedAt = sessionStart;

    seedJob(db, printerId, partId, gcodeId, 'failed', {
      finishedAt: sessionStart - 60_000,
    });

    scheduler._handleFinished(makePrinter(db, printerId));

    // Stale failed job must NOT be credited — repro of the Bambu-restart bug.
    const part = db.prepare('SELECT completed_qty FROM parts WHERE id = ?').get(partId);
    expect(part.completed_qty).toBe(0);
  });

  test('does not mark a stale failed job as finished', () => {
    const db        = makeDb();
    const scheduler = makeScheduler(db);
    const projectId = seedProject(db);
    const partId    = seedPart(db, projectId, { completedQty: 0 });
    const gcodeId   = seedGcode(db, partId);
    const printerId = seedPrinter(db);

    const sessionStart = Date.now();
    scheduler.startedAt = sessionStart;

    const jobId = seedJob(db, printerId, partId, gcodeId, 'failed', {
      finishedAt: sessionStart - 60_000,
    });

    scheduler._handleFinished(makePrinter(db, printerId));

    const job = db.prepare('SELECT status FROM jobs WHERE id = ?').get(jobId);
    expect(job.status).toBe('failed'); // untouched
  });

  test('does recover a failed job finished after the session started', () => {
    const db        = makeDb();
    const scheduler = makeScheduler(db);
    const projectId = seedProject(db);
    const partId    = seedPart(db, projectId, { completedQty: 0 });
    const gcodeId   = seedGcode(db, partId);
    const printerId = seedPrinter(db);

    // Session started 1 second ago; the job was marked failed just now
    // (legitimate transient-MQTT-disconnect recovery scenario).
    const sessionStart = Date.now() - 1000;
    scheduler.startedAt = sessionStart;

    seedJob(db, printerId, partId, gcodeId, 'failed', {
      partsPerPlate: 4,
      finishedAt: Date.now(),
    });

    scheduler._handleFinished(makePrinter(db, printerId));

    const part = db.prepare('SELECT completed_qty FROM parts WHERE id = ?').get(partId);
    expect(part.completed_qty).toBe(4);
  });
});

// ── No job found ──────────────────────────────────────────────────────────────

describe('_handleFinished — no job found', () => {
  test('does not throw when no printing or failed job exists', () => {
    const db        = makeDb();
    const scheduler = makeScheduler(db);
    const printerId = seedPrinter(db);

    expect(() => scheduler._handleFinished(makePrinter(db, printerId))).not.toThrow();
  });

  test('does not modify completed_qty when no job is found', () => {
    const db        = makeDb();
    const scheduler = makeScheduler(db);
    const projectId = seedProject(db);
    const partId    = seedPart(db, projectId, { completedQty: 5 });
    const printerId = seedPrinter(db);
    // No job seeded

    scheduler._handleFinished(makePrinter(db, printerId));

    const part = db.prepare('SELECT completed_qty FROM parts WHERE id = ?').get(partId);
    expect(part.completed_qty).toBe(5); // unchanged
  });

  // Regression test for the printerIdle/no-job-found bypass reported on the real
  // farm: this fallback used to call _dispatchToPrinter directly, skipping the
  // _isSweeping gate entirely, so a printer finishing with no tracked job could
  // dispatch concurrently with an in-progress batch sweep and push peak
  // concurrency past dispatch_batch_size. It must now route through
  // scheduleForPrinter like every other dispatch trigger.
  test('defers to the tail of an in-progress sweep instead of dispatching concurrently', () => {
    const db        = makeDb();
    // Construct directly (not via makeScheduler) so the real scheduleForPrinter
    // runs: its _isSweeping early-return does no DB/dispatch work, so this stays
    // safe against the minimal schema while proving the routing is correct.
    const scheduler = new JobScheduler(db, { on: () => {} });
    const printerId = seedPrinter(db);
    scheduler._isSweeping = true;

    scheduler._handleFinished(makePrinter(db, printerId));

    expect(scheduler._pendingPrinters).toHaveLength(1);
    expect(scheduler._pendingPrinters[0].id).toBe(printerId);
  });
});

// ── Part ledger (audit trail) ─────────────────────────────────────────────────
//
// _handleFinished is the only automatic credit path. Each real FINISHED event must
// leave exactly one ledger row, and nothing that CLAUDE.md's "phantom part credit" and
// "stale-status replay" rules guard against (a repeated FINISHED poll, a restart with a
// printer still reporting FINISHED, a stale failed job) may write one.

describe('_handleFinished: part ledger', () => {
  function ledgerRows(db, partId) {
    require('../partLedger').ensureSchema(db);
    return db.prepare('SELECT * FROM part_qty_ledger WHERE part_id = ? ORDER BY id').all(partId);
  }

  test('records one print_finished row with job, printer, gcode, and running total', () => {
    const db        = makeDb();
    const scheduler = makeScheduler(db);
    const partId    = seedPart(db, seedProject(db), { completedQty: 2 });
    const gcodeId   = seedGcode(db, partId);
    const printerId = seedPrinter(db, { name: 'Bambu_12' });
    const jobId     = seedJob(db, printerId, partId, gcodeId, 'printing', { partsPerPlate: 4 });

    scheduler._handleFinished(makePrinter(db, printerId));

    const rows = ledgerRows(db, partId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      job_id: jobId, printer_id: printerId, printer_name: 'Bambu_12', gcode_id: gcodeId,
      delta: 4, balance_after: 6, source: 'print_finished', note: null,
    });
  });

  test('a repeated FINISHED poll for the same print writes no second row', () => {
    const db        = makeDb();
    const scheduler = makeScheduler(db);
    const partId    = seedPart(db, seedProject(db));
    const gcodeId   = seedGcode(db, partId);
    const printerId = seedPrinter(db);
    seedJob(db, printerId, partId, gcodeId, 'printing');

    scheduler._handleFinished(makePrinter(db, printerId));
    scheduler._handleFinished(makePrinter(db, printerId));

    expect(ledgerRows(db, partId)).toHaveLength(1);
    expect(db.prepare('SELECT completed_qty FROM parts WHERE id = ?').get(partId).completed_qty).toBe(4);
  });

  test('a restart with the printer still reporting FINISHED writes no second row', () => {
    const db        = makeDb();
    const partId    = seedPart(db, seedProject(db));
    const gcodeId   = seedGcode(db, partId);
    const printerId = seedPrinter(db);
    seedJob(db, printerId, partId, gcodeId, 'printing');

    makeScheduler(db)._handleFinished(makePrinter(db, printerId));

    // New process: fresh scheduler, same DB, printer latched on FINISHED.
    const restarted = makeScheduler(db);
    restarted.startedAt = Date.now() + 1;
    restarted._handleFinished(makePrinter(db, printerId));

    expect(ledgerRows(db, partId)).toHaveLength(1);
  });

  test('MQTT recovery of a failed job this session is recorded with an explanatory note', () => {
    const db        = makeDb();
    const scheduler = makeScheduler(db);
    scheduler.startedAt = Date.now() - 1000;
    const partId    = seedPart(db, seedProject(db));
    const gcodeId   = seedGcode(db, partId);
    const printerId = seedPrinter(db);
    seedJob(db, printerId, partId, gcodeId, 'failed', { finishedAt: Date.now() });

    scheduler._handleFinished(makePrinter(db, printerId));

    const rows = ledgerRows(db, partId);
    expect(rows).toHaveLength(1);
    expect(rows[0].source).toBe('print_finished');
    expect(rows[0].note).toMatch(/connection drop/);
  });

  test('a stale failed job from a previous session writes no row', () => {
    const db        = makeDb();
    const scheduler = makeScheduler(db);
    scheduler.startedAt = Date.now();
    const partId    = seedPart(db, seedProject(db));
    const gcodeId   = seedGcode(db, partId);
    const printerId = seedPrinter(db);
    seedJob(db, printerId, partId, gcodeId, 'failed', { finishedAt: scheduler.startedAt - 60_000 });

    scheduler._handleFinished(makePrinter(db, printerId));

    expect(ledgerRows(db, partId)).toHaveLength(0);
  });
});
