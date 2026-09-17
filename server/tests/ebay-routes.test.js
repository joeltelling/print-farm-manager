jest.mock('axios');
const axios = require('axios');
const express = require('express');
const request = require('supertest');
const Database = require('better-sqlite3');
const { ensureErpSchema } = require('../erp/schema');
const { mountEbay } = require('../ebay');
const { clearTokenCache } = require('../ebay/client');

function buildApp() {
  const db = new Database(':memory:');
  ensureErpSchema(db);
  const app = express();
  app.use(express.json());
  app.use('/api/erp/ebay', mountEbay(db));
  return { app, db };
}

describe('eBay routes', () => {
  let app;
  let db;

  beforeEach(() => {
    ({ app, db } = buildApp());
    clearTokenCache();
    jest.clearAllMocks();
  });

  afterEach(() => {
    db.close();
    clearTokenCache();
  });

  test('GET /status and GET /credentials work without secrets configured', async () => {
    const status = await request(app).get('/api/erp/ebay/status');
    expect(status.status).toBe(200);
    expect(status.body.configured).toBe(false);

    const creds = await request(app).get('/api/erp/ebay/credentials');
    expect(creds.status).toBe(200);
    expect(creds.body.configured).toBe(false);
  });

  test('PUT /credentials saves and masks secrets', async () => {
    const res = await request(app).put('/api/erp/ebay/credentials').send({
      environment: 'sandbox',
      client_id: 'my-client-id-12345',
      client_secret: 'my-secret-value-999',
      refresh_token: 'my-refresh-token-abc',
      marketplace_id: 'EBAY_US',
      auto_post: 1,
    });
    expect(res.status).toBe(200);
    expect(res.body.configured).toBe(true);
    expect(res.body.client_secret).toContain('********');
    expect(res.body.client_secret).not.toContain('my-secret-value-999');
  });

  test('POST /listings validates required fields', async () => {
    const res = await request(app).post('/api/erp/ebay/listings').send({ ebay_sku: 'X' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/item_id/);
  });

  test('POST /listings 404 when item missing', async () => {
    const res = await request(app).post('/api/erp/ebay/listings').send({
      item_id: 9999,
      ebay_sku: 'X',
    });
    expect(res.status).toBe(404);
  });

  test('listing create + pending confirm 409 with acknowledge_required', async () => {
    const fin = db.prepare("SELECT id FROM warehouse WHERE lower(code)='fin_good'").get();
    const item = db.prepare(`
      INSERT INTO item (sku, name, warehouse_id, dimension, display_uom_code, purchase_uom_code, is_active, item_role, sourcing)
      VALUES ('FG-A', 'A', ?, 'COUNT', 'EA', 'EA', 1, 'product', 'manufactured')
    `).run(fin.id);

    const created = await request(app).post('/api/erp/ebay/listings').send({
      item_id: item.lastInsertRowid,
      ebay_sku: 'EBAY-A',
      offer_id: 'off-1',
    });
    expect(created.status).toBe(201);

    db.prepare(`
      INSERT INTO ebay_order
        (order_id, creation_date, last_modified_date, raw_json, imported_at)
      VALUES ('ORD-X', '2026-09-17T00:00:00.000Z', '2026-09-17T00:00:00.000Z', '{}', ?)
    `).run(Date.now());
    const line = db.prepare(`
      INSERT INTO ebay_order_line
        (line_item_id, ebay_order_id, ebay_sku, title, qty, unit_price, total_price, item_id, status)
      VALUES ('LINE-X', 'ORD-X', 'EBAY-A', 'A', 2, 10, 20, ?, 'pending')
    `).run(item.lastInsertRowid);

    const confirm = await request(app)
      .post(`/api/erp/ebay/pending/${line.lastInsertRowid}/confirm`)
      .send({});
    expect(confirm.status).toBe(409);
    expect(confirm.body.acknowledge_required).toBe(true);

    const ack = await request(app)
      .post(`/api/erp/ebay/pending/${line.lastInsertRowid}/confirm`)
      .send({ acknowledge_shortage: true });
    expect(ack.status).toBe(200);
    expect(ack.body.status).toBe('posted');

    const again = await request(app)
      .post(`/api/erp/ebay/pending/${line.lastInsertRowid}/confirm`)
      .send({ acknowledge_shortage: true });
    expect(again.status).toBe(409);
  });

  test('POST /test-connection returns 400 when not configured', async () => {
    const res = await request(app).post('/api/erp/ebay/test-connection');
    expect(res.status).toBe(400);
  });

  test('DELETE /listings/:id 404 for missing', async () => {
    const res = await request(app).delete('/api/erp/ebay/listings/999');
    expect(res.status).toBe(404);
  });
});
