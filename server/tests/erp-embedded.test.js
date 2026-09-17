const express = require('express');
const request = require('supertest');
const Database = require('better-sqlite3');
const { ensureErpSchema } = require('../erp/schema');
const { mountErp } = require('../erp');
const { buildSalesReportPdf } = require('../erp/pdf');

function buildApp() {
  const db = new Database(':memory:');
  ensureErpSchema(db);
  const app = express();
  app.use(express.json());
  app.use('/api/erp', mountErp(db));
  return { app, db };
}

describe('embedded ERP API (Acres parity)', () => {
  let app;
  let db;

  beforeEach(() => {
    ({ app, db } = buildApp());
  });

  afterEach(() => db.close());

  test('health embedded', async () => {
    const res = await request(app).get('/api/erp/health');
    expect(res.status).toBe(200);
    expect(res.body.erp).toBe('embedded');
  });

  test('mfg components + calculate cost + sales order flow', async () => {
    let rawWh = db.prepare("SELECT id FROM warehouse WHERE lower(code)='raw'").get();
    if (!rawWh) {
      const whRaw = await request(app).post('/api/erp/warehouses').send({ code: 'raw', name: 'Raw' });
      expect(whRaw.status).toBe(201);
      rawWh = whRaw.body;
    }
    const rawWhId = rawWh.id;
    const fin = db.prepare("SELECT id FROM warehouse WHERE lower(code)='fin_good'").get();
    const comp = db.prepare("SELECT id FROM warehouse WHERE lower(code)='comp'").get();

    const rawItem = await request(app).post('/api/erp/items').send({
      sku: 'RAW-PLA', name: 'PLA Raw', dimension: 'WEIGHT',
      display_uom_code: 'G', purchase_uom_code: 'KG', warehouse_id: rawWhId,
    });
    expect(rawItem.status).toBe(201);

    await request(app).post('/api/erp/inventory/receive_by_sku').send({
      sku: 'RAW-PLA', warehouse_id: rawWhId, qty: 10, unit_cost: 20,
    });

    await request(app).post('/api/erp/mfg/machines').send({ machine: 'CNC', hourly_rate: 60 });

    const mfg = await request(app).post('/api/erp/mfg/components').send({
      sku: 'COMP-BRACKET', name: 'Bracket Comp', machine: 'CNC',
      std_minutes: 30, raw_item_id: rawItem.body.id, raw_qty_per_unit: 100, scrap_pct: 10,
    });
    expect([200, 201]).toContain(mfg.status);
    expect(mfg.body.raw_sku).toBe('RAW-PLA');

    const cost = await request(app).post('/api/erp/mfg/calculate-component-cost').send({
      raw_sku: 'RAW-PLA', raw_qty_per_unit: 100, scrap_pct: 10,
      std_minutes: 30, machine: 'CNC',
    });
    expect(cost.status).toBe(200);
    expect(cost.body.material_cost_per_unit).toBeCloseTo(2.2, 4);
    expect(cost.body.time_cost_per_unit).toBe(30);

    const fg = await request(app).post('/api/erp/items').send({
      sku: 'FG-BRACKET', name: 'Bracket FG', dimension: 'COUNT',
      display_uom_code: 'EA', purchase_uom_code: 'EA', warehouse_id: fin.id,
    });
    expect(fg.status).toBe(201);

    // Ensure component item exists in catalog (created by mfg upsert)
    const compItem = db.prepare("SELECT * FROM item WHERE sku='COMP-BRACKET'").get();
    expect(compItem).toBeTruthy();

    const bom = await request(app).post('/api/erp/bom').send({
      item_id: fg.body.id, name: 'Bracket BOM', labor_hours_per_unit: 0.1,
    });
    expect([200, 201]).toContain(bom.status);

    await request(app).post(`/api/erp/bom/${bom.body.id}/line`).send({
      component_item_id: compItem.id, qty: 1,
    });

    const bomCost = await request(app).get(`/api/erp/bom/${bom.body.id}/calculate-cost`);
    expect(bomCost.status).toBe(200);
    expect(bomCost.body.lines[0]).toMatchObject({
      sku: 'COMP-BRACKET', unit_cost: 32.2, subtotal: 32.2,
    });
    expect(bomCost.body.total_cost).toBeCloseTo(34.2, 4);
    const bomList = await request(app).get('/api/erp/bom');
    expect(bomList.body[0]).toMatchObject({
      material_cost: 32.2, labor_cost: 2, total_cost: 34.2,
    });

    // Seed component stock path uses RAW on complete; receive enough raw already.
    // Also put some raw display conversion: purchase KG, display G, qty 10 KG received.
    const wo = await request(app).post('/api/erp/wo').send({
      item_id: fg.body.id, qty_planned: 1, warehouse_code: 'fin_good',
    });
    expect(wo.status).toBe(201);

    const done = await request(app).post(`/api/erp/wo/${wo.body.id}/complete`).send({});
    expect(done.status).toBe(200);
    expect(done.body.status).toBe('closed');
    const fgReceipt = db.prepare(
      'SELECT unit_cost FROM stock_move WHERE wo_id = ? AND item_id = ? AND qty > 0'
    ).get(wo.body.id, fg.body.id);
    expect(fgReceipt.unit_cost).toBeCloseTo(34.2, 4);
    expect(db.prepare(
      'SELECT resource, cost FROM wo_labor WHERE wo_id = ? ORDER BY id'
    ).all(wo.body.id)).toEqual([
      expect.objectContaining({ resource: 'CNC', cost: 30 }),
      expect.objectContaining({ resource: 'LABOR', cost: 2 }),
    ]);

    const orderItems = await request(app).get('/api/erp/sales/order/items');
    expect(orderItems.status).toBe(200);
    expect(orderItems.body.some(i => i.sku === 'FG-BRACKET')).toBe(true);

    const sale = await request(app).post('/api/erp/sales/orders').send({ sku: 'FG-BRACKET', qty: 1 });
    expect(sale.status).toBe(201);
    expect(sale.body.sku).toBe('FG-BRACKET');

    const hist = await request(app).get('/api/erp/sales/orders/report');
    expect(hist.status).toBe(200);
    expect(hist.body.total_items).toBeGreaterThanOrEqual(1);

    const csv = await request(app).get('/api/erp/sales/orders/report?format=csv');
    expect(csv.status).toBe(200);
    expect(csv.headers['content-type']).toMatch(/csv/);

    const pdf = await request(app).get('/api/erp/sales/orders/report?format=pdf');
    expect(pdf.status).toBe(200);
    expect(pdf.headers['content-type']).toMatch(/pdf/);

    const reset = await request(app).post(`/api/erp/sales/pricing/${fg.body.id}/reset`);
    expect(reset.status).toBe(200);

    // unused vars silence
    expect(comp.id).toBeTruthy();
  });

  test('locations and inventory dashboard', async () => {
    const wh = db.prepare('SELECT id FROM warehouse LIMIT 1').get();
    const loc = await request(app).post('/api/erp/locations').send({
      warehouse_id: wh.id, code: '01A01',
    });
    expect(loc.status).toBe(201);
    const list = await request(app).get('/api/erp/locations');
    expect(list.body.some(l => l.code === '01A01')).toBe(true);
    const dash = await request(app).get('/api/erp/inventory/dashboard');
    expect(dash.status).toBe(200);
    expect(dash.body).toHaveProperty('total_value');
  });

  test('validates receive location ownership and keeps receive idempotent', async () => {
    const raw = db.prepare("SELECT id FROM warehouse WHERE code = 'raw'").get();
    const comp = db.prepare("SELECT id FROM warehouse WHERE code = 'comp'").get();
    const location = await request(app).post('/api/erp/locations').send({
      warehouse_id: raw.id, code: '01A01',
    });
    expect(location.status).toBe(201);

    const item = await request(app).post('/api/erp/items').send({
      sku: 'RAW-IDEM', name: 'Idempotent raw', dimension: 'WEIGHT',
      display_uom_code: 'G', purchase_uom_code: 'KG', warehouse_id: raw.id,
      item_role: 'raw', sourcing: 'outsource',
    });
    expect(item.status).toBe(201);

    const wrongWarehouse = await request(app).post('/api/erp/inventory/receive_by_sku').send({
      sku: 'RAW-IDEM', warehouse_id: comp.id, location_id: location.body.id,
      qty: 1, unit_cost: 10,
    });
    expect(wrongWarehouse.status).toBe(400);
    expect(wrongWarehouse.body.error).toMatch(/does not belong/);

    const negativeCost = await request(app).post('/api/erp/inventory/receive_by_sku').send({
      sku: 'RAW-IDEM', warehouse_id: raw.id, qty: 1, unit_cost: -1,
    });
    expect(negativeCost.status).toBe(400);
    expect(negativeCost.body.error).toMatch(/unit_cost/);

    const payload = {
      sku: 'RAW-IDEM', warehouse_id: raw.id, location_id: location.body.id,
      qty: 2, unit_cost: 10, idem_key: 'receive-raw-idem-1',
    };
    const first = await request(app).post('/api/erp/inventory/receive_by_sku').send(payload);
    const replay = await request(app).post('/api/erp/inventory/receive_by_sku').send(payload);
    expect(first.status).toBe(200);
    expect(replay.status).toBe(200);
    expect(replay.body).toMatchObject({ move_id: first.body.move_id, idempotent: true });
    expect(db.prepare("SELECT COUNT(*) AS n FROM stock_move WHERE idem_key = 'receive-raw-idem-1'").get().n).toBe(1);
  });

  test('work order completion honors its destination warehouse and location', async () => {
    const targetWh = await request(app).post('/api/erp/warehouses').send({
      code: 'qa_finished', name: 'QA Finished',
    });
    expect(targetWh.status).toBe(201);
    const targetLoc = await request(app).post('/api/erp/locations').send({
      warehouse_id: targetWh.body.id, code: '10Q10',
    });
    expect(targetLoc.status).toBe(201);
    const wrongLoc = await request(app).post('/api/erp/locations').send({
      warehouse_id: db.prepare("SELECT id FROM warehouse WHERE code = 'comp'").get().id,
      code: '10C10',
    });
    expect(wrongLoc.status).toBe(201);

    const item = await request(app).post('/api/erp/items').send({
      sku: 'FG-QA', name: 'QA finished good', dimension: 'COUNT',
      display_uom_code: 'EA', purchase_uom_code: 'EA', warehouse_id: targetWh.body.id,
      item_role: 'product', sourcing: 'manufactured',
    });
    expect(item.status).toBe(201);
    const bom = await request(app).post('/api/erp/bom').send({
      item_id: item.body.id, name: 'QA BOM', labor_hours_per_unit: 0,
    });
    expect(bom.status).toBe(201);

    const mismatch = await request(app).post('/api/erp/wo').send({
      item_id: item.body.id, qty_planned: 2,
      warehouse_code: 'qa_finished', location_code: wrongLoc.body.code,
    });
    expect(mismatch.status).toBe(400);
    expect(mismatch.body.error).toMatch(/does not belong/);

    const wo = await request(app).post('/api/erp/wo').send({
      item_id: item.body.id, qty_planned: 2,
      warehouse_code: 'qa_finished', location_code: targetLoc.body.code,
    });
    expect(wo.status).toBe(201);
    const done = await request(app).post(`/api/erp/wo/${wo.body.id}/complete`).send({});
    expect(done.status).toBe(200);

    const receipt = db.prepare(
      'SELECT warehouse_id, location_id, qty FROM stock_move WHERE wo_id = ? AND item_id = ?'
    ).get(wo.body.id, item.body.id);
    expect(receipt).toMatchObject({
      warehouse_id: targetWh.body.id,
      location_id: targetLoc.body.id,
      qty: 2,
    });
    expect(db.prepare(
      'SELECT qty_on_hand FROM item_cost WHERE item_id = ? AND warehouse_id = ?'
    ).get(item.body.id, targetWh.body.id).qty_on_hand).toBe(2);
  });

  test('sales PDF includes every row across multiple pages', () => {
    const rows = Array.from({ length: 120 }, (_, i) => ({
      sale_date: '2026-09-17T10:00:00.000Z',
      sku: `SKU-${i + 1}`,
      qty: 1,
      unit_price: 2,
      total_price: 2,
      unit_margin: 1,
    }));
    const pdf = buildSalesReportPdf({ title: 'Sales', subtitle: 'All', summary: '120 rows', rows });
    const source = pdf.toString('latin1');
    expect(source).toContain('/Count 3');
    expect(source).toContain('SKU-120');
  });

  test('ERP dashboard + product/component roles + sync', async () => {
    db.exec(`CREATE TABLE IF NOT EXISTS projects (
      id INTEGER PRIMARY KEY, name TEXT, description TEXT, status TEXT, priority INTEGER, created_at INTEGER, updated_at INTEGER
    )`);
    db.exec(`CREATE TABLE IF NOT EXISTS parts (
      id INTEGER PRIMARY KEY, project_id INTEGER, name TEXT, target_qty INTEGER, completed_qty INTEGER DEFAULT 0, status TEXT DEFAULT 'open', created_at INTEGER, updated_at INTEGER, erp_sku TEXT, sort_order INTEGER
    )`);
    db.exec(`CREATE TABLE IF NOT EXISTS printers (
      id INTEGER PRIMARY KEY, name TEXT, model TEXT, status TEXT, is_active INTEGER
    );
    CREATE TABLE IF NOT EXISTS filament_types (
      id INTEGER PRIMARY KEY, name TEXT
    );
    CREATE TABLE IF NOT EXISTS filament_colors (
      id INTEGER PRIMARY KEY, type_id INTEGER, name TEXT
    )`);
    db.prepare('INSERT INTO projects (id, name, status, priority, created_at, updated_at) VALUES (1, ?, ?, 0, 1, 1)')
      .run('Demo Project', 'active');
    db.prepare('INSERT INTO parts (id, project_id, name, target_qty, completed_qty, status, created_at, updated_at, sort_order) VALUES (1, 1, ?, 10, 0, ?, 1, 1, 0)')
      .run('Demo Part', 'open');
    db.prepare("INSERT INTO printers (id, name, model, status, is_active) VALUES (1, 'P1', 'MK4', 'IDLE', 1)").run();
    db.prepare("INSERT INTO filament_types (id, name) VALUES (1, 'PLA')").run();
    db.prepare("INSERT INTO filament_colors (id, type_id, name) VALUES (1, 1, 'Black')").run();

    app.use('/api/projects', require('../routes/projects')(db));
    app.use('/api/parts', require('../routes/parts')(db));
    app.use('/api/shared', require('../routes/shared')(db));
    app.use('/api/bridge', require('../routes/bridge')(db));

    const sync = await request(app).post('/api/erp/sync');
    expect(sync.status).toBe(200);
    expect(sync.body.created.products).toBeGreaterThanOrEqual(1);
    expect(sync.body.created.components).toBeGreaterThanOrEqual(1);
    expect(sync.body.created.machines).toBeGreaterThanOrEqual(1);
    expect(sync.body.created.raw_materials).toBeGreaterThanOrEqual(1);

    const machines = await request(app).get('/api/erp/mfg/machines');
    expect(machines.status).toBe(200);
    const p1 = machines.body.find(m => m.machine === 'P1');
    expect(p1).toEqual(expect.objectContaining({
      machine: 'P1',
      printer_id: 1,
      printer_name: 'P1',
      printer_model: 'MK4',
      printer_status: 'IDLE',
      hourly_rate: 0,
      needs_erp_data: true,
    }));

    const dash = await request(app).get('/api/erp/dashboard');
    expect(dash.status).toBe(200);
    expect(dash.body.links.product_is).toBe('project');
    expect(dash.body.links.component_is).toBe('part');
    expect(dash.body.counts.products).toBeGreaterThanOrEqual(1);
    expect(dash.body.sync.needs_attention).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'machine', name: 'P1' }),
      expect.objectContaining({ kind: 'raw', name: 'PLA Black' }),
    ]));

    const rateSave = await request(app).post('/api/erp/mfg/machines').send({
      machine: 'P1', hourly_rate: 18.5,
    });
    expect(rateSave.status).toBe(200);
    expect(rateSave.body).toEqual(expect.objectContaining({
      machine: 'P1',
      hourly_rate: 18.5,
      printer_name: 'P1',
      printer_model: 'MK4',
      needs_erp_data: false,
    }));

    const syncedRaw = db.prepare("SELECT * FROM item WHERE item_role = 'raw' AND sku LIKE 'FIL-%'").get();
    const rawWarehouse = db.prepare("SELECT id FROM warehouse WHERE code = 'raw'").get();
    const rawReceipt = await request(app).post('/api/erp/inventory/receive_by_sku').send({
      sku: syncedRaw.sku, warehouse_id: rawWarehouse.id, qty: 1, unit_cost: 20,
    });
    expect(rawReceipt.status).toBe(200);
    expect(db.prepare('SELECT needs_erp_data FROM item WHERE id = ?').get(syncedRaw.id).needs_erp_data).toBe(0);
    const dashAfterReceipt = await request(app).get('/api/erp/dashboard');
    expect(dashAfterReceipt.body.sync.needs_attention).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'raw', id: syncedRaw.id }),
    ]));

    const product = db.prepare("SELECT * FROM item WHERE project_id = 1").get();
    expect(product.item_role).toBe('product');
    const put = await request(app).put(`/api/erp/items/${product.id}`).send({ sourcing: 'outsource' });
    expect(put.status).toBe(200);
    expect(put.body.sourcing).toBe('outsource');
    expect(put.body.needs_erp_data).toBe(0);

    const projectCreate = await request(app).post('/api/projects').send({
      name: 'Buy Project', sourcing: 'outsource',
    });
    expect(projectCreate.status).toBe(201);
    expect(projectCreate.body.erp_product).toMatchObject({
      item_role: 'product', sourcing: 'outsource',
    });
    const badProjectSourcing = await request(app).post('/api/projects').send({
      name: 'Bad source project', sourcing: 'invalid',
    });
    expect(badProjectSourcing.status).toBe(400);

    const partCreate = await request(app).post('/api/parts').send({
      project_id: projectCreate.body.id, name: 'Buy Part', target_qty: 2,
      sourcing: 'outsource',
    });
    expect(partCreate.status).toBe(201);
    expect(partCreate.body.erp_component).toMatchObject({
      item_role: 'component', sourcing: 'outsource',
    });
    const badPartSourcing = await request(app).post('/api/parts').send({
      project_id: projectCreate.body.id, name: 'Bad source part', target_qty: 1,
      sourcing: 'invalid',
    });
    expect(badPartSourcing.status).toBe(400);
    expect(db.prepare('SELECT completed_qty FROM parts WHERE id = ?').get(partCreate.body.id).completed_qty).toBe(0);

    const materials = await request(app).get('/api/shared/materials');
    expect(materials.status).toBe(200);
    expect(materials.body.filament_colors).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'Black', hex: null, hex_color: null }),
    ]));
    db.exec('ALTER TABLE filament_colors ADD COLUMN hex_color TEXT');
    db.prepare("UPDATE filament_colors SET hex_color = '#111111' WHERE id = 1").run();
    const currentMaterials = await request(app).get('/api/shared/materials');
    expect(currentMaterials.status).toBe(200);
    expect(currentMaterials.body.filament_colors[0]).toMatchObject({
      name: 'Black', hex: '#111111', hex_color: '#111111',
    });

    const badBridge = await request(app).post('/api/bridge/units-completed').send({ qty: -1 });
    expect(badBridge.status).toBe(400);

    const bridge = await request(app).post('/api/bridge/units-completed').send({
      sku: partCreate.body.erp_component.sku, qty: 2, shopfloor_job_ref: 501,
    });
    expect([200, 201]).toContain(bridge.status);
    expect(bridge.body.posting.status).toBe('pending');
    expect(bridge.body.linked_part.id).toBe(partCreate.body.id);
    expect(db.prepare('SELECT completed_qty FROM parts WHERE id = ?').get(partCreate.body.id).completed_qty).toBe(0);
  });

  test('GET /wo filters q in SQL before LIMIT', async () => {
    const fin = db.prepare("SELECT id FROM warehouse WHERE lower(code)='fin_good'").get();
    for (let i = 0; i < 5; i++) {
      const fg = await request(app).post('/api/erp/items').send({
        sku: `FG-Q-${i}`, name: i === 4 ? 'NeedleFind' : `Other ${i}`,
        dimension: 'COUNT', display_uom_code: 'EA', purchase_uom_code: 'EA', warehouse_id: fin.id,
        item_role: 'product', sourcing: 'manufactured',
      });
      const bom = await request(app).post('/api/erp/bom').send({
        item_id: fg.body.id, name: `BOM ${i}`, labor_hours_per_unit: 0,
      });
      await request(app).post('/api/erp/wo').send({
        item_id: fg.body.id, qty_planned: 1, warehouse_code: 'fin_good',
      });
      expect([200, 201]).toContain(bom.status);
    }
    const found = await request(app).get('/api/erp/wo?q=NeedleFind&limit=2');
    expect(found.status).toBe(200);
    expect(found.body.length).toBe(1);
    expect(found.body[0].item_name).toBe('NeedleFind');
  });
});
