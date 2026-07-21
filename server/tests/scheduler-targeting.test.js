// Tests for scheduler candidate-selection filtering by group, material, and color.
// Verifies that _dispatchToPrinter respects:
//   - gcodes.allowed_groups  (JSON array or NULL = all groups)
//   - gcodes.required_material (or NULL = any)
//   - gcodes.required_color    (or NULL = any)
//
// The driver is mocked so no real network I/O occurs.
// Each test builds its own in-memory DB to isolate state.

const path = require('path');
const fs   = require('fs');
const Database = require('better-sqlite3');

const mockDriver = {
  uploadAndPrint: jest.fn(),
  checkIfPrinting: jest.fn(),
};
jest.mock('../drivers', () => ({ getDriver: jest.fn(() => mockDriver) }));
jest.mock('../notifications', () => ({ add: jest.fn() }));

const JobScheduler = require('../scheduler');

const GCODE_DIR = path.join(__dirname, '..', 'gcode');

// A real gcode file on disk — required by the scheduler before it calls the driver
let gcodeFilename;
beforeAll(() => {
  if (!fs.existsSync(GCODE_DIR)) fs.mkdirSync(GCODE_DIR, { recursive: true });
  gcodeFilename = `targeting_test_${Date.now()}.bgcode`;
  fs.writeFileSync(path.join(GCODE_DIR, gcodeFilename), 'G28');
});
afterAll(() => {
  try { fs.unlinkSync(path.join(GCODE_DIR, gcodeFilename)); } catch (_) {}
});

beforeEach(() => {
  mockDriver.uploadAndPrint.mockResolvedValue(undefined);
  mockDriver.checkIfPrinting.mockResolvedValue(false);
  jest.clearAllMocks();
});

/**
 * Build a minimal in-memory DB for dispatch targeting tests.
 *
 * @param {object} opts
 * @param {string|null} opts.printerGroup     - group_name on the printer
 * @param {string|null} opts.printerMaterial  - loaded_material on the printer
 * @param {string|null} opts.printerColor     - loaded_color on the printer
 * @param {string|null} opts.gcodeGroups      - JSON string for allowed_groups (null = all)
 * @param {string|null} opts.gcodeMaterial    - required_material on the gcode (null = any)
 * @param {string|null} opts.gcodeColor       - required_color on the gcode (null = any)
 * @param {string|null} opts.projectGroups    - JSON string for projects.allowed_groups (null = none), used as the fallback when gcodeGroups is null
 */
function makeDb({ printerGroup = null, printerMaterial = null, printerColor = null,
                   gcodeGroups = null, gcodeMaterial = null, gcodeColor = null,
                   projectGroups = null } = {}) {
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
    CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    INSERT INTO settings VALUES ('dispatch_batch_size', '10');
  `);

  const now = Date.now();
  db.prepare(`INSERT INTO printers (name, ip, api_key, model, type, group_name, loaded_material, loaded_color, status, is_held, is_active, created_at)
              VALUES ('P1', '192.168.1.1', 'key', 'mk4s', 'prusa', ?, ?, ?, 'IDLE', 0, 1, ?)`)
    .run(printerGroup, printerMaterial, printerColor, now);
  db.prepare(`INSERT INTO projects (name, status, priority, allowed_groups, created_at, updated_at) VALUES ('Proj', 'active', 0, ?, ?, ?)`)
    .run(projectGroups, now, now);
  db.prepare(`INSERT INTO parts (project_id, name, target_qty, completed_qty, status, sort_order, created_at, updated_at)
              VALUES (1, 'Part A', 10, 0, 'open', 0, ?, ?)`)
    .run(now, now);
  db.prepare(`INSERT INTO gcodes (part_id, printer_model, filename, filepath, parts_per_plate, allowed_groups, required_material, required_color, created_at)
              VALUES (1, 'mk4s', ?, ?, 2, ?, ?, ?, ?)`)
    .run(gcodeFilename, gcodeFilename, gcodeGroups, gcodeMaterial, gcodeColor, now);

  return db;
}

// A printer object that matches the row just inserted (id=1)
const printer = { id: 1, name: 'P1', ip: '192.168.1.1', api_key: 'key', model: 'mk4s', type: 'prusa', status: 'IDLE', is_held: 0, is_active: 1 };

// ── Group filtering ───────────────────────────────────────────────────────────

describe('scheduler — group filtering', () => {
  test('dispatches when allowed_groups is null (all groups)', async () => {
    const db = makeDb({ printerGroup: 'Rack A', gcodeGroups: null });
    const scheduler = new JobScheduler(db, { on: () => {} });
    const jobId = await scheduler._dispatchToPrinter({ ...printer, group_name: 'Rack A' });
    expect(jobId).not.toBeNull();
    expect(mockDriver.uploadAndPrint).toHaveBeenCalled();
  });

  test('dispatches when printer group is in allowed_groups', async () => {
    const db = makeDb({ printerGroup: 'Rack B', gcodeGroups: JSON.stringify(['Rack A', 'Rack B']) });
    const scheduler = new JobScheduler(db, { on: () => {} });
    const jobId = await scheduler._dispatchToPrinter({ ...printer, group_name: 'Rack B' });
    expect(jobId).not.toBeNull();
    expect(mockDriver.uploadAndPrint).toHaveBeenCalled();
  });

  test('skips dispatch when printer group is NOT in allowed_groups', async () => {
    const db = makeDb({ printerGroup: 'Rack C', gcodeGroups: JSON.stringify(['Rack A', 'Rack B']) });
    const scheduler = new JobScheduler(db, { on: () => {} });
    const jobId = await scheduler._dispatchToPrinter({ ...printer, group_name: 'Rack C' });
    expect(jobId).toBeNull();
    expect(mockDriver.uploadAndPrint).not.toHaveBeenCalled();
  });

  test('skips dispatch when printer has no group and groups are restricted', async () => {
    const db = makeDb({ printerGroup: null, gcodeGroups: JSON.stringify(['Rack A']) });
    const scheduler = new JobScheduler(db, { on: () => {} });
    const jobId = await scheduler._dispatchToPrinter({ ...printer, group_name: null });
    expect(jobId).toBeNull();
    expect(mockDriver.uploadAndPrint).not.toHaveBeenCalled();
  });
});

// ── Material filtering ────────────────────────────────────────────────────────

describe('scheduler — material filtering', () => {
  test('dispatches when required_material is null (any material)', async () => {
    const db = makeDb({ printerMaterial: 'PETG', gcodeMaterial: null });
    const scheduler = new JobScheduler(db, { on: () => {} });
    const jobId = await scheduler._dispatchToPrinter({ ...printer, loaded_material: 'PETG' });
    expect(jobId).not.toBeNull();
    expect(mockDriver.uploadAndPrint).toHaveBeenCalled();
  });

  test('dispatches when printer material matches required_material', async () => {
    const db = makeDb({ printerMaterial: 'PLA', gcodeMaterial: 'PLA' });
    const scheduler = new JobScheduler(db, { on: () => {} });
    const jobId = await scheduler._dispatchToPrinter({ ...printer, loaded_material: 'PLA' });
    expect(jobId).not.toBeNull();
    expect(mockDriver.uploadAndPrint).toHaveBeenCalled();
  });

  test('skips dispatch when printer material does not match required_material', async () => {
    const db = makeDb({ printerMaterial: 'PETG', gcodeMaterial: 'PLA' });
    const scheduler = new JobScheduler(db, { on: () => {} });
    const jobId = await scheduler._dispatchToPrinter({ ...printer, loaded_material: 'PETG' });
    expect(jobId).toBeNull();
    expect(mockDriver.uploadAndPrint).not.toHaveBeenCalled();
  });

  test('skips dispatch when printer has no material loaded but gcode requires one', async () => {
    const db = makeDb({ printerMaterial: null, gcodeMaterial: 'PLA' });
    const scheduler = new JobScheduler(db, { on: () => {} });
    const jobId = await scheduler._dispatchToPrinter({ ...printer, loaded_material: null });
    expect(jobId).toBeNull();
    expect(mockDriver.uploadAndPrint).not.toHaveBeenCalled();
  });
});

// ── Color filtering ───────────────────────────────────────────────────────────

describe('scheduler — color filtering', () => {
  test('dispatches when required_color is null (any color)', async () => {
    const db = makeDb({ printerColor: 'Red', gcodeColor: null });
    const scheduler = new JobScheduler(db, { on: () => {} });
    const jobId = await scheduler._dispatchToPrinter({ ...printer, loaded_color: 'Red' });
    expect(jobId).not.toBeNull();
    expect(mockDriver.uploadAndPrint).toHaveBeenCalled();
  });

  test('dispatches when printer color matches required_color', async () => {
    const db = makeDb({ printerColor: 'Black', gcodeColor: 'Black' });
    const scheduler = new JobScheduler(db, { on: () => {} });
    const jobId = await scheduler._dispatchToPrinter({ ...printer, loaded_color: 'Black' });
    expect(jobId).not.toBeNull();
    expect(mockDriver.uploadAndPrint).toHaveBeenCalled();
  });

  test('skips dispatch when printer color does not match required_color', async () => {
    const db = makeDb({ printerColor: 'White', gcodeColor: 'Black' });
    const scheduler = new JobScheduler(db, { on: () => {} });
    const jobId = await scheduler._dispatchToPrinter({ ...printer, loaded_color: 'White' });
    expect(jobId).toBeNull();
    expect(mockDriver.uploadAndPrint).not.toHaveBeenCalled();
  });

  test('skips dispatch when printer has no color loaded but gcode requires one', async () => {
    const db = makeDb({ printerColor: null, gcodeColor: 'Black' });
    const scheduler = new JobScheduler(db, { on: () => {} });
    const jobId = await scheduler._dispatchToPrinter({ ...printer, loaded_color: null });
    expect(jobId).toBeNull();
    expect(mockDriver.uploadAndPrint).not.toHaveBeenCalled();
  });
});

// ── Combined filtering ────────────────────────────────────────────────────────

describe('scheduler — combined group + material + color filtering', () => {
  test('dispatches only when all three constraints are satisfied', async () => {
    const db = makeDb({
      printerGroup: 'Rack A', printerMaterial: 'PLA', printerColor: 'Black',
      gcodeGroups: JSON.stringify(['Rack A']), gcodeMaterial: 'PLA', gcodeColor: 'Black',
    });
    const scheduler = new JobScheduler(db, { on: () => {} });
    const jobId = await scheduler._dispatchToPrinter({
      ...printer, group_name: 'Rack A', loaded_material: 'PLA', loaded_color: 'Black',
    });
    expect(jobId).not.toBeNull();
    expect(mockDriver.uploadAndPrint).toHaveBeenCalled();
  });

  test('skips when group matches but material does not', async () => {
    const db = makeDb({
      printerGroup: 'Rack A', printerMaterial: 'PETG', printerColor: 'Black',
      gcodeGroups: JSON.stringify(['Rack A']), gcodeMaterial: 'PLA', gcodeColor: 'Black',
    });
    const scheduler = new JobScheduler(db, { on: () => {} });
    const jobId = await scheduler._dispatchToPrinter({
      ...printer, group_name: 'Rack A', loaded_material: 'PETG', loaded_color: 'Black',
    });
    expect(jobId).toBeNull();
    expect(mockDriver.uploadAndPrint).not.toHaveBeenCalled();
  });

  test('skips when material matches but color does not', async () => {
    const db = makeDb({
      printerGroup: 'Rack A', printerMaterial: 'PLA', printerColor: 'White',
      gcodeGroups: JSON.stringify(['Rack A']), gcodeMaterial: 'PLA', gcodeColor: 'Black',
    });
    const scheduler = new JobScheduler(db, { on: () => {} });
    const jobId = await scheduler._dispatchToPrinter({
      ...printer, group_name: 'Rack A', loaded_material: 'PLA', loaded_color: 'White',
    });
    expect(jobId).toBeNull();
    expect(mockDriver.uploadAndPrint).not.toHaveBeenCalled();
  });

  test('dispatches with no restrictions when all targeting fields are null', async () => {
    const db = makeDb({
      printerGroup: null, printerMaterial: null, printerColor: null,
      gcodeGroups: null, gcodeMaterial: null, gcodeColor: null,
    });
    const scheduler = new JobScheduler(db, { on: () => {} });
    const jobId = await scheduler._dispatchToPrinter({
      ...printer, group_name: null, loaded_material: null, loaded_color: null,
    });
    expect(jobId).not.toBeNull();
    expect(mockDriver.uploadAndPrint).toHaveBeenCalled();
  });
});

// ── Project-level group cascade ───────────────────────────────────────────────
// projects.allowed_groups is the fallback a gcode with no allowed_groups of its
// own inherits, mirroring the existing required_material/required_color cascade.
// COALESCE(gcodes.allowed_groups, projects.allowed_groups) means a gcode-level
// value always wins when present, regardless of what the project has set.

describe('scheduler: project-level group cascade', () => {
  test('gcode with no allowed_groups inherits the project restriction', async () => {
    const db = makeDb({ printerGroup: 'Rack A', gcodeGroups: null, projectGroups: JSON.stringify(['Rack A']) });
    const scheduler = new JobScheduler(db, { on: () => {} });
    const jobId = await scheduler._dispatchToPrinter({ ...printer, group_name: 'Rack A' });
    expect(jobId).not.toBeNull();
    expect(mockDriver.uploadAndPrint).toHaveBeenCalled();
  });

  test('printer outside the inherited project restriction is skipped', async () => {
    const db = makeDb({ printerGroup: 'Rack B', gcodeGroups: null, projectGroups: JSON.stringify(['Rack A']) });
    const scheduler = new JobScheduler(db, { on: () => {} });
    const jobId = await scheduler._dispatchToPrinter({ ...printer, group_name: 'Rack B' });
    expect(jobId).toBeNull();
    expect(mockDriver.uploadAndPrint).not.toHaveBeenCalled();
  });

  test('a gcode-level allowed_groups overrides the project default entirely', async () => {
    // Printer is in the project's restricted group but NOT in the gcode's:
    // the gcode-level value must win, not be unioned with the project's.
    const db = makeDb({
      printerGroup: 'Rack B', gcodeGroups: JSON.stringify(['Rack B']), projectGroups: JSON.stringify(['Rack A']),
    });
    const scheduler = new JobScheduler(db, { on: () => {} });
    const jobId = await scheduler._dispatchToPrinter({ ...printer, group_name: 'Rack B' });
    expect(jobId).not.toBeNull();
    expect(mockDriver.uploadAndPrint).toHaveBeenCalled();
  });

  test('a gcode-level allowed_groups excludes a printer the project default would have allowed', async () => {
    const db = makeDb({
      printerGroup: 'Rack A', gcodeGroups: JSON.stringify(['Rack B']), projectGroups: JSON.stringify(['Rack A']),
    });
    const scheduler = new JobScheduler(db, { on: () => {} });
    const jobId = await scheduler._dispatchToPrinter({ ...printer, group_name: 'Rack A' });
    expect(jobId).toBeNull();
    expect(mockDriver.uploadAndPrint).not.toHaveBeenCalled();
  });

  test('neither gcode nor project restricts groups: dispatches to any printer', async () => {
    const db = makeDb({ printerGroup: 'Rack Z', gcodeGroups: null, projectGroups: null });
    const scheduler = new JobScheduler(db, { on: () => {} });
    const jobId = await scheduler._dispatchToPrinter({ ...printer, group_name: 'Rack Z' });
    expect(jobId).not.toBeNull();
    expect(mockDriver.uploadAndPrint).toHaveBeenCalled();
  });
});
