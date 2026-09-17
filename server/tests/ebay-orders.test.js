jest.mock('axios');
const axios = require('axios');
const Database = require('better-sqlite3');
const { ensureErpSchema } = require('../erp/schema');
const { saveCredentials } = require('../ebay/credentials');
const { clearTokenCache, getSyncState } = require('../ebay/client');
const {
  syncOrders,
  upsertOrder,
  applyLineToErp,
  confirmLine,
} = require('../ebay/orders');

function seedFgItem(db, { sku = 'FG-WIDGET', qty = 10, wac = 5 } = {}) {
  const fin = db.prepare("SELECT id FROM warehouse WHERE lower(code)='fin_good'").get();
  const item = db.prepare(`
    INSERT INTO item (sku, name, warehouse_id, dimension, display_uom_code, purchase_uom_code, is_active, item_role, sourcing)
    VALUES (?, 'Widget', ?, 'COUNT', 'EA', 'EA', 1, 'product', 'manufactured')
  `).run(sku, fin.id);
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO stock_move (item_id, warehouse_id, qty, unit_cost, created_at, trans_date, note, idem_key)
    VALUES (?, ?, ?, ?, ?, ?, 'seed', ?)
  `).run(item.lastInsertRowid, fin.id, qty, wac, now, now, `seed-${sku}`);
  db.prepare(`
    INSERT INTO item_cost (item_id, warehouse_id, wac, qty_on_hand, created_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(item.lastInsertRowid, fin.id, wac, qty, now);
  return { itemId: item.lastInsertRowid, finId: fin.id };
}

function buildDb() {
  const db = new Database(':memory:');
  ensureErpSchema(db);
  saveCredentials(db, {
    environment: 'sandbox',
    client_id: 'c',
    client_secret: 's',
    refresh_token: 'r',
    auto_post: 1,
  });
  return db;
}

function sampleOrder({ orderId = 'O-1', lineId = 'L-1', sku = 'EBAY-WIDGET', qty = 2, unit = 12 } = {}) {
  return {
    orderId,
    legacyOrderId: 'LEG-1',
    creationDate: '2026-09-17T10:00:00.000Z',
    lastModifiedDate: '2026-09-17T10:05:00.000Z',
    orderPaymentStatus: 'PAID',
    orderFulfillmentStatus: 'NOT_STARTED',
    buyer: { username: 'buyer1' },
    pricingSummary: { total: { value: String(unit * qty), currency: 'USD' } },
    lineItems: [{
      lineItemId: lineId,
      sku,
      title: 'Widget',
      quantity: qty,
      lineItemCost: { value: String(unit * qty), currency: 'USD' },
      total: { value: String(unit * qty), currency: 'USD' },
      listingMarketplaceId: 'EBAY_US',
    }],
  };
}

describe('eBay order import hybrid posting', () => {
  let db;

  beforeEach(() => {
    db = buildDb();
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

  test('auto-posts when SKU mapped and stock sufficient', () => {
    const { itemId } = seedFgItem(db, { qty: 10 });
    db.prepare(`
      INSERT INTO ebay_listing (item_id, ebay_sku, offer_id, is_active)
      VALUES (?, 'EBAY-WIDGET', 'off-1', 1)
    `).run(itemId);

    const lines = upsertOrder(db, sampleOrder());
    expect(lines[0].status).toBe('pending');

    // Simulate tryAutoPost path via syncOrders mock response
    axios.mockResolvedValueOnce({
      status: 200,
      data: { orders: [sampleOrder()], total: 1 },
    });

    return syncOrders(db).then(result => {
      expect(result.ok).toBe(true);
      expect(result.auto_posted).toBe(1);
      const line = db.prepare("SELECT * FROM ebay_order_line WHERE line_item_id = 'L-1'").get();
      expect(line.status).toBe('auto_posted');
      expect(line.sales_order_id).toBeTruthy();
      expect(db.prepare('SELECT COUNT(*) AS n FROM sales_order').get().n).toBe(1);
      expect(db.prepare("SELECT qty FROM stock_move WHERE idem_key = 'ebay-line-L-1-sale'").get().qty).toBe(-2);
    });
  });

  test('queues when stock is short', () => {
    const { itemId } = seedFgItem(db, { qty: 1 });
    db.prepare(`
      INSERT INTO ebay_listing (item_id, ebay_sku, offer_id, is_active)
      VALUES (?, 'EBAY-WIDGET', 'off-1', 1)
    `).run(itemId);

    axios.mockResolvedValueOnce({
      status: 200,
      data: { orders: [sampleOrder({ qty: 5 })], total: 1 },
    });

    return syncOrders(db).then(result => {
      expect(result.ok).toBe(true);
      expect(result.queued).toBe(1);
      const line = db.prepare("SELECT * FROM ebay_order_line WHERE line_item_id = 'L-1'").get();
      expect(line.status).toBe('pending');
      expect(db.prepare('SELECT COUNT(*) AS n FROM sales_order').get().n).toBe(0);
    });
  });

  test('queues when SKU is unmapped', () => {
    seedFgItem(db, { qty: 10 });
    axios.mockResolvedValueOnce({
      status: 200,
      data: { orders: [sampleOrder({ sku: 'UNKNOWN-SKU' })], total: 1 },
    });

    return syncOrders(db).then(result => {
      expect(result.ok).toBe(true);
      expect(result.queued).toBe(1);
      const line = db.prepare("SELECT * FROM ebay_order_line WHERE line_item_id = 'L-1'").get();
      expect(line.status).toBe('pending');
      expect(line.item_id).toBeNull();
    });
  });

  test('reimporting the same order does not duplicate sales_order or stock_move', async () => {
    const { itemId } = seedFgItem(db, { qty: 10 });
    db.prepare(`
      INSERT INTO ebay_listing (item_id, ebay_sku, offer_id, is_active)
      VALUES (?, 'EBAY-WIDGET', 'off-1', 1)
    `).run(itemId);

    axios.mockResolvedValue({
      status: 200,
      data: { orders: [sampleOrder()], total: 1 },
    });

    const first = await syncOrders(db);
    expect(first.auto_posted).toBe(1);

    const second = await syncOrders(db);
    expect(second.ok).toBe(true);

    expect(db.prepare('SELECT COUNT(*) AS n FROM sales_order').get().n).toBe(1);
    expect(db.prepare(
      "SELECT COUNT(*) AS n FROM stock_move WHERE idem_key = 'ebay-line-L-1-sale'"
    ).get().n).toBe(1);
    expect(db.prepare("SELECT status FROM ebay_order_line WHERE line_item_id = 'L-1'").get().status)
      .toBe('auto_posted');
  });

  test('confirm with acknowledge_shortage posts despite short stock', () => {
    const { itemId } = seedFgItem(db, { qty: 0 });
    db.prepare(`
      INSERT INTO ebay_listing (item_id, ebay_sku, offer_id, is_active)
      VALUES (?, 'EBAY-WIDGET', 'off-1', 1)
    `).run(itemId);
    const lines = upsertOrder(db, sampleOrder({ qty: 2 }));
    const line = lines[0];

    const blocked = applyLineToErp(db, line, { acknowledge_shortage: false });
    expect(blocked.status).toBe(409);
    expect(blocked.acknowledge_required).toBe(true);

    const posted = confirmLine(db, line.id, { acknowledge_shortage: true });
    expect(posted.ok).toBe(true);
    expect(posted.status).toBe('posted');
    expect(db.prepare('SELECT COUNT(*) AS n FROM sales_order').get().n).toBe(1);
  });

  test('advances orders_last_modified watermark', async () => {
    seedFgItem(db, { qty: 10 });
    axios.mockResolvedValueOnce({
      status: 200,
      data: {
        orders: [sampleOrder({ orderId: 'O-2', lineId: 'L-2', sku: 'NOMAP' })],
        total: 1,
      },
    });
    await syncOrders(db);
    expect(getSyncState(db, 'orders_last_modified')).toBe('2026-09-17T10:05:00.000Z');
  });
});
