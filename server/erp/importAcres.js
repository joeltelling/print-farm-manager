/**
 * Import an original Acres SQLite database into the current CoMa database.
 *
 * Acres was the standalone ERP that predated CoMa's embedded ERP (removed from this
 * repo in "Remove standalone Acres Python trees", 2026-09-17). It shared the exact same
 * table and column names CoMa now creates in server/erp/schema.js (see the removed
 * erp/backend/app/models/*.py for the SQLAlchemy source of truth). This module merges
 * an exported/copied Acres .db file into the live CoMa database so an operator who ran
 * Acres standalone before adopting CoMa can bring their real masters, BOMs, work orders,
 * stock, pricing, and sales history across.
 *
 * Merge, not replace:
 *  - Matches rows by natural key (uom.code, warehouse.code, item.sku, machine.machine,
 *    mfg_component.sku, pricing_config.code, work_order.code) so importing into a
 *    database that already has seeded defaults (server/erp/schema.js) or shopfloor-synced
 *    stubs (server/erp/sync.js) never duplicates them.
 *  - Never overwrites pricing_config or item_cost rows that already exist unless the
 *    caller explicitly opts in (overwritePricingConfig / overwriteItemCost), matching the
 *    "never clobber operator data silently" rule used across CoMa's sync helpers.
 *  - Rewrites every foreign key (warehouse_id, item_id, machine references, bom_id,
 *    location_id, wo_id, raw_item_id, component_item_id, parent_wo_id) through an
 *    old-id -> new-id map built while walking tables in dependency order, because a
 *    fresh CoMa install's autoincrement ids will not line up with the Acres file's ids.
 *  - Runs inside one db.transaction: any failure rolls back the entire import, so a
 *    partially-merged database is never left behind.
 *
 * Never touches shopfloor tables (printers, projects, parts, jobs) or parts.completed_qty,
 * and never touches CoMa-only additions Acres never had (customer, sales_doc,
 * sales_doc_line, doc_counter, erp_posting, ebay_*) - those simply are not present in an
 * Acres source file and are left alone.
 */

const Database = require('better-sqlite3');

// Dependency order: a table only appears after every table it references by id.
const TABLE_ORDER = [
  'uom',
  'warehouse',
  'location',
  'item',
  'machine',
  'bom',
  'bom_line',
  'mfg_component',
  'work_order',
  'wo_issue',
  'wo_labor',
  'stock_move',
  'item_cost',
  'pricing_config',
  'sales_order',
];

function tableExists(conn, name) {
  return !!conn.prepare("SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = ?").get(name);
}

function sourceColumns(conn, table) {
  return new Set(conn.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name));
}

function openSource(sourceDbPath) {
  try {
    return new Database(sourceDbPath, { readonly: true, fileMustExist: true });
  } catch (_) {
    // Some exported files are not writable or carry a stale WAL; a plain connection
    // still only ever gets SELECT statements from this module.
    return new Database(sourceDbPath, { fileMustExist: true });
  }
}

function emptyStat() {
  return { matched: 0, inserted: 0, updated: 0, skipped: 0 };
}

/**
 * @param {import('better-sqlite3').Database} db  Live CoMa database (target)
 * @param {string} sourceDbPath                   Path to the original Acres .db file
 * @param {{ overwritePricingConfig?: boolean, overwriteItemCost?: boolean }} [options]
 * @returns {{ tables: object, warnings: string[] }}
 */
function importAcresDatabase(db, sourceDbPath, options = {}) {
  const overwritePricingConfig = !!options.overwritePricingConfig;
  const overwriteItemCost = !!options.overwriteItemCost;

  const source = openSource(sourceDbPath);
  const warnings = [];
  const stats = {};
  for (const t of TABLE_ORDER) stats[t] = emptyStat();

  // old id -> new id, per table that has a surrogate autoincrement PK
  const idMap = {
    warehouse: new Map(),
    location: new Map(),
    item: new Map(),
    machine: new Map(),
    bom: new Map(),
    mfg_component: new Map(),
    work_order: new Map(),
  };
  // work_order ids that were freshly inserted (vs matched to a pre-existing code) in
  // this run - wo_issue/wo_labor only import for these, so re-running the same source
  // file never duplicates a work order's children.
  const freshWorkOrders = new Set();
  // bom ids freshly inserted in this run (see bom_line note below).
  const freshBoms = new Set();

  const run = () => {
    try {
      importUom();
      importWarehouse();
      importLocation();
      importItem();
      importMachine();
      importBom();
      importBomLine();
      importMfgComponent();
      importWorkOrder();
      importWoIssue();
      importWoLabor();
      importStockMove();
      importItemCost();
      importPricingConfig();
      importSalesOrder();
    } finally {
      source.close();
    }
  };

  function importUom() {
    if (!tableExists(source, 'uom')) return;
    const cols = sourceColumns(source, 'uom');
    const rows = source.prepare('SELECT * FROM uom').all();
    const findExisting = db.prepare('SELECT code FROM uom WHERE code = ?');
    const insert = db.prepare(`
      INSERT INTO uom (code, name, dimension, is_base, factor_to_base)
      VALUES (@code, @name, @dimension, @is_base, @factor_to_base)
    `);
    for (const row of rows) {
      if (!row.code) { warnings.push('uom row without code skipped'); continue; }
      if (findExisting.get(row.code)) { stats.uom.matched += 1; continue; }
      insert.run({
        code: row.code,
        name: row.name || row.code,
        dimension: row.dimension || 'COUNT',
        is_base: row.is_base ? 1 : 0,
        factor_to_base: cols.has('factor_to_base') ? Number(row.factor_to_base) || 1 : 1,
      });
      stats.uom.inserted += 1;
    }
  }

  function importWarehouse() {
    if (!tableExists(source, 'warehouse')) return;
    const rows = source.prepare('SELECT * FROM warehouse').all();
    const findExisting = db.prepare('SELECT id FROM warehouse WHERE lower(code) = lower(?)');
    const insert = db.prepare('INSERT INTO warehouse (code, name) VALUES (?, ?)');
    for (const row of rows) {
      if (!row.code) { warnings.push(`warehouse id=${row.id} without code skipped`); continue; }
      const existing = findExisting.get(row.code);
      if (existing) {
        idMap.warehouse.set(row.id, existing.id);
        stats.warehouse.matched += 1;
        continue;
      }
      const info = insert.run(row.code, row.name || row.code);
      idMap.warehouse.set(row.id, Number(info.lastInsertRowid));
      stats.warehouse.inserted += 1;
    }
  }

  function importLocation() {
    if (!tableExists(source, 'location')) return;
    const rows = source.prepare('SELECT * FROM location').all();
    const findExisting = db.prepare('SELECT id FROM location WHERE warehouse_id = ? AND code = ?');
    const insert = db.prepare('INSERT INTO location (warehouse_id, code) VALUES (?, ?)');
    for (const row of rows) {
      const whId = idMap.warehouse.get(row.warehouse_id);
      if (!whId) { warnings.push(`location id=${row.id} references unknown warehouse ${row.warehouse_id}, skipped`); stats.location.skipped += 1; continue; }
      const existing = findExisting.get(whId, row.code);
      if (existing) {
        idMap.location.set(row.id, existing.id);
        stats.location.matched += 1;
        continue;
      }
      const info = insert.run(whId, row.code);
      idMap.location.set(row.id, Number(info.lastInsertRowid));
      stats.location.inserted += 1;
    }
  }

  function importItem() {
    if (!tableExists(source, 'item')) return;
    const rows = source.prepare('SELECT * FROM item').all();
    const findExisting = db.prepare('SELECT id FROM item WHERE sku = ?');
    const insert = db.prepare(`
      INSERT INTO item
        (sku, name, warehouse_id, dimension, display_uom_code, purchase_uom_code,
         custom_margin, custom_ads, custom_fee, is_active)
      VALUES (@sku, @name, @warehouse_id, @dimension, @display_uom_code, @purchase_uom_code,
              @custom_margin, @custom_ads, @custom_fee, @is_active)
    `);
    for (const row of rows) {
      if (!row.sku) { warnings.push(`item id=${row.id} without sku skipped`); stats.item.skipped += 1; continue; }
      const existing = findExisting.get(row.sku);
      if (existing) {
        idMap.item.set(row.id, existing.id);
        stats.item.matched += 1;
        continue;
      }
      const info = insert.run({
        sku: row.sku,
        name: row.name || row.sku,
        warehouse_id: row.warehouse_id != null ? (idMap.warehouse.get(row.warehouse_id) || null) : null,
        dimension: row.dimension || 'COUNT',
        display_uom_code: row.display_uom_code || 'EA',
        purchase_uom_code: row.purchase_uom_code || row.display_uom_code || 'EA',
        custom_margin: row.custom_margin ?? null,
        custom_ads: row.custom_ads ?? null,
        custom_fee: row.custom_fee ?? null,
        is_active: row.is_active === false || row.is_active === 0 ? 0 : 1,
      });
      idMap.item.set(row.id, Number(info.lastInsertRowid));
      stats.item.inserted += 1;
    }
  }

  function importMachine() {
    if (!tableExists(source, 'machine')) return;
    const rows = source.prepare('SELECT * FROM machine').all();
    const findExisting = db.prepare('SELECT id FROM machine WHERE machine = ?');
    const insert = db.prepare(`
      INSERT INTO machine (machine, hourly_rate, is_active, created_at, updated_at)
      VALUES (@machine, @hourly_rate, @is_active, @created_at, @updated_at)
    `);
    for (const row of rows) {
      if (!row.machine) { warnings.push(`machine id=${row.id} without name skipped`); stats.machine.skipped += 1; continue; }
      const existing = findExisting.get(row.machine);
      if (existing) {
        // Never overwrite a rate the operator may already have configured in CoMa.
        idMap.machine.set(row.id, existing.id);
        stats.machine.matched += 1;
        continue;
      }
      const info = insert.run({
        machine: row.machine,
        hourly_rate: Number(row.hourly_rate) || 0,
        is_active: row.is_active === false || row.is_active === 0 ? 0 : 1,
        created_at: row.created_at || null,
        updated_at: row.updated_at || null,
      });
      idMap.machine.set(row.id, Number(info.lastInsertRowid));
      stats.machine.inserted += 1;
    }
  }

  function importBom() {
    if (!tableExists(source, 'bom')) return;
    const rows = source.prepare('SELECT * FROM bom').all();
    const findExistingForItem = db.prepare('SELECT id FROM bom WHERE item_id = ? LIMIT 1');
    const insert = db.prepare('INSERT INTO bom (item_id, name, labor_hours_per_unit) VALUES (?, ?, ?)');
    for (const row of rows) {
      const itemId = idMap.item.get(row.item_id);
      if (!itemId) { warnings.push(`bom id=${row.id} references unknown item ${row.item_id}, skipped`); stats.bom.skipped += 1; continue; }
      const existing = findExistingForItem.get(itemId);
      if (existing) {
        idMap.bom.set(row.id, existing.id);
        stats.bom.matched += 1;
        continue;
      }
      const info = insert.run(itemId, row.name || null, Number(row.labor_hours_per_unit) || 0);
      const newId = Number(info.lastInsertRowid);
      idMap.bom.set(row.id, newId);
      freshBoms.add(newId);
      stats.bom.inserted += 1;
    }
  }

  function importBomLine() {
    if (!tableExists(source, 'bom_line')) return;
    const rows = source.prepare('SELECT * FROM bom_line').all();
    const findExisting = db.prepare(
      'SELECT id FROM bom_line WHERE bom_id = ? AND component_item_id = ?'
    );
    const insert = db.prepare(
      'INSERT INTO bom_line (bom_id, component_item_id, qty, scrap_pct) VALUES (?, ?, ?, ?)'
    );
    for (const row of rows) {
      const bomId = idMap.bom.get(row.bom_id);
      const componentId = idMap.item.get(row.component_item_id);
      if (!bomId || !componentId) {
        warnings.push(`bom_line id=${row.id} references unknown bom/item, skipped`);
        stats.bom_line.skipped += 1;
        continue;
      }
      if (!freshBoms.has(bomId) && findExisting.get(bomId, componentId)) {
        stats.bom_line.matched += 1;
        continue;
      }
      insert.run(bomId, componentId, Number(row.qty) || 0, Number(row.scrap_pct) || 0);
      stats.bom_line.inserted += 1;
    }
  }

  function importMfgComponent() {
    if (!tableExists(source, 'mfg_component')) return;
    const rows = source.prepare('SELECT * FROM mfg_component').all();
    const findExisting = db.prepare('SELECT id FROM mfg_component WHERE sku = ?');
    const insert = db.prepare(`
      INSERT INTO mfg_component
        (sku, name, machine, std_minutes, raw_item_id, raw_qty_per_unit, scrap_pct,
         is_active, created_at, updated_at)
      VALUES (@sku, @name, @machine, @std_minutes, @raw_item_id, @raw_qty_per_unit, @scrap_pct,
              @is_active, @created_at, @updated_at)
    `);
    for (const row of rows) {
      if (!row.sku) { warnings.push(`mfg_component id=${row.id} without sku skipped`); stats.mfg_component.skipped += 1; continue; }
      const existing = findExisting.get(row.sku);
      if (existing) {
        idMap.mfg_component.set(row.id, existing.id);
        stats.mfg_component.matched += 1;
        continue;
      }
      const rawItemId = idMap.item.get(row.raw_item_id);
      if (!rawItemId) {
        warnings.push(`mfg_component sku=${row.sku} references unknown raw item ${row.raw_item_id}, skipped`);
        stats.mfg_component.skipped += 1;
        continue;
      }
      const info = insert.run({
        sku: row.sku,
        name: row.name || row.sku,
        machine: row.machine || null,
        std_minutes: Number(row.std_minutes) || 0,
        raw_item_id: rawItemId,
        raw_qty_per_unit: Number(row.raw_qty_per_unit) || 0,
        scrap_pct: Number(row.scrap_pct) || 0,
        is_active: row.is_active === false || row.is_active === 0 ? 0 : 1,
        created_at: row.created_at || null,
        updated_at: row.updated_at || null,
      });
      idMap.mfg_component.set(row.id, Number(info.lastInsertRowid));
      stats.mfg_component.inserted += 1;
    }
  }

  function importWorkOrder() {
    if (!tableExists(source, 'work_order')) return;
    const rows = source.prepare('SELECT * FROM work_order').all();
    const findByCode = db.prepare('SELECT id FROM work_order WHERE code = ? AND code IS NOT NULL');
    const insert = db.prepare(`
      INSERT INTO work_order
        (code, kind, status, qty, qty_planned, qty_completed, item_id, target_item_id,
         warehouse_to, location_to, bom_id, parent_wo_id, created_at, started_at,
         due_date, completed_at, notes)
      VALUES (@code, @kind, @status, @qty, @qty_planned, @qty_completed, @item_id, @target_item_id,
              @warehouse_to, @location_to, @bom_id, NULL, @created_at, @started_at,
              @due_date, @completed_at, @notes)
    `);
    // parent_wo_id needs every work_order row's id already remapped, so it is filled in
    // a second pass below rather than during this INSERT.
    const pendingParents = [];
    for (const row of rows) {
      const itemId = idMap.item.get(row.item_id);
      if (!itemId) {
        warnings.push(`work_order id=${row.id} references unknown item ${row.item_id}, skipped`);
        stats.work_order.skipped += 1;
        continue;
      }
      if (row.code) {
        const existing = findByCode.get(row.code);
        if (existing) {
          idMap.work_order.set(row.id, existing.id);
          stats.work_order.matched += 1;
          continue;
        }
      }
      const info = insert.run({
        code: row.code || null,
        kind: row.kind || 'FG',
        status: row.status || 'draft',
        qty: Number(row.qty) || 0,
        qty_planned: Number(row.qty_planned) || 0,
        qty_completed: Number(row.qty_completed) || 0,
        item_id: itemId,
        target_item_id: row.target_item_id != null ? (idMap.item.get(row.target_item_id) || null) : null,
        warehouse_to: row.warehouse_to != null ? (idMap.warehouse.get(row.warehouse_to) || null) : null,
        location_to: row.location_to != null ? (idMap.location.get(row.location_to) || null) : null,
        bom_id: row.bom_id != null ? (idMap.bom.get(row.bom_id) || null) : null,
        created_at: row.created_at || null,
        started_at: row.started_at || null,
        due_date: row.due_date || null,
        completed_at: row.completed_at || null,
        notes: row.notes || null,
      });
      const newId = Number(info.lastInsertRowid);
      idMap.work_order.set(row.id, newId);
      freshWorkOrders.add(newId);
      stats.work_order.inserted += 1;
      if (row.parent_wo_id != null) pendingParents.push({ oldParent: row.parent_wo_id, newId });
    }
    if (pendingParents.length) {
      const updateParent = db.prepare('UPDATE work_order SET parent_wo_id = ? WHERE id = ?');
      for (const { oldParent, newId } of pendingParents) {
        const newParent = idMap.work_order.get(oldParent);
        if (newParent) updateParent.run(newParent, newId);
      }
    }
  }

  function importWoIssue() {
    if (!tableExists(source, 'wo_issue')) return;
    const rows = source.prepare('SELECT * FROM wo_issue').all();
    const insert = db.prepare(
      'INSERT INTO wo_issue (wo_id, item_id, qty, unit_cost, trans_date) VALUES (?, ?, ?, ?, ?)'
    );
    for (const row of rows) {
      const woId = idMap.work_order.get(row.wo_id);
      const itemId = idMap.item.get(row.item_id);
      if (!woId || !itemId) { stats.wo_issue.skipped += 1; continue; }
      // Only import children of a work order this run actually created - a work order
      // matched to a pre-existing code already has its issues/labor from a prior import.
      if (!freshWorkOrders.has(woId)) { stats.wo_issue.matched += 1; continue; }
      insert.run(woId, itemId, Number(row.qty) || 0, Number(row.unit_cost) || 0, row.trans_date || null);
      stats.wo_issue.inserted += 1;
    }
  }

  function importWoLabor() {
    if (!tableExists(source, 'wo_labor')) return;
    const rows = source.prepare('SELECT * FROM wo_labor').all();
    const insert = db.prepare(
      'INSERT INTO wo_labor (wo_id, hours, hourly_rate, cost, resource, notes) VALUES (?, ?, ?, ?, ?, ?)'
    );
    for (const row of rows) {
      const woId = idMap.work_order.get(row.wo_id);
      if (!woId) { stats.wo_labor.skipped += 1; continue; }
      if (!freshWorkOrders.has(woId)) { stats.wo_labor.matched += 1; continue; }
      insert.run(
        woId, Number(row.hours) || 0, Number(row.hourly_rate) || 0, Number(row.cost) || 0,
        row.resource || null, row.notes || null
      );
      stats.wo_labor.inserted += 1;
    }
  }

  function importStockMove() {
    if (!tableExists(source, 'stock_move')) return;
    const rows = source.prepare('SELECT * FROM stock_move').all();
    const findByIdemKey = db.prepare('SELECT id FROM stock_move WHERE idem_key = ?');
    const findByFingerprint = db.prepare(`
      SELECT id FROM stock_move
      WHERE item_id = ? AND warehouse_id = ? AND IFNULL(location_id, -1) = IFNULL(?, -1)
        AND qty = ? AND unit_cost = ? AND IFNULL(created_at, '') = IFNULL(?, '')
    `);
    const insert = db.prepare(`
      INSERT INTO stock_move (item_id, warehouse_id, location_id, wo_id, qty, unit_cost, note, created_at, trans_date, idem_key)
      VALUES (@item_id, @warehouse_id, @location_id, @wo_id, @qty, @unit_cost, @note, @created_at, @trans_date, @idem_key)
    `);
    for (const row of rows) {
      const itemId = idMap.item.get(row.item_id);
      const warehouseId = idMap.warehouse.get(row.warehouse_id);
      if (!itemId || !warehouseId) {
        warnings.push(`stock_move id=${row.id} references unknown item/warehouse, skipped`);
        stats.stock_move.skipped += 1;
        continue;
      }
      const locationId = row.location_id != null ? (idMap.location.get(row.location_id) || null) : null;
      const woId = row.wo_id != null ? (idMap.work_order.get(row.wo_id) || null) : null;

      if (row.idem_key && findByIdemKey.get(row.idem_key)) { stats.stock_move.matched += 1; continue; }
      if (!row.idem_key && findByFingerprint.get(itemId, warehouseId, locationId, Number(row.qty) || 0, Number(row.unit_cost) || 0, row.created_at || null)) {
        stats.stock_move.matched += 1;
        continue;
      }
      insert.run({
        item_id: itemId,
        warehouse_id: warehouseId,
        location_id: locationId,
        wo_id: woId,
        qty: Number(row.qty) || 0,
        unit_cost: Number(row.unit_cost) || 0,
        note: row.note || null,
        created_at: row.created_at || null,
        trans_date: row.trans_date || row.created_at || null,
        idem_key: row.idem_key || null,
      });
      stats.stock_move.inserted += 1;
    }
  }

  function importItemCost() {
    if (!tableExists(source, 'item_cost')) return;
    const rows = source.prepare('SELECT * FROM item_cost').all();
    const findExisting = db.prepare('SELECT * FROM item_cost WHERE item_id = ? AND warehouse_id = ?');
    const insert = db.prepare(`
      INSERT INTO item_cost (item_id, warehouse_id, wac, qty_on_hand, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    const update = db.prepare(
      'UPDATE item_cost SET wac = ?, qty_on_hand = ?, updated_at = ? WHERE item_id = ? AND warehouse_id = ?'
    );
    for (const row of rows) {
      const itemId = idMap.item.get(row.item_id);
      const warehouseId = idMap.warehouse.get(row.warehouse_id);
      if (!itemId || !warehouseId) { stats.item_cost.skipped += 1; continue; }
      const existing = findExisting.get(itemId, warehouseId);
      if (existing) {
        if (overwriteItemCost) {
          update.run(Number(row.wac) || 0, Number(row.qty_on_hand) || 0, row.updated_at || null, itemId, warehouseId);
          stats.item_cost.updated += 1;
        } else {
          stats.item_cost.matched += 1;
        }
        continue;
      }
      insert.run(itemId, warehouseId, Number(row.wac) || 0, Number(row.qty_on_hand) || 0, row.created_at || null, row.updated_at || null);
      stats.item_cost.inserted += 1;
    }
  }

  function importPricingConfig() {
    if (!tableExists(source, 'pricing_config')) return;
    const rows = source.prepare('SELECT * FROM pricing_config').all();
    const findExisting = db.prepare('SELECT id FROM pricing_config WHERE code = ?');
    const insert = db.prepare(
      'INSERT INTO pricing_config (name, code, value, last_update_date) VALUES (?, ?, ?, ?)'
    );
    const update = db.prepare(
      'UPDATE pricing_config SET name = ?, value = ?, last_update_date = ? WHERE code = ?'
    );
    for (const row of rows) {
      if (!row.code) { stats.pricing_config.skipped += 1; continue; }
      const existing = findExisting.get(row.code);
      if (existing) {
        if (overwritePricingConfig) {
          update.run(row.name || row.code, Number(row.value) || 0, row.last_update_date || null, row.code);
          stats.pricing_config.updated += 1;
        } else {
          stats.pricing_config.matched += 1;
        }
        continue;
      }
      insert.run(row.name || row.code, row.code, Number(row.value) || 0, row.last_update_date || null);
      stats.pricing_config.inserted += 1;
    }
  }

  function importSalesOrder() {
    if (!tableExists(source, 'sales_order')) return;
    const rows = source.prepare('SELECT * FROM sales_order').all();
    const findFingerprint = db.prepare(`
      SELECT id FROM sales_order
      WHERE sku = ? AND qty = ? AND unit_price = ? AND total_price = ? AND IFNULL(sale_date, '') = IFNULL(?, '')
    `);
    const insert = db.prepare(`
      INSERT INTO sales_order
        (item_id, sku, item_name, qty, unit_price, total_price, unit_margin, unit_cost, sale_date, created_at)
      VALUES (@item_id, @sku, @item_name, @qty, @unit_price, @total_price, @unit_margin, @unit_cost, @sale_date, @created_at)
    `);
    for (const row of rows) {
      if (!row.sku) { stats.sales_order.skipped += 1; continue; }
      if (findFingerprint.get(row.sku, Number(row.qty) || 0, Number(row.unit_price) || 0, Number(row.total_price) || 0, row.sale_date || null)) {
        stats.sales_order.matched += 1;
        continue;
      }
      insert.run({
        item_id: row.item_id != null ? (idMap.item.get(row.item_id) || null) : null,
        sku: row.sku,
        item_name: row.item_name || null,
        qty: Number(row.qty) || 0,
        unit_price: Number(row.unit_price) || 0,
        total_price: Number(row.total_price) || 0,
        unit_margin: Number(row.unit_margin) || 0,
        unit_cost: Number(row.unit_cost) || 0,
        sale_date: row.sale_date || null,
        created_at: row.created_at || null,
      });
      stats.sales_order.inserted += 1;
    }
  }

  db.transaction(run)();

  return { tables: stats, warnings };
}

module.exports = { importAcresDatabase, TABLE_ORDER };
