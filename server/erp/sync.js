/**
 * Keep ERP masters aligned with shopfloor rows (additive only).
 * Never overwrites operator rates or SKUs already present.
 *
 * Mapping:
 *   project  <-> ERP product  (item_role=product)
 *   part     <-> ERP component (item_role=component)
 *   printer  <-> ERP machine   (machine.printer_id)
 *   filament <-> ERP raw item  (item_role=raw)
 *
 * sourcing: manufactured | outsource (defaults; operator completes ERP-only fields)
 */

function tableExists(db, name) {
  return !!db.prepare(
    "SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = ?"
  ).get(name);
}

function ensureColumn(db, table, column, ddl) {
  try {
    const cols = db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name);
    if (!cols.includes(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
  } catch (_) { /* ignore */ }
}

function ensureErpLinkColumns(db) {
  ensureColumn(db, 'item', 'item_role', "item_role TEXT NOT NULL DEFAULT 'raw'");
  ensureColumn(db, 'item', 'sourcing', "sourcing TEXT NOT NULL DEFAULT 'manufactured'");
  ensureColumn(db, 'item', 'project_id', 'project_id INTEGER');
  ensureColumn(db, 'item', 'part_id', 'part_id INTEGER');
  ensureColumn(db, 'item', 'needs_erp_data', 'needs_erp_data INTEGER NOT NULL DEFAULT 0');
  ensureColumn(db, 'machine', 'printer_id', 'printer_id INTEGER');
  ensureColumn(db, 'machine', 'needs_erp_data', 'needs_erp_data INTEGER NOT NULL DEFAULT 0');
  ensureColumn(db, 'machine', 'rate_mode', "rate_mode TEXT NOT NULL DEFAULT 'manual'");
  ensureColumn(db, 'machine', 'maintenance_rate', 'maintenance_rate REAL NOT NULL DEFAULT 0');
  ensureColumn(db, 'machine', 'power_kw', 'power_kw REAL NOT NULL DEFAULT 0');
}

function ensureWarehouses(db) {
  const ins = db.prepare('INSERT OR IGNORE INTO warehouse (code, name) VALUES (?, ?)');
  ins.run('comp', 'Components');
  ins.run('fin_good', 'Finished Goods');
  ins.run('raw', 'Raw Materials');
}

function whId(db, code) {
  return db.prepare('SELECT id FROM warehouse WHERE lower(code) = lower(?)').get(code)?.id || null;
}

function skuSafe(prefix, id, name) {
  const base = String(name || '')
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 24) || 'X';
  return `${prefix}-${id}-${base}`.slice(0, 48);
}

/**
 * @returns {{ created: object, needs_attention: array }}
 */
function syncShopfloorToErp(db) {
  ensureErpLinkColumns(db);
  ensureWarehouses(db);

  const created = {
    machines: 0,
    products: 0,
    components: 0,
    raw_materials: 0,
  };
  const needs_attention = [];
  const now = new Date().toISOString();
  const finId = whId(db, 'fin_good');
  const compId = whId(db, 'comp');
  const rawId = whId(db, 'raw');

  // Printers -> machines
  if (tableExists(db, 'printers')) {
    const printers = db.prepare('SELECT id, name, model, is_active FROM printers').all();
    const findByPrinter = db.prepare('SELECT id, hourly_rate FROM machine WHERE printer_id = ?');
    const findByName = db.prepare('SELECT id FROM machine WHERE machine = ?');
    const insert = db.prepare(
      'INSERT INTO machine (machine, hourly_rate, is_active, created_at, printer_id, needs_erp_data) VALUES (?, 0, ?, ?, ?, 1)'
    );
    const link = db.prepare('UPDATE machine SET printer_id = COALESCE(printer_id, ?) WHERE id = ?');
    for (const p of printers) {
      let m = findByPrinter.get(p.id);
      if (!m) {
        const byName = findByName.get(p.name);
        if (byName) {
          link.run(p.id, byName.id);
          m = findByPrinter.get(p.id) || byName;
        } else {
          insert.run(p.name, p.is_active ? 1 : 0, now, p.id);
          created.machines += 1;
          m = findByPrinter.get(p.id);
        }
      }
      if (m && Number(m.hourly_rate || 0) === 0) {
        needs_attention.push({
          kind: 'machine',
          id: m.id,
          name: p.name,
          reason: 'Set hourly rate for shopfloor printer machine',
          fields: ['hourly_rate'],
        });
      }
    }
  }

  // Projects -> products (finished goods)
  if (tableExists(db, 'projects') && finId) {
    const projects = db.prepare('SELECT id, name, status FROM projects').all();
    const findByProject = db.prepare('SELECT id, sourcing FROM item WHERE project_id = ?');
    const insert = db.prepare(`
      INSERT INTO item
        (sku, name, warehouse_id, dimension, display_uom_code, purchase_uom_code,
         is_active, item_role, sourcing, project_id, needs_erp_data)
      VALUES (?, ?, ?, 'COUNT', 'EA', 'EA', 1, 'product', 'manufactured', ?, 1)
    `);
    for (const p of projects) {
      let it = findByProject.get(p.id);
      if (!it) {
        const sku = skuSafe('PRJ', p.id, p.name);
        if (!db.prepare('SELECT id FROM item WHERE sku = ?').get(sku)) {
          insert.run(sku, p.name, finId, p.id);
          created.products += 1;
          it = findByProject.get(p.id);
        }
      }
      if (it) {
        needs_attention.push({
          kind: 'product',
          id: it.id,
          name: p.name,
          project_id: p.id,
          reason: 'Confirm product sourcing (manufactured or outsource) and pricing defaults',
          fields: ['sourcing', 'custom_margin'],
        });
      }
    }
  }

  // Parts -> components
  if (tableExists(db, 'parts') && compId) {
    const parts = db.prepare('SELECT id, project_id, name, erp_sku FROM parts').all();
    const findByPart = db.prepare('SELECT id FROM item WHERE part_id = ?');
    const insert = db.prepare(`
      INSERT INTO item
        (sku, name, warehouse_id, dimension, display_uom_code, purchase_uom_code,
         is_active, item_role, sourcing, part_id, project_id, needs_erp_data)
      VALUES (?, ?, ?, 'COUNT', 'EA', 'EA', 1, 'component', 'manufactured', ?, ?, 1)
    `);
    const setErpSku = db.prepare("UPDATE parts SET erp_sku = ? WHERE id = ? AND (erp_sku IS NULL OR erp_sku = '')");
    for (const part of parts) {
      let it = findByPart.get(part.id);
      if (!it) {
        const sku = part.erp_sku || skuSafe('PRT', part.id, part.name);
        if (!db.prepare('SELECT id FROM item WHERE sku = ?').get(sku)) {
          insert.run(sku, part.name, compId, part.id, part.project_id);
          created.components += 1;
          setErpSku.run(sku, part.id);
          it = findByPart.get(part.id);
        }
      } else if (!part.erp_sku) {
        const row = db.prepare('SELECT sku FROM item WHERE part_id = ?').get(part.id);
        if (row) setErpSku.run(row.sku, part.id);
      }
      if (it) {
        needs_attention.push({
          kind: 'component',
          id: it.id,
          name: part.name,
          part_id: part.id,
          project_id: part.project_id,
          reason: 'Confirm component sourcing (manufactured or outsource)',
          fields: ['sourcing'],
        });
      }
    }
  }

  // Filament library -> raw materials
  if (tableExists(db, 'filament_types') && tableExists(db, 'filament_colors') && rawId) {
    const colors = db.prepare(`
      SELECT c.id, c.name AS color, t.name AS type_name
      FROM filament_colors c
      JOIN filament_types t ON t.id = c.type_id
    `).all();
    const findSku = db.prepare('SELECT id FROM item WHERE sku = ?');
    const insert = db.prepare(`
      INSERT INTO item
        (sku, name, warehouse_id, dimension, display_uom_code, purchase_uom_code,
         is_active, item_role, sourcing, needs_erp_data)
      VALUES (?, ?, ?, 'WEIGHT', 'G', 'KG', 1, 'raw', 'outsource', 1)
    `);
    for (const c of colors) {
      const sku = skuSafe('FIL', c.id, `${c.type_name}-${c.color}`);
      let item = findSku.get(sku);
      if (!item) {
        insert.run(sku, `${c.type_name} ${c.color}`, rawId);
        created.raw_materials += 1;
        item = findSku.get(sku);
      }
      if (item) {
        const onHand = db.prepare(
          'SELECT COALESCE(SUM(qty), 0) AS qty FROM stock_move WHERE item_id = ?'
        ).get(item.id)?.qty || 0;
        if (Number(onHand) > 0) {
          db.prepare('UPDATE item SET needs_erp_data = 0 WHERE id = ?').run(item.id);
        }
        needs_attention.push({
          kind: 'raw',
          id: item.id,
          sku,
          name: `${c.type_name} ${c.color}`,
          reason: 'Set purchase cost / receive stock for filament raw material',
          fields: ['unit_cost', 'receive'],
        });
      }
    }
  }

  // Deduplicate attention: only items still flagged needs_erp_data
  const flaggedItems = new Set(
    db.prepare('SELECT id FROM item WHERE needs_erp_data = 1').all().map(r => r.id)
  );
  const flaggedMachines = new Set(
    db.prepare('SELECT id FROM machine WHERE needs_erp_data = 1').all().map(r => r.id)
  );
  const filtered = needs_attention.filter(n => {
    if (n.kind === 'machine') return flaggedMachines.has(n.id);
    if (n.id != null) return flaggedItems.has(n.id);
    return true;
  });

  return { created, needs_attention: filtered.slice(0, 100) };
}

function buildErpDashboard(db) {
  const sync = syncShopfloorToErp(db);

  const inv = (() => {
    const stock = db.prepare(`
      SELECT item_id, warehouse_id, SUM(qty) AS qty, SUM(qty * unit_cost) AS tcost
      FROM stock_move GROUP BY item_id, warehouse_id
    `).all();
    let sku_lines = 0;
    let total_qty = 0;
    let total_value = 0;
    for (const r of stock) {
      const qty = Number(r.qty) || 0;
      if (Math.abs(qty) < 1e-12) continue;
      sku_lines += 1;
      total_qty += qty;
      total_value += qty ? (Number(r.tcost) || 0) : 0;
    }
    return {
      sku_lines,
      total_qty: Math.round(total_qty * 10000) / 10000,
      total_value: Math.round(total_value * 10000) / 10000,
    };
  })();

  const counts = {
    products: db.prepare("SELECT COUNT(*) AS n FROM item WHERE item_role = 'product'").get().n,
    components: db.prepare("SELECT COUNT(*) AS n FROM item WHERE item_role = 'component'").get().n,
    raw: db.prepare("SELECT COUNT(*) AS n FROM item WHERE item_role = 'raw'").get().n,
    manufactured: db.prepare("SELECT COUNT(*) AS n FROM item WHERE sourcing = 'manufactured'").get().n,
    outsource: db.prepare("SELECT COUNT(*) AS n FROM item WHERE sourcing = 'outsource'").get().n,
    machines: db.prepare('SELECT COUNT(*) AS n FROM machine').get().n,
    printers_linked: db.prepare('SELECT COUNT(*) AS n FROM machine WHERE printer_id IS NOT NULL').get().n,
    open_wo: db.prepare("SELECT COUNT(*) AS n FROM work_order WHERE status = 'open'").get().n,
    boms: db.prepare('SELECT COUNT(*) AS n FROM bom').get().n,
    sales_today: (() => {
      const day = new Date().toISOString().slice(0, 10);
      return db.prepare(
        "SELECT COUNT(*) AS n FROM sales_order WHERE sale_date LIKE ?"
      ).get(`${day}%`).n;
    })(),
  };

  let shopfloor = { projects: 0, parts: 0, printers: 0, active_printers: 0 };
  if (tableExists(db, 'projects')) {
    shopfloor.projects = db.prepare('SELECT COUNT(*) AS n FROM projects').get().n;
  }
  if (tableExists(db, 'parts')) {
    shopfloor.parts = db.prepare('SELECT COUNT(*) AS n FROM parts').get().n;
  }
  if (tableExists(db, 'printers')) {
    shopfloor.printers = db.prepare('SELECT COUNT(*) AS n FROM printers').get().n;
    shopfloor.active_printers = db.prepare(
      "SELECT COUNT(*) AS n FROM printers WHERE is_active = 1"
    ).get().n;
  }

  return {
    status: 'ok',
    inventory: inv,
    counts,
    shopfloor,
    sync,
    links: {
      product_is: 'project',
      component_is: 'part',
      sourcing: ['manufactured', 'outsource'],
    },
  };
}

module.exports = {
  ensureErpLinkColumns,
  syncShopfloorToErp,
  buildErpDashboard,
};
