/**
 * ERP costing helpers (parity with Acres Python sales/bom/mfg cost paths).
 */
function num(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function round4(n) {
  return Math.round(num(n) * 10000) / 10000;
}

function uomFactors(db) {
  const map = {};
  for (const u of db.prepare('SELECT code, factor_to_base FROM uom').all()) {
    map[u.code] = num(u.factor_to_base);
  }
  return map;
}

/** Convert unit cost from fromUom to toUom using factor_to_base. */
function convertUnitCost(cost, fromUom, toUom, factors) {
  if (!fromUom || !toUom || fromUom === toUom) return num(cost);
  const fFrom = factors[fromUom] || 0;
  const fTo = factors[toUom] || 0;
  if (fFrom <= 0 || fTo <= 0) return num(cost);
  return num(cost) * (fTo / fFrom);
}

/** Convert quantity from fromUom to toUom (same physical magnitude). */
function convertQty(qty, fromUom, toUom, factors) {
  if (!fromUom || !toUom || fromUom === toUom) return num(qty);
  const fFrom = factors[fromUom] || 0;
  const fTo = factors[toUom] || 0;
  if (fFrom <= 0 || fTo <= 0) return num(qty);
  return num(qty) * (fFrom / fTo);
}

function looksLikeRaw(code) {
  const c = (code || '').toLowerCase();
  if (!c) return false;
  return /^(raw(_?mat)?|rm|raw[-\s]?materials?|materia\s*prima|mp)/.test(c);
}

function electricityPricePerKwh(db) {
  const r = db.prepare("SELECT value FROM pricing_config WHERE code = 'ELEC_KWH'").get();
  return num(r?.value);
}

/**
 * Effective machine USD/h.
 * manual: stored hourly_rate
 * calculated: maintenance_rate + power_kw * electricity USD/kWh
 */
function effectiveHourlyRate(row, elecPrice = null) {
  if (!row) return 0;
  const mode = String(row.rate_mode || 'manual').toLowerCase();
  if (mode === 'calculated') {
    const elec = elecPrice == null ? 0 : num(elecPrice);
    return round4(num(row.maintenance_rate) + num(row.power_kw) * elec);
  }
  return round4(num(row.hourly_rate));
}

function laborRate(db) {
  const r = db.prepare("SELECT * FROM machine WHERE machine = 'LABOR'").get();
  return effectiveHourlyRate(r, electricityPricePerKwh(db));
}

function machineRate(db, name) {
  if (!name) return 0;
  const r = db.prepare(
    'SELECT * FROM machine WHERE lower(machine) = lower(?)'
  ).get(name);
  return effectiveHourlyRate(r, electricityPricePerKwh(db));
}

/** Persist computed hourly_rate for all calculated-mode machines (after ELEC_KWH change). */
function recomputeCalculatedMachineRates(db) {
  const elec = electricityPricePerKwh(db);
  const now = new Date().toISOString();
  const rows = db.prepare(
    "SELECT id, maintenance_rate, power_kw FROM machine WHERE lower(COALESCE(rate_mode, 'manual')) = 'calculated'"
  ).all();
  const upd = db.prepare(
    'UPDATE machine SET hourly_rate = ?, needs_erp_data = ?, updated_at = ? WHERE id = ?'
  );
  for (const r of rows) {
    const rate = round4(num(r.maintenance_rate) + num(r.power_kw) * elec);
    upd.run(rate, rate > 0 ? 0 : 1, now, r.id);
  }
  return { updated: rows.length, electricity_price_per_kwh: elec };
}

function avgWacForRaw(db, itemId) {
  const warehouses = db.prepare('SELECT id, code FROM warehouse').all();
  const rawIds = new Set(
    warehouses.filter(w => looksLikeRaw(w.code)).map(w => w.id)
  );
  const rows = db.prepare(`
    SELECT warehouse_id,
           COALESCE(SUM(qty), 0) AS qty,
           COALESCE(SUM(qty * unit_cost), 0) AS tcost
    FROM stock_move
    WHERE item_id = ?
    GROUP BY warehouse_id
  `).all(itemId);

  let totalQty = 0;
  let totalUnitXQty = 0;
  for (const r of rows) {
    const wh = warehouses.find(w => w.id === r.warehouse_id);
    const code = (wh?.code || '').toLowerCase();
    if (rawIds.size > 0) {
      if (!rawIds.has(r.warehouse_id)) continue;
    } else if (!looksLikeRaw(code)) {
      continue;
    }
    const qty = num(r.qty);
    if (qty <= 0) continue;
    const wacRow = num(r.tcost) / qty;
    totalQty += qty;
    totalUnitXQty += wacRow * qty;
  }
  return totalQty > 0 ? totalUnitXQty / totalQty : 0;
}

function mfgComponentUnitCost(db, mfg, factors) {
  const raw = db.prepare('SELECT * FROM item WHERE id = ?').get(mfg.raw_item_id);
  let mat = 0;
  if (raw) {
    const rawIc = db.prepare('SELECT wac FROM item_cost WHERE item_id = ? LIMIT 1').get(raw.id);
    const rawWac = num(rawIc?.wac);
    const rawWacDisplay = convertUnitCost(
      rawWac, raw.purchase_uom_code, raw.display_uom_code, factors
    );
    mat = rawWacDisplay * num(mfg.raw_qty_per_unit) * (1 + num(mfg.scrap_pct) / 100);
  }
  const rate = machineRate(db, mfg.machine);
  const time = (num(mfg.std_minutes) / 60) * rate;
  return mat + time;
}

function componentUnitCost(db, component, factors, warehouseId = null) {
  let ic;
  if (warehouseId) {
    ic = db.prepare(
      'SELECT wac FROM item_cost WHERE item_id = ? AND warehouse_id = ?'
    ).get(component.id, warehouseId);
  } else {
    ic = db.prepare('SELECT wac FROM item_cost WHERE item_id = ? LIMIT 1').get(component.id);
  }
  let unitCost = num(ic?.wac);
  let is_estimate = false;
  if (unitCost === 0) {
    const mfg = db.prepare('SELECT * FROM mfg_component WHERE sku = ?').get(component.sku);
    if (mfg) {
      unitCost = mfgComponentUnitCost(db, mfg, factors);
      is_estimate = true;
    }
  }
  return { unitCost, is_estimate };
}

/**
 * Full BOM cost for an item (material with WAC / MFG_COMP fallback + labor).
 * Matches Acres sales._bom_cost / bom.calculate-cost.
 */
function bomCostForItem(db, itemId, warehouseId = null) {
  const bom = db.prepare('SELECT * FROM bom WHERE item_id = ?').get(itemId);
  if (!bom) return 0;
  const factors = uomFactors(db);
  const lines = db.prepare('SELECT * FROM bom_line WHERE bom_id = ?').all(bom.id);
  let material = 0;
  for (const ln of lines) {
    const component = db.prepare('SELECT * FROM item WHERE id = ?').get(ln.component_item_id);
    if (!component) continue;
    const { unitCost } = componentUnitCost(db, component, factors, warehouseId);
    material += num(ln.qty) * unitCost;
  }
  const laborHours = num(bom.labor_hours_per_unit);
  const labor = laborHours * laborRate(db);
  return round4(material + labor);
}

function calculateBomCostDetail(db, bomId, warehouseId = null) {
  const bom = db.prepare('SELECT * FROM bom WHERE id = ?').get(bomId);
  if (!bom) return null;
  const factors = uomFactors(db);
  const lines = db.prepare('SELECT * FROM bom_line WHERE bom_id = ?').all(bom.id);
  let material_cost = 0;
  const line_costs = [];
  for (const ln of lines) {
    const component = db.prepare('SELECT * FROM item WHERE id = ?').get(ln.component_item_id);
    if (!component) continue;
    const { unitCost, is_estimate } = componentUnitCost(db, component, factors, warehouseId);
    const subtotal = num(ln.qty) * unitCost;
    material_cost += subtotal;
    line_costs.push({
      line_id: ln.id,
      component_item_id: ln.component_item_id,
      sku: component.sku,
      name: component.name,
      qty: num(ln.qty),
      unit_cost: round4(unitCost),
      subtotal: round4(subtotal),
      is_estimate: !!is_estimate,
    });
  }
  const labor_hours = num(bom.labor_hours_per_unit);
  const labor_rate = laborRate(db);
  const labor_cost = labor_hours * labor_rate;
  return {
    bom_id: bom.id,
    material_cost: round4(material_cost),
    labor_cost: round4(labor_cost),
    total_cost: round4(material_cost + labor_cost),
    labor_hours,
    labor_rate,
    lines: line_costs,
  };
}

function calculateComponentCost(db, payload) {
  const raw_sku = String(payload.raw_sku || '').trim();
  if (!raw_sku) {
    const err = new Error('raw_sku is required');
    err.status = 400;
    throw err;
  }
  const item = db.prepare('SELECT * FROM item WHERE sku = ?').get(raw_sku);
  if (!item) {
    const err = new Error(`SKU ${raw_sku} not found`);
    err.status = 404;
    throw err;
  }
  const factors = uomFactors(db);
  const unit_cost_source = avgWacForRaw(db, item.id);
  const unit_cost_display = convertUnitCost(
    unit_cost_source, item.purchase_uom_code, item.display_uom_code, factors
  );
  const raw_qty_per_unit = num(payload.raw_qty_per_unit);
  const scrap_pct = num(payload.scrap_pct);
  const std_minutes = num(payload.std_minutes);
  const machine = payload.machine || null;
  const material_cost_per_unit = unit_cost_display * raw_qty_per_unit * (1 + scrap_pct / 100);
  const time_cost_per_unit = (std_minutes / 60) * machineRate(db, machine);
  return {
    raw_sku,
    raw_qty_per_unit,
    scrap_pct,
    std_minutes,
    machine,
    unit_cost_source: round4(unit_cost_source),
    unit_cost_display: round4(unit_cost_display),
    material_cost_per_unit: round4(material_cost_per_unit),
    time_cost_per_unit: round4(time_cost_per_unit),
  };
}

function pricingNumbers(item, cfg, cost) {
  const margin_pct = item.custom_margin != null ? num(item.custom_margin) : num(cfg.MARGIN_DEF);
  const ads_pct = item.custom_ads != null ? num(item.custom_ads) : num(cfg.ADDS_PCT);
  const fee_pct = item.custom_fee != null ? num(item.custom_fee) : num(cfg.EBAY_FEE);
  const margin_value = round4(cost * margin_pct / 100);
  const selling_price = round4(
    cost * (1 + margin_pct / 100) * (1 + ads_pct / 100) * (1 + fee_pct / 100)
  );
  const fees_usd = round4(selling_price - (cost + margin_value));
  return { margin_pct, ads_pct, fee_pct, margin_value, selling_price, fees_usd };
}

function configMap(db) {
  return Object.fromEntries(
    db.prepare('SELECT code, value FROM pricing_config').all().map(r => [r.code, num(r.value)])
  );
}

function finWarehouseId(db) {
  const w = db.prepare(
    "SELECT id FROM warehouse WHERE lower(code) IN ('fin_good', 'fin_goods')"
  ).get();
  return w?.id || null;
}

function whIdByCode(db, code) {
  const w = db.prepare('SELECT id FROM warehouse WHERE lower(code) = lower(?)').get(code);
  return w?.id || null;
}

module.exports = {
  num,
  round4,
  uomFactors,
  convertUnitCost,
  convertQty,
  electricityPricePerKwh,
  effectiveHourlyRate,
  laborRate,
  machineRate,
  recomputeCalculatedMachineRates,
  avgWacForRaw,
  bomCostForItem,
  calculateBomCostDetail,
  calculateComponentCost,
  pricingNumbers,
  configMap,
  finWarehouseId,
  whIdByCode,
};
