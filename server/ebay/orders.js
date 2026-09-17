/**
 * eBay Fulfillment order import with hybrid ERP posting.
 * Auto-posts when SKU mapped + stock sufficient; otherwise queues for operator.
 * Never touches parts.completed_qty.
 */
const {
  num,
  round4,
  finWarehouseId,
  configMap,
} = require('../erp/costing');
const { getCredentials } = require('./credentials');
const { ebayRequest, setSyncState, getSyncState } = require('./client');

// Overlap so a clock skew or delayed lastModifiedDate cannot skip an order.
const WATERMARK_OVERLAP_MS = 5 * 60 * 1000;
const DEFAULT_LOOKBACK_MS = 7 * 24 * 60 * 60 * 1000;
const PAGE_LIMIT = 50;

function stockAvailable(db, item_id, warehouse_id) {
  const r = db.prepare(
    'SELECT COALESCE(SUM(qty), 0) AS qty FROM stock_move WHERE item_id = ? AND warehouse_id = ?'
  ).get(item_id, warehouse_id);
  return num(r?.qty);
}

function wacFor(db, item_id, warehouse_id) {
  const r = db.prepare(
    'SELECT wac FROM item_cost WHERE item_id = ? AND warehouse_id = ?'
  ).get(item_id, warehouse_id);
  if (r) return num(r.wac);
  const any = db.prepare('SELECT wac FROM item_cost WHERE item_id = ? LIMIT 1').get(item_id);
  return num(any?.wac);
}

function resolveItemId(db, ebaySku) {
  if (!ebaySku) return null;
  const sku = String(ebaySku).trim();
  if (!sku) return null;
  const listing = db.prepare(
    'SELECT item_id FROM ebay_listing WHERE ebay_sku = ? AND is_active = 1'
  ).get(sku);
  if (listing) return listing.item_id;
  const item = db.prepare('SELECT id FROM item WHERE sku = ?').get(sku);
  return item ? item.id : null;
}

function amountValue(amount) {
  if (!amount) return 0;
  return num(amount.value);
}

function lineUnitPrice(li) {
  const qty = Math.max(1, num(li.quantity) || 1);
  // Official LineItem.lineItemCost is the cost for the line quantity; divide for unit.
  // Fall back to total / qty when lineItemCost is absent.
  if (li.lineItemCost && li.lineItemCost.value != null) {
    return round4(num(li.lineItemCost.value) / qty);
  }
  if (li.total && li.total.value != null) {
    return round4(num(li.total.value) / qty);
  }
  return 0;
}

function lineTotalPrice(li) {
  if (li.total && li.total.value != null) return round4(num(li.total.value));
  const qty = num(li.quantity) || 0;
  return round4(lineUnitPrice(li) * qty);
}

/**
 * Apply a pending/auto line to ERP: stock_move + sales_order.
 * Idempotent via stock_move.idem_key = ebay-line-{line_item_id}-sale
 * and ebay_order_line.status check inside the transaction.
 */
function applyLineToErp(db, line, opts = {}) {
  const acknowledgeShortage = !!opts.acknowledge_shortage;
  const status = line.status;
  if (status === 'posted' || status === 'auto_posted' || status === 'dismissed') {
    return { ok: false, status: 409, error: `Line already ${status}` };
  }

  const finId = finWarehouseId(db);
  if (!finId) return { ok: false, status: 400, error: 'FIN_GOOD warehouse not found' };

  let itemId = line.item_id;
  if (!itemId) {
    itemId = resolveItemId(db, line.ebay_sku);
  }
  if (!itemId) {
    return {
      ok: false,
      status: 409,
      error: 'SKU not mapped to an ERP item',
      acknowledge_required: false,
      unmapped: true,
    };
  }

  const item = db.prepare('SELECT * FROM item WHERE id = ?').get(itemId);
  if (!item) return { ok: false, status: 404, error: 'Item not found' };

  const qty = num(line.qty);
  if (qty <= 0) return { ok: false, status: 400, error: 'qty must be > 0' };

  const available = stockAvailable(db, item.id, finId);
  if (available + 1e-9 < qty && !acknowledgeShortage) {
    const shortage = [{ item_id: item.id, sku: item.sku, need: qty, available }];
    db.prepare(
      'UPDATE ebay_order_line SET item_id = ?, shortage_json = ? WHERE id = ?'
    ).run(item.id, JSON.stringify(shortage), line.id);
    return {
      ok: false,
      status: 409,
      error: 'Insufficient stock',
      acknowledge_required: true,
      missing: shortage,
    };
  }

  const unit_price = num(line.unit_price);
  const total_price = num(line.total_price) || round4(unit_price * qty);
  const unit_wac = wacFor(db, item.id, finId);
  const cfg = configMap(db);
  const margin_pct = item.custom_margin != null ? num(item.custom_margin) : num(cfg.MARGIN_DEF);
  const unit_margin = round4(unit_wac * (margin_pct / 100));
  const nowIso = new Date().toISOString();
  const nowMs = Date.now();
  const idemKey = `ebay-line-${line.line_item_id}-sale`;
  const finalStatus = opts.auto ? 'auto_posted' : 'posted';

  let salesOrderId = null;
  let stockMoveId = null;

  try {
    db.transaction(() => {
      const fresh = db.prepare('SELECT status FROM ebay_order_line WHERE id = ?').get(line.id);
      if (!fresh || fresh.status !== 'pending') {
        throw Object.assign(new Error(`Line status is ${fresh?.status || 'missing'}`), { code: 'CONFLICT' });
      }

      const existingMove = db.prepare('SELECT id FROM stock_move WHERE idem_key = ?').get(idemKey);
      if (existingMove) {
        stockMoveId = existingMove.id;
      } else {
        const move = db.prepare(`
          INSERT INTO stock_move (item_id, warehouse_id, qty, unit_cost, trans_date, created_at, note, idem_key)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          item.id, finId, -qty, unit_wac, nowIso, nowIso,
          `eBay order ${line.ebay_order_id} line ${line.line_item_id}`,
          idemKey
        );
        stockMoveId = move.lastInsertRowid;
      }

      let ic = db.prepare(
        'SELECT * FROM item_cost WHERE item_id = ? AND warehouse_id = ?'
      ).get(item.id, finId);
      if (!ic) {
        db.prepare(
          'INSERT INTO item_cost (item_id, warehouse_id, wac, qty_on_hand, created_at) VALUES (?, ?, ?, 0, ?)'
        ).run(item.id, finId, unit_wac, nowIso);
        ic = { qty_on_hand: 0, wac: unit_wac };
      }
      const remaining = num(ic.qty_on_hand) - qty;
      db.prepare(
        'UPDATE item_cost SET qty_on_hand = ?, updated_at = ? WHERE item_id = ? AND warehouse_id = ?'
      ).run(remaining, nowIso, item.id, finId);

      // Avoid duplicate sales_order on re-confirm of a partially written line
      if (line.sales_order_id) {
        salesOrderId = line.sales_order_id;
      } else {
        const so = db.prepare(`
          INSERT INTO sales_order
            (item_id, sku, item_name, qty, unit_price, total_price, unit_margin, unit_cost, sale_date, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          item.id, item.sku, item.name, qty, unit_price, total_price,
          unit_margin, unit_wac, nowIso, nowIso
        );
        salesOrderId = so.lastInsertRowid;
      }

      db.prepare(`
        UPDATE ebay_order_line SET
          item_id = ?, status = ?, sales_order_id = ?, stock_move_id = ?,
          posted_at = ?, shortage_json = NULL, note = COALESCE(?, note)
        WHERE id = ?
      `).run(
        item.id, finalStatus, salesOrderId, stockMoveId, nowMs,
        opts.note || null, line.id
      );
    })();
  } catch (err) {
    if (err.code === 'CONFLICT') {
      return { ok: false, status: 409, error: err.message };
    }
    throw err;
  }

  return {
    ok: true,
    status: finalStatus,
    sales_order_id: salesOrderId,
    stock_move_id: stockMoveId,
  };
}

function upsertOrder(db, order) {
  const now = Date.now();
  const total = amountValue(order.pricingSummary?.total);
  const currency = order.pricingSummary?.total?.currency || null;
  const buyer = order.buyer?.username || null;

  db.prepare(`
    INSERT INTO ebay_order (
      order_id, legacy_order_id, creation_date, last_modified_date,
      order_payment_status, order_fulfillment_status, buyer_username,
      total_amount, currency, marketplace_id, raw_json, imported_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(order_id) DO UPDATE SET
      legacy_order_id = excluded.legacy_order_id,
      creation_date = excluded.creation_date,
      last_modified_date = excluded.last_modified_date,
      order_payment_status = excluded.order_payment_status,
      order_fulfillment_status = excluded.order_fulfillment_status,
      buyer_username = excluded.buyer_username,
      total_amount = excluded.total_amount,
      currency = excluded.currency,
      marketplace_id = excluded.marketplace_id,
      raw_json = excluded.raw_json
  `).run(
    order.orderId,
    order.legacyOrderId || null,
    order.creationDate || null,
    order.lastModifiedDate || null,
    order.orderPaymentStatus || null,
    order.orderFulfillmentStatus || null,
    buyer,
    total,
    currency,
    order.lineItems?.[0]?.listingMarketplaceId || null,
    JSON.stringify(order),
    now
  );

  const lines = order.lineItems || [];
  const results = [];
  for (const li of lines) {
    const lineItemId = li.lineItemId;
    if (!lineItemId) continue;
    const ebaySku = li.sku || null;
    const qty = num(li.quantity) || 0;
    const unit_price = lineUnitPrice(li);
    const total_price = lineTotalPrice(li);
    const title = li.title || null;
    const itemId = resolveItemId(db, ebaySku);

    const existing = db.prepare(
      'SELECT * FROM ebay_order_line WHERE line_item_id = ?'
    ).get(lineItemId);

    if (existing) {
      // Never rewrite a posted/dismissed line; keep qty/price snapshot for pending only
      if (existing.status === 'pending') {
        db.prepare(`
          UPDATE ebay_order_line SET
            ebay_sku = ?, title = ?, qty = ?, unit_price = ?, total_price = ?,
            item_id = COALESCE(?, item_id)
          WHERE id = ?
        `).run(ebaySku, title, qty, unit_price, total_price, itemId, existing.id);
      }
      results.push(db.prepare('SELECT * FROM ebay_order_line WHERE id = ?').get(existing.id));
    } else {
      const r = db.prepare(`
        INSERT INTO ebay_order_line (
          line_item_id, ebay_order_id, ebay_sku, title, qty, unit_price, total_price,
          item_id, status
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending')
      `).run(
        lineItemId, order.orderId, ebaySku, title, qty, unit_price, total_price, itemId
      );
      results.push(db.prepare('SELECT * FROM ebay_order_line WHERE id = ?').get(r.lastInsertRowid));
    }
  }
  return results;
}

function tryAutoPost(db, line) {
  const creds = getCredentials(db);
  if (!creds.auto_post) return { skipped: true, reason: 'auto_post disabled' };
  if (line.status !== 'pending') return { skipped: true, reason: `status ${line.status}` };
  if (!line.item_id) {
    return { skipped: true, reason: 'unmapped sku', queued: true };
  }
  const finId = finWarehouseId(db);
  if (!finId) return { skipped: true, reason: 'no fin_good' };
  const available = stockAvailable(db, line.item_id, finId);
  if (available + 1e-9 < num(line.qty)) {
    return { skipped: true, reason: 'insufficient stock', queued: true };
  }
  return applyLineToErp(db, line, { auto: true });
}

function watermarkFrom(db) {
  const stored = getSyncState(db, 'orders_last_modified');
  if (stored) {
    const t = Date.parse(stored);
    if (!Number.isNaN(t)) {
      return new Date(t - WATERMARK_OVERLAP_MS).toISOString().replace(/\.\d{3}Z$/, '.000Z');
    }
  }
  return new Date(Date.now() - DEFAULT_LOOKBACK_MS).toISOString().replace(/\.\d{3}Z$/, '.000Z');
}

/**
 * Pull orders from eBay Fulfillment API and apply hybrid posting.
 */
async function syncOrders(db, opts = {}) {
  const from = opts.from || watermarkFrom(db);
  // Official filter: lastmodifieddate:[ISO..] with brackets percent-encoded by axios params
  const filter = `lastmodifieddate:[${from}..]`;

  let offset = 0;
  let fetched = 0;
  let autoPosted = 0;
  let queued = 0;
  let maxModified = from;
  const errors = [];

  for (;;) {
    const res = await ebayRequest(db, {
      method: 'GET',
      // Fulfillment OpenAPI lists both api and apiz; production uses api, sandbox often apiz
      host: getCredentials(db).environment === 'sandbox' ? 'apiz' : 'api',
      path: '/sell/fulfillment/v1/order',
      params: {
        filter,
        limit: PAGE_LIMIT,
        offset,
      },
    });

    if (!res.ok) {
      setSyncState(db, 'last_orders_error', res.error);
      setSyncState(db, 'last_orders_sync_at', String(Date.now()));
      return {
        ok: false,
        error: res.error,
        fetched,
        auto_posted: autoPosted,
        queued,
      };
    }

    const orders = res.data?.orders || [];
    for (const order of orders) {
      fetched += 1;
      if (order.lastModifiedDate && order.lastModifiedDate > maxModified) {
        maxModified = order.lastModifiedDate;
      }
      const lines = upsertOrder(db, order);
      for (const line of lines) {
        if (line.status !== 'pending') continue;
        const result = tryAutoPost(db, line);
        if (result.ok) autoPosted += 1;
        else if (result.queued || result.acknowledge_required || result.unmapped) queued += 1;
        else if (result.error && result.status !== 409) errors.push(result.error);
      }
    }

    const next = res.data?.next;
    if (!next || orders.length === 0) break;
    offset += orders.length;
    if (offset >= (res.data?.total || offset)) break;
  }

  setSyncState(db, 'orders_last_modified', maxModified);
  setSyncState(db, 'last_orders_error', '');
  setSyncState(db, 'last_orders_sync_at', String(Date.now()));
  setSyncState(db, 'last_orders_result', JSON.stringify({
    fetched, auto_posted: autoPosted, queued, from, max_modified: maxModified,
  }));

  return {
    ok: true,
    fetched,
    auto_posted: autoPosted,
    queued,
    from,
    max_modified: maxModified,
    errors: errors.slice(0, 10),
  };
}

function confirmLine(db, lineId, opts = {}) {
  const line = db.prepare('SELECT * FROM ebay_order_line WHERE id = ?').get(lineId);
  if (!line) return { ok: false, status: 404, error: 'Line not found' };
  return applyLineToErp(db, line, {
    acknowledge_shortage: !!opts.acknowledge_shortage,
    auto: false,
  });
}

function dismissLine(db, lineId) {
  const line = db.prepare('SELECT * FROM ebay_order_line WHERE id = ?').get(lineId);
  if (!line) return { ok: false, status: 404, error: 'Line not found' };
  if (line.status !== 'pending') {
    return { ok: false, status: 409, error: `Line already ${line.status}` };
  }
  db.prepare(
    'UPDATE ebay_order_line SET status = ?, posted_at = ? WHERE id = ?'
  ).run('dismissed', Date.now(), line.id);
  return { ok: true, status: 'dismissed' };
}

function listPending(db) {
  return db.prepare(`
    SELECT l.*, o.buyer_username, o.creation_date, o.order_payment_status, o.order_fulfillment_status
    FROM ebay_order_line l
    JOIN ebay_order o ON o.order_id = l.ebay_order_id
    WHERE l.status = 'pending'
    ORDER BY o.creation_date DESC, l.id DESC
  `).all();
}

function listOrders(db, { limit = 50, offset = 0 } = {}) {
  const lim = Math.min(200, Math.max(1, Number(limit) || 50));
  const off = Math.max(0, Number(offset) || 0);
  const rows = db.prepare(`
    SELECT * FROM ebay_order
    ORDER BY COALESCE(creation_date, '') DESC, id DESC
    LIMIT ? OFFSET ?
  `).all(lim, off);
  const total = db.prepare('SELECT COUNT(*) AS n FROM ebay_order').get().n;
  return { orders: rows, total, limit: lim, offset: off };
}

function getOrder(db, orderId) {
  const order = db.prepare('SELECT * FROM ebay_order WHERE order_id = ?').get(orderId);
  if (!order) return null;
  const lines = db.prepare(
    'SELECT * FROM ebay_order_line WHERE ebay_order_id = ? ORDER BY id'
  ).all(orderId);
  return { ...order, lines };
}

module.exports = {
  WATERMARK_OVERLAP_MS,
  stockAvailable,
  resolveItemId,
  lineUnitPrice,
  applyLineToErp,
  upsertOrder,
  tryAutoPost,
  syncOrders,
  confirmLine,
  dismissLine,
  listPending,
  listOrders,
  getOrder,
};
