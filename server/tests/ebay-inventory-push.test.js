jest.mock('axios');
const axios = require('axios');
const Database = require('better-sqlite3');
const { ensureErpSchema } = require('../erp/schema');
const { saveCredentials } = require('../ebay/credentials');
const { clearTokenCache } = require('../ebay/client');
const {
  pushInventory,
  createListing,
  MAX_OFFERS_PER_CALL,
} = require('../ebay/inventory');
const { bomCostForItem, pricingNumbers, configMap } = require('../erp/costing');

function buildDb() {
  const db = new Database(':memory:');
  ensureErpSchema(db);
  saveCredentials(db, {
    environment: 'sandbox',
    client_id: 'c',
    client_secret: 's',
    refresh_token: 'r',
  });
  const fin = db.prepare("SELECT id FROM warehouse WHERE lower(code)='fin_good'").get();
  const item = db.prepare(`
    INSERT INTO item (sku, name, warehouse_id, dimension, display_uom_code, purchase_uom_code, is_active, item_role, sourcing)
    VALUES ('FG-1', 'Product', ?, 'COUNT', 'EA', 'EA', 1, 'product', 'manufactured')
  `).run(fin.id);
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO stock_move (item_id, warehouse_id, qty, unit_cost, created_at, trans_date, idem_key)
    VALUES (?, ?, 7, 4, ?, ?, 'seed-fg')
  `).run(item.lastInsertRowid, fin.id, now, now);
  db.prepare(`
    INSERT INTO item_cost (item_id, warehouse_id, wac, qty_on_hand, created_at)
    VALUES (?, ?, 4, 7, ?)
  `).run(item.lastInsertRowid, fin.id, now);
  db.prepare("UPDATE pricing_config SET value = 10 WHERE code = 'MARGIN_DEF'").run();
  db.prepare("UPDATE pricing_config SET value = 5 WHERE code = 'ADDS_PCT'").run();
  db.prepare("UPDATE pricing_config SET value = 12 WHERE code = 'EBAY_FEE'").run();
  return { db, itemId: item.lastInsertRowid, finId: fin.id };
}

describe('eBay inventory push', () => {
  let db;
  let itemId;

  beforeEach(() => {
    ({ db, itemId } = buildDb());
    clearTokenCache();
    jest.clearAllMocks();
    axios.post.mockResolvedValue({
      status: 200,
      data: { access_token: 'tok', expires_in: 7200 },
    });
  });

  afterEach(() => {
    db.close();
    clearTokenCache();
  });

  test('pushes computed qty and selling price for one SKU', async () => {
    createListing(db, { item_id: itemId, ebay_sku: 'EBAY-FG-1', offer_id: 'offer-A' });

    const item = db.prepare('SELECT * FROM item WHERE id = ?').get(itemId);
    const expectedPrice = pricingNumbers(item, configMap(db), bomCostForItem(db, itemId)).selling_price;

    let captured;
    axios.mockImplementation(async (cfg) => {
      if (cfg.url && String(cfg.url).includes('bulk_update_price_quantity')) {
        captured = cfg.data;
        return { status: 200, data: { responses: [{ statusCode: 200 }] } };
      }
      return { status: 200, data: {} };
    });

    const result = await pushInventory(db);
    expect(result.ok).toBe(true);
    expect(result.ok_count).toBe(1);
    expect(captured.requests[0].sku).toBe('EBAY-FG-1');
    expect(captured.requests[0].shipToLocationAvailability.quantity).toBe(7);
    expect(captured.requests[0].offers[0].offerId).toBe('offer-A');
    expect(captured.requests[0].offers[0].availableQuantity).toBe(7);
    expect(Number(captured.requests[0].offers[0].price.value)).toBe(expectedPrice);

    const listing = db.prepare('SELECT * FROM ebay_listing WHERE ebay_sku = ?').get('EBAY-FG-1');
    expect(listing.last_pushed_qty).toBe(7);
    expect(listing.last_pushed_price).toBe(expectedPrice);
    expect(listing.last_error).toBeNull();
  });

  test('chunks offer ids into batches of MAX_OFFERS_PER_CALL', async () => {
    const offerIds = Array.from({ length: MAX_OFFERS_PER_CALL + 3 }, (_, i) => `off-${i}`).join(',');
    createListing(db, { item_id: itemId, ebay_sku: 'EBAY-FG-1', offer_id: offerIds });

    const payloads = [];
    axios.mockImplementation(async (cfg) => {
      if (cfg.url && String(cfg.url).includes('bulk_update_price_quantity')) {
        payloads.push(cfg.data);
        return { status: 200, data: { responses: [] } };
      }
      return { status: 200, data: {} };
    });

    const result = await pushInventory(db);
    expect(result.ok).toBe(true);
    expect(payloads.length).toBe(2);
    expect(payloads[0].requests[0].offers.length).toBe(MAX_OFFERS_PER_CALL);
    expect(payloads[1].requests[0].offers.length).toBe(3);
  });

  test('persists error without throwing when offer_id missing', async () => {
    createListing(db, { item_id: itemId, ebay_sku: 'EBAY-FG-1', offer_id: null });
    const result = await pushInventory(db);
    expect(result.ok).toBe(false);
    expect(result.fail_count).toBe(1);
    const listing = db.prepare('SELECT last_error FROM ebay_listing WHERE ebay_sku = ?').get('EBAY-FG-1');
    expect(listing.last_error).toMatch(/offer_id/);
  });
});
