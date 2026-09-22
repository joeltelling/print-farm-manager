// Unit tests for PrinterPoller's per-lane filament sync (_syncLanes, called from
// _pollPrinter when the driver exports getLaneData: see server/drivers/klipper.js).
// This file covers only the lane-sync addition; poller.js has no broader test file.
// The driver is mocked so no real network I/O occurs.

jest.mock('../drivers', () => ({ getDriver: jest.fn() }));

const Database = require('better-sqlite3');
const { getDriver } = require('../drivers');
const PrinterPoller = require('../poller');

function makeDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE printers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL, type TEXT DEFAULT 'klipper',
      status TEXT DEFAULT 'IDLE', is_held INTEGER DEFAULT 0, is_active INTEGER DEFAULT 1,
      job_name TEXT, job_progress REAL, job_time_remaining INTEGER
    );
    CREATE TABLE jobs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      part_id INTEGER, printer_id INTEGER, gcode_id INTEGER,
      status TEXT DEFAULT 'queued', started_at INTEGER, finished_at INTEGER
    );
    CREATE TABLE printer_lanes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      printer_id INTEGER NOT NULL, lane_index INTEGER NOT NULL,
      material TEXT, color TEXT, updated_at INTEGER NOT NULL
    );
  `);
  db.prepare(`INSERT INTO printers (id, name, type, status) VALUES (1, 'K1', 'klipper', 'IDLE')`).run();
  return db;
}

function getPrinterRow(db) {
  return db.prepare('SELECT * FROM printers WHERE id = 1').get();
}

// getStatus reports the same status the row already has, so _pollPrinter's status-
// transition branch (hold logic, event emission) never runs: these tests are only
// about the lane-sync side effect that runs after it.
function mockDriver(getLaneData) {
  return { getStatus: jest.fn().mockResolvedValue({ status: 'IDLE', progress: null, timeRemaining: null }), getLaneData };
}

afterEach(() => jest.clearAllMocks());

describe('PrinterPoller: lane sync', () => {
  test('upserts every lane getLaneData reports', async () => {
    const db = makeDb();
    getDriver.mockReturnValue(mockDriver(jest.fn().mockResolvedValue([
      { index: 0, material: 'PLA', color: 'Black' },
      { index: 1, material: 'PETG', color: 'Red' },
    ])));
    const poller = new PrinterPoller(db);
    await poller._pollPrinter(getPrinterRow(db));

    const lanes = db.prepare('SELECT * FROM printer_lanes WHERE printer_id = 1 ORDER BY lane_index').all();
    expect(lanes).toHaveLength(2);
    expect(lanes[0]).toMatchObject({ lane_index: 0, material: 'PLA', color: 'Black' });
    expect(lanes[1]).toMatchObject({ lane_index: 1, material: 'PETG', color: 'Red' });
  });

  test('updates an existing lane in place instead of duplicating it', async () => {
    const db = makeDb();
    db.prepare('INSERT INTO printer_lanes (printer_id, lane_index, material, color, updated_at) VALUES (1, 0, ?, ?, ?)')
      .run('OLD', 'OldColor', 1);
    getDriver.mockReturnValue(mockDriver(jest.fn().mockResolvedValue([{ index: 0, material: 'NEW', color: 'NewColor' }])));
    const poller = new PrinterPoller(db);
    await poller._pollPrinter(getPrinterRow(db));

    const lanes = db.prepare('SELECT * FROM printer_lanes WHERE printer_id = 1').all();
    expect(lanes).toHaveLength(1);
    expect(lanes[0].material).toBe('NEW');
    expect(lanes[0].color).toBe('NewColor');
  });

  test('removes a lane no longer reported (e.g. toolhead count changed)', async () => {
    const db = makeDb();
    db.prepare('INSERT INTO printer_lanes (printer_id, lane_index, material, color, updated_at) VALUES (1, 0, ?, ?, ?)').run('PLA', 'Black', 1);
    db.prepare('INSERT INTO printer_lanes (printer_id, lane_index, material, color, updated_at) VALUES (1, 1, ?, ?, ?)').run('PETG', 'Red', 1);
    getDriver.mockReturnValue(mockDriver(jest.fn().mockResolvedValue([{ index: 0, material: 'PLA', color: 'Black' }])));
    const poller = new PrinterPoller(db);
    await poller._pollPrinter(getPrinterRow(db));

    const lanes = db.prepare('SELECT * FROM printer_lanes WHERE printer_id = 1').all();
    expect(lanes).toHaveLength(1);
    expect(lanes[0].lane_index).toBe(0);
  });

  test('leaves printer_lanes untouched when getLaneData returns null (plugin not installed)', async () => {
    const db = makeDb();
    db.prepare('INSERT INTO printer_lanes (printer_id, lane_index, material, color, updated_at) VALUES (1, 0, ?, ?, ?)').run('PLA', 'Black', 1);
    getDriver.mockReturnValue(mockDriver(jest.fn().mockResolvedValue(null)));
    const poller = new PrinterPoller(db);
    await poller._pollPrinter(getPrinterRow(db));

    // Untouched, not wiped: a transient plugin read failure must not delete
    // filament state that was already known.
    const lanes = db.prepare('SELECT * FROM printer_lanes WHERE printer_id = 1').all();
    expect(lanes).toHaveLength(1);
    expect(lanes[0].material).toBe('PLA');
  });

  test('does nothing for a driver without getLaneData (no crash, no query)', async () => {
    const db = makeDb();
    getDriver.mockReturnValue({ getStatus: jest.fn().mockResolvedValue({ status: 'IDLE', progress: null, timeRemaining: null }) });
    const poller = new PrinterPoller(db);
    await expect(poller._pollPrinter(getPrinterRow(db))).resolves.not.toThrow();
    expect(db.prepare('SELECT COUNT(*) AS c FROM printer_lanes').get().c).toBe(0);
  });
});
