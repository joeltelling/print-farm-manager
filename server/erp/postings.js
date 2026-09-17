/**
 * Shopfloor → ERP posting queue.
 * Set Ready (and bridge) create pending rows; operators confirm stock moves in ERP.
 * Never touches parts.completed_qty.
 */
const {
  num,
  round4,
  uomFactors,
  convertQty,
  convertUnitCost,
  machineRate,
  avgWacForRaw,
  whIdByCode,
} = require('./costing');

function ensurePostingTable(db) {
  db.exec(`
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
}

function postingOut(row) {
  if (!row) return null;
  let shortage = null;
  if (row.shortage_json) {
    try { shortage = JSON.parse(row.shortage_json); } catch (_) { shortage = null; }
  }
  return {
    id: row.id,
    job_id: row.job_id,
    part_id: row.part_id,
    printer_id: row.printer_id,
    erp_sku: row.erp_sku,
    qty: num(row.qty),
    status: row.status,
    created_at: row.created_at,
    posted_at: row.posted_at,
    stock_move_id: row.stock_move_id,
    note: row.note,
    shortage,
  };
}

/**
 * Resolve SKU from part.erp_sku or linked item.part_id.
 */
function resolveErpSku(db, partId, explicitSku) {
  if (explicitSku) return String(explicitSku).trim();
  if (partId == null) return null;
  try {
    const part = db.prepare('SELECT id, name, erp_sku FROM parts WHERE id = ?').get(partId);
    if (part?.erp_sku) return part.erp_sku;
    const linked = db.prepare(
      "SELECT sku FROM item WHERE part_id = ? AND item_role = 'component' LIMIT 1"
    ).get(partId);
    return linked?.sku || null;
  } catch (_) {
    return null;
  }
}

/**
 * Idempotent insert: one pending/posted row per job_id.
 * Returns { posting, created }.
 */
function recordShopfloorPosting(db, opts = {}) {
  ensurePostingTable(db);
  const qty = num(opts.qty);
  if (!Number.isFinite(qty) || qty < 0) {
    const err = new Error('qty must be a non-negative number');
    err.status = 400;
    throw err;
  }
  const job_id = opts.job_id != null ? Number(opts.job_id) : null;
  const part_id = opts.part_id != null ? Number(opts.part_id) : null;
  const printer_id = opts.printer_id != null ? Number(opts.printer_id) : null;
  const erp_sku = resolveErpSku(db, part_id, opts.sku || opts.erp_sku);
  const now = Date.now();
  const note = opts.note || null;

  if (job_id != null) {
    const existing = db.prepare('SELECT * FROM erp_posting WHERE job_id = ?').get(job_id);
    if (existing) {
      // Allow qty refresh while still pending (operator adjusted confirmed_qty)
      if (existing.status === 'pending' && num(existing.qty) !== qty) {
        db.prepare('UPDATE erp_posting SET qty = ?, erp_sku = COALESCE(?, erp_sku), note = COALESCE(?, note) WHERE id = ?')
          .run(qty, erp_sku, note, existing.id);
        return { posting: postingOut(db.prepare('SELECT * FROM erp_posting WHERE id = ?').get(existing.id)), created: false };
      }
      return { posting: postingOut(existing), created: false };
    }
  }

  const r = db.prepare(`
    INSERT INTO erp_posting (job_id, part_id, printer_id, erp_sku, qty, status, created_at, note)
    VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)
  `).run(job_id, part_id, printer_id, erp_sku, qty, now, note);

  return {
    posting: postingOut(db.prepare('SELECT * FROM erp_posting WHERE id = ?').get(r.lastInsertRowid)),
    created: true,
  };
}

function stockAvailable(db, item_id, warehouse_id) {
  const r = db.prepare(
    'SELECT COALESCE(SUM(qty), 0) AS qty FROM stock_move WHERE item_id = ? AND warehouse_id = ?'
  ).get(item_id, warehouse_id);
  return num(r?.qty);
}

/**
 * Build issue plan for confirming a component posting (mirrors WO complete for one SKU).
 */
function buildIssuePlan(db, erp_sku, qty) {
  if (!erp_sku) {
    return { error: 'No ERP SKU linked to this posting', missing: [], plan: null, item: null };
  }
  const item = db.prepare('SELECT * FROM item WHERE sku = ?').get(erp_sku);
  if (!item) {
    return { error: `Item SKU ${erp_sku} not found`, missing: [], plan: null, item: null };
  }
  const factors = uomFactors(db);
  const comp_wh_id = whIdByCode(db, 'comp');
  if (!comp_wh_id) {
    return { error: "Warehouse 'comp' not found", missing: [], plan: null, item };
  }
  const mfg = db.prepare('SELECT * FROM mfg_component WHERE sku = ?').get(erp_sku);
  const missing = [];
  const plan = { issues: [], receive: null, unit_cost: 0 };

  if (mfg) {
    const raw = db.prepare('SELECT * FROM item WHERE id = ?').get(mfg.raw_item_id);
    if (!raw) {
      return { error: `Raw item missing for component ${erp_sku}`, missing: [], plan: null, item };
    }
    const raw_wh = raw.warehouse_id || whIdByCode(db, 'raw') || comp_wh_id;
    let reqDisplay = qty * num(mfg.raw_qty_per_unit);
    if (num(mfg.scrap_pct)) reqDisplay *= (1 + num(mfg.scrap_pct) / 100);
    const reqStock = convertQty(reqDisplay, raw.display_uom_code, raw.purchase_uom_code, factors);
    const avail = stockAvailable(db, raw.id, raw_wh);
    if (avail + 1e-9 < reqStock) {
      missing.push({
        item_id: raw.id, sku: raw.sku, name: raw.name,
        required: round4(reqStock), available: round4(avail), component_sku: erp_sku,
      });
    }
    const rawWac = avgWacForRaw(db, raw.id) || (() => {
      const ic = db.prepare('SELECT wac FROM item_cost WHERE item_id = ? LIMIT 1').get(raw.id);
      return num(ic?.wac);
    })();
    const rawWacDisplay = convertUnitCost(rawWac, raw.purchase_uom_code, raw.display_uom_code, factors);
    const matPerUnit = rawWacDisplay * num(mfg.raw_qty_per_unit) * (1 + num(mfg.scrap_pct) / 100);
    const timePerUnit = (num(mfg.std_minutes) / 60) * machineRate(db, mfg.machine);
    plan.unit_cost = round4(matPerUnit + timePerUnit);
    plan.issues.push({
      item_id: raw.id,
      warehouse_id: raw_wh,
      qty: reqStock,
      unit_wac: rawWac,
      component_sku: erp_sku,
    });
  } else {
    // No recipe: receive component only (outsource / purchased), no material issue
    const ic = db.prepare(
      'SELECT wac FROM item_cost WHERE item_id = ? AND warehouse_id = ?'
    ).get(item.id, comp_wh_id);
    plan.unit_cost = round4(num(ic?.wac));
  }

  plan.receive = {
    item_id: item.id,
    warehouse_id: item.warehouse_id || comp_wh_id,
    qty,
    unit_cost: plan.unit_cost,
  };

  return { error: null, missing, plan, item };
}

function applyIssuePlan(db, posting, plan) {
  const nowIso = new Date().toISOString();
  const nowMs = Date.now();
  let lastMoveId = null;
  const idemBase = `erp-posting-${posting.id}`;

  for (const issue of plan.issues) {
    const key = `${idemBase}-issue-${issue.item_id}`;
    const existing = db.prepare('SELECT id FROM stock_move WHERE idem_key = ?').get(key);
    if (existing) {
      lastMoveId = existing.id;
      continue;
    }
    const r = db.prepare(`
      INSERT INTO stock_move (item_id, warehouse_id, qty, unit_cost, note, created_at, trans_date, idem_key)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      issue.item_id, issue.warehouse_id, -issue.qty, issue.unit_wac,
      `posting #${posting.id} issue`, nowIso, nowIso, key
    );
    lastMoveId = r.lastInsertRowid;
    const ic = db.prepare(
      'SELECT * FROM item_cost WHERE item_id = ? AND warehouse_id = ?'
    ).get(issue.item_id, issue.warehouse_id);
    if (ic) {
      const nextQty = num(ic.qty_on_hand) - issue.qty; // may go negative when shortage ack'd
      db.prepare(
        'UPDATE item_cost SET qty_on_hand = ?, updated_at = ? WHERE item_id = ? AND warehouse_id = ?'
      ).run(nextQty, nowIso, issue.item_id, issue.warehouse_id);
    }
  }

  if (plan.receive) {
    const key = `${idemBase}-recv`;
    const existing = db.prepare('SELECT id FROM stock_move WHERE idem_key = ?').get(key);
    if (existing) {
      lastMoveId = existing.id;
    } else {
      const r = db.prepare(`
        INSERT INTO stock_move (item_id, warehouse_id, qty, unit_cost, note, created_at, trans_date, idem_key)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        plan.receive.item_id, plan.receive.warehouse_id, plan.receive.qty, plan.receive.unit_cost,
        `posting #${posting.id} receive`, nowIso, nowIso, key
      );
      lastMoveId = r.lastInsertRowid;

      let ic = db.prepare(
        'SELECT * FROM item_cost WHERE item_id = ? AND warehouse_id = ?'
      ).get(plan.receive.item_id, plan.receive.warehouse_id);
      if (!ic) {
        db.prepare(
          'INSERT INTO item_cost (item_id, warehouse_id, wac, qty_on_hand, created_at) VALUES (?, ?, ?, 0, ?)'
        ).run(plan.receive.item_id, plan.receive.warehouse_id, plan.receive.unit_cost, nowIso);
        ic = db.prepare(
          'SELECT * FROM item_cost WHERE item_id = ? AND warehouse_id = ?'
        ).get(plan.receive.item_id, plan.receive.warehouse_id);
      }
      const q0 = num(ic.qty_on_hand);
      const w0 = num(ic.wac);
      const q1 = q0 + plan.receive.qty;
      const w1 = q1 > 0 ? ((q0 * w0) + (plan.receive.qty * plan.receive.unit_cost)) / q1 : plan.receive.unit_cost;
      db.prepare(
        'UPDATE item_cost SET qty_on_hand = ?, wac = ?, updated_at = ? WHERE item_id = ? AND warehouse_id = ?'
      ).run(q1, w1, nowIso, plan.receive.item_id, plan.receive.warehouse_id);
    }
  }

  db.prepare(`
    UPDATE erp_posting
    SET status = 'posted', posted_at = ?, stock_move_id = ?, shortage_json = NULL
    WHERE id = ?
  `).run(nowMs, lastMoveId, posting.id);

  return postingOut(db.prepare('SELECT * FROM erp_posting WHERE id = ?').get(posting.id));
}

function previewPosting(db, id) {
  ensurePostingTable(db);
  const row = db.prepare('SELECT * FROM erp_posting WHERE id = ?').get(id);
  if (!row) {
    const err = new Error('Posting not found');
    err.status = 404;
    throw err;
  }
  const built = buildIssuePlan(db, row.erp_sku, num(row.qty));
  return {
    posting: postingOut(row),
    missing: built.missing,
    error: built.error,
    unit_cost: built.plan?.unit_cost ?? null,
    item: built.item ? { id: built.item.id, sku: built.item.sku, name: built.item.name } : null,
  };
}

function confirmPosting(db, id, opts = {}) {
  ensurePostingTable(db);
  const row = db.prepare('SELECT * FROM erp_posting WHERE id = ?').get(id);
  if (!row) {
    const err = new Error('Posting not found');
    err.status = 404;
    throw err;
  }
  if (row.status === 'posted') {
    const err = new Error('Posting already confirmed');
    err.status = 409;
    throw err;
  }
  if (row.status === 'dismissed') {
    const err = new Error('Posting was dismissed');
    err.status = 409;
    throw err;
  }

  const built = buildIssuePlan(db, row.erp_sku, num(row.qty));
  if (built.error) {
    const err = new Error(built.error);
    err.status = 400;
    throw err;
  }
  if (built.missing.length && !opts.acknowledge_shortage) {
    db.prepare('UPDATE erp_posting SET shortage_json = ? WHERE id = ?')
      .run(JSON.stringify(built.missing), id);
    const err = new Error('Insufficient material stock');
    err.status = 409;
    err.body = { missing: built.missing, acknowledge_required: true };
    throw err;
  }

  let result;
  db.transaction(() => {
    // Re-check status inside transaction
    const fresh = db.prepare('SELECT * FROM erp_posting WHERE id = ?').get(id);
    if (fresh.status !== 'pending') {
      const err = new Error('Posting already confirmed');
      err.status = 409;
      throw err;
    }
    if (built.missing.length) {
      db.prepare('UPDATE erp_posting SET shortage_json = ?, note = COALESCE(note, ?) WHERE id = ?')
        .run(JSON.stringify(built.missing), 'confirmed with shortage ack', id);
    }
    result = applyIssuePlan(db, fresh, built.plan);
  })();
  return result;
}

function dismissPosting(db, id, note) {
  ensurePostingTable(db);
  const row = db.prepare('SELECT * FROM erp_posting WHERE id = ?').get(id);
  if (!row) {
    const err = new Error('Posting not found');
    err.status = 404;
    throw err;
  }
  if (row.status !== 'pending') {
    const err = new Error(`Cannot dismiss posting in status ${row.status}`);
    err.status = 409;
    throw err;
  }
  db.prepare(`
    UPDATE erp_posting SET status = 'dismissed', posted_at = ?, note = COALESCE(?, note)
    WHERE id = ?
  `).run(Date.now(), note || 'dismissed by operator', id);
  return postingOut(db.prepare('SELECT * FROM erp_posting WHERE id = ?').get(id));
}

function listPostings(db, opts = {}) {
  ensurePostingTable(db);
  const status = opts.status || null;
  const limit = Math.min(Math.max(parseInt(opts.limit || '200', 10), 1), 500);
  let rows;
  if (status) {
    rows = db.prepare(
      'SELECT * FROM erp_posting WHERE status = ? ORDER BY created_at DESC LIMIT ?'
    ).all(status, limit);
  } else {
    rows = db.prepare('SELECT * FROM erp_posting ORDER BY created_at DESC LIMIT ?').all(limit);
  }
  return rows.map(postingOut);
}

function pendingCount(db) {
  ensurePostingTable(db);
  return db.prepare("SELECT COUNT(*) AS n FROM erp_posting WHERE status = 'pending'").get().n;
}

/**
 * After set-ready on a printer: find the job that was just confirmed and enqueue.
 */
function recordFromSetReady(db, { printer_id, job, qty, note }) {
  if (!job) return null;
  try {
    const { posting } = recordShopfloorPosting(db, {
      job_id: job.id,
      part_id: job.part_id,
      printer_id: printer_id != null ? printer_id : job.printer_id,
      qty: qty != null ? qty : (job.parts_per_plate || 1),
      note: note || 'set-ready',
    });
    return posting;
  } catch (e) {
    console.log('[erp] posting record skipped:', e.message);
    return null;
  }
}

module.exports = {
  ensurePostingTable,
  recordShopfloorPosting,
  recordFromSetReady,
  previewPosting,
  confirmPosting,
  dismissPosting,
  listPostings,
  pendingCount,
  postingOut,
};
