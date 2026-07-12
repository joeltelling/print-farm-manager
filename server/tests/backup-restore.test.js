// Regression test for the backup export/restore round-trip.
//
// Reported (PR review): the restore side used a hand-maintained column list per table,
// which had drifted out of sync with migrations added to server/db.js over time. A backup
// containing printers.serial_number/loaded_material/loaded_color, projects.required_material/
// required_color, parts.print_time_seconds/material_grams, and gcodes.ams_slot/material_grams/
// allowed_groups/required_material/required_color restored successfully but silently dropped
// all of those fields back to null/default.
//
// Fixed by deriving each restore INSERT's column list from PRAGMA table_info(table) instead
// of a hardcoded list (see makeInserter() in server/routes/backup.js) — this test seeds every
// one of those previously-dropped columns with a distinctive value and asserts they all
// survive a real export → restore round trip through the actual HTTP endpoints. If a future
// migration adds a new column that the restore logic somehow stops picking up, this is the
// test that should catch it.

// Restore lazily requires the creality driver to dispose its cached persistent
// connections (they bypass the per-printer lifecycle routes during a bulk restore).
// Mock it so no real WebSocket module loads here; the stable mock fn survives the
// jest.resetModules() in beforeEach because the factory closes over it.
const mockDisposeAllConnections = jest.fn();
jest.mock('../drivers/creality', () => ({ disposeAllConnections: mockDisposeAllConnections }));

const request  = require('supertest');
const express  = require('express');
const Database = require('better-sqlite3');
const path     = require('path');
const fs       = require('fs');
const os       = require('os');

let db;
let app;

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  // Full current schema (base CREATE TABLE + every migration in server/db.js), so
  // PRAGMA table_info in makeInserter() sees exactly what a real installation would.
  db.exec(`
    CREATE TABLE printers (
      id                  INTEGER PRIMARY KEY AUTOINCREMENT,
      name                TEXT NOT NULL UNIQUE,
      ip                  TEXT NOT NULL,
      api_key             TEXT NOT NULL,
      group_name          TEXT,
      type                TEXT DEFAULT 'prusa',
      model               TEXT NOT NULL,
      status              TEXT DEFAULT 'UNKNOWN',
      is_held             INTEGER DEFAULT 1,
      is_active           INTEGER DEFAULT 1,
      created_at          INTEGER NOT NULL,
      decommissioned_at   INTEGER,
      decommission_note   TEXT,
      job_name            TEXT,
      job_progress        REAL,
      job_time_remaining  INTEGER,
      serial_number       TEXT DEFAULT '',
      loaded_material     TEXT,
      loaded_color        TEXT
    );
    CREATE TABLE projects (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      name              TEXT NOT NULL,
      description       TEXT,
      status            TEXT DEFAULT 'draft',
      priority          INTEGER DEFAULT 0,
      created_at        INTEGER NOT NULL,
      updated_at        INTEGER NOT NULL,
      required_material TEXT,
      required_color    TEXT,
      allowed_groups    TEXT
    );
    CREATE TABLE parts (
      id                  INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id          INTEGER NOT NULL REFERENCES projects(id),
      name                TEXT NOT NULL,
      target_qty          INTEGER NOT NULL,
      completed_qty       INTEGER DEFAULT 0,
      status              TEXT DEFAULT 'open',
      created_at          INTEGER NOT NULL,
      updated_at          INTEGER NOT NULL,
      sort_order          INTEGER NOT NULL DEFAULT 0,
      print_time_seconds  INTEGER,
      material_grams      REAL
    );
    CREATE TABLE gcodes (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      part_id           INTEGER NOT NULL REFERENCES parts(id),
      printer_model     TEXT NOT NULL,
      filename          TEXT NOT NULL,
      filepath          TEXT NOT NULL,
      parts_per_plate   INTEGER NOT NULL,
      est_print_secs    INTEGER,
      created_at        INTEGER NOT NULL,
      ams_slot          INTEGER,
      material_grams    REAL,
      allowed_groups    TEXT,
      required_material TEXT,
      required_color    TEXT
    );
    CREATE TABLE jobs (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      part_id          INTEGER NOT NULL REFERENCES parts(id),
      printer_id       INTEGER NOT NULL REFERENCES printers(id),
      gcode_id         INTEGER REFERENCES gcodes(id),
      parts_per_plate  INTEGER NOT NULL,
      status           TEXT DEFAULT 'queued',
      started_at       INTEGER,
      finished_at      INTEGER,
      created_at       INTEGER NOT NULL
    );
    CREATE TABLE printer_events (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      printer_id  INTEGER NOT NULL,
      event_type  TEXT NOT NULL,
      note        TEXT,
      created_at  INTEGER NOT NULL
    );
    CREATE TABLE printer_models (
      model_id   TEXT PRIMARY KEY,
      label      TEXT NOT NULL,
      connector  TEXT NOT NULL
    );
    CREATE TABLE printer_groups (
      name        TEXT PRIMARY KEY,
      created_at  INTEGER NOT NULL
    );
    CREATE TABLE filament_types (
      id    INTEGER PRIMARY KEY AUTOINCREMENT,
      name  TEXT NOT NULL UNIQUE
    );
    CREATE TABLE filament_colors (
      id        INTEGER PRIMARY KEY AUTOINCREMENT,
      type_id   INTEGER NOT NULL REFERENCES filament_types(id),
      name      TEXT NOT NULL,
      hex_color TEXT,
      UNIQUE(type_id, name)
    );
    CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  `);

  const now = Date.now();

  db.prepare(`
    INSERT INTO printers
      (name, ip, api_key, group_name, type, model, status, is_held, is_active, created_at,
       serial_number, loaded_material, loaded_color)
    VALUES
      ('Bambu_01', '192.168.1.50', 'ac1B2c', 'Bambu Farm', 'bambu', 'x1c', 'IDLE', 0, 1, ?,
       '01S00A123456789', 'PLA', 'Galaxy Black')
  `).run(now);

  db.prepare(`
    INSERT INTO projects (name, description, status, priority, created_at, updated_at, required_material, required_color, allowed_groups)
    VALUES ('Targeted Project', 'test', 'active', 0, ?, ?, 'PETG', 'Red', '["Bambu Farm"]')
  `).run(now, now);

  db.prepare(`
    INSERT INTO parts (project_id, name, target_qty, completed_qty, status, created_at, updated_at, sort_order, print_time_seconds, material_grams)
    VALUES (1, 'Estimated Part', 10, 0, 'open', ?, ?, 0, 7350, 42.5)
  `).run(now, now);

  db.prepare(`
    INSERT INTO gcodes
      (part_id, printer_model, filename, filepath, parts_per_plate, est_print_secs, created_at,
       ams_slot, material_grams, allowed_groups, required_material, required_color)
    VALUES
      (1, 'x1c', 'part.gcode', 'part_stub.gcode', 4, 3600, ?,
       2, 45.5, '["Bambu Farm"]', 'PETG', 'Red')
  `).run(now);

  // Two types/colors (not one) so a restore that gets the filament_colors -> filament_types
  // FK order wrong, or maps a color to the wrong type, doesn't slip through by coincidence.
  db.prepare(`INSERT INTO printer_models (model_id, label, connector) VALUES ('x1c', 'Bambu X1 Carbon', 'bambu')`).run();
  db.prepare(`INSERT INTO printer_groups (name, created_at) VALUES ('Bambu Farm', ?)`).run(now);
  db.prepare(`INSERT INTO filament_types (name) VALUES ('PLA')`).run();
  db.prepare(`INSERT INTO filament_types (name) VALUES ('PETG')`).run();
  db.prepare(`INSERT INTO filament_colors (type_id, name, hex_color) VALUES (1, 'Galaxy Black', '#1a1a1a')`).run();
  db.prepare(`INSERT INTO filament_colors (type_id, name, hex_color) VALUES (2, 'Signal Red', '#cc0000')`).run();
  db.prepare(`INSERT INTO settings (key, value) VALUES ('farm_name', 'Test Farm')`).run();
  db.prepare(`INSERT INTO settings (key, value) VALUES ('dispatch_batch_size', '5')`).run();

  // server/routes/backup.js declares its Express router at module scope, like every
  // route file in this codebase. Node's require() cache means a second require() in the
  // same process would reuse that router with a stale db closure from a previous test's
  // beforeEach — jest.resetModules() forces a fresh module (and router) each time.
  jest.resetModules();
  app = express();
  app.use(express.json());
  app.use('/api/backup', require('../routes/backup')(db));
});

function writeTempBackupFile(backup) {
  const p = path.join(os.tmpdir(), `backup-restore-test-${Date.now()}.json`);
  fs.writeFileSync(p, JSON.stringify(backup));
  return p;
}

describe('Backup export/restore — column round-trip regression', () => {
  test('export includes the migrated columns', async () => {
    const res = await request(app).get('/api/backup');
    expect(res.status).toBe(200);

    expect(res.body.printers[0]).toMatchObject({
      serial_number: '01S00A123456789',
      loaded_material: 'PLA',
      loaded_color: 'Galaxy Black',
    });
    expect(res.body.projects[0]).toMatchObject({
      required_material: 'PETG',
      required_color: 'Red',
      allowed_groups: '["Bambu Farm"]',
    });
    expect(res.body.parts[0]).toMatchObject({
      print_time_seconds: 7350,
      material_grams: 42.5,
    });
    expect(res.body.gcodes[0]).toMatchObject({
      ams_slot: 2,
      material_grams: 45.5,
      allowed_groups: '["Bambu Farm"]',
      required_material: 'PETG',
      required_color: 'Red',
    });
  });

  test('restore preserves every migrated column, not just the base schema', async () => {
    const exportRes = await request(app).get('/api/backup');
    expect(exportRes.status).toBe(200);
    const backupFile = writeTempBackupFile(exportRes.body);

    try {
      // Wipe the columns under test so a false-positive (restore is a no-op / DB untouched)
      // can't slip through — restore must be what puts these values back.
      db.prepare("UPDATE printers SET serial_number = '', loaded_material = NULL, loaded_color = NULL").run();
      db.prepare("UPDATE projects SET required_material = NULL, required_color = NULL, allowed_groups = NULL").run();
      db.prepare("UPDATE parts SET print_time_seconds = NULL, material_grams = NULL").run();
      db.prepare("UPDATE gcodes SET ams_slot = NULL, material_grams = NULL, allowed_groups = NULL, required_material = NULL, required_color = NULL").run();

      const restoreRes = await request(app)
        .post('/api/backup/restore')
        .attach('file', backupFile);

      expect(restoreRes.status).toBe(200);
      expect(restoreRes.body.ok).toBe(true);

      const printer = db.prepare('SELECT * FROM printers WHERE id = 1').get();
      expect(printer.serial_number).toBe('01S00A123456789');
      expect(printer.loaded_material).toBe('PLA');
      expect(printer.loaded_color).toBe('Galaxy Black');

      const project = db.prepare('SELECT * FROM projects WHERE id = 1').get();
      expect(project.required_material).toBe('PETG');
      expect(project.required_color).toBe('Red');
      expect(project.allowed_groups).toBe('["Bambu Farm"]');

      const part = db.prepare('SELECT * FROM parts WHERE id = 1').get();
      expect(part.print_time_seconds).toBe(7350);
      expect(part.material_grams).toBe(42.5);

      const gcode = db.prepare('SELECT * FROM gcodes WHERE id = 1').get();
      expect(gcode.ams_slot).toBe(2);
      expect(gcode.material_grams).toBe(45.5);
      expect(gcode.allowed_groups).toBe('["Bambu Farm"]');
      expect(gcode.required_material).toBe('PETG');
      expect(gcode.required_color).toBe('Red');
    } finally {
      fs.unlinkSync(backupFile);
    }
  });

  test('restore tolerates an older backup missing a since-added column (defaults to null, does not throw)', async () => {
    const exportRes = await request(app).get('/api/backup');
    const backup = exportRes.body;
    // Simulate a pre-migration backup: strip a column that was added later.
    delete backup.printers[0].loaded_color;
    delete backup.gcodes[0].required_color;
    const backupFile = writeTempBackupFile(backup);

    try {
      const restoreRes = await request(app).post('/api/backup/restore').attach('file', backupFile);
      expect(restoreRes.status).toBe(200);

      const printer = db.prepare('SELECT * FROM printers WHERE id = 1').get();
      expect(printer.loaded_color).toBeNull();
      const gcode = db.prepare('SELECT * FROM gcodes WHERE id = 1').get();
      expect(gcode.required_color).toBeNull();
    } finally {
      fs.unlinkSync(backupFile);
    }
  });

  // Reported (PR review, second round): makeInserter() bound every live column, including
  // ones absent from the backup row, as an explicit NULL. That's fine for nullable columns
  // (covered above) but a NOT NULL DEFAULT column like parts.sort_order rejects an explicit
  // NULL outright, so restoring a backup predating that column threw a constraint failure
  // instead of falling back to the column's own default. Fixed by omitting columns missing
  // from every row of the backup's data from the generated INSERT entirely, letting SQLite
  // apply the schema default.
  test('restore falls back to the schema default for a NOT NULL DEFAULT column missing from an older backup', async () => {
    const exportRes = await request(app).get('/api/backup');
    const backup = exportRes.body;
    expect(backup.parts[0]).toHaveProperty('sort_order');
    delete backup.parts[0].sort_order; // simulate a backup predating this column
    const backupFile = writeTempBackupFile(backup);

    try {
      const restoreRes = await request(app).post('/api/backup/restore').attach('file', backupFile);
      expect(restoreRes.status).toBe(200);
      expect(restoreRes.body.ok).toBe(true);

      const part = db.prepare('SELECT * FROM parts WHERE id = 1').get();
      expect(part.sort_order).toBe(0); // schema DEFAULT, not a thrown NOT NULL violation
    } finally {
      fs.unlinkSync(backupFile);
    }
  });
});

// Reported (PR review, third round): the regression suite covered migrated columns on
// printers/projects/parts/gcodes, the missing NOT NULL DEFAULT case, and gcode_files
// validation, but never seeded or asserted printer_models/filament_types/filament_colors/
// settings — the four tables this PR originally added to backup/restore — leaving both the
// round trip (including the filament_colors -> filament_types FK order) and the
// older-backup compatibility guard (missing keys must leave existing config alone) untested.
describe('Backup export/restore: config tables (printer models, printer groups, filament library, settings)', () => {
  test('export includes printer_models, printer_groups, filament_types, filament_colors, and settings', async () => {
    const res = await request(app).get('/api/backup');
    expect(res.status).toBe(200);

    expect(res.body.printer_models).toEqual(
      expect.arrayContaining([expect.objectContaining({ model_id: 'x1c', label: 'Bambu X1 Carbon', connector: 'bambu' })])
    );
    expect(res.body.printer_groups).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: 'Bambu Farm' })])
    );
    expect(res.body.filament_types).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: 'PLA' }), expect.objectContaining({ name: 'PETG' })])
    );
    expect(res.body.filament_colors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'Galaxy Black', hex_color: '#1a1a1a' }),
        expect.objectContaining({ name: 'Signal Red', hex_color: '#cc0000' }),
      ])
    );
    expect(res.body.settings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ key: 'farm_name', value: 'Test Farm' }),
        expect.objectContaining({ key: 'dispatch_batch_size', value: '5' }),
      ])
    );
  });

  test('restore round-trips printer models, filament library (preserving type/color FK relationships), and settings', async () => {
    const exportRes = await request(app).get('/api/backup');
    expect(exportRes.status).toBe(200);
    const backupFile = writeTempBackupFile(exportRes.body);

    try {
      // Mutate (don't delete) the existing rows so a no-op restore can't slip through, while
      // *leaving the filament_colors -> filament_types FK relationship intact* going into
      // restore. Deleting them here first would make restore's own internal
      // DELETE FROM filament_colors / DELETE FROM filament_types run against already-empty
      // tables, which would silently pass even if that delete order were reversed — the
      // exact bug this test needs to catch only shows up when restore has to clear real,
      // still-linked rows: deleting filament_types first while filament_colors still
      // references them (or inserting filament_colors before their filament_types row
      // exists) raises a foreign key constraint violation and the request would 500 instead
      // of 200 below.
      db.prepare("UPDATE filament_colors SET hex_color = '#000000'").run();
      db.prepare("UPDATE filament_types SET name = name || '-wiped'").run(); // keeps UNIQUE(name) satisfied
      db.prepare("UPDATE printer_models SET label = 'Wiped'").run();
      db.prepare("UPDATE printer_groups SET created_at = 0").run();
      db.prepare("UPDATE settings SET value = 'Wiped Farm' WHERE key = 'farm_name'").run();

      const restoreRes = await request(app).post('/api/backup/restore').attach('file', backupFile);
      expect(restoreRes.status).toBe(200);
      expect(restoreRes.body.ok).toBe(true);
      expect(restoreRes.body.printer_models).toBe(1);
      expect(restoreRes.body.printer_groups).toBe(1);
      expect(restoreRes.body.filament_types).toBe(2);
      expect(restoreRes.body.filament_colors).toBe(2);

      const model = db.prepare('SELECT * FROM printer_models WHERE model_id = ?').get('x1c');
      expect(model).toMatchObject({ label: 'Bambu X1 Carbon', connector: 'bambu' });

      const group = db.prepare('SELECT * FROM printer_groups WHERE name = ?').get('Bambu Farm');
      expect(group.created_at).not.toBe(0);

      // Confirm each restored color's type_id resolves to the *correct* filament_types row
      // by name, not just to some row that happens to satisfy the FK.
      const black = db.prepare(`
        SELECT ft.name AS type_name, fc.hex_color FROM filament_colors fc
        JOIN filament_types ft ON ft.id = fc.type_id
        WHERE fc.name = 'Galaxy Black'
      `).get();
      expect(black.type_name).toBe('PLA');
      expect(black.hex_color).toBe('#1a1a1a');

      const red = db.prepare(`
        SELECT ft.name AS type_name, fc.hex_color FROM filament_colors fc
        JOIN filament_types ft ON ft.id = fc.type_id
        WHERE fc.name = 'Signal Red'
      `).get();
      expect(red.type_name).toBe('PETG');
      expect(red.hex_color).toBe('#cc0000');

      const farmName = db.prepare("SELECT value FROM settings WHERE key = 'farm_name'").get();
      expect(farmName.value).toBe('Test Farm');
    } finally {
      fs.unlinkSync(backupFile);
    }
  });

  test('restoring an older backup missing printer_models/printer_groups/filament/settings keys leaves current config untouched', async () => {
    const exportRes = await request(app).get('/api/backup');
    const backup = exportRes.body;
    // Simulate a pre-this-feature backup: strip the keys entirely rather than leaving
    // them as empty arrays, matching what an old export actually produced.
    delete backup.printer_models;
    delete backup.printer_groups;
    delete backup.filament_types;
    delete backup.filament_colors;
    delete backup.settings;
    const backupFile = writeTempBackupFile(backup);

    try {
      const restoreRes = await request(app).post('/api/backup/restore').attach('file', backupFile);
      expect(restoreRes.status).toBe(200);
      expect(restoreRes.body.ok).toBe(true);

      const model = db.prepare('SELECT * FROM printer_models WHERE model_id = ?').get('x1c');
      expect(model).toMatchObject({ label: 'Bambu X1 Carbon', connector: 'bambu' });

      const group = db.prepare('SELECT * FROM printer_groups WHERE name = ?').get('Bambu Farm');
      expect(group).toBeTruthy();

      const types = db.prepare('SELECT name FROM filament_types ORDER BY name').all().map(t => t.name);
      expect(types).toEqual(['PETG', 'PLA']);

      const colors = db.prepare('SELECT name FROM filament_colors ORDER BY name').all().map(c => c.name);
      expect(colors).toEqual(['Galaxy Black', 'Signal Red']);

      const farmName = db.prepare("SELECT value FROM settings WHERE key = 'farm_name'").get();
      expect(farmName.value).toBe('Test Farm');
    } finally {
      fs.unlinkSync(backupFile);
    }
  });
});

// Reported (PR review, second round): restore wrote each backup.gcode_files entry straight
// through path.join(GCODE_DIR, key) with no validation. A key like `../../server/index.js`
// resolves outside GCODE_DIR, so a crafted backup could overwrite arbitrary files the server
// process can write to instead of only restoring gcode files. Fixed by rejecting any
// gcode_files key that isn't a bare filename before writing anything to disk.
describe('Backup restore — gcode_files path traversal', () => {
  test('rejects a gcode_files key that would escape GCODE_DIR and writes nothing', async () => {
    const exportRes = await request(app).get('/api/backup');
    const backup = exportRes.body;
    backup.gcode_files = {
      '../../server/index.js': Buffer.from('malicious payload').toString('base64'),
    };
    const backupFile = writeTempBackupFile(backup);

    const writeSpy = jest.spyOn(fs, 'writeFileSync');
    try {
      const restoreRes = await request(app).post('/api/backup/restore').attach('file', backupFile);
      expect(restoreRes.status).toBe(400);
      expect(restoreRes.body.error).toMatch(/invalid gcode file name/i);

      const gcodeWrites = writeSpy.mock.calls.filter(([p]) => typeof p === 'string' && p.includes(`${path.sep}gcode${path.sep}`));
      expect(gcodeWrites.length).toBe(0);
    } finally {
      writeSpy.mockRestore();
      fs.unlinkSync(backupFile);
    }
  });

  test('rejects a bare ".." gcode_files key', async () => {
    const exportRes = await request(app).get('/api/backup');
    const backup = exportRes.body;
    backup.gcode_files = { '..': Buffer.from('malicious payload').toString('base64') };
    const backupFile = writeTempBackupFile(backup);

    try {
      const restoreRes = await request(app).post('/api/backup/restore').attach('file', backupFile);
      expect(restoreRes.status).toBe(400);
    } finally {
      fs.unlinkSync(backupFile);
    }
  });
});

// Reported (PR review): restore bulk-deletes every printer at the top of its
// transaction, bypassing the lifecycle routes where disposeConnection() is called, so
// an existing Creality socket kept its heartbeat and reconnect loop after the restored
// farm had replaced (or removed) that printer. Restore must dispose every cached
// Creality connection before replacing the printers table.
describe('Backup restore disposes cached Creality driver connections', () => {
  test('disposeAllConnections is called when a Creality printer exists', async () => {
    db.prepare(`
      INSERT INTO printers (name, ip, api_key, type, model, status, is_held, is_active, created_at)
      VALUES ('K1_restore', '192.168.1.60', '', 'creality', 'k1', 'IDLE', 0, 1, ?)
    `).run(Date.now());

    const exportRes = await request(app).get('/api/backup');
    const backupFile = writeTempBackupFile(exportRes.body);
    try {
      mockDisposeAllConnections.mockClear();
      const restoreRes = await request(app).post('/api/backup/restore').attach('file', backupFile);
      expect(restoreRes.status).toBe(200);
      expect(mockDisposeAllConnections).toHaveBeenCalledTimes(1);
    } finally {
      fs.unlinkSync(backupFile);
    }
  });

  test('the driver module is not touched when no Creality printer exists', async () => {
    const exportRes = await request(app).get('/api/backup'); // seed data is bambu-only
    const backupFile = writeTempBackupFile(exportRes.body);
    try {
      mockDisposeAllConnections.mockClear();
      const restoreRes = await request(app).post('/api/backup/restore').attach('file', backupFile);
      expect(restoreRes.status).toBe(200);
      expect(mockDisposeAllConnections).not.toHaveBeenCalled();
    } finally {
      fs.unlinkSync(backupFile);
    }
  });
});
