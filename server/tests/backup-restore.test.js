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

const request  = require('supertest');
const express  = require('express');
const Database = require('better-sqlite3');
const path     = require('path');
const fs       = require('fs');
const os       = require('os');
const { ensureErpSchema } = require('../erp/schema');

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
      loaded_color        TEXT,
      camera_snapshot_url TEXT,
      camera_stream_url   TEXT
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
      material_grams      REAL,
      erp_sku             TEXT
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
      created_at       INTEGER NOT NULL,
      printing_seconds REAL NOT NULL DEFAULT 0,
      paused_seconds   REAL NOT NULL DEFAULT 0,
      sample_count     INTEGER NOT NULL DEFAULT 0,
      last_sample_at   INTEGER,
      material_grams_actual REAL,
      energy_kwh       REAL,
      telemetry_quality TEXT NOT NULL DEFAULT 'none'
    );
    CREATE TABLE printer_events (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      printer_id  INTEGER NOT NULL,
      event_type  TEXT NOT NULL,
      note        TEXT,
      created_at  INTEGER NOT NULL
    );
    CREATE TABLE printer_status_history (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      printer_id  INTEGER NOT NULL,
      job_id      INTEGER,
      status      TEXT NOT NULL,
      started_at  INTEGER NOT NULL,
      ended_at    INTEGER,
      duration_ms INTEGER
    );
    CREATE TABLE timelapses (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      job_id           INTEGER UNIQUE,
      printer_id       INTEGER NOT NULL,
      part_id          INTEGER,
      status           TEXT NOT NULL DEFAULT 'capturing',
      interval_seconds INTEGER NOT NULL DEFAULT 10,
      frame_count      INTEGER NOT NULL DEFAULT 0,
      dir_path         TEXT,
      video_path       TEXT,
      bytes            INTEGER,
      started_at       INTEGER NOT NULL,
      ended_at         INTEGER,
      render_error     TEXT
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
    CREATE TABLE calendar_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      event_type TEXT NOT NULL,
      title TEXT NOT NULL,
      notes TEXT,
      start_at INTEGER NOT NULL,
      end_at INTEGER,
      all_day INTEGER NOT NULL DEFAULT 1,
      status TEXT NOT NULL DEFAULT 'planned',
      blocks_dispatch INTEGER NOT NULL DEFAULT 0,
      project_id INTEGER REFERENCES projects(id),
      item_sku TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `);
  ensureErpSchema(db);

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
  db.prepare(`
    INSERT INTO calendar_events (
      event_type, title, notes, start_at, end_at, all_day, status,
      blocks_dispatch, item_sku, created_at, updated_at
    ) VALUES (
      'production_closure', 'Holiday shutdown', 'Plant closed', ?, ?, 1, 'planned',
      1, NULL, ?, ?
    )
  `).run(now, now + 3 * 86400000, now, now);

  const rawWh = db.prepare("SELECT id FROM warehouse WHERE code = 'raw'").get();
  const compWh = db.prepare("SELECT id FROM warehouse WHERE code = 'comp'").get();
  const finWh = db.prepare("SELECT id FROM warehouse WHERE code = 'fin_good'").get();
  const location = db.prepare('INSERT INTO location (warehouse_id, code) VALUES (?, ?)')
    .run(rawWh.id, '01A01');
  const rawItem = db.prepare(`
    INSERT INTO item
      (sku, name, warehouse_id, dimension, display_uom_code, purchase_uom_code,
       item_role, sourcing, needs_erp_data)
    VALUES ('RAW-PLA', 'PLA Black', ?, 'WEIGHT', 'G', 'KG', 'raw', 'outsource', 0)
  `).run(rawWh.id);
  const componentItem = db.prepare(`
    INSERT INTO item
      (sku, name, warehouse_id, dimension, display_uom_code, purchase_uom_code,
       item_role, sourcing, part_id, project_id, needs_erp_data)
    VALUES ('COMP-BRACKET', 'Bracket component', ?, 'COUNT', 'EA', 'EA',
            'component', 'manufactured', 1, 1, 0)
  `).run(compWh.id);
  db.prepare("UPDATE parts SET erp_sku = 'COMP-BRACKET' WHERE id = 1").run();
  const finishedItem = db.prepare(`
    INSERT INTO item
      (sku, name, warehouse_id, dimension, display_uom_code, purchase_uom_code,
       custom_margin, item_role, sourcing, project_id, needs_erp_data)
    VALUES ('FG-BRACKET', 'Bracket', ?, 'COUNT', 'EA', 'EA', 35,
            'product', 'manufactured', 1, 0)
  `).run(finWh.id);
  db.prepare(`
    INSERT INTO machine
      (machine, hourly_rate, is_active, created_at, printer_id, needs_erp_data)
    VALUES ('Bambu_01', 32.5, 1, '2026-09-17T10:00:00.000Z', 1, 0)
  `).run();
  db.prepare(`
    INSERT INTO mfg_component
      (sku, name, machine, std_minutes, raw_item_id, raw_qty_per_unit, scrap_pct,
       is_active, created_at)
    VALUES ('COMP-BRACKET', 'Bracket component', 'Bambu_01', 30, ?, 100, 5, 1,
            '2026-09-17T10:00:00.000Z')
  `).run(rawItem.lastInsertRowid);
  const bom = db.prepare(`
    INSERT INTO bom (item_id, name, labor_hours_per_unit)
    VALUES (?, 'Bracket BOM', 0.25)
  `).run(finishedItem.lastInsertRowid);
  db.prepare('INSERT INTO bom_line (bom_id, component_item_id, qty, scrap_pct) VALUES (?, ?, 2, 1)')
    .run(bom.lastInsertRowid, componentItem.lastInsertRowid);
  const wo = db.prepare(`
    INSERT INTO work_order
      (code, kind, status, qty, qty_planned, qty_completed, item_id, target_item_id,
       warehouse_to, bom_id, created_at, completed_at, notes)
    VALUES ('WO-ERP-1', 'FG', 'closed', 3, 3, 3, ?, ?, ?, ?,
            '2026-09-17T10:00:00.000Z', '2026-09-17T11:00:00.000Z', 'backup test')
  `).run(finishedItem.lastInsertRowid, finishedItem.lastInsertRowid, finWh.id, bom.lastInsertRowid);
  db.prepare(`
    INSERT INTO stock_move
      (item_id, warehouse_id, location_id, wo_id, qty, unit_cost, note, created_at,
       trans_date, idem_key)
    VALUES (?, ?, ?, NULL, 5, 20, 'PO-ERP', '2026-09-17T09:00:00.000Z',
            '2026-09-17', 'backup-raw-receipt')
  `).run(rawItem.lastInsertRowid, rawWh.id, location.lastInsertRowid);
  db.prepare(`
    INSERT INTO stock_move
      (item_id, warehouse_id, wo_id, qty, unit_cost, note, created_at, trans_date,
       idem_key)
    VALUES (?, ?, ?, 3, 7.5, 'WO receipt', '2026-09-17T11:00:00.000Z',
            '2026-09-17', 'backup-wo-receipt')
  `).run(finishedItem.lastInsertRowid, finWh.id, wo.lastInsertRowid);
  db.prepare(`
    INSERT INTO item_cost (item_id, warehouse_id, wac, qty_on_hand, created_at, updated_at)
    VALUES (?, ?, 20, 5, '2026-09-17T09:00:00.000Z', '2026-09-17T09:00:00.000Z')
  `).run(rawItem.lastInsertRowid, rawWh.id);
  db.prepare(`
    INSERT INTO wo_issue (wo_id, item_id, qty, unit_cost, trans_date)
    VALUES (?, ?, 0.315, 20, '2026-09-17')
  `).run(wo.lastInsertRowid, rawItem.lastInsertRowid);
  db.prepare(`
    INSERT INTO wo_labor (wo_id, hours, hourly_rate, cost, resource, notes)
    VALUES (?, 1.5, 32.5, 48.75, 'Bambu_01', 'backup test')
  `).run(wo.lastInsertRowid);
  db.prepare("UPDATE pricing_config SET value = 18 WHERE code = 'MARGIN_DEF'").run();
  db.prepare(`
    INSERT INTO sales_order
      (item_id, sku, item_name, qty, unit_price, total_price, unit_margin, unit_cost,
       sale_date, created_at)
    VALUES (?, 'FG-BRACKET', 'Bracket', 1, 15, 15, 7.5, 7.5,
            '2026-09-17', '2026-09-17T12:00:00.000Z')
  `).run(finishedItem.lastInsertRowid);
  db.prepare(`
    INSERT INTO erp_posting
      (job_id, part_id, printer_id, erp_sku, qty, status, created_at, note)
    VALUES (1, 1, 1, 'COMP-BRACKET', 1, 'pending', ?, 'backup seed')
  `).run(Date.now());

  // eBay Sell tables (credentials seeded but must NOT appear in backup export)
  db.prepare(`
    UPDATE ebay_credential SET
      client_id = 'test-client-id',
      client_secret = 'test-client-secret',
      refresh_token = 'test-refresh-token',
      updated_at = ?
    WHERE id = 1
  `).run(Date.now());
  db.prepare(`
    INSERT INTO ebay_listing (item_id, ebay_sku, offer_id, listing_id, last_pushed_qty, last_pushed_price, is_active)
    VALUES (?, 'EBAY-FG-BRACKET', 'offer-1', 'listing-1', 3, 15.5, 1)
  `).run(finishedItem.lastInsertRowid);
  db.prepare(`
    INSERT INTO ebay_order
      (order_id, legacy_order_id, creation_date, last_modified_date, order_payment_status,
       order_fulfillment_status, buyer_username, total_amount, currency, marketplace_id,
       raw_json, imported_at)
    VALUES ('ORD-1', 'LEG-1', '2026-09-17T12:00:00.000Z', '2026-09-17T12:05:00.000Z',
            'PAID', 'NOT_STARTED', 'buyer1', 15.5, 'USD', 'EBAY_US', '{}', ?)
  `).run(Date.now());
  db.prepare(`
    INSERT INTO ebay_order_line
      (line_item_id, ebay_order_id, ebay_sku, title, qty, unit_price, total_price, item_id, status)
    VALUES ('LINE-1', 'ORD-1', 'EBAY-FG-BRACKET', 'Bracket', 1, 15.5, 15.5, ?, 'pending')
  `).run(finishedItem.lastInsertRowid);
  db.prepare(
    "INSERT INTO ebay_sync_state (key, value) VALUES ('orders_last_modified', '2026-09-17T12:05:00.000Z')"
  ).run();

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

describe('Backup export/restore: embedded ERP domain', () => {
  const erpTables = [
    'uom', 'warehouse', 'location', 'item', 'machine', 'bom', 'bom_line',
    'stock_move', 'item_cost', 'mfg_component', 'work_order', 'wo_issue',
    'wo_labor', 'pricing_config', 'sales_order', 'erp_posting',
    'ebay_listing', 'ebay_order', 'ebay_order_line', 'ebay_sync_state',
  ];

  test('export includes every ERP table and the shopfloor ERP link', async () => {
    const res = await request(app).get('/api/backup');
    expect(res.status).toBe(200);
    expect(Object.keys(res.body.erp).sort()).toEqual([...erpTables].sort());
    for (const table of erpTables) expect(res.body.erp[table].length).toBeGreaterThan(0);
    expect(res.body.parts[0].erp_sku).toBe('COMP-BRACKET');
    expect(res.body.erp.sales_order[0]).toMatchObject({
      sku: 'FG-BRACKET', qty: 1, total_price: 15,
    });
  });

  test('export never includes ebay_credential secrets', async () => {
    const res = await request(app).get('/api/backup');
    expect(res.status).toBe(200);
    expect(res.body.erp.ebay_credential).toBeUndefined();
    expect(JSON.stringify(res.body)).not.toMatch(/test-client-secret/);
    expect(JSON.stringify(res.body)).not.toMatch(/test-refresh-token/);
    // Row still exists in DB
    expect(db.prepare('SELECT client_secret FROM ebay_credential WHERE id = 1').get().client_secret)
      .toBe('test-client-secret');
  });

  test('restore round-trips inventory, costing, BOM, WO, machine, pricing, and sales data', async () => {
    const exportRes = await request(app).get('/api/backup');
    expect(exportRes.status).toBe(200);
    const expectedCounts = Object.fromEntries(
      erpTables.map(table => [table, exportRes.body.erp[table].length])
    );
    const backupFile = writeTempBackupFile(exportRes.body);

    try {
      db.exec(`
        DELETE FROM ebay_order_line;
        DELETE FROM ebay_order;
        DELETE FROM ebay_listing;
        DELETE FROM ebay_sync_state;
        DELETE FROM erp_posting;
        DELETE FROM sales_order;
        DELETE FROM wo_labor;
        DELETE FROM wo_issue;
        DELETE FROM stock_move;
        DELETE FROM work_order;
        DELETE FROM bom_line;
        DELETE FROM bom;
        DELETE FROM mfg_component;
        DELETE FROM item_cost;
        DELETE FROM machine;
        DELETE FROM item;
        DELETE FROM location;
        DELETE FROM warehouse;
        DELETE FROM uom;
        DELETE FROM pricing_config;
      `);
      db.prepare("UPDATE parts SET erp_sku = NULL WHERE id = 1").run();

      const restoreRes = await request(app).post('/api/backup/restore').attach('file', backupFile);
      expect(restoreRes.status).toBe(200);
      expect(restoreRes.body.ok).toBe(true);
      expect(restoreRes.body.erp).toEqual(expectedCounts);

      for (const [table, count] of Object.entries(expectedCounts)) {
        expect(db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n).toBe(count);
      }
      expect(db.prepare('SELECT erp_sku FROM parts WHERE id = 1').get().erp_sku).toBe('COMP-BRACKET');
      expect(db.prepare("SELECT hourly_rate, printer_id FROM machine WHERE machine = 'Bambu_01'").get())
        .toMatchObject({ hourly_rate: 32.5, printer_id: 1 });
      expect(db.prepare("SELECT qty, unit_cost FROM stock_move WHERE idem_key = 'backup-raw-receipt'").get())
        .toMatchObject({ qty: 5, unit_cost: 20 });
      expect(db.prepare("SELECT qty_completed, status FROM work_order WHERE code = 'WO-ERP-1'").get())
        .toMatchObject({ qty_completed: 3, status: 'closed' });
      expect(db.prepare(`
        SELECT i.sku AS product_sku, c.sku AS component_sku, bl.qty
        FROM bom b
        JOIN item i ON i.id = b.item_id
        JOIN bom_line bl ON bl.bom_id = b.id
        JOIN item c ON c.id = bl.component_item_id
        WHERE b.name = 'Bracket BOM'
      `).get()).toMatchObject({ product_sku: 'FG-BRACKET', component_sku: 'COMP-BRACKET', qty: 2 });
      expect(db.prepare("SELECT value FROM pricing_config WHERE code = 'MARGIN_DEF'").get().value).toBe(18);
      expect(db.prepare("SELECT total_price FROM sales_order WHERE sku = 'FG-BRACKET'").get().total_price).toBe(15);
      expect(db.prepare("SELECT ebay_sku FROM ebay_listing WHERE ebay_sku = 'EBAY-FG-BRACKET'").get().ebay_sku)
        .toBe('EBAY-FG-BRACKET');
      expect(db.prepare("SELECT order_id FROM ebay_order WHERE order_id = 'ORD-1'").get().order_id).toBe('ORD-1');
    } finally {
      fs.unlinkSync(backupFile);
    }
  });

  test('older shopfloor-only backup preserves the current ERP domain', async () => {
    const exportRes = await request(app).get('/api/backup');
    const backup = exportRes.body;
    delete backup.erp;
    db.prepare("UPDATE machine SET hourly_rate = 77 WHERE machine = 'Bambu_01'").run();
    const beforeSales = db.prepare('SELECT COUNT(*) AS n FROM sales_order').get().n;
    const backupFile = writeTempBackupFile(backup);

    try {
      const restoreRes = await request(app).post('/api/backup/restore').attach('file', backupFile);
      expect(restoreRes.status).toBe(200);
      expect(restoreRes.body.erp).toBeNull();
      expect(db.prepare("SELECT hourly_rate FROM machine WHERE machine = 'Bambu_01'").get().hourly_rate).toBe(77);
      expect(db.prepare('SELECT COUNT(*) AS n FROM sales_order').get().n).toBe(beforeSales);
    } finally {
      fs.unlinkSync(backupFile);
    }
  });

  test('rejects a partial ERP section before changing the database', async () => {
    const exportRes = await request(app).get('/api/backup');
    const backup = exportRes.body;
    delete backup.erp.sales_order;
    const before = db.prepare('SELECT COUNT(*) AS n FROM sales_order').get().n;
    const backupFile = writeTempBackupFile(backup);

    try {
      const restoreRes = await request(app).post('/api/backup/restore').attach('file', backupFile);
      expect(restoreRes.status).toBe(400);
      expect(restoreRes.body.error).toMatch(/missing table arrays/);
      expect(db.prepare('SELECT COUNT(*) AS n FROM sales_order').get().n).toBe(before);
    } finally {
      fs.unlinkSync(backupFile);
    }
  });

  test('older ERP backup without eBay tables still restores', async () => {
    const exportRes = await request(app).get('/api/backup');
    const backup = exportRes.body;
    delete backup.erp.ebay_listing;
    delete backup.erp.ebay_order;
    delete backup.erp.ebay_order_line;
    delete backup.erp.ebay_sync_state;
    const backupFile = writeTempBackupFile(backup);

    try {
      const restoreRes = await request(app).post('/api/backup/restore').attach('file', backupFile);
      expect(restoreRes.status).toBe(200);
      expect(restoreRes.body.ok).toBe(true);
      expect(db.prepare('SELECT COUNT(*) AS n FROM ebay_listing').get().n).toBe(0);
      expect(db.prepare("SELECT total_price FROM sales_order WHERE sku = 'FG-BRACKET'").get().total_price).toBe(15);
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
    expect(res.body.calendar_events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          event_type: 'production_closure',
          title: 'Holiday shutdown',
          blocks_dispatch: 1,
        }),
      ])
    );
  });

  test('restore round-trips calendar_events', async () => {
    const exportRes = await request(app).get('/api/backup');
    expect(exportRes.status).toBe(200);
    const backupFile = writeTempBackupFile(exportRes.body);

    try {
      db.prepare("UPDATE calendar_events SET title = 'Wiped'").run();

      const restoreRes = await request(app).post('/api/backup/restore').attach('file', backupFile);
      expect(restoreRes.status).toBe(200);
      expect(restoreRes.body.ok).toBe(true);
      expect(restoreRes.body.calendar_events).toBe(1);

      const row = db.prepare('SELECT * FROM calendar_events WHERE title = ?').get('Holiday shutdown');
      expect(row).toMatchObject({
        event_type: 'production_closure',
        blocks_dispatch: 1,
        status: 'planned',
      });
    } finally {
      fs.unlinkSync(backupFile);
    }
  });

  test('older backup without calendar_events leaves current calendar rows alone', async () => {
    const exportRes = await request(app).get('/api/backup');
    expect(exportRes.status).toBe(200);
    const backup = { ...exportRes.body };
    delete backup.calendar_events;
    const backupFile = writeTempBackupFile(backup);

    try {
      const before = db.prepare('SELECT COUNT(*) AS n FROM calendar_events').get().n;
      expect(before).toBe(1);

      const restoreRes = await request(app).post('/api/backup/restore').attach('file', backupFile);
      expect(restoreRes.status).toBe(200);

      const after = db.prepare('SELECT COUNT(*) AS n FROM calendar_events').get().n;
      expect(after).toBe(1);
      expect(db.prepare('SELECT title FROM calendar_events').get().title).toBe('Holiday shutdown');
    } finally {
      fs.unlinkSync(backupFile);
    }
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

// Regression guard for the login patch (server/auth.js, server/routes/auth.js): a backup
// must never carry the operator account or its password hash. Restoring a backup on a
// different machine must not change who can log into it, the same way ebay_credential is
// excluded above for secrets.
describe('Backup export: auth tables intentionally excluded', () => {
  test('GET /api/backup never includes auth_account or auth_sessions, or a password hash', async () => {
    db.exec(`
      CREATE TABLE auth_account (
        id                      INTEGER PRIMARY KEY CHECK (id = 1),
        username                TEXT NOT NULL,
        password_hash           TEXT NOT NULL,
        password_salt           TEXT NOT NULL,
        onboarding_completed_at INTEGER,
        created_at              INTEGER NOT NULL
      );
      CREATE TABLE auth_sessions (
        token       TEXT PRIMARY KEY,
        created_at  INTEGER NOT NULL,
        expires_at  INTEGER NOT NULL
      );
    `);
    db.prepare(`
      INSERT INTO auth_account (id, username, password_hash, password_salt, created_at)
      VALUES (1, 'operator', 'deadbeefsecrethash', 'somesalt', ?)
    `).run(Date.now());
    db.prepare('INSERT INTO auth_sessions (token, created_at, expires_at) VALUES (?, ?, ?)')
      .run('sometoken', Date.now(), Date.now() + 1000);

    const res = await request(app).get('/api/backup');
    expect(res.status).toBe(200);
    expect(res.body.auth_account).toBeUndefined();
    expect(res.body.auth_sessions).toBeUndefined();
    expect(JSON.stringify(res.body)).not.toMatch(/deadbeefsecrethash/);
  });
});
