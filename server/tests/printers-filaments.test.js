// Tests for:
//   GET /api/printers/filaments
//   PUT /api/printers/:id — loaded_material / loaded_color fields
//   Auto-registration into printer_groups on create/update

const request  = require('supertest');
const express  = require('express');
const Database = require('better-sqlite3');

let db;
let app;

beforeAll(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE printers (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      name              TEXT NOT NULL UNIQUE,
      ip                TEXT NOT NULL,
      api_key           TEXT NOT NULL DEFAULT '',
      group_name        TEXT,
      type              TEXT DEFAULT 'prusa',
      model             TEXT NOT NULL,
      status            TEXT DEFAULT 'UNKNOWN',
      is_held           INTEGER DEFAULT 1,
      is_active         INTEGER DEFAULT 1,
      decommissioned_at INTEGER,
      decommission_note TEXT,
      serial_number     TEXT DEFAULT '',
      loaded_material   TEXT,
      loaded_color      TEXT,
      created_at        INTEGER NOT NULL
    );
    CREATE TABLE printer_events (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      printer_id INTEGER NOT NULL,
      event_type TEXT NOT NULL,
      note       TEXT,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE printer_models (
      model_id  TEXT PRIMARY KEY,
      label     TEXT NOT NULL,
      connector TEXT NOT NULL
    );
    CREATE TABLE printer_groups (
      name       TEXT PRIMARY KEY,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE projects (id INTEGER PRIMARY KEY, name TEXT, status TEXT DEFAULT 'draft',
      priority INTEGER DEFAULT 0, created_at INTEGER, updated_at INTEGER);
    CREATE TABLE parts (id INTEGER PRIMARY KEY, project_id INTEGER, name TEXT,
      target_qty INTEGER, completed_qty INTEGER DEFAULT 0, status TEXT DEFAULT 'open',
      sort_order INTEGER DEFAULT 0, created_at INTEGER, updated_at INTEGER);
    CREATE TABLE gcodes (id INTEGER PRIMARY KEY, part_id INTEGER, printer_model TEXT,
      filename TEXT, filepath TEXT, parts_per_plate INTEGER, est_print_secs INTEGER,
      material_grams REAL, ams_slot INTEGER, allowed_groups TEXT,
      required_material TEXT, required_color TEXT, created_at INTEGER);
    CREATE TABLE jobs (id INTEGER PRIMARY KEY, part_id INTEGER, printer_id INTEGER,
      gcode_id INTEGER, parts_per_plate INTEGER, status TEXT DEFAULT 'queued',
      started_at INTEGER, finished_at INTEGER, created_at INTEGER);
    CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);

    INSERT INTO printer_models VALUES ('mk4s', 'MK4S', 'prusa');
  `);

  // Seed printers with varied groups/materials/colors
  const now = Date.now();
  const ins = db.prepare(`
    INSERT INTO printers (name, ip, api_key, group_name, model, is_active, loaded_material, loaded_color, created_at)
    VALUES (?, ?, '', ?, 'mk4s', ?, ?, ?, ?)
  `);
  ins.run('P1', '192.168.1.1', 'Rack A', 1, 'PLA',  'Black',  now);
  ins.run('P2', '192.168.1.2', 'Rack A', 1, 'PLA',  'White',  now);
  ins.run('P3', '192.168.1.3', 'Rack B', 1, 'PETG', 'Black',  now);
  ins.run('P4', '192.168.1.4', 'Rack B', 1, null,    null,     now);
  ins.run('P5', '192.168.1.5', null,     0, 'ABS',  'Red',    now); // decommissioned

  app = express();
  app.use(express.json());
  app.use('/api/printers', require('../routes/printers')(db));
});

// ── GET /api/printers/filaments ───────────────────────────────────────────────

describe('GET /api/printers/filaments', () => {
  test('returns distinct materials and colors', async () => {
    const res = await request(app).get('/api/printers/filaments');
    expect(res.status).toBe(200);
    expect(res.body.materials).toEqual(['ABS', 'PETG', 'PLA']); // sorted, deduped
    expect(res.body.colors).toEqual(['Black', 'Red', 'White']); // sorted, deduped
  });

  test('does not include null or empty values', async () => {
    const res = await request(app).get('/api/printers/filaments');
    expect(res.body.materials).not.toContain(null);
    expect(res.body.colors).not.toContain(null);
    expect(res.body.materials).not.toContain('');
    expect(res.body.colors).not.toContain('');
  });

});

// The filaments query logic tested directly — the printers router uses a module-level
// express.Router(), so a second factory call in the same Jest module registry would
// share the first call's db. Test the underlying SQL instead.
describe('filaments query logic — direct SQL', () => {
  test('returns empty arrays when no printers have material configured', () => {
    const testDb = new Database(':memory:');
    testDb.exec(`CREATE TABLE printers (id INTEGER PRIMARY KEY,
      loaded_material TEXT, loaded_color TEXT, is_active INTEGER DEFAULT 1)`);
    // Two printers with NULL material/color
    testDb.exec(`INSERT INTO printers VALUES (1, NULL, NULL, 1)`);
    testDb.exec(`INSERT INTO printers VALUES (2, '', '', 1)`);

    const materials = testDb.prepare(
      "SELECT DISTINCT loaded_material FROM printers WHERE loaded_material IS NOT NULL AND loaded_material != '' ORDER BY loaded_material"
    ).all().map(r => r.loaded_material);
    const colors = testDb.prepare(
      "SELECT DISTINCT loaded_color FROM printers WHERE loaded_color IS NOT NULL AND loaded_color != '' ORDER BY loaded_color"
    ).all().map(r => r.loaded_color);

    expect(materials).toEqual([]);
    expect(colors).toEqual([]);
  });

  test('deduplicates and sorts when multiple printers share the same material', () => {
    const testDb = new Database(':memory:');
    testDb.exec(`CREATE TABLE printers (id INTEGER PRIMARY KEY,
      loaded_material TEXT, loaded_color TEXT, is_active INTEGER DEFAULT 1)`);
    testDb.exec(`INSERT INTO printers VALUES (1, 'PLA', 'Black', 1)`);
    testDb.exec(`INSERT INTO printers VALUES (2, 'PLA', 'White', 1)`);
    testDb.exec(`INSERT INTO printers VALUES (3, 'PETG', 'Black', 1)`);

    const materials = testDb.prepare(
      "SELECT DISTINCT loaded_material FROM printers WHERE loaded_material IS NOT NULL AND loaded_material != '' ORDER BY loaded_material"
    ).all().map(r => r.loaded_material);
    const colors = testDb.prepare(
      "SELECT DISTINCT loaded_color FROM printers WHERE loaded_color IS NOT NULL AND loaded_color != '' ORDER BY loaded_color"
    ).all().map(r => r.loaded_color);

    expect(materials).toEqual(['PETG', 'PLA']);
    expect(colors).toEqual(['Black', 'White']);
  });
});

// ── PUT /api/printers/:id — loaded_material / loaded_color ────────────────────

describe('PUT /api/printers/:id — material and color', () => {
  let printerId;

  beforeAll(() => {
    const row = db.prepare(
      "INSERT INTO printers (name, ip, api_key, model, is_active, created_at) VALUES ('EditMe', '10.0.0.1', '', 'mk4s', 1, ?)"
    ).run(Date.now());
    printerId = row.lastInsertRowid;
  });

  test('sets loaded_material and loaded_color', async () => {
    const res = await request(app)
      .put(`/api/printers/${printerId}`)
      .send({ loaded_material: 'PLA', loaded_color: 'Blue' });
    expect(res.status).toBe(200);
    expect(res.body.loaded_material).toBe('PLA');
    expect(res.body.loaded_color).toBe('Blue');
  });

  test('updates material without touching color', async () => {
    // Only send loaded_material — color should remain 'Blue' from previous test
    const res = await request(app)
      .put(`/api/printers/${printerId}`)
      .send({ loaded_material: 'PETG' });
    expect(res.status).toBe(200);
    expect(res.body.loaded_material).toBe('PETG');
    expect(res.body.loaded_color).toBe('Blue');
  });

  test('clears loaded_material when empty string is sent', async () => {
    const res = await request(app)
      .put(`/api/printers/${printerId}`)
      .send({ loaded_material: '' });
    expect(res.status).toBe(200);
    expect(res.body.loaded_material).toBeNull();
    expect(res.body.loaded_color).toBe('Blue'); // color unchanged
  });

  test('clears loaded_color when null is sent', async () => {
    // First restore material so we can verify independent clearing
    await request(app)
      .put(`/api/printers/${printerId}`)
      .send({ loaded_material: 'ASA', loaded_color: 'Grey' });

    const res = await request(app)
      .put(`/api/printers/${printerId}`)
      .send({ loaded_color: null });
    expect(res.status).toBe(200);
    expect(res.body.loaded_material).toBe('ASA');
    expect(res.body.loaded_color).toBeNull();
  });

  test('omitting both fields leaves them unchanged', async () => {
    // Set known state
    await request(app)
      .put(`/api/printers/${printerId}`)
      .send({ loaded_material: 'TPU', loaded_color: 'Orange' });

    // Update something else entirely, don't touch material/color
    const res = await request(app)
      .put(`/api/printers/${printerId}`)
      .send({ serial_number: 'SN-9999' });
    expect(res.status).toBe(200);
    expect(res.body.loaded_material).toBe('TPU');
    expect(res.body.loaded_color).toBe('Orange');
  });
});

// ── printer_groups auto-registration ───────────────────────────────────────
// A group typed on a printer must persist in the registry even after every
// printer carrying it is later reassigned elsewhere: this is what the
// registry exists to fix. Create/update are the two places a new name enters.

describe('printer_groups auto-registration', () => {
  test('POST /api/printers registers a new group_name', async () => {
    const res = await request(app)
      .post('/api/printers')
      .send({ name: 'NewOne', ip: '10.0.0.9', api_key: 'k', model: 'mk4s', group_name: 'Rack Z' });
    expect(res.status).toBe(201);
    expect(db.prepare('SELECT * FROM printer_groups WHERE name = ?').get('Rack Z')).toBeTruthy();
  });

  test('PUT /api/printers/:id registers a new group_name', async () => {
    const row = db.prepare(
      "INSERT INTO printers (name, ip, api_key, model, is_active, created_at) VALUES ('GroupEditMe', '10.0.0.8', '', 'mk4s', 1, ?)"
    ).run(Date.now());

    const res = await request(app)
      .put(`/api/printers/${row.lastInsertRowid}`)
      .send({ group_name: 'Rack Q' });
    expect(res.status).toBe(200);
    expect(db.prepare('SELECT * FROM printer_groups WHERE name = ?').get('Rack Q')).toBeTruthy();
  });

  test('the registry keeps a group even after the only printer carrying it moves away', async () => {
    const created = await request(app)
      .post('/api/printers')
      .send({ name: 'Mover', ip: '10.0.0.7', api_key: 'k', model: 'mk4s', group_name: 'Rack Solo' });
    expect(db.prepare('SELECT * FROM printer_groups WHERE name = ?').get('Rack Solo')).toBeTruthy();

    // Reassign the only printer that ever carried "Rack Solo" elsewhere.
    await request(app)
      .put(`/api/printers/${created.body.id}`)
      .send({ group_name: 'Rack Other' });

    // No printer carries "Rack Solo" anymore, but the registry entry survives:
    // this is the exact bug the registry exists to fix.
    expect(db.prepare('SELECT COUNT(*) AS c FROM printers WHERE group_name = ?').get('Rack Solo').c).toBe(0);
    expect(db.prepare('SELECT * FROM printer_groups WHERE name = ?').get('Rack Solo')).toBeTruthy();
  });
});
