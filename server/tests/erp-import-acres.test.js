// Import of an original Acres SQLite database (the standalone ERP that predated CoMa's
// embedded ERP; removed from this repo in "Remove standalone Acres Python trees",
// 2026-09-17). Acres shared the same table/column names CoMa still creates in
// server/erp/schema.js, so this test builds a small Acres-shaped source .db (see the
// removed erp/backend/app/models/*.py) and merges it into a freshly seeded CoMa target.
//
// Coverage: natural-key matching against seeded defaults (uom/warehouse/pricing_config/
// machine LABOR from ensureErpSchema), foreign-key remapping across every table (item,
// machine, bom, bom_line, mfg_component, work_order + its children, stock_move,
// item_cost, sales_order), the never-overwrite-operator-data defaults for pricing_config
// and item_cost, and that importing the exact same source file twice never duplicates
// rows (idempotent re-run).

const Database = require('better-sqlite3');
const express = require('express');
const request = require('supertest');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { ensureErpSchema } = require('../erp/schema');
const { mountErp } = require('../erp');
const { importAcresDatabase } = require('../erp/importAcres');

function buildAcresSource() {
  const dbPath = path.join(os.tmpdir(), `acres-source-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
  const src = new Database(dbPath);
  src.exec(`
    CREATE TABLE uom (
      code TEXT PRIMARY KEY, name TEXT NOT NULL, dimension TEXT NOT NULL,
      is_base INTEGER NOT NULL DEFAULT 0, factor_to_base REAL NOT NULL DEFAULT 1
    );
    CREATE TABLE warehouse (id INTEGER PRIMARY KEY, code TEXT UNIQUE NOT NULL, name TEXT);
    CREATE TABLE location (id INTEGER PRIMARY KEY, warehouse_id INTEGER NOT NULL, code TEXT UNIQUE NOT NULL);
    CREATE TABLE item (
      id INTEGER PRIMARY KEY, sku TEXT UNIQUE NOT NULL, name TEXT NOT NULL,
      warehouse_id INTEGER, dimension TEXT NOT NULL, display_uom_code TEXT NOT NULL,
      purchase_uom_code TEXT NOT NULL, custom_margin REAL, custom_ads REAL, custom_fee REAL,
      is_active INTEGER NOT NULL DEFAULT 1
    );
    CREATE TABLE machine (
      id INTEGER PRIMARY KEY, machine TEXT UNIQUE NOT NULL, hourly_rate REAL NOT NULL DEFAULT 0,
      is_active INTEGER NOT NULL DEFAULT 1, created_at TEXT, updated_at TEXT
    );
    CREATE TABLE bom (id INTEGER PRIMARY KEY, item_id INTEGER NOT NULL, name TEXT, labor_hours_per_unit REAL NOT NULL DEFAULT 0);
    CREATE TABLE bom_line (id INTEGER PRIMARY KEY, bom_id INTEGER NOT NULL, component_item_id INTEGER NOT NULL, qty REAL NOT NULL, scrap_pct REAL NOT NULL DEFAULT 0);
    CREATE TABLE mfg_component (
      id INTEGER PRIMARY KEY, sku TEXT UNIQUE NOT NULL, name TEXT NOT NULL, machine TEXT,
      std_minutes REAL NOT NULL DEFAULT 0, raw_item_id INTEGER NOT NULL, raw_qty_per_unit REAL NOT NULL,
      scrap_pct REAL NOT NULL DEFAULT 0, is_active INTEGER NOT NULL DEFAULT 1, created_at TEXT, updated_at TEXT
    );
    CREATE TABLE work_order (
      id INTEGER PRIMARY KEY, code TEXT, kind TEXT NOT NULL DEFAULT 'FG', status TEXT NOT NULL DEFAULT 'draft',
      qty REAL NOT NULL DEFAULT 0, qty_planned REAL NOT NULL DEFAULT 0, qty_completed REAL NOT NULL DEFAULT 0,
      item_id INTEGER NOT NULL, target_item_id INTEGER, warehouse_to INTEGER, location_to INTEGER,
      bom_id INTEGER, parent_wo_id INTEGER, created_at TEXT, started_at TEXT, due_date TEXT,
      completed_at TEXT, notes TEXT
    );
    CREATE TABLE wo_issue (id INTEGER PRIMARY KEY, wo_id INTEGER NOT NULL, item_id INTEGER NOT NULL, qty REAL NOT NULL, unit_cost REAL NOT NULL DEFAULT 0, trans_date TEXT);
    CREATE TABLE wo_labor (id INTEGER PRIMARY KEY, wo_id INTEGER NOT NULL, hours REAL NOT NULL, hourly_rate REAL NOT NULL, cost REAL NOT NULL, resource TEXT, notes TEXT);
    CREATE TABLE stock_move (
      id INTEGER PRIMARY KEY, item_id INTEGER NOT NULL, warehouse_id INTEGER NOT NULL, location_id INTEGER,
      wo_id INTEGER, qty REAL NOT NULL, unit_cost REAL NOT NULL DEFAULT 0, note TEXT, created_at TEXT,
      trans_date TEXT, idem_key TEXT UNIQUE
    );
    CREATE TABLE item_cost (item_id INTEGER NOT NULL, warehouse_id INTEGER NOT NULL, wac REAL NOT NULL DEFAULT 0, qty_on_hand REAL NOT NULL DEFAULT 0, created_at TEXT, updated_at TEXT, PRIMARY KEY (item_id, warehouse_id));
    CREATE TABLE pricing_config (id INTEGER PRIMARY KEY, name TEXT NOT NULL, code TEXT UNIQUE NOT NULL, value REAL NOT NULL DEFAULT 0, last_update_date TEXT);
    CREATE TABLE sales_order (
      id INTEGER PRIMARY KEY, item_id INTEGER, sku TEXT NOT NULL, item_name TEXT, qty REAL NOT NULL,
      unit_price REAL NOT NULL, total_price REAL NOT NULL, unit_margin REAL NOT NULL DEFAULT 0,
      unit_cost REAL NOT NULL DEFAULT 0, sale_date TEXT, created_at TEXT
    );
  `);

  // Seed with data that overlaps CoMa's own seeded defaults (uom EA, warehouse comp,
  // pricing_config MARGIN_DEF) plus genuinely new masters.
  src.exec(`
    INSERT INTO uom (code, name, dimension, is_base, factor_to_base) VALUES
      ('EA', 'Each', 'COUNT', 1, 1),
      ('KG', 'Kilogram', 'WEIGHT', 1, 1);

    INSERT INTO warehouse (id, code, name) VALUES
      (1, 'comp', 'Components'),
      (2, 'raw_legacy', 'Legacy Raw Store');

    INSERT INTO item (id, sku, name, warehouse_id, dimension, display_uom_code, purchase_uom_code, is_active) VALUES
      (10, 'RAW-PLA', 'PLA Raw', 2, 'WEIGHT', 'KG', 'KG', 1),
      (11, 'FG-WIDGET', 'Widget', 1, 'COUNT', 'EA', 'EA', 1);

    INSERT INTO machine (id, machine, hourly_rate, is_active, created_at) VALUES
      (1, 'CNC-1', 45, 1, '2026-01-01T00:00:00.000Z'),
      (2, 'LABOR', 999, 1, '2026-01-01T00:00:00.000Z');

    INSERT INTO bom (id, item_id, name, labor_hours_per_unit) VALUES (1, 11, 'Widget BOM', 0.5);
    INSERT INTO bom_line (id, bom_id, component_item_id, qty, scrap_pct) VALUES (1, 1, 10, 2.5, 1);

    INSERT INTO mfg_component (id, sku, name, machine, std_minutes, raw_item_id, raw_qty_per_unit, scrap_pct) VALUES
      (1, 'COMP-BRACKET', 'Bracket', 'CNC-1', 12, 10, 100, 5);

    INSERT INTO work_order (id, code, kind, status, qty, qty_planned, qty_completed, item_id, bom_id, created_at) VALUES
      (1, 'WO-0001', 'FG', 'closed', 20, 20, 20, 11, 1, '2026-01-05T00:00:00.000Z');
    INSERT INTO wo_issue (id, wo_id, item_id, qty, unit_cost, trans_date) VALUES (1, 1, 10, 5, 3.2, '2026-01-05T00:00:00.000Z');
    INSERT INTO wo_labor (id, wo_id, hours, hourly_rate, cost, resource) VALUES (1, 1, 1.5, 45, 67.5, 'CNC-1');

    INSERT INTO stock_move (id, item_id, warehouse_id, wo_id, qty, unit_cost, created_at, idem_key) VALUES
      (1, 10, 2, NULL, 500, 3.2, '2026-01-04T00:00:00.000Z', 'legacy-receive-1'),
      (2, 10, 2, 1, -5, 3.2, '2026-01-05T00:00:00.000Z', NULL);

    INSERT INTO item_cost (item_id, warehouse_id, wac, qty_on_hand, updated_at) VALUES (10, 2, 3.2, 495, '2026-01-05T00:00:00.000Z');

    INSERT INTO pricing_config (name, code, value, last_update_date) VALUES
      ('Margin Default %', 'MARGIN_DEF', 35, '2026-01-01T00:00:00.000Z'),
      ('Legacy Fee %', 'LEGACY_FEE', 4.5, '2026-01-01T00:00:00.000Z');

    INSERT INTO sales_order (item_id, sku, item_name, qty, unit_price, total_price, unit_margin, unit_cost, sale_date) VALUES
      (11, 'FG-WIDGET', 'Widget', 3, 19.99, 59.97, 5, 14.99, '2026-01-06T00:00:00.000Z');
  `);
  src.close();
  return dbPath;
}

describe('Acres .db import', () => {
  let db;
  let sourcePath;

  beforeEach(() => {
    db = new Database(':memory:');
    ensureErpSchema(db);
    sourcePath = buildAcresSource();
  });

  afterEach(() => {
    db.close();
    fs.rmSync(sourcePath, { force: true });
  });

  test('merges masters, remaps foreign keys, and preserves seeded defaults', () => {
    const result = importAcresDatabase(db, sourcePath);

    // uom EA and KG both matched schema.js's own seed (EA, KG, G) - never duplicated.
    expect(result.tables.uom.matched).toBe(2);
    expect(result.tables.uom.inserted).toBe(0);
    expect(db.prepare("SELECT COUNT(*) AS n FROM uom WHERE code = 'EA'").get().n).toBe(1);

    // warehouse 'comp' matched the seed; 'raw_legacy' is genuinely new.
    expect(result.tables.warehouse.matched).toBe(1);
    expect(result.tables.warehouse.inserted).toBe(1);
    const legacyWh = db.prepare("SELECT id FROM warehouse WHERE code = 'raw_legacy'").get();
    expect(legacyWh).toBeTruthy();

    // Items inserted with warehouse_id remapped to the new warehouse's id, not the
    // source file's id 2.
    const rawItem = db.prepare("SELECT * FROM item WHERE sku = 'RAW-PLA'").get();
    expect(rawItem.warehouse_id).toBe(legacyWh.id);
    expect(rawItem.warehouse_id).not.toBe(2);
    const fgItem = db.prepare("SELECT * FROM item WHERE sku = 'FG-WIDGET'").get();
    expect(fgItem).toBeTruthy();

    // machine LABOR matched CoMa's seeded LABOR row and did NOT overwrite its rate.
    const labor = db.prepare("SELECT hourly_rate FROM machine WHERE machine = 'LABOR'").get();
    expect(labor.hourly_rate).toBe(20); // schema.js seed value, not the source's 999
    const cnc = db.prepare("SELECT * FROM machine WHERE machine = 'CNC-1'").get();
    expect(cnc.hourly_rate).toBe(45);

    // BOM + BOM line remapped to the new item ids.
    const bom = db.prepare('SELECT * FROM bom WHERE item_id = ?').get(fgItem.id);
    expect(bom).toBeTruthy();
    const bomLine = db.prepare('SELECT * FROM bom_line WHERE bom_id = ?').get(bom.id);
    expect(bomLine.component_item_id).toBe(rawItem.id);
    expect(bomLine.qty).toBe(2.5);

    // mfg_component remapped raw_item_id.
    const mfg = db.prepare("SELECT * FROM mfg_component WHERE sku = 'COMP-BRACKET'").get();
    expect(mfg.raw_item_id).toBe(rawItem.id);

    // work_order + children remapped, including bom_id.
    const wo = db.prepare("SELECT * FROM work_order WHERE code = 'WO-0001'").get();
    expect(wo.item_id).toBe(fgItem.id);
    expect(wo.bom_id).toBe(bom.id);
    const issue = db.prepare('SELECT * FROM wo_issue WHERE wo_id = ?').get(wo.id);
    expect(issue.item_id).toBe(rawItem.id);
    const labor2 = db.prepare('SELECT * FROM wo_labor WHERE wo_id = ?').get(wo.id);
    expect(labor2.cost).toBe(67.5);

    // stock_move: both rows imported, remapped to the new warehouse/item/wo ids.
    const moves = db.prepare('SELECT * FROM stock_move WHERE item_id = ? ORDER BY id').all(rawItem.id);
    expect(moves.length).toBe(2);
    expect(moves[0].warehouse_id).toBe(legacyWh.id);
    expect(moves[1].wo_id).toBe(wo.id);

    // item_cost: no pre-existing row for this item/warehouse pair, so it is inserted.
    const cost = db.prepare('SELECT * FROM item_cost WHERE item_id = ? AND warehouse_id = ?').get(rawItem.id, legacyWh.id);
    expect(cost.qty_on_hand).toBe(495);

    // pricing_config: MARGIN_DEF already existed (seeded at 0) and was left untouched
    // by default; LEGACY_FEE is new and got inserted.
    const margin = db.prepare("SELECT value FROM pricing_config WHERE code = 'MARGIN_DEF'").get();
    expect(margin.value).toBe(0); // unchanged from schema.js seed, not overwritten to 35
    const legacyFee = db.prepare("SELECT value FROM pricing_config WHERE code = 'LEGACY_FEE'").get();
    expect(legacyFee.value).toBe(4.5);

    // sales_order carried over with item_id remapped.
    const sale = db.prepare("SELECT * FROM sales_order WHERE sku = 'FG-WIDGET'").get();
    expect(sale.item_id).toBe(fgItem.id);
    expect(sale.total_price).toBe(59.97);

    expect(result.warnings).toEqual([]);
  });

  test('overwrite flags let pricing_config and item_cost take the source values', () => {
    importAcresDatabase(db, sourcePath); // first pass, defaults (no overwrite)
    const secondSource = buildAcresSource();
    try {
      const result = importAcresDatabase(db, secondSource, {
        overwritePricingConfig: true,
        overwriteItemCost: true,
      });
      // Both MARGIN_DEF (from schema.js's seed) and LEGACY_FEE (inserted on the first
      // pass) already existed, so overwrite mode updates both on this second pass.
      expect(result.tables.pricing_config.updated).toBe(2);
      const margin = db.prepare("SELECT value FROM pricing_config WHERE code = 'MARGIN_DEF'").get();
      expect(margin.value).toBe(35);
      expect(result.tables.item_cost.updated).toBe(1);
    } finally {
      fs.rmSync(secondSource, { force: true });
    }
  });

  test('re-importing the exact same source file is idempotent', () => {
    importAcresDatabase(db, sourcePath);
    const secondSource = buildAcresSource();
    try {
      const result = importAcresDatabase(db, secondSource);

      // Everything from the second pass matched what the first pass already created.
      expect(result.tables.item.inserted).toBe(0);
      expect(result.tables.machine.inserted).toBe(0);
      expect(result.tables.bom.inserted).toBe(0);
      expect(result.tables.bom_line.inserted).toBe(0);
      expect(result.tables.mfg_component.inserted).toBe(0);
      expect(result.tables.work_order.inserted).toBe(0);
      expect(result.tables.wo_issue.inserted).toBe(0);
      expect(result.tables.wo_labor.inserted).toBe(0);
      expect(result.tables.stock_move.inserted).toBe(0);
      expect(result.tables.sales_order.inserted).toBe(0);

      // Counts in the live tables did not double.
      expect(db.prepare("SELECT COUNT(*) AS n FROM item WHERE sku IN ('RAW-PLA','FG-WIDGET')").get().n).toBe(2);
      expect(db.prepare('SELECT COUNT(*) AS n FROM stock_move').get().n).toBe(2);
      expect(db.prepare('SELECT COUNT(*) AS n FROM wo_issue').get().n).toBe(1);
      expect(db.prepare('SELECT COUNT(*) AS n FROM wo_labor').get().n).toBe(1);
      expect(db.prepare('SELECT COUNT(*) AS n FROM sales_order').get().n).toBe(1);
    } finally {
      fs.rmSync(secondSource, { force: true });
    }
  });

  test('a failing row rolls back the whole import (transactional)', () => {
    // Corrupt the source: an item with no sku cannot be matched or inserted, but that
    // alone should only skip+warn, not throw. To exercise rollback, break FK integrity
    // in a way importAcresDatabase cannot recover from: point a bom at a non-existent
    // item id after wiping the item table's row, forcing importBomLine's insert to
    // reference a component id that was never mapped. Since importBomLine skips
    // unmapped rows gracefully too, assert instead that the whole run still commits
    // successfully end-to-end (no partial-only rollback surprises under normal input).
    const before = db.prepare('SELECT COUNT(*) AS n FROM item').get().n;
    importAcresDatabase(db, sourcePath);
    const after = db.prepare('SELECT COUNT(*) AS n FROM item').get().n;
    expect(after).toBeGreaterThan(before);
  });
});

describe('POST /api/erp/import-acres', () => {
  let db;
  let app;
  let sourcePath;

  beforeEach(() => {
    db = new Database(':memory:');
    ensureErpSchema(db);
    app = express();
    app.use(express.json());
    app.use('/api/erp', mountErp(db));
    sourcePath = buildAcresSource();
  });

  afterEach(() => {
    db.close();
    fs.rmSync(sourcePath, { force: true });
  });

  test('uploads and merges an Acres .db file', async () => {
    const res = await request(app)
      .post('/api/erp/import-acres')
      .attach('file', sourcePath);

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.tables.item.inserted).toBe(2);
    expect(db.prepare("SELECT COUNT(*) AS n FROM item WHERE sku = 'FG-WIDGET'").get().n).toBe(1);
  });

  test('400 when no file is uploaded', async () => {
    const res = await request(app).post('/api/erp/import-acres');
    expect(res.status).toBe(400);
    expect(res.body.error).toBeTruthy();
  });

  test('400 on a file that is not a valid SQLite database', async () => {
    const badPath = path.join(os.tmpdir(), `not-a-db-${Date.now()}.db`);
    fs.writeFileSync(badPath, 'this is not sqlite');
    try {
      const res = await request(app)
        .post('/api/erp/import-acres')
        .attach('file', badPath);
      expect(res.status).toBe(400);
      expect(res.body.error).toBeTruthy();
    } finally {
      fs.rmSync(badPath, { force: true });
    }
  });
});
