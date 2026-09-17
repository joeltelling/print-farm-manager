/**
 * ERP analytics reports that cross shopfloor telemetry with costing / sales.
 */
const {
  num,
  round4,
  pricingNumbers,
  configMap,
  bomCostForItem,
  machineRate,
} = require('./costing');

function costVarianceReport(db, { days = 90 } = {}) {
  const since = Date.now() - Math.max(1, Number(days) || 90) * 24 * 60 * 60 * 1000;
  const postings = db.prepare(`
    SELECT * FROM erp_posting
    WHERE status = 'posted' AND COALESCE(posted_at, created_at) >= ?
    ORDER BY posted_at DESC
  `).all(since);

  const bySku = new Map();
  for (const p of postings) {
    const sku = p.erp_sku || '(none)';
    if (!bySku.has(sku)) {
      bySku.set(sku, {
        erp_sku: sku,
        postings: 0,
        qty: 0,
        std_minutes_total: 0,
        actual_minutes_total: 0,
        actual_grams_total: 0,
        actual_energy_kwh_total: 0,
        std_cost_total: 0,
        actual_cost_total: 0,
        measured_count: 0,
      });
    }
    const row = bySku.get(sku);
    const qty = num(p.qty);
    row.postings += 1;
    row.qty += qty;
    row.actual_minutes_total += num(p.actual_minutes);
    row.actual_grams_total += num(p.actual_grams);
    row.actual_energy_kwh_total += num(p.actual_energy_kwh);
    row.std_cost_total += num(p.std_unit_cost) * qty;
    row.actual_cost_total += num(p.actual_unit_cost != null ? p.actual_unit_cost : p.std_unit_cost) * qty;
    if (p.telemetry_quality === 'measured') row.measured_count += 1;

    const mfg = db.prepare('SELECT std_minutes FROM mfg_component WHERE sku = ?').get(sku);
    if (mfg) row.std_minutes_total += num(mfg.std_minutes) * qty;
  }

  // Failed-job grams for scrap suggestion
  const failedBySku = db.prepare(`
    SELECT parts.erp_sku AS sku,
      COALESCE(SUM(jobs.material_grams_actual), 0) AS failed_grams,
      COALESCE(SUM(CASE WHEN jobs.status = 'finished' THEN jobs.material_grams_actual ELSE 0 END), 0) AS ok_grams
    FROM jobs
    JOIN parts ON parts.id = jobs.part_id
    WHERE parts.erp_sku IS NOT NULL
      AND COALESCE(jobs.finished_at, jobs.started_at, jobs.created_at) >= ?
    GROUP BY parts.erp_sku
  `).all(since);
  const scrapMap = Object.fromEntries(failedBySku.map(r => {
    const failed = num(r.failed_grams);
    // Re-query failed only
    const failOnly = db.prepare(`
      SELECT COALESCE(SUM(jobs.material_grams_actual), 0) AS g
      FROM jobs JOIN parts ON parts.id = jobs.part_id
      WHERE parts.erp_sku = ? AND jobs.status IN ('failed', 'cancelled')
        AND COALESCE(jobs.finished_at, jobs.started_at, jobs.created_at) >= ?
    `).get(r.sku, since);
    const failG = num(failOnly?.g);
    const okG = num(r.ok_grams);
    const total = failG + okG;
    return [r.sku, total > 0 ? round4((failG / total) * 100) : 0];
  }));

  const rows = [...bySku.values()].map(r => {
    const suggestedStd = r.qty > 0 ? round4(r.actual_minutes_total / r.qty) : null;
    const varianceUsd = round4(r.actual_cost_total - r.std_cost_total);
    return {
      ...r,
      qty: round4(r.qty),
      std_minutes_total: round4(r.std_minutes_total),
      actual_minutes_total: round4(r.actual_minutes_total),
      actual_grams_total: round4(r.actual_grams_total),
      actual_energy_kwh_total: round4(r.actual_energy_kwh_total),
      std_cost_total: round4(r.std_cost_total),
      actual_cost_total: round4(r.actual_cost_total),
      variance_usd: varianceUsd,
      suggested_std_minutes: suggestedStd,
      suggested_scrap_pct: scrapMap[r.erp_sku] ?? null,
    };
  });

  rows.sort((a, b) => Math.abs(b.variance_usd) - Math.abs(a.variance_usd));
  return { days: Number(days) || 90, since, rows };
}

function profitabilityReport(db, { days = 90 } = {}) {
  const since = Date.now() - Math.max(1, Number(days) || 90) * 24 * 60 * 60 * 1000;
  const cfg = configMap(db);

  const projects = db.prepare(`
    SELECT projects.id, projects.name,
      COALESCE(SUM(CASE WHEN jobs.status = 'finished' THEN jobs.parts_per_plate ELSE 0 END), 0) AS pieces,
      COALESCE(SUM(jobs.printing_seconds), 0) AS printing_seconds,
      COALESCE(SUM(jobs.energy_kwh), 0) AS energy_kwh,
      COALESCE(SUM(jobs.material_grams_actual), 0) AS material_grams,
      COALESCE(SUM(CASE WHEN jobs.status IN ('failed','cancelled') THEN jobs.printing_seconds ELSE 0 END), 0) AS failed_seconds,
      COALESCE(SUM(CASE WHEN jobs.status IN ('failed','cancelled') THEN jobs.material_grams_actual ELSE 0 END), 0) AS failed_grams
    FROM projects
    LEFT JOIN parts ON parts.project_id = projects.id
    LEFT JOIN jobs ON jobs.part_id = parts.id
      AND COALESCE(jobs.finished_at, jobs.started_at, jobs.created_at) >= ?
    GROUP BY projects.id
    HAVING pieces > 0 OR printing_seconds > 0
    ORDER BY projects.name
  `).all(since);

  const rows = projects.map(p => {
    const item = db.prepare(
      "SELECT * FROM item WHERE project_id = ? AND item_role = 'product' LIMIT 1"
    ).get(p.id);
    let unitCost = 0;
    let selling = 0;
    if (item) {
      unitCost = bomCostForItem(db, item.id);
      const pn = pricingNumbers(item, cfg, unitCost);
      selling = pn.selling_price;
    }

    // Prefer actual posting costs when available for components of this project
    const actual = db.prepare(`
      SELECT COALESCE(SUM(
        COALESCE(erp_posting.actual_unit_cost, erp_posting.std_unit_cost, 0) * erp_posting.qty
      ), 0) AS cost
      FROM erp_posting
      JOIN parts ON parts.id = erp_posting.part_id
      WHERE parts.project_id = ? AND erp_posting.status = 'posted'
        AND COALESCE(erp_posting.posted_at, erp_posting.created_at) >= ?
    `).get(p.id, since);

    const pieces = num(p.pieces);
    const machineHours = num(p.printing_seconds) / 3600;
    const actualCostTotal = num(actual?.cost) || (unitCost * pieces);
    const revenue = selling * pieces;
    const margin = revenue - actualCostTotal;

    return {
      project_id: p.id,
      project_name: p.name,
      product_sku: item?.sku || null,
      pieces,
      machine_hours: round4(machineHours),
      energy_kwh: round4(num(p.energy_kwh)),
      material_grams: round4(num(p.material_grams)),
      failed_hours: round4(num(p.failed_seconds) / 3600),
      failed_grams: round4(num(p.failed_grams)),
      unit_cost_std: round4(unitCost),
      unit_cost_actual: pieces > 0 ? round4(actualCostTotal / pieces) : null,
      selling_price: round4(selling),
      revenue: round4(revenue),
      cost_total: round4(actualCostTotal),
      margin_usd: round4(margin),
      margin_pct: revenue > 0 ? round4((margin / revenue) * 100) : null,
    };
  });

  return { days: Number(days) || 90, since, rows };
}

function machineOeeReport(db, { days = 30 } = {}) {
  const windowMs = Math.max(1, Number(days) || 30) * 24 * 60 * 60 * 1000;
  const since = Date.now() - windowMs;
  const now = Date.now();

  const printers = db.prepare('SELECT id, name FROM printers WHERE is_active = 1').all();
  const rows = printers.map(pr => {
    const hist = db.prepare(`
      SELECT status,
        SUM(COALESCE(duration_ms,
          CASE WHEN ended_at IS NULL THEN (? - started_at) ELSE 0 END
        )) AS ms
      FROM printer_status_history
      WHERE printer_id = ? AND started_at >= ?
      GROUP BY status
    `).all(now, pr.id, since);

    const byStatus = {};
    let totalMs = 0;
    for (const h of hist) {
      byStatus[h.status] = num(h.ms);
      totalMs += num(h.ms);
    }
    const printingMs = byStatus.PRINTING || 0;
    const availDenom = totalMs - (byStatus.OFFLINE || 0);
    const availability = availDenom > 0 ? printingMs / availDenom : 0;

    const jobStats = db.prepare(`
      SELECT
        SUM(CASE WHEN status = 'finished' THEN 1 ELSE 0 END) AS finished,
        SUM(CASE WHEN status IN ('failed','cancelled') THEN 1 ELSE 0 END) AS failed,
        COALESCE(SUM(printing_seconds), 0) AS printing_seconds,
        COALESCE(SUM(energy_kwh), 0) AS energy_kwh
      FROM jobs
      WHERE printer_id = ? AND COALESCE(finished_at, started_at, created_at) >= ?
    `).get(pr.id, since);

    const finished = num(jobStats?.finished);
    const failed = num(jobStats?.failed);
    const quality = (finished + failed) > 0 ? finished / (finished + failed) : 0;
    // Performance proxy: measured printing time vs wall window of printing status
    const performance = printingMs > 0
      ? Math.min(1, (num(jobStats?.printing_seconds) * 1000) / printingMs)
      : 0;
    const oee = availability * performance * quality;

    const machine = db.prepare('SELECT * FROM machine WHERE printer_id = ? LIMIT 1').get(pr.id);
    const configuredRate = machine ? machineRate(db, machine.machine) : 0;
    const hours = num(jobStats?.printing_seconds) / 3600;
    const postingCost = db.prepare(`
      SELECT COALESCE(SUM(
        COALESCE(actual_unit_cost, std_unit_cost, 0) * qty
      ), 0) AS cost
      FROM erp_posting
      WHERE printer_id = ? AND status = 'posted'
        AND COALESCE(posted_at, created_at) >= ?
    `).get(pr.id, since);
    const costTotal = num(postingCost?.cost);
    const actualRate = hours > 0 ? costTotal / hours : null;

    return {
      printer_id: pr.id,
      printer_name: pr.name,
      machine_name: machine?.machine || null,
      availability_pct: round4(availability * 100),
      performance_pct: round4(performance * 100),
      quality_pct: round4(quality * 100),
      oee_pct: round4(oee * 100),
      printing_hours: round4(hours),
      energy_kwh: round4(num(jobStats?.energy_kwh)),
      jobs_finished: finished,
      jobs_failed: failed,
      configured_hourly_rate: round4(configuredRate),
      actual_cost_per_hour: actualRate != null ? round4(actualRate) : null,
      cost_total: round4(costTotal),
      by_status_ms: byStatus,
    };
  });

  rows.sort((a, b) => b.oee_pct - a.oee_pct);
  return { days: Number(days) || 30, since, rows };
}

module.exports = {
  costVarianceReport,
  profitabilityReport,
  machineOeeReport,
};
