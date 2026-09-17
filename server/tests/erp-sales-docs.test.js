// Customers + sales documents: Presupuesto (quote) -> Albaran (delivery) -> Factura
// (invoice). Covers CRUD, the draft-only edit rule, the convertible chain, PDF export,
// and the shopfloor-sync path that turns a confirmed erp_posting into a delivery line.
const request  = require('supertest');
const express  = require('express');
const Database = require('better-sqlite3');
const { ensureErpSchema } = require('../erp/schema');
const { mountErp } = require('../erp');
const { recordShopfloorPosting, confirmPosting } = require('../erp/postings');

function buildApp() {
  const db = new Database(':memory:');
  ensureErpSchema(db);
  db.exec(`
    CREATE TABLE IF NOT EXISTS parts (
      id INTEGER PRIMARY KEY,
      name TEXT,
      project_id INTEGER,
      erp_sku TEXT,
      completed_qty REAL DEFAULT 0,
      target_qty REAL DEFAULT 10,
      status TEXT DEFAULT 'open'
    );
    CREATE TABLE IF NOT EXISTS jobs (
      id INTEGER PRIMARY KEY,
      part_id INTEGER,
      printer_id INTEGER,
      printing_seconds REAL DEFAULT 0
    );
  `);
  const app = express();
  app.use(express.json());
  app.use('/api/erp', mountErp(db));
  return { app, db };
}

async function makeCustomer(app) {
  const res = await request(app).post('/api/erp/customers').send({ name: 'Acme SL', tax_id: 'B12345678' });
  return res.body;
}

describe('Customers', () => {
  let app, db;
  beforeEach(() => { ({ app, db } = buildApp()); });
  afterEach(() => db.close());

  test('create, list, update', async () => {
    const created = await request(app).post('/api/erp/customers').send({ name: 'Acme SL', tax_id: 'B12345678' });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ name: 'Acme SL', tax_id: 'B12345678', is_active: true });

    const list = await request(app).get('/api/erp/customers');
    expect(list.status).toBe(200);
    expect(list.body.length).toBe(1);

    const updated = await request(app).put(`/api/erp/customers/${created.body.id}`).send({ city: 'Madrid' });
    expect(updated.status).toBe(200);
    expect(updated.body).toMatchObject({ name: 'Acme SL', city: 'Madrid' });
  });

  test('name is required', async () => {
    const res = await request(app).post('/api/erp/customers').send({ tax_id: 'B12345678' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/name/);
  });

  test('404 on unknown customer', async () => {
    const res = await request(app).get('/api/erp/customers/999');
    expect(res.status).toBe(404);
  });
});

describe('Sales documents: create, edit, confirm', () => {
  let app, db;
  beforeEach(() => { ({ app, db } = buildApp()); });
  afterEach(() => db.close());

  test('creating a quote computes totals and assigns a sequential PRE- number', async () => {
    const customer = await makeCustomer(app);
    const res = await request(app).post('/api/erp/sales-docs').send({
      doc_type: 'quote',
      customer_id: customer.id,
      lines: [
        { description: 'Bracket x5', qty: 5, unit_price: 20, tax_rate: 21 },
        { description: 'Shipping', qty: 1, unit_price: 10, tax_rate: 21 },
      ],
    });
    expect(res.status).toBe(201);
    expect(res.body.doc_number).toBe('PRE-000001');
    expect(res.body.status).toBe('draft');
    expect(res.body.subtotal).toBe(110);
    expect(res.body.tax_total).toBeCloseTo(23.1, 4);
    expect(res.body.total).toBeCloseTo(133.1, 4);
    expect(res.body.lines).toHaveLength(2);

    const second = await request(app).post('/api/erp/sales-docs').send({
      doc_type: 'quote', customer_id: customer.id, lines: [{ description: 'x', qty: 1, unit_price: 1 }],
    });
    expect(second.body.doc_number).toBe('PRE-000002');
  });

  test('rejects unknown doc_type, missing customer, and empty lines', async () => {
    const customer = await makeCustomer(app);
    const badType = await request(app).post('/api/erp/sales-docs').send({
      doc_type: 'nope', customer_id: customer.id, lines: [{ description: 'x', qty: 1, unit_price: 1 }],
    });
    expect(badType.status).toBe(400);

    const noCustomer = await request(app).post('/api/erp/sales-docs').send({
      doc_type: 'quote', lines: [{ description: 'x', qty: 1, unit_price: 1 }],
    });
    expect(noCustomer.status).toBe(400);

    const badCustomer = await request(app).post('/api/erp/sales-docs').send({
      doc_type: 'quote', customer_id: 999, lines: [{ description: 'x', qty: 1, unit_price: 1 }],
    });
    expect(badCustomer.status).toBe(404);

    const noLines = await request(app).post('/api/erp/sales-docs').send({
      doc_type: 'quote', customer_id: customer.id, lines: [],
    });
    expect(noLines.status).toBe(400);
  });

  test('draft documents can be edited; confirmed/cancelled cannot', async () => {
    const customer = await makeCustomer(app);
    const created = await request(app).post('/api/erp/sales-docs').send({
      doc_type: 'quote', customer_id: customer.id, lines: [{ description: 'x', qty: 1, unit_price: 100, tax_rate: 21 }],
    });
    const id = created.body.id;

    const edited = await request(app).put(`/api/erp/sales-docs/${id}`).send({
      lines: [{ description: 'x', qty: 2, unit_price: 100, tax_rate: 21 }],
    });
    expect(edited.status).toBe(200);
    expect(edited.body.subtotal).toBe(200);

    const confirmed = await request(app).post(`/api/erp/sales-docs/${id}/confirm`);
    expect(confirmed.status).toBe(200);
    expect(confirmed.body.status).toBe('confirmed');

    const editAfterConfirm = await request(app).put(`/api/erp/sales-docs/${id}`).send({ notes: 'late edit' });
    expect(editAfterConfirm.status).toBe(409);

    const cancelled = await request(app).post(`/api/erp/sales-docs/${id}/cancel`);
    expect(cancelled.status).toBe(200);
    expect(cancelled.body.status).toBe('cancelled');

    const doubleCancel = await request(app).post(`/api/erp/sales-docs/${id}/cancel`);
    expect(doubleCancel.status).toBe(409);
  });

  test('404 on unknown document', async () => {
    const res = await request(app).get('/api/erp/sales-docs/999');
    expect(res.status).toBe(404);
  });
});

describe('Sales documents: convertible chain (quote -> delivery -> invoice)', () => {
  let app, db;
  beforeEach(() => { ({ app, db } = buildApp()); });
  afterEach(() => db.close());

  test('converts a confirmed quote into a delivery note, then into an invoice', async () => {
    const customer = await makeCustomer(app);
    const quote = await request(app).post('/api/erp/sales-docs').send({
      doc_type: 'quote', customer_id: customer.id,
      lines: [{ description: 'Bracket', qty: 3, unit_price: 20, tax_rate: 21 }],
    });
    await request(app).post(`/api/erp/sales-docs/${quote.body.id}/confirm`);

    const delivery = await request(app).post(`/api/erp/sales-docs/${quote.body.id}/convert`).send({ to: 'delivery' });
    expect(delivery.status).toBe(201);
    expect(delivery.body.doc_type).toBe('delivery');
    expect(delivery.body.doc_number).toBe('ALB-000001');
    expect(delivery.body.status).toBe('draft');
    expect(delivery.body.source_doc_id).toBe(quote.body.id);
    expect(delivery.body.total).toBeCloseTo(quote.body.total, 4);

    await request(app).post(`/api/erp/sales-docs/${delivery.body.id}/confirm`);
    const invoice = await request(app).post(`/api/erp/sales-docs/${delivery.body.id}/convert`).send({ to: 'invoice' });
    expect(invoice.status).toBe(201);
    expect(invoice.body.doc_type).toBe('invoice');
    expect(invoice.body.doc_number).toBe('FAC-000001');
    expect(invoice.body.source_doc_id).toBe(delivery.body.id);
  });

  test('cannot convert a draft document, or skip a step in the chain', async () => {
    const customer = await makeCustomer(app);
    const quote = await request(app).post('/api/erp/sales-docs').send({
      doc_type: 'quote', customer_id: customer.id,
      lines: [{ description: 'Bracket', qty: 1, unit_price: 20 }],
    });

    const draftConvert = await request(app).post(`/api/erp/sales-docs/${quote.body.id}/convert`).send({ to: 'delivery' });
    expect(draftConvert.status).toBe(409);

    await request(app).post(`/api/erp/sales-docs/${quote.body.id}/confirm`);
    const skipStep = await request(app).post(`/api/erp/sales-docs/${quote.body.id}/convert`).send({ to: 'invoice' });
    expect(skipStep.status).toBe(400);
  });
});

describe('Sales document PDF export', () => {
  let app, db;
  beforeEach(() => { ({ app, db } = buildApp()); });
  afterEach(() => db.close());

  test('GET /sales-docs/:id/pdf returns a PDF file', async () => {
    const customer = await makeCustomer(app);
    const quote = await request(app).post('/api/erp/sales-docs').send({
      doc_type: 'quote', customer_id: customer.id,
      lines: [{ description: 'Bracket', qty: 1, unit_price: 20, tax_rate: 21 }],
    });
    const res = await request(app).get(`/api/erp/sales-docs/${quote.body.id}/pdf`);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('application/pdf');
    expect(res.body.slice(0, 5).toString('latin1')).toBe('%PDF-');
  });
});

describe('Shopfloor sync: confirmed posting -> delivery note line', () => {
  let app, db;
  beforeEach(() => { ({ app, db } = buildApp()); });
  afterEach(() => db.close());

  async function seedPostedComponent(app, db) {
    let rawWh = db.prepare("SELECT id FROM warehouse WHERE lower(code)='raw'").get();
    const rawItem = await request(app).post('/api/erp/items').send({
      sku: 'RAW-PLA', name: 'PLA', dimension: 'WEIGHT',
      display_uom_code: 'G', purchase_uom_code: 'KG', warehouse_id: rawWh.id,
      item_role: 'raw', sourcing: 'outsource',
    });
    await request(app).post('/api/erp/inventory/receive_by_sku').send({
      sku: 'RAW-PLA', warehouse_id: rawWh.id, qty: 10, unit_cost: 20,
    });
    await request(app).post('/api/erp/mfg/machines').send({ machine: 'CNC', hourly_rate: 60 });
    await request(app).post('/api/erp/mfg/components').send({
      sku: 'COMP-BRACKET', name: 'Bracket', machine: 'CNC',
      std_minutes: 30, raw_item_id: rawItem.body.id, raw_qty_per_unit: 100, scrap_pct: 0,
    });
    db.prepare(
      "INSERT INTO parts (id, name, project_id, erp_sku, completed_qty) VALUES (1, 'Bracket', 1, 'COMP-BRACKET', 0)"
    ).run();
    const { posting } = recordShopfloorPosting(db, { job_id: 42, part_id: 1, printer_id: 1, qty: 2, note: 'set-ready' });
    confirmPosting(db, posting.id, {});
    return posting;
  }

  test('creates a brand new delivery note from a posted posting', async () => {
    const posting = await seedPostedComponent(app, db);
    const customer = await makeCustomer(app);

    const res = await request(app).post(`/api/erp/postings/${posting.id}/attach-to-delivery`).send({
      customer_id: customer.id, unit_price: 15,
    });
    expect(res.status).toBe(201);
    expect(res.body.doc_type).toBe('delivery');
    expect(res.body.lines).toHaveLength(1);
    expect(res.body.lines[0]).toMatchObject({ sku: 'COMP-BRACKET', qty: 2, unit_price: 15, job_id: 42, posting_id: posting.id });
  });

  test('appends to an existing draft delivery note when doc_id is given', async () => {
    const posting = await seedPostedComponent(app, db);
    const customer = await makeCustomer(app);
    const delivery = await request(app).post('/api/erp/sales-docs').send({
      doc_type: 'delivery', customer_id: customer.id,
      lines: [{ description: 'Existing line', qty: 1, unit_price: 5 }],
    });

    const res = await request(app).post(`/api/erp/postings/${posting.id}/attach-to-delivery`).send({
      doc_id: delivery.body.id, unit_price: 15,
    });
    expect(res.status).toBe(201);
    expect(res.body.id).toBe(delivery.body.id);
    expect(res.body.lines).toHaveLength(2);
  });

  test('refuses to attach a pending (not yet posted) posting', async () => {
    const { posting } = recordShopfloorPosting(db, { job_id: 7, part_id: null, printer_id: 1, qty: 1, note: 'pending' });
    const customer = await makeCustomer(app);
    const res = await request(app).post(`/api/erp/postings/${posting.id}/attach-to-delivery`).send({
      customer_id: customer.id,
    });
    expect(res.status).toBe(409);
  });

  test('404 for an unknown posting', async () => {
    const customer = await makeCustomer(app);
    const res = await request(app).post('/api/erp/postings/999/attach-to-delivery').send({ customer_id: customer.id });
    expect(res.status).toBe(404);
  });
});
