// Regression: an active production_closure with blocks_dispatch=1 must prevent
// _reserveJob from inserting any new jobs. Cancelled closures and closures
// outside the current window must not block.

const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const mockDriver = {
  uploadAndPrint: jest.fn(),
  checkIfPrinting: jest.fn(),
};
jest.mock('../drivers', () => ({
  getDriver: jest.fn(() => mockDriver),
}));

const JobScheduler = require('../scheduler');

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
      group_name TEXT, type TEXT DEFAULT 'prusa', model TEXT NOT NULL,
      status TEXT DEFAULT 'IDLE', is_held INTEGER DEFAULT 0, is_active INTEGER DEFAULT 1,
      loaded_material TEXT, loaded_color TEXT, created_at INTEGER NOT NULL
    );
    CREATE TABLE projects (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL, status TEXT DEFAULT 'active', priority INTEGER DEFAULT 0,
      required_material TEXT, required_color TEXT, allowed_groups TEXT,
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
        filename TEXT NOT NULL, filepath TEXT NOT NULL, parts_per_plate INTEGER NOT NULL,
        ams_slot INTEGER,
        allowed_groups TEXT, required_material TEXT, required_color TEXT,
        created_at INTEGER NOT NULL
      );
    CREATE TABLE jobs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      part_id INTEGER NOT NULL, printer_id INTEGER NOT NULL, gcode_id INTEGER,
      parts_per_plate INTEGER NOT NULL, status TEXT DEFAULT 'queued',
      started_at INTEGER, finished_at INTEGER, created_at INTEGER NOT NULL
    );
    CREATE TABLE calendar_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      event_type TEXT NOT NULL, title TEXT NOT NULL, notes TEXT,
      start_at INTEGER NOT NULL, end_at INTEGER,
      all_day INTEGER NOT NULL DEFAULT 1,
      status TEXT NOT NULL DEFAULT 'planned',
      blocks_dispatch INTEGER NOT NULL DEFAULT 0,
      project_id INTEGER, item_sku TEXT,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
  `);
  db.prepare("INSERT INTO settings (key, value) VALUES ('dispatch_batch_size', '10')").run();
  return db;
}

function seedDispatchable(db) {
  const now = Date.now();
  db.prepare(`
    INSERT INTO printers (name, ip, api_key, model, status, is_held, is_active, created_at)
    VALUES ('P1', '10.0.0.1', 'k', 'mk4s', 'IDLE', 0, 1, ?)
  `).run(now);
  db.prepare(`
    INSERT INTO projects (name, status, priority, created_at, updated_at)
    VALUES ('Proj', 'active', 0, ?, ?)
  `).run(now, now);
  db.prepare(`
    INSERT INTO parts (project_id, name, target_qty, completed_qty, status, created_at, updated_at)
    VALUES (1, 'Part', 10, 0, 'open', ?, ?)
  `).run(now, now);
  const fname = `closure-gate-${now}.gcode`;
  const full = path.join(GCODE_DIR, fname);
  fs.writeFileSync(full, '; stub');
  filesToClean.push(full);
  db.prepare(`
    INSERT INTO gcodes (part_id, printer_model, filename, filepath, parts_per_plate, created_at)
    VALUES (1, 'mk4s', ?, ?, 1, ?)
  `).run(fname, fname, now);
  return db.prepare('SELECT * FROM printers WHERE id = 1').get();
}

describe('scheduler production closure gate', () => {
  test('active closure: _reserveJob returns null and inserts no jobs', () => {
    const db = makeDb();
    const printer = seedDispatchable(db);
    const now = Date.now();
    db.prepare(`
      INSERT INTO calendar_events (
        event_type, title, start_at, end_at, status, blocks_dispatch, created_at, updated_at
      ) VALUES ('production_closure', 'Holiday', ?, ?, 'planned', 1, ?, ?)
    `).run(now - 1000, now + 86400000, now, now);

    const scheduler = new JobScheduler(db, { on: () => {} });
    scheduler.start();
    const reservation = scheduler._reserveJob(printer);

    expect(reservation).toBeNull();
    expect(db.prepare('SELECT COUNT(*) AS n FROM jobs').get().n).toBe(0);
  });

  test('cancelled closure does not block dispatch', () => {
    const db = makeDb();
    const printer = seedDispatchable(db);
    const now = Date.now();
    db.prepare(`
      INSERT INTO calendar_events (
        event_type, title, start_at, end_at, status, blocks_dispatch, created_at, updated_at
      ) VALUES ('production_closure', 'Cancelled', ?, ?, 'cancelled', 1, ?, ?)
    `).run(now - 1000, now + 86400000, now, now);

    const scheduler = new JobScheduler(db, { on: () => {} });
    scheduler.start();
    const reservation = scheduler._reserveJob(printer);

    expect(reservation).not.toBeNull();
    expect(db.prepare('SELECT COUNT(*) AS n FROM jobs').get().n).toBe(1);
  });

  test('closure outside the current window does not block', () => {
    const db = makeDb();
    const printer = seedDispatchable(db);
    const now = Date.now();
    db.prepare(`
      INSERT INTO calendar_events (
        event_type, title, start_at, end_at, status, blocks_dispatch, created_at, updated_at
      ) VALUES ('production_closure', 'Future', ?, ?, 'planned', 1, ?, ?)
    `).run(now + 86400000, now + 2 * 86400000, now, now);

    const scheduler = new JobScheduler(db, { on: () => {} });
    scheduler.start();
    const reservation = scheduler._reserveJob(printer);

    expect(reservation).not.toBeNull();
    expect(db.prepare('SELECT COUNT(*) AS n FROM jobs').get().n).toBe(1);
  });

  test('sweepIdlePrinters skips entirely while a closure is active', () => {
    const db = makeDb();
    seedDispatchable(db);
    const now = Date.now();
    db.prepare(`
      INSERT INTO calendar_events (
        event_type, title, start_at, end_at, status, blocks_dispatch, created_at, updated_at
      ) VALUES ('production_closure', 'Holiday', ?, ?, 'planned', 1, ?, ?)
    `).run(now - 1000, now + 86400000, now, now);

    const scheduler = new JobScheduler(db, { on: () => {} });
    scheduler.start();
    scheduler._sweepInBatches = jest.fn();
    scheduler.sweepIdlePrinters();

    expect(scheduler._sweepInBatches).not.toHaveBeenCalled();
    expect(db.prepare('SELECT COUNT(*) AS n FROM jobs').get().n).toBe(0);
  });
});
