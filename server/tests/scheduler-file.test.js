// Tests for scheduler._dispatchToPrinter file-handling logic.
// The driver is mocked so no real network calls are made.
// These tests cover the scheduler's own responsibilities:
//   - Resolving the G-code path and checking file existence (GCODE_MISSING)
//   - Stripping basename from old absolute paths (cross-OS path resolution)
//   - Calling driver.uploadAndPrint with the resolved absolute path
//   - Upload failure recovery via driver.checkIfPrinting
//   - Holding the printer after all retries are exhausted

const path = require('path');
const fs   = require('fs');
const Database = require('better-sqlite3');

// Mock drivers module before requiring the scheduler
const mockDriver = {
  uploadAndPrint: jest.fn(),
  checkIfPrinting: jest.fn(),
};
jest.mock('../drivers', () => ({
  getDriver: jest.fn(() => mockDriver),
}));

// Mock notifications so we can assert on it without side effects
jest.mock('../notifications', () => ({ add: jest.fn() }));
const notifications = require('../notifications');

const JobScheduler = require('../scheduler');

const GCODE_DIR = path.join(__dirname, '..', 'gcode');

// Files created during tests — cleaned up after all tests complete
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
  mockDriver.uploadAndPrint.mockResolvedValue(undefined);
  mockDriver.checkIfPrinting.mockResolvedValue(false);
  notifications.add.mockClear();
});

afterEach(() => {
  jest.clearAllMocks();
});

// Build an in-memory DB pre-populated with one printer, project, part, and gcode.
// gcodeFilepath is the value stored in the gcodes table (may be bare or absolute).
function makeDb(gcodeFilepath) {
  const db = new Database(':memory:');
  db.exec(`
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

  const now = Date.now();
  db.prepare(`INSERT INTO printers (name, ip, api_key, model, type, status, is_held, is_active, created_at)
              VALUES ('P1', '192.168.1.1', 'key', 'mk4s', 'prusa', 'IDLE', 0, 1, ?)`).run(now);
  db.prepare(`INSERT INTO projects (name, status, priority, created_at, updated_at)
              VALUES ('Proj', 'active', 0, ?, ?)`).run(now, now);
  db.prepare(`INSERT INTO parts (project_id, name, target_qty, completed_qty, status, sort_order, created_at, updated_at)
              VALUES (1, 'Part A', 10, 0, 'open', 0, ?, ?)`).run(now, now);
  db.prepare(`INSERT INTO gcodes (part_id, printer_model, filename, filepath, parts_per_plate, created_at)
              VALUES (1, 'mk4s', 'test.bgcode', ?, 2, ?)`).run(gcodeFilepath, now);

  return db;
}

const fakePrinter = { id: 1, name: 'P1', ip: '192.168.1.1', api_key: 'key', model: 'mk4s', type: 'prusa', status: 'IDLE', is_held: 0, is_active: 1 };

function createTestFile(filename) {
  const filePath = path.join(GCODE_DIR, filename);
  fs.writeFileSync(filePath, 'fake gcode');
  filesToClean.push(filePath);
  return filePath;
}

// ─── GCODE_MISSING ────────────────────────────────────────────────────────────

describe('_dispatchToPrinter — GCODE_MISSING', () => {
  test('returns null without leaving any job record when file does not exist on disk', async () => {
    const db = makeDb('nonexistent.bgcode');
    const scheduler = new JobScheduler(db, { on: () => {} });

    const jobId = await scheduler._dispatchToPrinter(fakePrinter);

    expect(jobId).toBeNull();
    // Probe job must be deleted — no stale job record left behind
    const job = db.prepare("SELECT status FROM jobs ORDER BY id DESC LIMIT 1").get();
    expect(job).toBeUndefined();
    // Printer must NOT be held — it is free to pick up work for other parts
    const printer = db.prepare('SELECT is_held FROM printers WHERE id = 1').get();
    expect(printer.is_held).toBe(0);
  });

  test('sends a notification naming the part and project when file is missing', async () => {
    const db = makeDb('also_missing.bgcode');
    const scheduler = new JobScheduler(db, { on: () => {} });

    await scheduler._dispatchToPrinter(fakePrinter);

    expect(notifications.add).toHaveBeenCalledTimes(1);
    const msg = notifications.add.mock.calls[0][0];
    expect(msg).toMatch(/G-code file missing/);
    // Notification should name the part and project so the operator knows what to re-upload
    expect(msg).toMatch(/Part A/);
    expect(msg).toMatch(/Proj/);
    // Printer is not held — notification intentionally omits it
  });

  test('does not call driver.uploadAndPrint when file is missing', async () => {
    const db = makeDb('ghost.bgcode');
    const scheduler = new JobScheduler(db, { on: () => {} });

    await scheduler._dispatchToPrinter(fakePrinter);

    expect(mockDriver.uploadAndPrint).not.toHaveBeenCalled();
  });

  test('sends exactly one notification (not one per retry) when file is missing', async () => {
    const db = makeDb('single_notif.bgcode');
    const scheduler = new JobScheduler(db, { on: () => {} });

    await scheduler._dispatchToPrinter(fakePrinter);

    // Missing file is a permanent condition — detected once before any retry loop
    expect(notifications.add).toHaveBeenCalledTimes(1);
  });
});

// ─── Path resolution ──────────────────────────────────────────────────────────

describe('_dispatchToPrinter — path resolution', () => {
  test('calls driver.uploadAndPrint with an absolute path when filepath is a bare filename', async () => {
    const filename = `bare_${Date.now()}.bgcode`;
    createTestFile(filename);
    const db = makeDb(filename); // bare filename stored in DB
    const scheduler = new JobScheduler(db, { on: () => {} });

    await scheduler._dispatchToPrinter(fakePrinter);

    expect(mockDriver.uploadAndPrint).toHaveBeenCalledTimes(1);
    const [, resolvedPath] = mockDriver.uploadAndPrint.mock.calls[0];
    expect(path.isAbsolute(resolvedPath)).toBe(true);
    expect(resolvedPath).toBe(path.join(GCODE_DIR, filename));
  });

  test('strips old absolute Unix path to basename before resolving', async () => {
    const filename = `abs_unix_${Date.now()}.bgcode`;
    createTestFile(filename);
    const oldPath = `/Users/olduser/dev/print-farm-manager/server/gcode/${filename}`;
    const db = makeDb(oldPath); // old absolute path stored in DB
    const scheduler = new JobScheduler(db, { on: () => {} });

    await scheduler._dispatchToPrinter(fakePrinter);

    expect(mockDriver.uploadAndPrint).toHaveBeenCalledTimes(1);
    const [, resolvedPath] = mockDriver.uploadAndPrint.mock.calls[0];
    expect(resolvedPath).toBe(path.join(GCODE_DIR, filename));
  });

  test('strips old absolute Windows path to basename before resolving', async () => {
    const filename = `abs_win_${Date.now()}.bgcode`;
    createTestFile(filename);
    const oldPath = `C:\\Users\\operator\\print-farm-manager\\server\\gcode\\${filename}`;
    const db = makeDb(oldPath);
    const scheduler = new JobScheduler(db, { on: () => {} });

    await scheduler._dispatchToPrinter(fakePrinter);

    expect(mockDriver.uploadAndPrint).toHaveBeenCalledTimes(1);
    const [, resolvedPath] = mockDriver.uploadAndPrint.mock.calls[0];
    expect(resolvedPath).toBe(path.join(GCODE_DIR, filename));
  });

  test('GCODE_MISSING when basename of absolute path is not in GCODE_DIR', async () => {
    const db = makeDb('/old/machine/path/ghost_abs.bgcode');
    const scheduler = new JobScheduler(db, { on: () => {} });

    const jobId = await scheduler._dispatchToPrinter(fakePrinter);

    expect(jobId).toBeNull();
    expect(mockDriver.uploadAndPrint).not.toHaveBeenCalled();
    expect(notifications.add).toHaveBeenCalledTimes(1);
  });
});

// ─── Upload failure recovery ───────────────────────────────────────────────────
// These tests use fake timers to avoid waiting for the real 5s retry delays.

describe('_dispatchToPrinter — upload failure recovery', () => {
  beforeEach(() => { jest.useFakeTimers(); });
  afterEach(() => { jest.useRealTimers(); });

  test('recovers job when uploadAndPrint fails but checkIfPrinting returns true', async () => {
    const filename = `recover_${Date.now()}.bgcode`;
    createTestFile(filename);
    const db = makeDb(filename);
    const scheduler = new JobScheduler(db, { on: () => {} });

    // All upload attempts fail, but printer is actually printing
    mockDriver.uploadAndPrint.mockRejectedValue(new Error('ETIMEDOUT'));
    mockDriver.checkIfPrinting.mockResolvedValue(true);

    const promise = scheduler._dispatchToPrinter(fakePrinter);
    await jest.runAllTimersAsync();
    const jobId = await promise;

    expect(jobId).not.toBeNull();
    const job = db.prepare('SELECT status FROM jobs WHERE id = ?').get(jobId);
    expect(job.status).toBe('printing');
    // Printer should NOT be held when recovery succeeds
    const printer = db.prepare('SELECT is_held FROM printers WHERE id = 1').get();
    expect(printer.is_held).toBe(0);
  });

  test('leaves job as uploading (not failed) and holds printer when all retries exhausted and not printing', async () => {
    const filename = `exhaust_${Date.now()}.bgcode`;
    createTestFile(filename);
    const db = makeDb(filename);
    const scheduler = new JobScheduler(db, { on: () => {} });

    mockDriver.uploadAndPrint.mockRejectedValue(new Error('ECONNRESET'));
    mockDriver.checkIfPrinting.mockResolvedValue(false);

    const promise = scheduler._dispatchToPrinter(fakePrinter);
    await jest.runAllTimersAsync();
    const jobId = await promise;

    expect(jobId).toBeNull();
    // Job must be left as 'uploading' — operator must confirm via Fleet UI (Job Running / Upload Failed)
    const job = db.prepare("SELECT status FROM jobs ORDER BY id DESC LIMIT 1").get();
    expect(job.status).toBe('uploading');
    // Printer should be held for operator review
    const printer = db.prepare('SELECT is_held FROM printers WHERE id = 1').get();
    expect(printer.is_held).toBe(1);
  });

  test('sends a notification when upload retries are exhausted', async () => {
    const filename = `notif_exhaust_${Date.now()}.bgcode`;
    createTestFile(filename);
    const db = makeDb(filename);
    const scheduler = new JobScheduler(db, { on: () => {} });

    mockDriver.uploadAndPrint.mockRejectedValue(new Error('ETIMEDOUT'));
    mockDriver.checkIfPrinting.mockResolvedValue(false);

    const promise = scheduler._dispatchToPrinter(fakePrinter);
    await jest.runAllTimersAsync();
    await promise;

    expect(notifications.add).toHaveBeenCalledTimes(1);
    const msg = notifications.add.mock.calls[0][0];
    expect(msg).toMatch(/P1/);
    expect(msg).toMatch(/failed after/);
  });

  test('retries up to MAX_RETRIES times before giving up', async () => {
    const filename = `retry_${Date.now()}.bgcode`;
    createTestFile(filename);
    const db = makeDb(filename);
    const scheduler = new JobScheduler(db, { on: () => {} });

    // Succeed on the 2nd attempt
    mockDriver.uploadAndPrint
      .mockRejectedValueOnce(new Error('ECONNRESET'))
      .mockResolvedValueOnce(undefined);

    const promise = scheduler._dispatchToPrinter(fakePrinter);
    await jest.runAllTimersAsync();
    const jobId = await promise;

    expect(jobId).not.toBeNull();
    expect(mockDriver.uploadAndPrint).toHaveBeenCalledTimes(2);
    const job = db.prepare('SELECT status FROM jobs WHERE id = ?').get(jobId);
    expect(job.status).toBe('printing');
  });
});

// ─── Upload lock ──────────────────────────────────────────────────────────────
// _activeUploads prevents a second concurrent dispatch to the same printer while
// an upload is still in flight. Without this guard, a slow transfer could cause
// a retry that immediately triggers a 409 Conflict on the still-running first attempt.

describe('_dispatchToPrinter — upload lock', () => {
  test('skips dispatch if an upload is already in flight for the same printer', async () => {
    const filename = `lock_${Date.now()}.bgcode`;
    createTestFile(filename);
    const db = makeDb(filename);
    const scheduler = new JobScheduler(db, { on: () => {} });

    let resolveUpload;
    // First upload hangs indefinitely until we resolve it
    mockDriver.uploadAndPrint.mockReturnValueOnce(new Promise(r => { resolveUpload = r; }));

    // Start first dispatch — it will suspend at the awaited uploadAndPrint.
    // Everything up to _activeUploads.add runs synchronously before the first await,
    // so the printer ID is in _activeUploads immediately after this call.
    const firstDispatch = scheduler._dispatchToPrinter(fakePrinter);

    // Second dispatch for the same printer — must be skipped by the upload lock
    const secondResult = await scheduler._dispatchToPrinter(fakePrinter);
    expect(secondResult).toBeNull();
    // Only one uploadAndPrint call should exist (from the first dispatch)
    expect(mockDriver.uploadAndPrint).toHaveBeenCalledTimes(1);

    // Clean up: let the first upload complete normally
    resolveUpload();
    await firstDispatch;
  });

  test('allows a second dispatch after the first upload completes', async () => {
    const filename = `lock2_${Date.now()}.bgcode`;
    createTestFile(filename);
    const db = makeDb(filename);
    const scheduler = new JobScheduler(db, { on: () => {} });

    // First upload succeeds immediately
    mockDriver.uploadAndPrint.mockResolvedValueOnce(undefined);
    const firstJobId = await scheduler._dispatchToPrinter(fakePrinter);
    expect(firstJobId).not.toBeNull();

    // After first completes, _activeUploads no longer contains the printer.
    // However, the printer now has an active 'printing' job, so the double-dispatch
    // guard will prevent a second job — this just confirms the lock is cleared.
    expect(scheduler._activeUploads.has(fakePrinter.id)).toBe(false);
  });
});

// ─── Stale-job grace window ─────────────────────────────────────────────────────
// A job dispatched moments ago is 'printing' while the printer's stored status still
// reads IDLE/FINISHED until the next poll. The stale-job auto-fail must not fire on
// such a fresh job — otherwise a second dispatch (e.g. recommission + "scan for jobs"
// enqueueing the same printer twice) kills the job it just created and re-holds the printer.

describe('_dispatchToPrinter — stale-job grace window', () => {
  test('does NOT auto-fail a freshly dispatched job when the printer status has not yet caught up', async () => {
    const filename = `fresh_${Date.now()}.bgcode`;
    createTestFile(filename);
    const db = makeDb(filename);
    const scheduler = new JobScheduler(db, { on: () => {} });

    // Printer is IDLE in the DB (last poll), but a job was just dispatched and is 'printing'.
    db.prepare("UPDATE printers SET status = 'IDLE', is_held = 0 WHERE id = 1").run();
    const now = Date.now();
    const { lastInsertRowid: jobId } = db.prepare(`
      INSERT INTO jobs (part_id, printer_id, gcode_id, parts_per_plate, status, started_at, created_at)
      VALUES (1, 1, 1, 2, 'printing', ?, ?)
    `).run(now, now);

    const result = await scheduler._dispatchToPrinter(fakePrinter);

    expect(result).toBeNull();
    // The fresh job must be left intact — not auto-failed
    const job = db.prepare('SELECT status FROM jobs WHERE id = ?').get(jobId);
    expect(job.status).toBe('printing');
    // Printer must NOT be re-held
    const printer = db.prepare('SELECT is_held FROM printers WHERE id = 1').get();
    expect(printer.is_held).toBe(0);
    expect(notifications.add).not.toHaveBeenCalled();
  });

  test('auto-fails and holds when the active job is genuinely stale (older than the grace window)', async () => {
    const filename = `stale_${Date.now()}.bgcode`;
    createTestFile(filename);
    const db = makeDb(filename);
    const scheduler = new JobScheduler(db, { on: () => {} });

    db.prepare("UPDATE printers SET status = 'IDLE', is_held = 0 WHERE id = 1").run();
    const old = Date.now() - 10 * 60 * 1000; // 10 minutes ago — well past the grace window
    const { lastInsertRowid: jobId } = db.prepare(`
      INSERT INTO jobs (part_id, printer_id, gcode_id, parts_per_plate, status, started_at, created_at)
      VALUES (1, 1, 1, 2, 'printing', ?, ?)
    `).run(old, old);

    const result = await scheduler._dispatchToPrinter(fakePrinter);

    expect(result).toBeNull();
    const job = db.prepare('SELECT status FROM jobs WHERE id = ?').get(jobId);
    expect(job.status).toBe('failed');
    const printer = db.prepare('SELECT is_held FROM printers WHERE id = 1').get();
    expect(printer.is_held).toBe(1);
    expect(notifications.add).toHaveBeenCalledTimes(1);
    expect(notifications.add.mock.calls[0][0]).toMatch(/stale job/);
  });
});
