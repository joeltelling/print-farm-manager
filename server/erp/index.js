const express = require('express');
const {
  num,
  round4,
  uomFactors,
  convertQty,
  laborRate,
  machineRate,
  bomCostForItem,
  calculateBomCostDetail,
  calculateComponentCost,
  pricingNumbers,
  configMap,
  finWarehouseId,
  whIdByCode,
} = require('./costing');
const { buildSalesReportPdf } = require('./pdf');
const { syncShopfloorToErp, buildErpDashboard } = require('./sync');
const {
  ensurePostingTable,
  listPostings,
  previewPosting,
  confirmPosting,
  dismissPosting,
  pendingCount,
  recordShopfloorPosting,
} = require('./postings');

const PIECE_UOM_CANDIDATES = ['EA', 'EACH', 'UN', 'UNIT', 'PCS', 'PC', 'PZA'];
const ITEM_ROLES = new Set(['product', 'component', 'raw']);
const SOURCING = new Set(['manufactured', 'outsource']);

function mountErp(db) {
  const router = express.Router();
  ensurePostingTable(db);

  function stockAvailable(item_id, warehouse_id) {
    const r = db.prepare(
      'SELECT COALESCE(SUM(qty), 0) AS qty FROM stock_move WHERE item_id = ? AND warehouse_id = ?'
    ).get(item_id, warehouse_id);
    return num(r?.qty);
  }

  function wacFor(item_id, warehouse_id = null) {
    if (warehouse_id) {
      const r = db.prepare(
        'SELECT wac FROM item_cost WHERE item_id = ? AND warehouse_id = ?'
      ).get(item_id, warehouse_id);
      if (r) return num(r.wac);
    }
    const r = db.prepare('SELECT wac FROM item_cost WHERE item_id = ? LIMIT 1').get(item_id);
    return num(r?.wac);
  }

  function pickPieceUom() {
    for (const code of PIECE_UOM_CANDIDATES) {
      if (db.prepare('SELECT code FROM uom WHERE code = ?').get(code)) return code;
    }
    const base = db.prepare('SELECT code FROM uom WHERE is_base = 1 LIMIT 1').get();
    if (base) return base.code;
    const any = db.prepare('SELECT code FROM uom LIMIT 1').get();
    if (!any) {
      const err = new Error('No UOM defined; create at least one (e.g. EA).');
      err.status = 400;
      throw err;
    }
    return any.code;
  }

  function ensureCompItem(sku, nameHint) {
    const compWh = db.prepare("SELECT * FROM warehouse WHERE lower(code) = 'comp'").get();
    if (!compWh) {
      const err = new Error("Warehouse 'comp' does not exist. Create it first.");
      err.status = 400;
      throw err;
    }
    let it = db.prepare('SELECT * FROM item WHERE sku = ?').get(sku);
    if (it) {
      if (Number(it.warehouse_id || 0) !== Number(compWh.id)) {
        db.prepare('UPDATE item SET warehouse_id = ? WHERE id = ?').run(compWh.id, it.id);
        it = db.prepare('SELECT * FROM item WHERE id = ?').get(it.id);
      }
      return it;
    }
    const piece = pickPieceUom();
    const uom = db.prepare('SELECT * FROM uom WHERE code = ?').get(piece);
    const dim = (uom?.dimension || 'COUNT').toUpperCase();
    const r = db.prepare(`
      INSERT INTO item (sku, name, warehouse_id, dimension, display_uom_code, purchase_uom_code, is_active)
      VALUES (?, ?, ?, ?, ?, ?, 1)
    `).run(sku.trim(), (nameHint || sku).trim(), compWh.id, dim, piece, piece);
    return db.prepare('SELECT * FROM item WHERE id = ?').get(r.lastInsertRowid);
  }

  function mfgOut(r, rawSku) {
    return {
      id: r.id,
      sku: r.sku,
      name: r.name,
      machine: r.machine,
      std_minutes: num(r.std_minutes),
      raw_item_id: r.raw_item_id,
      raw_qty_per_unit: String(r.raw_qty_per_unit ?? '0'),
      scrap_pct: String(r.scrap_pct ?? '0'),
      is_active: !!r.is_active,
      raw_sku: rawSku || null,
    };
  }

  function pricingRow(it, cfg) {
    const cost = bomCostForItem(db, it.id);
    const p = pricingNumbers(it, cfg, cost);
    return {
      item_id: it.id,
      name: it.name,
      sku: it.sku,
      cost: round4(cost),
      margin_pct: p.margin_pct,
      margin_value: p.margin_value,
      ads_pct: p.ads_pct,
      fee_pct: p.fee_pct,
      selling_price: Math.round(p.selling_price * 100) / 100,
    };
  }

  function unitPrice(it, cfg) {
    return pricingNumbers(it, cfg, bomCostForItem(db, it.id)).selling_price;
  }

  function parseDate(val, end = false) {
    if (!val) return null;
    let dt = null;
    if (/^\d{4}-\d{2}-\d{2}$/.test(val)) {
      dt = new Date(val + (end ? 'T23:59:59.999Z' : 'T00:00:00.000Z'));
    } else {
      dt = new Date(val);
    }
    if (Number.isNaN(dt.getTime())) {
      const err = new Error('Invalid date format, use YYYY-MM-DD');
      err.status = 400;
      throw err;
    }
    return dt;
  }

  function buildHistory(startDt, endDt, page, limit) {
    let rows = db.prepare('SELECT * FROM sales_order ORDER BY sale_date DESC, id DESC').all();
    if (startDt) {
      const t = startDt.getTime();
      rows = rows.filter(r => r.sale_date && new Date(r.sale_date).getTime() >= t);
    }
    if (endDt) {
      const t = endDt.getTime();
      rows = rows.filter(r => r.sale_date && new Date(r.sale_date).getTime() <= t);
    }
    const total_items = rows.length;
    let pageRows = rows;
    if (page && limit) {
      pageRows = rows.slice((page - 1) * limit, page * limit);
    }
    let total_qty = 0;
    let total_revenue = 0;
    let total_margin = 0;
    const items = pageRows.map(r => {
      const qty = num(r.qty);
      const unit_price = num(r.unit_price);
      const unit_margin = num(r.unit_margin);
      const total_price = num(r.total_price);
      total_qty += qty;
      total_revenue += total_price;
      total_margin += unit_margin * qty;
      return {
        sale_date: r.sale_date || '',
        sku: r.sku,
        item_name: r.item_name,
        qty,
        unit_price,
        total_price,
        unit_margin,
        unit_cost: num(r.unit_cost),
      };
    });
    // Totals for export should cover full filtered set, not just page
    if (page && limit) {
      total_qty = 0;
      total_revenue = 0;
      total_margin = 0;
      for (const r of rows) {
        const qty = num(r.qty);
        total_qty += qty;
        total_revenue += num(r.total_price);
        total_margin += num(r.unit_margin) * qty;
      }
    }
    return {
      items,
      total_qty,
      total_revenue,
      total_margin,
      total_items,
      page: page || 1,
      limit: limit || (total_items || 1),
    };
  }

  function woOut(wo) {
    let warehouse_code = null;
    let location_code = null;
    if (wo.warehouse_to) {
      warehouse_code = db.prepare('SELECT code FROM warehouse WHERE id = ?').get(wo.warehouse_to)?.code || null;
    }
    if (wo.location_to) {
      location_code = db.prepare('SELECT code FROM location WHERE id = ?').get(wo.location_to)?.code || null;
    }
    const it = db.prepare('SELECT sku, name FROM item WHERE id = ?').get(wo.item_id);
    return {
      id: wo.id,
      kind: wo.kind,
      item_id: wo.item_id,
      item_sku: it?.sku || null,
      item_name: it?.name || null,
      qty: num(wo.qty),
      qty_planned: num(wo.qty_planned),
      qty_completed: num(wo.qty_completed),
      warehouse_code,
      location_code,
      status: wo.status,
      created_at: wo.created_at,
      completed_at: wo.completed_at,
    };
  }

  // ---------- health ----------
  router.get('/health', (_req, res) => res.json({ status: 'ok', erp: 'embedded' }));

  router.get('/dashboard', (_req, res) => {
    try {
      const dash = buildErpDashboard(db);
      dash.counts.pending_postings = pendingCount(db);
      res.json(dash);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  router.post('/sync', (_req, res) => {
    try {
      res.json({ ok: true, ...syncShopfloorToErp(db) });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  router.get('/config/ui', (_req, res) => res.json({ decimals_display: 2 }));

  // ---------- uom ----------
  router.get('/uom', (req, res) => {
    const { dimension } = req.query;
    const rows = dimension
      ? db.prepare('SELECT * FROM uom WHERE dimension = ? ORDER BY code').all(dimension)
      : db.prepare('SELECT * FROM uom ORDER BY code').all();
    res.json(rows.map(r => ({ ...r, is_base: !!r.is_base })));
  });

  // ---------- warehouses / locations ----------
  router.get('/warehouses', (_req, res) => {
    res.json(db.prepare('SELECT * FROM warehouse ORDER BY code').all());
  });

  router.post('/warehouses', (req, res) => {
    const { code, name } = req.body || {};
    if (!code || !name) return res.status(400).json({ error: 'code and name are required' });
    if (db.prepare('SELECT id FROM warehouse WHERE code = ?').get(code)) {
      return res.status(409).json({ error: 'Warehouse code already exists' });
    }
    const r = db.prepare('INSERT INTO warehouse (code, name) VALUES (?, ?)').run(code, name);
    res.status(201).json(db.prepare('SELECT * FROM warehouse WHERE id = ?').get(r.lastInsertRowid));
  });

  router.get('/locations', (req, res) => {
    const { warehouse_id } = req.query;
    const rows = warehouse_id
      ? db.prepare(`
          SELECT l.*, w.code AS warehouse_code, w.name AS warehouse_name
          FROM location l JOIN warehouse w ON w.id = l.warehouse_id
          WHERE l.warehouse_id = ? ORDER BY l.code
        `).all(warehouse_id)
      : db.prepare(`
          SELECT l.*, w.code AS warehouse_code, w.name AS warehouse_name
          FROM location l JOIN warehouse w ON w.id = l.warehouse_id
          ORDER BY w.code, l.code
        `).all();
    res.json(rows);
  });

  router.post('/locations', (req, res) => {
    const { warehouse_id, code } = req.body || {};
    if (!warehouse_id || !code) return res.status(400).json({ error: 'warehouse_id and code are required' });
    const warehouse = db.prepare('SELECT id FROM warehouse WHERE id = ?').get(warehouse_id);
    if (!warehouse) return res.status(404).json({ error: 'Warehouse not found' });
    const normalizedCode = String(code).trim().toUpperCase();
    if (!/^[0-9]{2}[A-Z][0-9]{2}$/.test(normalizedCode)) {
      return res.status(400).json({ error: 'code must use ##A## format, for example 01A01' });
    }
    try {
      const r = db.prepare('INSERT INTO location (warehouse_id, code) VALUES (?, ?)')
        .run(warehouse_id, normalizedCode);
      res.status(201).json(db.prepare('SELECT * FROM location WHERE id = ?').get(r.lastInsertRowid));
    } catch (e) {
      const status = String(e.code || '').includes('CONSTRAINT_UNIQUE') ? 409 : 400;
      res.status(status).json({ error: e.message });
    }
  });

  // ---------- items ----------
  router.get('/items', (req, res) => {
    const term = (req.query.search || req.query.q || '').toString().trim().toLowerCase();
    const limit = Math.min(Math.max(parseInt(req.query.limit || '50', 10), 1), 200);
    const offset = Math.max(parseInt(req.query.offset || '0', 10), 0);
    let rows;
    if (term) {
      const like = `%${term}%`;
      rows = db.prepare(
        `SELECT i.*, w.code AS warehouse_code
         FROM item i
         LEFT JOIN warehouse w ON w.id = i.warehouse_id
         WHERE lower(i.sku) LIKE ? OR lower(i.name) LIKE ?
         ORDER BY i.sku LIMIT ? OFFSET ?`
      ).all(like, like, limit, offset);
    } else {
      rows = db.prepare(
        `SELECT i.*, w.code AS warehouse_code
         FROM item i
         LEFT JOIN warehouse w ON w.id = i.warehouse_id
         ORDER BY i.sku LIMIT ? OFFSET ?`
      ).all(limit, offset);
    }
    res.json(rows.map(r => ({ ...r, is_active: !!r.is_active })));
  });

  router.post('/items', (req, res) => {
    const b = req.body || {};
    if (!b.sku || !b.name || !b.dimension || !b.display_uom_code || !b.purchase_uom_code) {
      return res.status(400).json({ error: 'sku, name, dimension, display_uom_code, purchase_uom_code required' });
    }
    const item_role = String(b.item_role || 'raw');
    const sourcing = String(b.sourcing || 'manufactured');
    if (!ITEM_ROLES.has(item_role)) {
      return res.status(400).json({ error: 'item_role must be product, component, or raw' });
    }
    if (!SOURCING.has(sourcing)) {
      return res.status(400).json({ error: 'sourcing must be manufactured or outsource' });
    }
    if (db.prepare('SELECT id FROM item WHERE sku = ?').get(b.sku)) {
      return res.status(409).json({ error: 'SKU already exists' });
    }
    const r = db.prepare(`
      INSERT INTO item (
        sku, name, warehouse_id, dimension, display_uom_code, purchase_uom_code, is_active,
        item_role, sourcing, project_id, part_id, needs_erp_data
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      b.sku, b.name, b.warehouse_id || null, b.dimension,
      b.display_uom_code, b.purchase_uom_code, b.is_active === false ? 0 : 1,
      item_role, sourcing,
      b.project_id || null, b.part_id || null,
      b.needs_erp_data ? 1 : 0
    );
    const row = db.prepare('SELECT * FROM item WHERE id = ?').get(r.lastInsertRowid);
    res.status(201).json({ ...row, is_active: !!row.is_active });
  });

  router.put('/items/:id', (req, res) => {
    const id = parseInt(req.params.id, 10);
    const cur = db.prepare('SELECT * FROM item WHERE id = ?').get(id);
    if (!cur) return res.status(404).json({ error: 'Item not found' });
    const b = req.body || {};
    if (b.item_role != null && !ITEM_ROLES.has(String(b.item_role))) {
      return res.status(400).json({ error: 'item_role must be product, component, or raw' });
    }
    if (b.sourcing != null && !SOURCING.has(String(b.sourcing))) {
      return res.status(400).json({ error: 'sourcing must be manufactured or outsource' });
    }
    db.prepare(`
      UPDATE item SET
        name = COALESCE(?, name),
        warehouse_id = COALESCE(?, warehouse_id),
        dimension = COALESCE(?, dimension),
        display_uom_code = COALESCE(?, display_uom_code),
        purchase_uom_code = COALESCE(?, purchase_uom_code),
        custom_margin = COALESCE(?, custom_margin),
        custom_ads = COALESCE(?, custom_ads),
        custom_fee = COALESCE(?, custom_fee),
        is_active = COALESCE(?, is_active),
        item_role = COALESCE(?, item_role),
        sourcing = COALESCE(?, sourcing),
        project_id = COALESCE(?, project_id),
        part_id = COALESCE(?, part_id),
        needs_erp_data = COALESCE(?, needs_erp_data)
      WHERE id = ?
    `).run(
      b.name ?? null,
      b.warehouse_id !== undefined ? b.warehouse_id : null,
      b.dimension ?? null,
      b.display_uom_code ?? null,
      b.purchase_uom_code ?? null,
      b.custom_margin !== undefined ? b.custom_margin : null,
      b.custom_ads !== undefined ? b.custom_ads : null,
      b.custom_fee !== undefined ? b.custom_fee : null,
      b.is_active !== undefined ? (b.is_active ? 1 : 0) : null,
      b.item_role ?? null,
      b.sourcing ?? null,
      b.project_id !== undefined ? b.project_id : null,
      b.part_id !== undefined ? b.part_id : null,
      b.needs_erp_data !== undefined ? (b.needs_erp_data ? 1 : 0) : null,
      id
    );
    // Clearing needs_erp_data when sourcing explicitly set
    if (b.sourcing != null || b.item_role != null) {
      db.prepare('UPDATE item SET needs_erp_data = 0 WHERE id = ?').run(id);
    }
    const row = db.prepare('SELECT * FROM item WHERE id = ?').get(id);
    res.json({ ...row, is_active: !!row.is_active });
  });

  // ---------- machines ----------
  // Acres machine row is only name + hourly_rate (+ is_active). CoMa adds printer_id /
  // needs_erp_data and joins shopfloor printers so the rates UI shows linked fleet data.
  function mapMachineRow(r) {
    return {
      id: r.id,
      machine: r.machine,
      hourly_rate: num(r.hourly_rate),
      is_active: !!r.is_active,
      created_at: r.created_at ?? null,
      updated_at: r.updated_at ?? null,
      printer_id: r.printer_id ?? null,
      needs_erp_data: !!r.needs_erp_data,
      printer_name: r.printer_name ?? null,
      printer_model: r.printer_model ?? null,
      printer_status: r.printer_status ?? null,
      printer_is_active: r.printer_is_active == null ? null : !!r.printer_is_active,
    };
  }

  function loadMachines(q, limit, offset) {
    const hasPrinters = !!db.prepare(
      "SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = 'printers'"
    ).get();
    const like = q ? `%${q}%` : null;
    if (hasPrinters) {
      const sql = `
        SELECT m.*,
               p.name AS printer_name,
               p.model AS printer_model,
               p.status AS printer_status,
               p.is_active AS printer_is_active
        FROM machine m
        LEFT JOIN printers p ON p.id = m.printer_id
        ${like ? 'WHERE m.machine LIKE ?' : ''}
        ORDER BY m.machine
        LIMIT ? OFFSET ?
      `;
      return like
        ? db.prepare(sql).all(like, limit, offset)
        : db.prepare(sql).all(limit, offset);
    }
    const sql = `
      SELECT * FROM machine
      ${like ? 'WHERE machine LIKE ?' : ''}
      ORDER BY machine
      LIMIT ? OFFSET ?
    `;
    return like
      ? db.prepare(sql).all(like, limit, offset)
      : db.prepare(sql).all(limit, offset);
  }

  function loadMachineById(id) {
    const hasPrinters = !!db.prepare(
      "SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = 'printers'"
    ).get();
    if (hasPrinters) {
      return db.prepare(`
        SELECT m.*,
               p.name AS printer_name,
               p.model AS printer_model,
               p.status AS printer_status,
               p.is_active AS printer_is_active
        FROM machine m
        LEFT JOIN printers p ON p.id = m.printer_id
        WHERE m.id = ?
      `).get(id);
    }
    return db.prepare('SELECT * FROM machine WHERE id = ?').get(id);
  }

  router.get('/mfg/machines', (req, res) => {
    const q = (req.query.q || '').toString().trim();
    const limit = Math.min(Math.max(parseInt(req.query.limit || '200', 10), 1), 1000);
    const offset = Math.max(parseInt(req.query.offset || '0', 10), 0);
    res.json(loadMachines(q, limit, offset).map(mapMachineRow));
  });

  router.post('/mfg/machines', (req, res) => {
    const name = String((req.body || {}).machine || '').trim();
    const hourly_rate = num((req.body || {}).hourly_rate, 0);
    if (!name) return res.status(400).json({ error: 'machine is required' });
    if (hourly_rate < 0) return res.status(400).json({ error: 'hourly_rate must be >= 0' });
    const ex = db.prepare('SELECT * FROM machine WHERE machine = ?').get(name);
    const now = new Date().toISOString();
    const needs = hourly_rate > 0 ? 0 : 1;
    let id;
    if (ex) {
      db.prepare(
        'UPDATE machine SET hourly_rate = ?, is_active = 1, updated_at = ?, needs_erp_data = ? WHERE id = ?'
      ).run(hourly_rate, now, needs, ex.id);
      id = ex.id;
    } else {
      const r = db.prepare(
        'INSERT INTO machine (machine, hourly_rate, is_active, created_at, needs_erp_data) VALUES (?, ?, 1, ?, ?)'
      ).run(name, hourly_rate, now, needs);
      id = r.lastInsertRowid;
    }
    res.status(ex ? 200 : 201).json(mapMachineRow(loadMachineById(id)));
  });

  // ---------- mfg components ----------
  router.get('/mfg/components', (req, res) => {
    const q = (req.query.q || '').toString().trim().toLowerCase();
    const active = req.query.active;
    const limit = Math.min(Math.max(parseInt(req.query.limit || '200', 10), 1), 1000);
    const offset = Math.max(parseInt(req.query.offset || '0', 10), 0);
    let rows = db.prepare('SELECT * FROM mfg_component ORDER BY sku').all();
    if (q) {
      rows = rows.filter(r =>
        (r.sku || '').toLowerCase().includes(q) || (r.name || '').toLowerCase().includes(q)
      );
    }
    if (active !== undefined && active !== '') {
      const want = active === 'true' || active === '1';
      rows = rows.filter(r => !!r.is_active === want);
    }
    rows = rows.slice(offset, offset + limit);
    res.json(rows.map(r => {
      const raw = db.prepare('SELECT sku FROM item WHERE id = ?').get(r.raw_item_id);
      return mfgOut(r, raw?.sku);
    }));
  });

  router.post('/mfg/components', (req, res) => {
    const b = req.body || {};
    const sku = String(b.sku || '').trim();
    const name = String(b.name || '').trim();
    if (!sku || !name) return res.status(400).json({ error: 'sku and name are required' });
    if (!b.raw_item_id) return res.status(400).json({ error: 'raw_item_id is required' });
    const raw = db.prepare('SELECT * FROM item WHERE id = ?').get(b.raw_item_id);
    if (!raw) return res.status(404).json({ error: `raw_item_id ${b.raw_item_id} not found` });

    const now = new Date().toISOString();
    const ex = db.prepare('SELECT * FROM mfg_component WHERE sku = ?').get(sku);
    let row;
    if (ex) {
      db.prepare(`
        UPDATE mfg_component SET name = ?, machine = ?, std_minutes = ?, raw_item_id = ?,
          raw_qty_per_unit = ?, scrap_pct = ?, is_active = ?, updated_at = ?
        WHERE id = ?
      `).run(
        name, b.machine || null, num(b.std_minutes), Number(b.raw_item_id),
        num(b.raw_qty_per_unit), num(b.scrap_pct), b.is_active === false ? 0 : 1, now, ex.id
      );
      row = db.prepare('SELECT * FROM mfg_component WHERE id = ?').get(ex.id);
    } else {
      const r = db.prepare(`
        INSERT INTO mfg_component
          (sku, name, machine, std_minutes, raw_item_id, raw_qty_per_unit, scrap_pct, is_active, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        sku, name, b.machine || null, num(b.std_minutes), Number(b.raw_item_id),
        num(b.raw_qty_per_unit), num(b.scrap_pct), b.is_active === false ? 0 : 1, now
      );
      row = db.prepare('SELECT * FROM mfg_component WHERE id = ?').get(r.lastInsertRowid);
    }
    try {
      ensureCompItem(row.sku, row.name);
    } catch (e) {
      return res.status(e.status || 400).json({ error: e.message });
    }
    res.status(ex ? 200 : 201).json(mfgOut(row, raw.sku));
  });

  router.post('/mfg/calculate-component-cost', (req, res) => {
    try {
      res.json(calculateComponentCost(db, req.body || {}));
    } catch (e) {
      res.status(e.status || 500).json({ error: e.message });
    }
  });

  // ---------- inventory ----------
  router.get('/inventory/stock', (req, res) => {
    const warehouse_id = req.query.warehouse_id ? parseInt(req.query.warehouse_id, 10) : null;
    const moveSql = warehouse_id
      ? `SELECT item_id, warehouse_id, SUM(qty) AS qty, SUM(qty * unit_cost) AS tcost
         FROM stock_move WHERE warehouse_id = ? GROUP BY item_id, warehouse_id`
      : `SELECT item_id, warehouse_id, SUM(qty) AS qty, SUM(qty * unit_cost) AS tcost
         FROM stock_move GROUP BY item_id, warehouse_id`;
    const moves = warehouse_id ? db.prepare(moveSql).all(warehouse_id) : db.prepare(moveSql).all();

    const rows = [];
    const seen = new Set();
    for (const r of moves) {
      const qty = num(r.qty);
      if (Math.abs(qty) < 1e-12) continue;
      const wac = qty ? num(r.tcost) / qty : 0;
      const it = db.prepare('SELECT sku, name FROM item WHERE id = ?').get(r.item_id);
      const wh = db.prepare('SELECT code, name FROM warehouse WHERE id = ?').get(r.warehouse_id);
      rows.push({
        item_id: r.item_id,
        warehouse_id: r.warehouse_id,
        sku: it?.sku || String(r.item_id),
        name: it?.name || null,
        warehouse: wh ? `${wh.code}${wh.name ? ' - ' + wh.name : ''}` : String(r.warehouse_id),
        warehouse_code: wh?.code || null,
        qty_on_hand: qty,
        wac: round4(wac),
        value: round4(qty * wac),
      });
      seen.add(`${r.item_id}:${r.warehouse_id}`);
    }

    const costs = warehouse_id
      ? db.prepare('SELECT * FROM item_cost WHERE warehouse_id = ?').all(warehouse_id)
      : db.prepare('SELECT * FROM item_cost').all();
    for (const ic of costs) {
      if (seen.has(`${ic.item_id}:${ic.warehouse_id}`)) continue;
      const it = db.prepare('SELECT sku, name FROM item WHERE id = ?').get(ic.item_id);
      const wh = db.prepare('SELECT code, name FROM warehouse WHERE id = ?').get(ic.warehouse_id);
      rows.push({
        item_id: ic.item_id,
        warehouse_id: ic.warehouse_id,
        sku: it?.sku || String(ic.item_id),
        name: it?.name || null,
        warehouse: wh ? `${wh.code}${wh.name ? ' - ' + wh.name : ''}` : String(ic.warehouse_id),
        warehouse_code: wh?.code || null,
        qty_on_hand: 0,
        wac: round4(ic.wac),
        value: 0,
      });
    }
    rows.sort((a, b) => (a.sku + a.warehouse).localeCompare(b.sku + b.warehouse));
    res.json(rows);
  });

  router.get('/inventory/dashboard', (_req, res) => {
    const stock = db.prepare(`
      SELECT item_id, warehouse_id, SUM(qty) AS qty, SUM(qty * unit_cost) AS tcost
      FROM stock_move GROUP BY item_id, warehouse_id
    `).all();
    let skus = 0;
    let total_qty = 0;
    let total_value = 0;
    const by_wh = {};
    for (const r of stock) {
      const qty = num(r.qty);
      if (Math.abs(qty) < 1e-12) continue;
      skus += 1;
      total_qty += qty;
      const wac = qty ? num(r.tcost) / qty : 0;
      total_value += qty * wac;
      const wh = db.prepare('SELECT code FROM warehouse WHERE id = ?').get(r.warehouse_id);
      const code = wh?.code || String(r.warehouse_id);
      if (!by_wh[code]) by_wh[code] = { warehouse: code, lines: 0, qty: 0, value: 0 };
      by_wh[code].lines += 1;
      by_wh[code].qty += qty;
      by_wh[code].value += qty * wac;
    }
    res.json({
      sku_lines: skus,
      total_qty: round4(total_qty),
      total_value: round4(total_value),
      by_warehouse: Object.values(by_wh).map(w => ({
        ...w,
        qty: round4(w.qty),
        value: round4(w.value),
      })),
    });
  });

  router.post('/inventory/receive_by_sku', (req, res) => {
    const b = req.body || {};
    const sku = String(b.sku || '').trim();
    if (!sku) return res.status(400).json({ error: 'sku is required' });
    const it = db.prepare('SELECT * FROM item WHERE sku = ?').get(sku);
    if (!it) return res.status(404).json({ error: 'SKU not found' });
    const wh_id = parseInt(b.warehouse_id, 10);
    if (!wh_id) return res.status(400).json({ error: 'warehouse_id is required' });
    if (!db.prepare('SELECT id FROM warehouse WHERE id = ?').get(wh_id)) {
      return res.status(404).json({ error: 'Warehouse not found' });
    }
    let locationId = null;
    if (b.location_id !== undefined && b.location_id !== null && b.location_id !== '') {
      locationId = parseInt(b.location_id, 10);
      const location = db.prepare('SELECT id, warehouse_id FROM location WHERE id = ?').get(locationId);
      if (!location) return res.status(404).json({ error: 'Location not found' });
      if (Number(location.warehouse_id) !== wh_id) {
        return res.status(400).json({ error: 'Location does not belong to warehouse' });
      }
    }
    const qty = num(b.qty);
    const unit_cost = num(b.unit_cost);
    if (qty <= 0) return res.status(400).json({ error: 'qty must be > 0' });
    if (unit_cost < 0) return res.status(400).json({ error: 'unit_cost must be >= 0' });

    if (b.idem_key) {
      const ex = db.prepare('SELECT id FROM stock_move WHERE idem_key = ?').get(b.idem_key);
      if (ex) return res.json({ status: 'ok', move_id: ex.id, idempotent: true });
    }

    const now = new Date().toISOString();
    const move_id = db.transaction(() => {
      const r = db.prepare(`
        INSERT INTO stock_move (item_id, warehouse_id, location_id, qty, unit_cost, note, created_at, trans_date, idem_key)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(it.id, wh_id, locationId, qty, unit_cost, b.note || null, now, b.trans_date || now, b.idem_key || null);

      let ic = db.prepare('SELECT * FROM item_cost WHERE item_id = ? AND warehouse_id = ?').get(it.id, wh_id);
      if (!ic) {
        db.prepare(
          'INSERT INTO item_cost (item_id, warehouse_id, wac, qty_on_hand, created_at) VALUES (?, ?, ?, 0, ?)'
        ).run(it.id, wh_id, unit_cost, now);
        ic = db.prepare('SELECT * FROM item_cost WHERE item_id = ? AND warehouse_id = ?').get(it.id, wh_id);
      }
      const qty_old = num(ic.qty_on_hand);
      const wac_old = num(ic.wac);
      const qty_new = qty_old + qty;
      const wac_new = qty_new > 0 ? ((qty_old * wac_old) + (qty * unit_cost)) / qty_new : 0;
      db.prepare(
        'UPDATE item_cost SET qty_on_hand = ?, wac = ?, updated_at = ? WHERE item_id = ? AND warehouse_id = ?'
      ).run(qty_new, wac_new, now, it.id, wh_id);
      if (it.item_role === 'raw') {
        db.prepare('UPDATE item SET needs_erp_data = 0 WHERE id = ?').run(it.id);
      }
      return r.lastInsertRowid;
    })();
    res.json({ status: 'ok', move_id });
  });

  // ---------- BOM ----------
  router.get('/bom', (req, res) => {
    const q = (req.query.q || '').toString().trim().toLowerCase();
    const limit = Math.min(Math.max(parseInt(req.query.limit || '200', 10), 1), 1000);
    const offset = Math.max(parseInt(req.query.offset || '0', 10), 0);
    let rows = db.prepare(`
      SELECT b.*, i.sku AS item_sku, i.name AS item_name
      FROM bom b JOIN item i ON i.id = b.item_id
      ORDER BY i.sku
    `).all();
    if (q) {
      rows = rows.filter(r =>
        (r.item_sku || '').toLowerCase().includes(q) || (r.item_name || '').toLowerCase().includes(q)
      );
    }
    rows = rows.slice(offset, offset + limit);
    res.json(rows.map(r => {
      const cost = calculateBomCostDetail(db, r.id);
      return {
        id: r.id,
        item_id: r.item_id,
        item_sku: r.item_sku,
        item_name: r.item_name,
        name: r.name,
        labor_hours_per_unit: num(r.labor_hours_per_unit),
        material_cost: cost?.material_cost || 0,
        labor_cost: cost?.labor_cost || 0,
        total_cost: cost?.total_cost || 0,
      };
    }));
  });

  router.post('/bom', (req, res) => {
    const b = req.body || {};
    if (!b.item_id) return res.status(400).json({ error: 'item_id required' });
    const it = db.prepare('SELECT * FROM item WHERE id = ?').get(b.item_id);
    if (!it) return res.status(404).json({ error: 'item not found' });
    const ex = db.prepare('SELECT * FROM bom WHERE item_id = ?').get(b.item_id);
    if (ex) {
      db.prepare('UPDATE bom SET name = COALESCE(?, name), labor_hours_per_unit = ? WHERE id = ?')
        .run(b.name || null, num(b.labor_hours_per_unit), ex.id);
      const row = db.prepare('SELECT * FROM bom WHERE id = ?').get(ex.id);
      return res.json({
        id: row.id, item_id: row.item_id, item_sku: it.sku, item_name: it.name,
        name: row.name, labor_hours_per_unit: num(row.labor_hours_per_unit),
      });
    }
    const r = db.prepare(
      'INSERT INTO bom (item_id, name, labor_hours_per_unit) VALUES (?, ?, ?)'
    ).run(b.item_id, b.name || null, num(b.labor_hours_per_unit));
    res.status(201).json({
      id: r.lastInsertRowid, item_id: it.id, item_sku: it.sku, item_name: it.name,
      name: b.name || null, labor_hours_per_unit: num(b.labor_hours_per_unit),
    });
  });

  router.get('/bom/:id', (req, res) => {
    const bom = db.prepare('SELECT * FROM bom WHERE id = ?').get(req.params.id);
    if (!bom) return res.status(404).json({ error: 'BOM not found' });
    const it = db.prepare('SELECT * FROM item WHERE id = ?').get(bom.item_id);
    const lines = db.prepare(`
      SELECT l.*, i.sku, i.name FROM bom_line l
      JOIN item i ON i.id = l.component_item_id
      WHERE l.bom_id = ? ORDER BY l.id
    `).all(bom.id);
    res.json({
      id: bom.id,
      item_id: bom.item_id,
      item_sku: it?.sku,
      item_name: it?.name,
      name: bom.name,
      labor_hours_per_unit: num(bom.labor_hours_per_unit),
      lines: lines.map(l => ({
        id: l.id, component_item_id: l.component_item_id, qty: num(l.qty),
        scrap_pct: num(l.scrap_pct), sku: l.sku, name: l.name,
      })),
    });
  });

  router.post('/bom/:id/line', (req, res) => {
    const bom = db.prepare('SELECT * FROM bom WHERE id = ?').get(req.params.id);
    if (!bom) return res.status(404).json({ error: 'BOM not found' });
    const { component_item_id, qty } = req.body || {};
    if (!component_item_id) return res.status(400).json({ error: 'component_item_id required' });
    const comp = db.prepare('SELECT * FROM item WHERE id = ?').get(component_item_id);
    if (!comp) return res.status(404).json({ error: 'component not found' });
    const ex = db.prepare(
      'SELECT * FROM bom_line WHERE bom_id = ? AND component_item_id = ?'
    ).get(bom.id, component_item_id);
    if (ex) {
      db.prepare('UPDATE bom_line SET qty = ? WHERE id = ?').run(num(qty), ex.id);
      return res.json({
        id: ex.id, component_item_id, qty: num(qty), sku: comp.sku, name: comp.name,
      });
    }
    const r = db.prepare(
      'INSERT INTO bom_line (bom_id, component_item_id, qty, scrap_pct) VALUES (?, ?, ?, 0)'
    ).run(bom.id, component_item_id, num(qty));
    res.status(201).json({
      id: r.lastInsertRowid, component_item_id, qty: num(qty), sku: comp.sku, name: comp.name,
    });
  });

  // Static-before-param style: delete by component_item_id query
  router.delete('/bom/:id/line', (req, res) => {
    const bomId = req.params.id;
    const component_item_id = parseInt(req.query.component_item_id, 10);
    if (!component_item_id) return res.status(400).json({ error: 'component_item_id required' });
    const ln = db.prepare(
      'SELECT * FROM bom_line WHERE bom_id = ? AND component_item_id = ?'
    ).get(bomId, component_item_id);
    if (!ln) return res.status(404).json({ error: 'line not found' });
    db.prepare('DELETE FROM bom_line WHERE id = ?').run(ln.id);
    res.json({ status: 'ok', deleted: ln.id, bom_id: Number(bomId) });
  });

  router.delete('/bom/:id/line/:lineId', (req, res) => {
    const ln = db.prepare('SELECT * FROM bom_line WHERE id = ? AND bom_id = ?')
      .get(req.params.lineId, req.params.id);
    if (!ln) return res.status(404).json({ error: 'line not found' });
    db.prepare('DELETE FROM bom_line WHERE id = ?').run(ln.id);
    res.json({ status: 'ok', deleted: ln.id, bom_id: Number(req.params.id) });
  });

  router.get('/bom/:id/calculate-cost', (req, res) => {
    const warehouse_id = req.query.warehouse_id ? parseInt(req.query.warehouse_id, 10) : null;
    const detail = calculateBomCostDetail(db, parseInt(req.params.id, 10), warehouse_id);
    if (!detail) return res.status(404).json({ error: 'BOM not found' });
    res.json(detail);
  });

  router.delete('/bom/:id', (req, res) => {
    const bom = db.prepare('SELECT * FROM bom WHERE id = ?').get(req.params.id);
    if (!bom) return res.status(404).json({ error: 'BOM not found' });
    db.transaction(() => {
      db.prepare('DELETE FROM bom_line WHERE bom_id = ?').run(bom.id);
      db.prepare('DELETE FROM bom WHERE id = ?').run(bom.id);
    })();
    res.json({ status: 'ok' });
  });

  // ---------- Work orders ----------
  router.get('/wo', (req, res) => {
    const q = (req.query.q || '').toString().trim().toLowerCase();
    const limit = Math.min(Math.max(parseInt(req.query.limit || '500', 10), 1), 1000);
    const offset = Math.max(parseInt(req.query.offset || '0', 10), 0);
    let rows;
    if (q) {
      const like = `%${q}%`;
      rows = db.prepare(`
        SELECT wo.*
        FROM work_order wo
        JOIN item i ON i.id = wo.item_id
        WHERE lower(i.sku) LIKE ? OR lower(i.name) LIKE ?
        ORDER BY wo.id DESC
        LIMIT ? OFFSET ?
      `).all(like, like, limit, offset);
    } else {
      rows = db.prepare('SELECT * FROM work_order ORDER BY id DESC LIMIT ? OFFSET ?').all(limit, offset);
    }
    res.json(rows.map(woOut));
  });

  router.get('/wo/:id', (req, res) => {
    const wo = db.prepare('SELECT * FROM work_order WHERE id = ?').get(req.params.id);
    if (!wo) return res.status(404).json({ error: 'WO not found' });
    res.json(woOut(wo));
  });

  router.post('/wo', (req, res) => {
    const b = req.body || {};
    let it = null;
    if (b.item_id) it = db.prepare('SELECT * FROM item WHERE id = ?').get(b.item_id);
    if (!it && b.item_sku) it = db.prepare('SELECT * FROM item WHERE sku = ?').get(b.item_sku);
    if (!it) return res.status(404).json({ error: 'Finished good not found' });
    const qty_planned = num(b.qty_planned);
    if (qty_planned <= 0) return res.status(422).json({ error: 'qty_planned must be > 0' });
    const whCode = b.warehouse_code || 'fin_good';
    const wh_id = whIdByCode(db, whCode);
    if (!wh_id) return res.status(400).json({ error: `Warehouse '${whCode}' not found` });
    let loc_id = null;
    if (b.location_code) {
      const loc = db.prepare(
        'SELECT id, warehouse_id FROM location WHERE upper(code) = upper(?)'
      ).get(b.location_code);
      if (!loc) return res.status(400).json({ error: `Location code '${b.location_code}' not found` });
      if (Number(loc.warehouse_id) !== Number(wh_id)) {
        return res.status(400).json({ error: 'Location does not belong to warehouse' });
      }
      loc_id = loc.id;
    }
    const bom = db.prepare('SELECT * FROM bom WHERE item_id = ?').get(it.id);
    if (!bom) return res.status(404).json({ error: `No BOM for finished item (sku=${it.sku})` });
    const now = new Date().toISOString();
    const r = db.prepare(`
      INSERT INTO work_order (kind, item_id, qty, qty_planned, status, warehouse_to, location_to, bom_id, created_at)
      VALUES (?, ?, 0, ?, 'open', ?, ?, ?, ?)
    `).run(whCode, it.id, qty_planned, wh_id, loc_id, bom.id, now);
    res.status(201).json(woOut(db.prepare('SELECT * FROM work_order WHERE id = ?').get(r.lastInsertRowid)));
  });

  router.post('/wo/:id/complete', (req, res) => {
    const wo = db.prepare('SELECT * FROM work_order WHERE id = ?').get(req.params.id);
    if (!wo) return res.status(404).json({ error: 'WO not found' });
    if (wo.status === 'completed' || wo.status === 'closed') return res.json(woOut(wo));

    const qty_plan = num((req.body || {}).qty_completed ?? wo.qty_planned);
    if (qty_plan <= 0) return res.status(422).json({ error: 'WO qty_planned must be > 0' });

    const comp_wh_id = whIdByCode(db, 'comp');
    const target_wh_id = wo.warehouse_to || whIdByCode(db, 'fin_good') || finWarehouseId(db);
    if (!comp_wh_id || !target_wh_id) {
      return res.status(400).json({ error: 'Component and target warehouses are required' });
    }

    const bom = db.prepare('SELECT * FROM bom WHERE item_id = ?').get(wo.item_id);
    if (!bom) return res.status(404).json({ error: 'No BOM for WO item' });
    const lines = db.prepare('SELECT * FROM bom_line WHERE bom_id = ?').all(bom.id);
    const factors = uomFactors(db);

    const issue_plan = [];
    const missing = [];
    for (const ln of lines) {
      const comp = db.prepare('SELECT * FROM item WHERE id = ?').get(ln.component_item_id);
      if (!comp) return res.status(404).json({ error: `Component item_id ${ln.component_item_id} not found` });
      const need = num(ln.qty) * qty_plan;
      if (need <= 0) continue;
      const mfg = db.prepare('SELECT * FROM mfg_component WHERE sku = ?').get(comp.sku);
      if (mfg) {
        const raw = db.prepare('SELECT * FROM item WHERE id = ?').get(mfg.raw_item_id);
        if (!raw) return res.status(404).json({ error: `Raw item missing for component ${comp.sku}` });
        const raw_wh = raw.warehouse_id || comp_wh_id;
        let reqDisplay = need * num(mfg.raw_qty_per_unit);
        if (num(mfg.scrap_pct)) reqDisplay *= (1 + num(mfg.scrap_pct) / 100);
        const reqStock = convertQty(reqDisplay, raw.display_uom_code, raw.purchase_uom_code, factors);
        const avail = stockAvailable(raw.id, raw_wh);
        if (avail + 1e-9 < reqStock) {
          missing.push({
            item_id: raw.id, sku: raw.sku, name: raw.name,
            required: reqStock, available: avail, component_sku: comp.sku,
          });
        }
        const machine_hours = (num(mfg.std_minutes) / 60) * need;
        const machine_rate = machineRate(db, mfg.machine);
        issue_plan.push({
          item_id: raw.id,
          warehouse_id: raw_wh,
          qty: reqStock,
          component_sku: comp.sku,
          machine: mfg.machine || null,
          machine_hours,
          machine_rate,
          machine_cost: machine_hours * machine_rate,
        });
      } else {
        const reqStock = convertQty(need, comp.display_uom_code, comp.purchase_uom_code, factors);
        const avail = stockAvailable(comp.id, comp_wh_id);
        if (avail + 1e-9 < reqStock) {
          missing.push({
            item_id: comp.id, sku: comp.sku, name: comp.name,
            required: reqStock, available: avail, component_sku: comp.sku,
          });
        }
        issue_plan.push({ item_id: comp.id, warehouse_id: comp_wh_id, qty: reqStock, component_sku: comp.sku });
      }
    }
    if (missing.length) {
      return res.status(409).json({ error: 'Insufficient material stock', missing });
    }

    const now = new Date().toISOString();
    db.transaction(() => {
      let total_mat = 0;
      for (const plan of issue_plan) {
        const unit_wac = wacFor(plan.item_id, plan.warehouse_id);
        total_mat += (unit_wac * plan.qty) + num(plan.machine_cost);
        db.prepare(`
          INSERT INTO stock_move (item_id, warehouse_id, qty, unit_cost, trans_date, created_at, wo_id)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run(plan.item_id, plan.warehouse_id, -plan.qty, unit_wac, now, now, wo.id);
        db.prepare(
          'INSERT INTO wo_issue (wo_id, item_id, qty, unit_cost, trans_date) VALUES (?, ?, ?, ?, ?)'
        ).run(wo.id, plan.item_id, plan.qty, unit_wac, now);
        if (num(plan.machine_hours) > 0 && num(plan.machine_rate) > 0) {
          db.prepare(`
            INSERT INTO wo_labor (wo_id, hours, hourly_rate, cost, resource)
            VALUES (?, ?, ?, ?, ?)
          `).run(
            wo.id,
            plan.machine_hours,
            plan.machine_rate,
            plan.machine_cost,
            plan.machine || plan.component_sku
          );
        }
        const ic = db.prepare('SELECT * FROM item_cost WHERE item_id = ? AND warehouse_id = ?')
          .get(plan.item_id, plan.warehouse_id);
        if (ic) {
          const nextQty = Math.max(0, num(ic.qty_on_hand) - plan.qty);
          db.prepare(
            'UPDATE item_cost SET qty_on_hand = ?, updated_at = ? WHERE item_id = ? AND warehouse_id = ?'
          ).run(nextQty, now, plan.item_id, plan.warehouse_id);
        }
      }
      const rate = laborRate(db);
      const labor_hours = num(bom.labor_hours_per_unit) * qty_plan;
      const labor_value = rate * labor_hours;
      if (labor_hours > 0) {
        db.prepare(
          'INSERT INTO wo_labor (wo_id, hours, hourly_rate, cost, resource) VALUES (?, ?, ?, ?, ?)'
        ).run(wo.id, labor_hours, rate, labor_value, 'LABOR');
      }
      const unit_fg = (total_mat + labor_value) / qty_plan;
      db.prepare(`
        INSERT INTO stock_move
          (item_id, warehouse_id, location_id, qty, unit_cost, trans_date, created_at, wo_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(wo.item_id, target_wh_id, wo.location_to || null, qty_plan, unit_fg, now, now, wo.id);

      let icFg = db.prepare('SELECT * FROM item_cost WHERE item_id = ? AND warehouse_id = ?')
        .get(wo.item_id, target_wh_id);
      if (!icFg) {
        db.prepare(
          'INSERT INTO item_cost (item_id, warehouse_id, wac, qty_on_hand, created_at) VALUES (?, ?, ?, 0, ?)'
        ).run(wo.item_id, target_wh_id, unit_fg, now);
        icFg = db.prepare('SELECT * FROM item_cost WHERE item_id = ? AND warehouse_id = ?')
          .get(wo.item_id, target_wh_id);
      }
      const q0 = num(icFg.qty_on_hand);
      const w0 = num(icFg.wac);
      const q1 = q0 + qty_plan;
      const w1 = q1 > 0 ? ((q0 * w0) + (qty_plan * unit_fg)) / q1 : unit_fg;
      db.prepare(
        'UPDATE item_cost SET qty_on_hand = ?, wac = ?, updated_at = ? WHERE item_id = ? AND warehouse_id = ?'
      ).run(q1, w1, now, wo.item_id, target_wh_id);

      db.prepare(`
        UPDATE work_order SET qty = ?, qty_completed = ?, status = 'closed', completed_at = ?
        WHERE id = ?
      `).run(qty_plan, qty_plan, now, wo.id);
    })();

    res.json(woOut(db.prepare('SELECT * FROM work_order WHERE id = ?').get(wo.id)));
  });

  // ---------- Sales ----------
  router.get('/sales/config', (_req, res) => {
    const rows = db.prepare('SELECT * FROM pricing_config ORDER BY id').all();
    res.json(rows.map(r => ({
      id: r.id, name: r.name, code: r.code, value: num(r.value),
      last_update_date: r.last_update_date,
    })));
  });

  router.post('/sales/config', (req, res) => {
    const body = req.body;
    const updates = Array.isArray(body) ? body : [body];
    if (!updates.length) return res.status(400).json({ error: 'Empty payload' });
    const now = new Date().toISOString();
    try {
      db.transaction(() => {
        for (const u of updates) {
          if (!u?.code) continue;
          const row = db.prepare('SELECT id FROM pricing_config WHERE code = ?').get(u.code);
          if (!row) {
            const err = new Error(`Config code ${u.code} not found`);
            err.status = 404;
            throw err;
          }
          db.prepare(
            'UPDATE pricing_config SET value = ?, last_update_date = ? WHERE code = ?'
          ).run(num(u.value), now, u.code);
        }
      })();
    } catch (e) {
      return res.status(e.status || 500).json({ error: e.message });
    }
    const rows = db.prepare('SELECT * FROM pricing_config ORDER BY id').all();
    res.json(rows.map(r => ({
      id: r.id, name: r.name, code: r.code, value: num(r.value),
      last_update_date: r.last_update_date,
    })));
  });

  router.get('/sales/pricing', (req, res) => {
    const page = Math.max(parseInt(req.query.page || '1', 10), 1);
    const limit = 20;
    const search = (req.query.search || '').toString().trim().toLowerCase();
    const finId = finWarehouseId(db);
    if (!finId) return res.json({ items: [], page, limit, total: 0 });
    let items = db.prepare('SELECT * FROM item WHERE warehouse_id = ? ORDER BY sku').all(finId);
    if (search) {
      items = items.filter(i =>
        (i.sku || '').toLowerCase().includes(search) || (i.name || '').toLowerCase().includes(search)
      );
    }
    const total = items.length;
    const slice = items.slice((page - 1) * limit, page * limit);
    const cfg = configMap(db);
    res.json({ items: slice.map(it => pricingRow(it, cfg)), page, limit, total });
  });

  router.patch('/sales/pricing/:itemId', (req, res) => {
    const id = parseInt(req.params.itemId, 10);
    const it = db.prepare('SELECT * FROM item WHERE id = ?').get(id);
    if (!it) return res.status(404).json({ error: 'Item not found' });
    const b = req.body || {};
    const field = b.field;
    if (field && ['custom_margin', 'custom_ads', 'custom_fee'].includes(field)) {
      db.prepare(`UPDATE item SET ${field} = ? WHERE id = ?`).run(num(b.value), id);
    } else if (field) {
      return res.status(400).json({ error: 'field must be custom_margin, custom_ads, or custom_fee' });
    } else {
      db.prepare(`
        UPDATE item SET
          custom_margin = COALESCE(?, custom_margin),
          custom_ads = COALESCE(?, custom_ads),
          custom_fee = COALESCE(?, custom_fee)
        WHERE id = ?
      `).run(
        b.custom_margin !== undefined ? b.custom_margin : null,
        b.custom_ads !== undefined ? b.custom_ads : null,
        b.custom_fee !== undefined ? b.custom_fee : null,
        id
      );
    }
    const updated = db.prepare('SELECT * FROM item WHERE id = ?').get(id);
    res.json(pricingRow(updated, configMap(db)));
  });

  router.post('/sales/pricing/:itemId/reset', (req, res) => {
    const id = parseInt(req.params.itemId, 10);
    const it = db.prepare('SELECT * FROM item WHERE id = ?').get(id);
    if (!it) return res.status(404).json({ error: 'Item not found' });
    db.prepare(
      'UPDATE item SET custom_margin = NULL, custom_ads = NULL, custom_fee = NULL WHERE id = ?'
    ).run(id);
    const updated = db.prepare('SELECT * FROM item WHERE id = ?').get(id);
    res.json(pricingRow(updated, configMap(db)));
  });

  router.get('/sales/reports', (req, res) => {
    const page = Math.max(parseInt(req.query.page || '1', 10), 1);
    const limit = Math.min(Math.max(parseInt(req.query.limit || '20', 10), 1), 200);
    const search = (req.query.search || '').toString().trim().toLowerCase();
    const sort_by = (req.query.sort_by || 'item_name').toLowerCase();
    const order = (req.query.order || 'asc').toLowerCase() === 'desc' ? 'desc' : 'asc';
    const finId = finWarehouseId(db);
    if (!finId) {
      return res.json({ items: [], page, limit, total: 0, sort_by, order, search: search || null });
    }
    let items = db.prepare('SELECT * FROM item WHERE warehouse_id = ? ORDER BY sku').all(finId);
    if (search) {
      items = items.filter(i =>
        (i.sku || '').toLowerCase().includes(search) || (i.name || '').toLowerCase().includes(search)
      );
    }
    const cfg = configMap(db);
    let rows = items.map(it => {
      const cost = bomCostForItem(db, it.id);
      const p = pricingNumbers(it, cfg, cost);
      return {
        item_id: it.id,
        item_name: it.name,
        sku: it.sku,
        cost: round4(cost),
        margin_pct: p.margin_pct,
        margin_usd: p.margin_value,
        ads_pct: p.ads_pct,
        fee_pct: p.fee_pct,
        selling_price: Math.round(p.selling_price * 100) / 100,
        fees_usd: p.fees_usd,
      };
    });
    const sorters = {
      margin_pct: r => r.margin_pct,
      margin_usd: r => r.margin_usd,
      selling_price: r => r.selling_price,
      item_name: r => (r.item_name || '').toLowerCase(),
      sku: r => (r.sku || '').toLowerCase(),
    };
    const key = sorters[sort_by] || sorters.item_name;
    rows.sort((a, b) => {
      const av = key(a);
      const bv = key(b);
      if (av < bv) return order === 'desc' ? 1 : -1;
      if (av > bv) return order === 'desc' ? -1 : 1;
      return 0;
    });
    const total = rows.length;
    rows = rows.slice((page - 1) * limit, page * limit);
    res.json({
      items: rows, page, limit, total,
      sort_by: sorters[sort_by] ? sort_by : 'item_name',
      order, search: search || null,
    });
  });

  router.get('/sales/order/items', (req, res) => {
    const finId = finWarehouseId(db);
    if (!finId) return res.status(400).json({ error: 'FIN_GOOD warehouse not found' });
    const search = (req.query.search || '').toString().trim().toLowerCase();
    const limit = Math.min(Math.max(parseInt(req.query.limit || '100', 10), 1), 200);
    let items = db.prepare('SELECT * FROM item WHERE warehouse_id = ? ORDER BY sku').all(finId);
    if (search) {
      items = items.filter(i =>
        (i.sku || '').toLowerCase().includes(search) || (i.name || '').toLowerCase().includes(search)
      );
    }
    items = items.slice(0, limit);
    const cfg = configMap(db);
    res.json(items.map(it => ({
      item_id: it.id,
      name: it.name,
      sku: it.sku,
      selling_price: Math.round(unitPrice(it, cfg) * 100) / 100,
      available_qty: stockAvailable(it.id, finId),
    })));
  });

  router.post('/sales/orders', (req, res) => {
    const b = req.body || {};
    const qty = num(b.qty);
    if (qty <= 0) return res.status(400).json({ error: 'qty must be > 0' });
    const finId = finWarehouseId(db);
    if (!finId) return res.status(400).json({ error: 'FIN_GOOD warehouse not found' });
    const item = db.prepare(
      'SELECT * FROM item WHERE sku = ? AND warehouse_id = ?'
    ).get(String(b.sku || '').trim(), finId);
    if (!item) return res.status(404).json({ error: 'Item not found in FIN_GOOD' });

    const available = stockAvailable(item.id, finId);
    if (available + 1e-9 < qty) return res.status(409).json({ error: 'Insufficient stock' });

    const cfg = configMap(db);
    const unit_price = unitPrice(item, cfg);
    const total_price = round4(unit_price * qty);
    const unit_wac = wacFor(item.id, finId);
    const margin_pct = item.custom_margin != null ? num(item.custom_margin) : num(cfg.MARGIN_DEF);
    const unit_margin = round4(unit_wac * (margin_pct / 100));
    const now = new Date().toISOString();

    let remaining = 0;
    db.transaction(() => {
      db.prepare(`
        INSERT INTO stock_move (item_id, warehouse_id, qty, unit_cost, trans_date, created_at, note)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(item.id, finId, -qty, unit_wac, now, now, 'Sale order');

      let ic = db.prepare(
        'SELECT * FROM item_cost WHERE item_id = ? AND warehouse_id = ?'
      ).get(item.id, finId);
      if (!ic) {
        db.prepare(
          'INSERT INTO item_cost (item_id, warehouse_id, wac, qty_on_hand, created_at) VALUES (?, ?, ?, 0, ?)'
        ).run(item.id, finId, unit_wac, now);
        ic = db.prepare(
          'SELECT * FROM item_cost WHERE item_id = ? AND warehouse_id = ?'
        ).get(item.id, finId);
      }
      remaining = num(ic.qty_on_hand) - qty;
      db.prepare(
        'UPDATE item_cost SET qty_on_hand = ?, updated_at = ? WHERE item_id = ? AND warehouse_id = ?'
      ).run(remaining, now, item.id, finId);

      db.prepare(`
        INSERT INTO sales_order
          (item_id, sku, item_name, qty, unit_price, total_price, unit_margin, unit_cost, sale_date, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(item.id, item.sku, item.name, qty, unit_price, total_price, unit_margin, unit_wac, now, now);
    })();

    res.status(201).json({
      item_id: item.id,
      sku: item.sku,
      qty,
      unit_price,
      total_price,
      remaining_qty: remaining,
      unit_margin,
    });
  });

  router.get('/sales/orders/report', (req, res) => {
    try {
      const startDt = parseDate(req.query.start_date);
      const endDt = parseDate(req.query.end_date, true);
      if (startDt && endDt && startDt > endDt) {
        return res.status(400).json({ error: 'start_date must be <= end_date' });
      }
      const fmt = String(req.query.format || '').toLowerCase();
      if (fmt === 'csv' || fmt === 'pdf') {
        const data = buildHistory(startDt, endDt, null, null);
        if (fmt === 'csv') {
          const header = 'sale_date,sku,item_name,qty,unit_price,total_price,unit_margin,unit_cost\n';
          const csvCell = value => `"${String(value ?? '').replace(/"/g, '""')}"`;
          const body = data.items.map(r => [
            r.sale_date, r.sku, r.item_name || '', r.qty.toFixed(4), r.unit_price.toFixed(4),
            r.total_price.toFixed(4), r.unit_margin.toFixed(4), r.unit_cost.toFixed(4),
          ].map(csvCell).join(',')).join('\n');
          res.setHeader('Content-Type', 'text/csv');
          res.setHeader('Content-Disposition', 'attachment; filename=sales_report.csv');
          return res.send(header + body + '\n');
        }
        const buf = buildSalesReportPdf({
          title: 'Sales Report',
          subtitle: `Range: ${req.query.start_date || '-'} to ${req.query.end_date || '-'}`,
          summary: `Rows: ${data.items.length}  |  Revenue: $${data.total_revenue.toFixed(2)}  |  Margin: $${data.total_margin.toFixed(2)}`,
          rows: data.items,
        });
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', 'attachment; filename=sales_report.pdf');
        return res.send(buf);
      }
      const page = Math.max(parseInt(req.query.page || '1', 10), 1);
      const limit = Math.min(Math.max(parseInt(req.query.limit || '25', 10), 1), 200);
      res.json(buildHistory(startDt, endDt, page, limit));
    } catch (e) {
      res.status(e.status || 500).json({ error: e.message });
    }
  });

  // ---------- Shopfloor postings queue ----------
  router.get('/postings', (req, res) => {
    try {
      const status = req.query.status || null;
      const limit = req.query.limit || '200';
      res.json(listPostings(db, { status, limit }));
    } catch (e) {
      res.status(e.status || 500).json({ error: e.message });
    }
  });

  router.get('/postings/:id', (req, res) => {
    try {
      res.json(previewPosting(db, req.params.id));
    } catch (e) {
      res.status(e.status || 500).json({ error: e.message });
    }
  });

  router.post('/postings/:id/confirm', (req, res) => {
    try {
      const acknowledge_shortage = !!(req.body || {}).acknowledge_shortage;
      const out = confirmPosting(db, req.params.id, { acknowledge_shortage });
      res.json(out);
    } catch (e) {
      const status = e.status || 500;
      const body = e.body ? { error: e.message, ...e.body } : { error: e.message };
      res.status(status).json(body);
    }
  });

  router.post('/postings/:id/dismiss', (req, res) => {
    try {
      const note = (req.body || {}).note || null;
      res.json(dismissPosting(db, req.params.id, note));
    } catch (e) {
      res.status(e.status || 500).json({ error: e.message });
    }
  });

  // Internal helper exposure for bridge (same process)
  router._recordShopfloorPosting = (opts) => recordShopfloorPosting(db, opts);

  return router;
}

module.exports = { mountErp };
