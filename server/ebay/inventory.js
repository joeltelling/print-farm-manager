/**
 * Push CoMa fin_good qty + computed selling price to existing eBay offers.
 * Uses Inventory API bulkUpdatePriceQuantity (one SKU per call, up to 25 offers).
 * Does not create or publish listings.
 */
const {
  num,
  round4,
  finWarehouseId,
  bomCostForItem,
  pricingNumbers,
  configMap,
} = require('../erp/costing');
const { getCredentials } = require('./credentials');
const { ebayRequest, setSyncState } = require('./client');

// Official Inventory API limit: up to 25 offers per SKU per bulkUpdatePriceQuantity call.
const MAX_OFFERS_PER_CALL = 25;

function stockAvailable(db, item_id, warehouse_id) {
  const r = db.prepare(
    'SELECT COALESCE(SUM(qty), 0) AS qty FROM stock_move WHERE item_id = ? AND warehouse_id = ?'
  ).get(item_id, warehouse_id);
  return num(r?.qty);
}

function sellingPriceForItem(db, item) {
  const cfg = configMap(db);
  const cost = bomCostForItem(db, item.id);
  return pricingNumbers(item, cfg, cost).selling_price;
}

function listListings(db) {
  return db.prepare(`
    SELECT l.*, i.sku AS item_sku, i.name AS item_name
    FROM ebay_listing l
    JOIN item i ON i.id = l.item_id
    ORDER BY l.id DESC
  `).all();
}

function createListing(db, body) {
  const b = body || {};
  const itemId = Number(b.item_id);
  const ebaySku = String(b.ebay_sku || '').trim();
  if (!itemId || !ebaySku) {
    return { ok: false, status: 400, error: 'item_id and ebay_sku are required' };
  }
  const item = db.prepare('SELECT id FROM item WHERE id = ?').get(itemId);
  if (!item) return { ok: false, status: 404, error: 'Item not found' };
  const clash = db.prepare('SELECT id FROM ebay_listing WHERE ebay_sku = ?').get(ebaySku);
  if (clash) return { ok: false, status: 409, error: 'ebay_sku already mapped' };

  const r = db.prepare(`
    INSERT INTO ebay_listing (item_id, ebay_sku, offer_id, listing_id, is_active)
    VALUES (?, ?, ?, ?, 1)
  `).run(itemId, ebaySku, b.offer_id || null, b.listing_id || null);
  const row = db.prepare('SELECT * FROM ebay_listing WHERE id = ?').get(r.lastInsertRowid);
  return { ok: true, listing: row };
}

function updateListing(db, id, body) {
  const row = db.prepare('SELECT * FROM ebay_listing WHERE id = ?').get(id);
  if (!row) return { ok: false, status: 404, error: 'Listing not found' };
  const b = body || {};
  const ebaySku = b.ebay_sku != null ? String(b.ebay_sku).trim() : row.ebay_sku;
  if (!ebaySku) return { ok: false, status: 400, error: 'ebay_sku required' };
  if (ebaySku !== row.ebay_sku) {
    const clash = db.prepare('SELECT id FROM ebay_listing WHERE ebay_sku = ? AND id != ?').get(ebaySku, id);
    if (clash) return { ok: false, status: 409, error: 'ebay_sku already mapped' };
  }
  const itemId = b.item_id != null ? Number(b.item_id) : row.item_id;
  if (b.item_id != null) {
    const item = db.prepare('SELECT id FROM item WHERE id = ?').get(itemId);
    if (!item) return { ok: false, status: 404, error: 'Item not found' };
  }
  db.prepare(`
    UPDATE ebay_listing SET
      item_id = ?,
      ebay_sku = ?,
      offer_id = COALESCE(?, offer_id),
      listing_id = COALESCE(?, listing_id),
      is_active = COALESCE(?, is_active)
    WHERE id = ?
  `).run(
    itemId,
    ebaySku,
    b.offer_id !== undefined ? b.offer_id : null,
    b.listing_id !== undefined ? b.listing_id : null,
    b.is_active != null ? (b.is_active ? 1 : 0) : null,
    id
  );
  return { ok: true, listing: db.prepare('SELECT * FROM ebay_listing WHERE id = ?').get(id) };
}

function deleteListing(db, id) {
  const row = db.prepare('SELECT id FROM ebay_listing WHERE id = ?').get(id);
  if (!row) return { ok: false, status: 404, error: 'Listing not found' };
  db.prepare('DELETE FROM ebay_listing WHERE id = ?').run(id);
  return { ok: true };
}

/**
 * Build and send bulkUpdatePriceQuantity for one listing.
 * Payload shape from Inventory API OpenAPI (PriceQuantity / OfferPriceQuantity).
 */
async function pushOneListing(db, listing) {
  const finId = finWarehouseId(db);
  if (!finId) {
    return { ok: false, error: 'FIN_GOOD warehouse not found' };
  }
  const item = db.prepare('SELECT * FROM item WHERE id = ?').get(listing.item_id);
  if (!item) {
    return { ok: false, error: 'Item not found' };
  }

  const qty = Math.max(0, Math.floor(stockAvailable(db, item.id, finId)));
  const price = round4(sellingPriceForItem(db, item));
  const currency = 'USD';
  const creds = getCredentials(db);

  if (!listing.offer_id) {
    const msg = 'offer_id required for price/quantity push (map an existing eBay offer)';
    db.prepare(
      'UPDATE ebay_listing SET last_error = ?, last_push_at = ? WHERE id = ?'
    ).run(msg, Date.now(), listing.id);
    return { ok: false, error: msg, listing_id: listing.id };
  }

  // Chunk offers (single offer_id today; ready for multi-offer rows later)
  const offerIds = String(listing.offer_id).split(',').map(s => s.trim()).filter(Boolean);
  const chunks = [];
  for (let i = 0; i < offerIds.length; i += MAX_OFFERS_PER_CALL) {
    chunks.push(offerIds.slice(i, i + MAX_OFFERS_PER_CALL));
  }

  let lastData = null;
  for (const chunk of chunks) {
    const payload = {
      requests: [{
        sku: listing.ebay_sku,
        shipToLocationAvailability: { quantity: qty },
        offers: chunk.map(offerId => ({
          offerId,
          availableQuantity: qty,
          price: { currency, value: String(price) },
        })),
      }],
    };

    const res = await ebayRequest(db, {
      method: 'POST',
      path: '/sell/inventory/v1/bulk_update_price_quantity',
      data: payload,
      headers: {
        'Content-Language': creds.marketplace_id === 'EBAY_US' ? 'en-US' : 'en-US',
      },
    });

    if (!res.ok) {
      db.prepare(
        'UPDATE ebay_listing SET last_error = ?, last_push_at = ? WHERE id = ?'
      ).run(res.error, Date.now(), listing.id);
      return { ok: false, error: res.error, listing_id: listing.id, status: res.status };
    }
    lastData = res.data;
  }

  db.prepare(`
    UPDATE ebay_listing SET
      last_pushed_qty = ?, last_pushed_price = ?, last_push_at = ?, last_error = NULL
    WHERE id = ?
  `).run(qty, price, Date.now(), listing.id);

  return {
    ok: true,
    listing_id: listing.id,
    ebay_sku: listing.ebay_sku,
    qty,
    price,
    data: lastData,
  };
}

async function pushInventory(db, opts = {}) {
  let listings;
  if (opts.listingId) {
    const one = db.prepare('SELECT * FROM ebay_listing WHERE id = ?').get(opts.listingId);
    if (!one) return { ok: false, error: 'Listing not found', results: [] };
    listings = [one];
  } else {
    listings = db.prepare('SELECT * FROM ebay_listing WHERE is_active = 1').all();
  }

  const results = [];
  let okCount = 0;
  let failCount = 0;
  for (const listing of listings) {
    const r = await pushOneListing(db, listing);
    results.push(r);
    if (r.ok) okCount += 1;
    else failCount += 1;
  }

  setSyncState(db, 'last_inventory_push_at', String(Date.now()));
  setSyncState(db, 'last_inventory_push_result', JSON.stringify({ ok: okCount, fail: failCount }));
  if (failCount > 0) {
    setSyncState(db, 'last_inventory_error', results.find(r => !r.ok)?.error || 'push failed');
  } else {
    setSyncState(db, 'last_inventory_error', '');
  }

  return { ok: failCount === 0, ok_count: okCount, fail_count: failCount, results };
}

module.exports = {
  MAX_OFFERS_PER_CALL,
  stockAvailable,
  sellingPriceForItem,
  listListings,
  createListing,
  updateListing,
  deleteListing,
  pushOneListing,
  pushInventory,
};
