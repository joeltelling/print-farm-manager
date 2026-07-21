// Tests for the batch-dispatch wave loop: _sweepInBatches, scheduleForPrinter,
// and the fill-to-target-concurrency behavior they share.
//
// Dispatch is split into two phases (see scheduler.js's // ─── Dispatch ─── section):
//   _reserveJob(printer)            : synchronous, finds/locks a candidate job, or
//                                      returns null if there is nothing dispatchable
//                                      right now (no candidate, held, ceiling hit, etc).
//   _executeUpload(printer, resv)   : async, the real network upload.
// Most tests below mock both methods directly rather than driving real dispatch SQL,
// so they can assert on the wave loop's own control flow (sweep lock, pending-printer
// deferral, and, the point of this file's newest tests, the fill-to-target
// concurrency the operator's dispatch_batch_size setting is supposed to guarantee).
// The "ceiling interaction" describe block at the bottom is the exception: it drives
// _reserveJob for real against an in-memory schema, with only the driver mocked, to
// prove the wave loop and the per-part ceiling check still cooperate correctly.

const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

// Mocked at file scope (Jest hoists jest.mock calls) so the "ceiling interaction"
// tests at the bottom can exercise real dispatch SQL without any network I/O. The
// mocked-_reserveJob/_executeUpload tests above it never reach this driver at all.
const mockDriver = {
  uploadAndPrint: jest.fn(),
  checkIfPrinting: jest.fn(),
};
jest.mock('../drivers', () => ({
  getDriver: jest.fn(() => mockDriver),
}));

const JobScheduler = require('../scheduler');

function makeScheduler(batchSize = 10) {
  const db = new Database(':memory:');
  // Minimal schema: most tests below stub _reserveJob/_executeUpload/_waitForBatch
  // so the DB doesn't need real printers/parts/gcodes/jobs tables.
  db.exec(`CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);`);
  db.prepare("INSERT INTO settings (key, value) VALUES ('dispatch_batch_size', ?)").run(String(batchSize));
  return new JobScheduler(db, { on: () => {} });
}

const fakePrinter = (id, name = `P${id}`) => ({ id, name, model: 'mk4s' });

// ── _isSweeping flag & _pendingPrinters queue ────────────────────────────────

describe('_sweepInBatches: sweep lock', () => {
  test('sets _isSweeping true for the duration of the sweep', async () => {
    const scheduler = makeScheduler();
    const states = [];

    scheduler._reserveJob = jest.fn((printer) => {
      states.push(scheduler._isSweeping);
      return { jobId: printer.id, printer };
    });
    scheduler._executeUpload = jest.fn().mockResolvedValue(null);
    scheduler._waitForBatch = jest.fn().mockResolvedValue();

    await scheduler._sweepInBatches([fakePrinter(1)]);

    expect(states).toEqual([true]);           // true while reserving
    expect(scheduler._isSweeping).toBe(false); // false after sweep completes
  });

  test('_isSweeping is false after sweep completes normally', async () => {
    const scheduler = makeScheduler();
    scheduler._reserveJob = jest.fn((printer) => ({ jobId: printer.id, printer }));
    scheduler._executeUpload = jest.fn().mockResolvedValue(null);
    scheduler._waitForBatch = jest.fn().mockResolvedValue();

    await scheduler._sweepInBatches([fakePrinter(1)]);

    expect(scheduler._isSweeping).toBe(false);
  });

  test('_isSweeping is false even when _executeUpload rejects', async () => {
    const scheduler = makeScheduler();
    scheduler._reserveJob = jest.fn((printer) => ({ jobId: printer.id, printer }));
    scheduler._executeUpload = jest.fn().mockRejectedValue(new Error('boom'));
    scheduler._waitForBatch = jest.fn().mockResolvedValue();

    // Errors from individual uploads are caught inside _sweepInBatches
    await scheduler._sweepInBatches([fakePrinter(1)]);

    expect(scheduler._isSweeping).toBe(false);
  });

  test('_isSweeping is false even when _reserveJob throws synchronously', async () => {
    const scheduler = makeScheduler();
    scheduler._reserveJob = jest.fn(() => { throw new Error('boom'); });
    scheduler._executeUpload = jest.fn();
    scheduler._waitForBatch = jest.fn().mockResolvedValue();

    // A synchronous reservation error is treated like "no candidate": it must
    // not stall or crash the wave loop, and must not be handed to _executeUpload.
    await scheduler._sweepInBatches([fakePrinter(1)]);

    expect(scheduler._isSweeping).toBe(false);
    expect(scheduler._executeUpload).not.toHaveBeenCalled();
  });

  test('concurrent _sweepInBatches call defers printers to _pendingPrinters', async () => {
    const scheduler = makeScheduler();

    // Hold P1's upload until we've injected P2
    let releaseP1;
    const p1Gate = new Promise(r => { releaseP1 = r; });

    scheduler._reserveJob = jest.fn((printer) => ({ jobId: printer.id, printer }));
    scheduler._executeUpload = jest.fn((printer) => {
      if (printer.id === 1) return p1Gate.then(() => null);
      return Promise.resolve(null);
    });
    scheduler._waitForBatch = jest.fn().mockResolvedValue();

    const sweepPromise = scheduler._sweepInBatches([fakePrinter(1)]);

    // Sweep is now in progress (awaiting P1's upload); a second call should defer P2
    scheduler._sweepInBatches([fakePrinter(2)]);

    expect(scheduler._pendingPrinters).toHaveLength(1);
    expect(scheduler._pendingPrinters[0].id).toBe(2);

    releaseP1();
    await sweepPromise;
  });

  test('deferred printers are dispatched after the main sweep completes', async () => {
    const scheduler = makeScheduler();
    const dispatched = [];

    let releaseP1;
    const p1Gate = new Promise(r => { releaseP1 = r; });

    scheduler._reserveJob = jest.fn((printer) => ({ jobId: printer.id, printer }));
    scheduler._executeUpload = jest.fn((printer) => {
      dispatched.push(printer.id);
      if (printer.id === 1) return p1Gate.then(() => null);
      return Promise.resolve(null);
    });
    scheduler._waitForBatch = jest.fn().mockResolvedValue();

    const sweepPromise = scheduler._sweepInBatches([fakePrinter(1)]);

    // Defer P2 mid-sweep
    scheduler._sweepInBatches([fakePrinter(2)]);

    releaseP1();
    await sweepPromise;

    expect(dispatched).toEqual([1, 2]);
    expect(scheduler._isSweeping).toBe(false);
    expect(scheduler._pendingPrinters).toHaveLength(0);
  });

  test('multiple deferred printers are all dispatched at the tail', async () => {
    const scheduler = makeScheduler();
    const dispatched = [];

    let releaseP1;
    const p1Gate = new Promise(r => { releaseP1 = r; });

    scheduler._reserveJob = jest.fn((printer) => ({ jobId: printer.id, printer }));
    scheduler._executeUpload = jest.fn((printer) => {
      dispatched.push(printer.id);
      if (printer.id === 1) return p1Gate.then(() => null);
      return Promise.resolve(null);
    });
    scheduler._waitForBatch = jest.fn().mockResolvedValue();

    const sweepPromise = scheduler._sweepInBatches([fakePrinter(1)]);

    // Defer P2 and P3 via separate calls mid-sweep
    scheduler._sweepInBatches([fakePrinter(2)]);
    scheduler._sweepInBatches([fakePrinter(3)]);

    releaseP1();
    await sweepPromise;

    expect(dispatched).toEqual([1, 2, 3]);
  });

  test('_pendingPrinters is empty after sweep drains them', async () => {
    const scheduler = makeScheduler();

    let releaseP1;
    const p1Gate = new Promise(r => { releaseP1 = r; });

    scheduler._reserveJob = jest.fn((printer) => ({ jobId: printer.id, printer }));
    scheduler._executeUpload = jest.fn((printer) => {
      if (printer.id === 1) return p1Gate.then(() => null);
      return Promise.resolve(null);
    });
    scheduler._waitForBatch = jest.fn().mockResolvedValue();

    const sweepPromise = scheduler._sweepInBatches([fakePrinter(1)]);
    scheduler._sweepInBatches([fakePrinter(2)]);

    releaseP1();
    await sweepPromise;

    expect(scheduler._pendingPrinters).toHaveLength(0);
  });
});

// ── scheduleForPrinter ────────────────────────────────────────────────────────

describe('scheduleForPrinter', () => {
  test('dispatches immediately when no sweep is running', () => {
    const scheduler = makeScheduler();
    scheduler._reserveJob = jest.fn((printer) => ({ jobId: printer.id, printer }));
    scheduler._executeUpload = jest.fn().mockResolvedValue(1);
    scheduler._waitForBatch = jest.fn().mockResolvedValue();

    scheduler.scheduleForPrinter(fakePrinter(1));

    // _reserveJob runs synchronously at the top of _sweepInBatches's wave-fill
    // loop, before the first await, so by the time scheduleForPrinter returns,
    // reservation has already happened even though the sweep itself is still
    // in flight (fire-and-forget from scheduleForPrinter's point of view).
    expect(scheduler._reserveJob).toHaveBeenCalledWith(fakePrinter(1));
    expect(scheduler._pendingPrinters).toHaveLength(0);
  });

  test('defers to _pendingPrinters when a sweep is in progress', () => {
    const scheduler = makeScheduler();
    scheduler._isSweeping = true;
    scheduler._reserveJob = jest.fn();

    scheduler.scheduleForPrinter(fakePrinter(1));

    expect(scheduler._reserveJob).not.toHaveBeenCalled();
    expect(scheduler._pendingPrinters).toHaveLength(1);
    expect(scheduler._pendingPrinters[0].id).toBe(1);
  });

  test('deferred printer is dispatched when the sweep later completes', async () => {
    const scheduler = makeScheduler();
    const dispatched = [];

    let releaseP1;
    const p1Gate = new Promise(r => { releaseP1 = r; });

    scheduler._reserveJob = jest.fn((printer) => ({ jobId: printer.id, printer }));
    scheduler._executeUpload = jest.fn((printer) => {
      dispatched.push(printer.id);
      if (printer.id === 1) return p1Gate.then(() => null);
      return Promise.resolve(null);
    });
    scheduler._waitForBatch = jest.fn().mockResolvedValue();

    const sweepPromise = scheduler._sweepInBatches([fakePrinter(1)]);

    // Single set-ready mid-sweep: should be deferred
    scheduler.scheduleForPrinter(fakePrinter(2));

    releaseP1();
    await sweepPromise;

    expect(dispatched).toContain(2);
    expect(scheduler._isSweeping).toBe(false);
  });

  test('multiple scheduleForPrinter calls during a sweep all get deferred', async () => {
    const scheduler = makeScheduler();
    const dispatched = [];

    let releaseP1;
    const p1Gate = new Promise(r => { releaseP1 = r; });

    scheduler._reserveJob = jest.fn((printer) => ({ jobId: printer.id, printer }));
    scheduler._executeUpload = jest.fn((printer) => {
      dispatched.push(printer.id);
      if (printer.id === 1) return p1Gate.then(() => null);
      return Promise.resolve(null);
    });
    scheduler._waitForBatch = jest.fn().mockResolvedValue();

    const sweepPromise = scheduler._sweepInBatches([fakePrinter(1)]);

    scheduler.scheduleForPrinter(fakePrinter(2));
    scheduler.scheduleForPrinter(fakePrinter(3));
    scheduler.scheduleForPrinter(fakePrinter(4));

    expect(scheduler._pendingPrinters).toHaveLength(3);

    releaseP1();
    await sweepPromise;

    expect(dispatched).toEqual([1, 2, 3, 4]);
  });
});

// ── Fill-to-target concurrency ────────────────────────────────────────────────
// The actual bug: dispatch_batch_size is supposed to be how many printers are
// uploading/printing AT ONCE, not how many are merely considered per pass. A
// printer with no dispatchable candidate right now must not consume a slot in
// the wave: the wave must draw further into the queue until it finds enough
// real work to hit the target, or the queue runs dry.
//
// Harness: _reserveJob returns a reservation only for a chosen subset of printer
// IDs (the "real candidates"); _executeUpload tracks an in-flight counter so peak
// concurrency is directly observable. Because _reserveJob is fully synchronous,
// an entire wave's worth of reservations happens in one synchronous pass before
// any upload promise's continuation can run, so the peak counter recorded during
// that pass is the true concurrency the wave achieved, not an artifact of when a
// mocked promise happens to resolve.
function makeConcurrencyHarness({ batchSize, candidateIds }) {
  const scheduler = makeScheduler(batchSize);
  const candidateSet = new Set(candidateIds);

  let inFlight = 0;
  let peak = 0;
  const reservedOrder = [];
  const executedOrder = [];

  scheduler._reserveJob = jest.fn((printer) => {
    reservedOrder.push(printer.id);
    if (!candidateSet.has(printer.id)) return null;
    return { jobId: printer.id, printer };
  });

  scheduler._executeUpload = jest.fn((printer, reservation) => {
    executedOrder.push(printer.id);
    inFlight++;
    peak = Math.max(peak, inFlight);
    return Promise.resolve().then(() => {
      inFlight--;
      return reservation.jobId;
    });
  });

  scheduler._waitForBatch = jest.fn().mockResolvedValue();

  return {
    scheduler,
    reservedOrder,
    executedOrder,
    peak: () => peak,
  };
}

describe('_sweepInBatches: fill-to-target concurrency', () => {
  test('sparse candidates: draws past batchSize to reach real work at the tail of the queue', async () => {
    // batchSize=5, 8 printers, but only 3 have a dispatchable candidate, and none
    // of the 3 are in the first 5. This is the direct regression case for "1 of 5
    // uploading": the old fixed-chunk code only ever considered the first 5 printers
    // per pass and would have found zero real candidates in that slice.
    const printers = Array.from({ length: 8 }, (_, i) => fakePrinter(i + 1));
    const { scheduler, reservedOrder, peak } = makeConcurrencyHarness({
      batchSize: 5,
      candidateIds: [6, 7, 8],
    });

    await scheduler._sweepInBatches(printers);

    // The wave reached all 8 printers, not just the first 5.
    expect(reservedOrder).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    // All 3 real candidates uploaded concurrently within that single wave.
    expect(peak()).toBe(3);
    // One wave: the queue emptied before the target was hit.
    expect(scheduler._waitForBatch).toHaveBeenCalledTimes(1);
  });

  test('ample candidates: peak concurrency caps exactly at batchSize', async () => {
    // batchSize=5, 10 printers, all real candidates.
    const printers = Array.from({ length: 10 }, (_, i) => fakePrinter(i + 1));
    const { scheduler, peak } = makeConcurrencyHarness({
      batchSize: 5,
      candidateIds: Array.from({ length: 10 }, (_, i) => i + 1),
    });

    await scheduler._sweepInBatches(printers);

    expect(peak()).toBe(5);
    // Two waves of 5, not one wave of 10.
    expect(scheduler._waitForBatch).toHaveBeenCalledTimes(2);
  });

  test('dense candidates: never exceeds batchSize even at a smaller target', async () => {
    // batchSize=3, 6 printers, all real candidates: guards an off-by-one in the
    // wave's draw condition (activeJobIds.length < batchSize).
    const printers = Array.from({ length: 6 }, (_, i) => fakePrinter(i + 1));
    const { scheduler, executedOrder, peak } = makeConcurrencyHarness({
      batchSize: 3,
      candidateIds: [1, 2, 3, 4, 5, 6],
    });

    await scheduler._sweepInBatches(printers);

    expect(peak()).toBe(3);
    expect(executedOrder).toHaveLength(6);
    expect(scheduler._waitForBatch).toHaveBeenCalledTimes(2);
  });
});

// ── Ceiling interaction through the real wave loop ────────────────────────────
// Reproduces the reported bug end to end against real dispatch SQL (only the
// driver is mocked): dispatch_batch_size=2, printer P1 has the wrong material
// loaded (no candidate), P2-P4 all match the same part, which has room for
// exactly 2. The old fixed-chunk code would have grouped P1+P2 as one chunk:
// P1 finds nothing, P2 gets the only job in that chunk, so the first wave
// uploads to just 1 printer despite a configured concurrency of 2. The fix must
// reach P3 within that SAME wave so the full target of 2 is actually hit, while
// the per-part ceiling still allows exactly 2 jobs total and holds nothing back
// incorrectly for P4.
describe('_sweepInBatches: ceiling interaction through the real wave loop', () => {
  const GCODE_DIR = path.join(__dirname, '..', 'gcode');
  const filesToClean = [];

  beforeAll(() => {
    if (!fs.existsSync(GCODE_DIR)) fs.mkdirSync(GCODE_DIR, { recursive: true });
  });

  afterAll(() => {
    for (const p of filesToClean) {
      try { fs.unlinkSync(p); } catch (_) {}
    }
  });

  beforeEach(() => {
    mockDriver.uploadAndPrint.mockReset().mockResolvedValue(undefined);
    mockDriver.checkIfPrinting.mockReset().mockResolvedValue(false);
  });

  function makeDb() {
    const db = new Database(':memory:');
    db.exec(`
      CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE printers (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL, ip TEXT NOT NULL, api_key TEXT NOT NULL,
        model TEXT NOT NULL, type TEXT DEFAULT 'prusa',
        group_name TEXT, loaded_material TEXT, loaded_color TEXT,
        status TEXT DEFAULT 'IDLE', is_held INTEGER DEFAULT 0, is_active INTEGER DEFAULT 1,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE projects (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL, status TEXT DEFAULT 'active',
        priority INTEGER DEFAULT 0, required_material TEXT, required_color TEXT,
        allowed_groups TEXT,
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
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
        parts_per_plate INTEGER NOT NULL, ams_slot INTEGER,
        allowed_groups TEXT, required_material TEXT, required_color TEXT,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE jobs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        part_id INTEGER NOT NULL, printer_id INTEGER NOT NULL,
        gcode_id INTEGER, parts_per_plate INTEGER NOT NULL,
        status TEXT DEFAULT 'queued',
        started_at INTEGER, finished_at INTEGER, created_at INTEGER NOT NULL
      );
    `);
    return db;
  }

  test('wave fills to batchSize past a no-candidate printer, and the ceiling still caps total jobs at target_qty', async () => {
    const db = makeDb();
    const now = Date.now();

    db.prepare("INSERT INTO settings (key, value) VALUES ('dispatch_batch_size', '2')").run();

    const filename = `ceiling_wave_${now}.bgcode`;
    const filePath = path.join(GCODE_DIR, filename);
    fs.writeFileSync(filePath, 'fake gcode');
    filesToClean.push(filePath);

    db.prepare(`INSERT INTO projects (name, status, priority, created_at, updated_at)
                VALUES ('Proj', 'active', 0, ?, ?)`).run(now, now);
    // Room for exactly 2 plates of 1 part each.
    db.prepare(`INSERT INTO parts (project_id, name, target_qty, completed_qty, status, sort_order, created_at, updated_at)
                VALUES (1, 'Part A', 2, 0, 'open', 0, ?, ?)`).run(now, now);
    db.prepare(`INSERT INTO gcodes (part_id, printer_model, filename, filepath, parts_per_plate, required_material, created_at)
                VALUES (1, 'mk4s', ?, ?, 1, 'PLA', ?)`).run(filename, filename, now);

    // P1: wrong material loaded, no candidate. P2-P4: all match.
    const printerRows = [
      { name: 'P1', material: 'ABS' },
      { name: 'P2', material: 'PLA' },
      { name: 'P3', material: 'PLA' },
      { name: 'P4', material: 'PLA' },
    ].map(({ name, material }) => {
      const { lastInsertRowid } = db.prepare(`
        INSERT INTO printers (name, ip, api_key, model, type, loaded_material, status, is_held, is_active, created_at)
        VALUES (?, '192.168.1.1', 'key', 'mk4s', 'prusa', ?, 'IDLE', 0, 1, ?)
      `).run(name, material, now);
      return db.prepare('SELECT * FROM printers WHERE id = ?').get(lastInsertRowid);
    });

    const scheduler = new JobScheduler(db, { on: () => {} });
    scheduler._waitForBatch = jest.fn().mockResolvedValue();
    const reserveSpy = jest.spyOn(scheduler, '_reserveJob');

    await scheduler._sweepInBatches(printerRows);

    // All 4 printers were considered: the fix reached past P1 within the first
    // wave, and reached P4 once the queue was drawn down to it in a second wave.
    expect(reserveSpy).toHaveBeenCalledTimes(4);

    // The first (and only) wave with real work hit the full configured
    // concurrency of 2 (P2 and P3), not 1. The second wave (P4 alone) hits the
    // ceiling and reserves nothing, so it never calls _waitForBatch at all;
    // there is nothing to wait for.
    expect(scheduler._waitForBatch).toHaveBeenCalledTimes(1);
    expect(scheduler._waitForBatch.mock.calls[0][0]).toHaveLength(2);

    // Exactly 2 jobs exist for the part: the ceiling correctly stopped P4.
    const jobs = db.prepare('SELECT printer_id, status FROM jobs WHERE part_id = 1').all();
    expect(jobs).toHaveLength(2);
    const jobbedPrinterIds = jobs.map(j => j.printer_id).sort();
    expect(jobbedPrinterIds).toEqual([printerRows[1].id, printerRows[2].id].sort());

    // P1 (no matching material) and P4 (ceiling) were never held: "no candidate"
    // is not an error condition.
    const p1 = db.prepare('SELECT is_held FROM printers WHERE id = ?').get(printerRows[0].id);
    const p4 = db.prepare('SELECT is_held FROM printers WHERE id = ?').get(printerRows[3].id);
    expect(p1.is_held).toBe(0);
    expect(p4.is_held).toBe(0);
  });
});
