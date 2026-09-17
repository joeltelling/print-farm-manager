/**
 * Acres ERP tables in the same SQLite file as shopfloor.
 * CREATE IF NOT EXISTS only: never drops or rewrites existing Acres/CoMa data.
 */
function ensureErpSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS uom (
      code TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      dimension TEXT NOT NULL,
      is_base INTEGER NOT NULL DEFAULT 0,
      factor_to_base REAL NOT NULL DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS warehouse (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      code TEXT UNIQUE NOT NULL,
      name TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS location (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      warehouse_id INTEGER REFERENCES warehouse(id) ON DELETE CASCADE,
      code TEXT NOT NULL,
      UNIQUE (warehouse_id, code)
    );

    CREATE TABLE IF NOT EXISTS item (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      sku TEXT UNIQUE NOT NULL,
      name TEXT NOT NULL,
      warehouse_id INTEGER REFERENCES warehouse(id),
      dimension TEXT NOT NULL DEFAULT 'COUNT',
      display_uom_code TEXT NOT NULL,
      purchase_uom_code TEXT NOT NULL,
      custom_margin REAL,
      custom_ads REAL,
      custom_fee REAL,
      is_active INTEGER NOT NULL DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS machine (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      machine TEXT UNIQUE NOT NULL,
      hourly_rate REAL NOT NULL DEFAULT 0,
      is_active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT,
      updated_at TEXT
    );

    CREATE TABLE IF NOT EXISTS bom (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      item_id INTEGER NOT NULL REFERENCES item(id),
      name TEXT,
      labor_hours_per_unit REAL NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS bom_line (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      bom_id INTEGER NOT NULL REFERENCES bom(id) ON DELETE CASCADE,
      component_item_id INTEGER NOT NULL REFERENCES item(id),
      qty REAL NOT NULL DEFAULT 0,
      scrap_pct REAL NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS stock_move (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      item_id INTEGER NOT NULL REFERENCES item(id),
      warehouse_id INTEGER NOT NULL REFERENCES warehouse(id),
      location_id INTEGER REFERENCES location(id),
      wo_id INTEGER,
      qty REAL NOT NULL,
      unit_cost REAL NOT NULL DEFAULT 0,
      note TEXT,
      created_at TEXT,
      trans_date TEXT,
      idem_key TEXT UNIQUE
    );

    CREATE TABLE IF NOT EXISTS item_cost (
      item_id INTEGER NOT NULL REFERENCES item(id) ON DELETE CASCADE,
      warehouse_id INTEGER NOT NULL REFERENCES warehouse(id) ON DELETE CASCADE,
      wac REAL NOT NULL DEFAULT 0,
      qty_on_hand REAL NOT NULL DEFAULT 0,
      created_at TEXT,
      updated_at TEXT,
      PRIMARY KEY (item_id, warehouse_id)
    );

    CREATE TABLE IF NOT EXISTS mfg_component (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      sku TEXT UNIQUE NOT NULL,
      name TEXT NOT NULL,
      machine TEXT,
      std_minutes REAL NOT NULL DEFAULT 0,
      raw_item_id INTEGER NOT NULL REFERENCES item(id),
      raw_qty_per_unit REAL NOT NULL,
      scrap_pct REAL NOT NULL DEFAULT 0,
      is_active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT,
      updated_at TEXT
    );

    CREATE TABLE IF NOT EXISTS work_order (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      code TEXT,
      kind TEXT NOT NULL DEFAULT 'FG',
      status TEXT NOT NULL DEFAULT 'draft',
      qty REAL NOT NULL DEFAULT 0,
      qty_planned REAL NOT NULL DEFAULT 0,
      qty_completed REAL NOT NULL DEFAULT 0,
      item_id INTEGER NOT NULL REFERENCES item(id),
      target_item_id INTEGER REFERENCES item(id),
      warehouse_to INTEGER REFERENCES warehouse(id),
      location_to INTEGER REFERENCES location(id),
      bom_id INTEGER REFERENCES bom(id),
      parent_wo_id INTEGER,
      created_at TEXT,
      started_at TEXT,
      due_date TEXT,
      completed_at TEXT,
      notes TEXT
    );

    CREATE TABLE IF NOT EXISTS wo_issue (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      wo_id INTEGER NOT NULL REFERENCES work_order(id) ON DELETE CASCADE,
      item_id INTEGER NOT NULL REFERENCES item(id),
      qty REAL NOT NULL DEFAULT 0,
      unit_cost REAL NOT NULL DEFAULT 0,
      trans_date TEXT
    );

    CREATE TABLE IF NOT EXISTS wo_labor (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      wo_id INTEGER NOT NULL REFERENCES work_order(id) ON DELETE CASCADE,
      hours REAL NOT NULL DEFAULT 0,
      hourly_rate REAL NOT NULL DEFAULT 0,
      cost REAL NOT NULL DEFAULT 0,
      resource TEXT,
      notes TEXT
    );

    CREATE TABLE IF NOT EXISTS pricing_config (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      code TEXT UNIQUE NOT NULL,
      value REAL NOT NULL DEFAULT 0,
      last_update_date TEXT
    );

    CREATE TABLE IF NOT EXISTS sales_order (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      item_id INTEGER REFERENCES item(id),
      sku TEXT NOT NULL,
      item_name TEXT,
      qty REAL NOT NULL,
      unit_price REAL NOT NULL,
      total_price REAL NOT NULL,
      unit_margin REAL NOT NULL DEFAULT 0,
      unit_cost REAL NOT NULL DEFAULT 0,
      sale_date TEXT,
      created_at TEXT
    );

    CREATE TABLE IF NOT EXISTS erp_posting (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      job_id INTEGER UNIQUE,
      part_id INTEGER,
      printer_id INTEGER,
      erp_sku TEXT,
      qty REAL NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'pending',
      created_at INTEGER NOT NULL,
      posted_at INTEGER,
      stock_move_id INTEGER,
      note TEXT,
      shortage_json TEXT
    );
  `);

  // Seed baselines only when empty (never overwrite operator data)
  const uomCount = db.prepare('SELECT COUNT(*) AS n FROM uom').get().n;
  if (uomCount === 0) {
    const ins = db.prepare(
      'INSERT INTO uom (code, name, dimension, is_base, factor_to_base) VALUES (?, ?, ?, ?, ?)'
    );
    ins.run('EA', 'Each', 'COUNT', 1, 1);
    ins.run('KG', 'Kilogram', 'WEIGHT', 1, 1);
    ins.run('G', 'Gram', 'WEIGHT', 0, 0.001);
  }

  const whCount = db.prepare('SELECT COUNT(*) AS n FROM warehouse').get().n;
  if (whCount === 0) {
    const ins = db.prepare('INSERT INTO warehouse (code, name) VALUES (?, ?)');
    ins.run('comp', 'Components');
    ins.run('fin_good', 'Finished Goods');
  }

  const pcCount = db.prepare('SELECT COUNT(*) AS n FROM pricing_config').get().n;
  if (pcCount === 0) {
    const now = new Date().toISOString();
    const ins = db.prepare(
      'INSERT INTO pricing_config (name, code, value, last_update_date) VALUES (?, ?, ?, ?)'
    );
    ins.run('Margin Default %', 'MARGIN_DEF', 0, now);
    ins.run('Adds %', 'ADDS_PCT', 0, now);
    ins.run('Ebay %', 'EBAY_FEE', 0, now);
    ins.run('Electricity USD/kWh', 'ELEC_KWH', 0, now);
  } else {
    // Additive seed for installs that already have other pricing rows
    const elec = db.prepare("SELECT id FROM pricing_config WHERE code = 'ELEC_KWH'").get();
    if (!elec) {
      db.prepare(
        'INSERT INTO pricing_config (name, code, value, last_update_date) VALUES (?, ?, ?, ?)'
      ).run('Electricity USD/kWh', 'ELEC_KWH', 0, new Date().toISOString());
    }
  }

  const labor = db.prepare("SELECT id FROM machine WHERE machine = 'LABOR'").get();
  if (!labor) {
    db.prepare(
      'INSERT INTO machine (machine, hourly_rate, is_active, created_at) VALUES (?, ?, 1, ?)'
    ).run('LABOR', 20, new Date().toISOString());
  }

  // Ensure raw WH + shopfloor link columns, then soft-sync masters
  const { ensureErpLinkColumns, syncShopfloorToErp } = require('./sync');
  ensureErpLinkColumns(db);
  try {
    db.prepare('INSERT OR IGNORE INTO warehouse (code, name) VALUES (?, ?)').run('raw', 'Raw Materials');
  } catch (_) { /* ignore */ }
  try {
    syncShopfloorToErp(db);
  } catch (e) {
    console.log('[erp] shopfloor sync skipped:', e.message);
  }
}

module.exports = { ensureErpSchema };
