const express = require('express');
const request = require('supertest');
const Database = require('better-sqlite3');
const { ensureErpSchema } = require('../erp/schema');
const { mountErp } = require('../erp');
const {
  recordShopfloorPosting,
  confirmPosting,
  dismissPosting,
  listPostings,
} = require('../erp/postings');

function buildApp() {
  const db = new Database(':memory:');
  ensureErpSchema(db);
  // Minimal shopfloor parts table for SKU resolution
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
  `);
  const app = express();
  app.use(express.json());
  app.use('/api/erp', mountErp(db));
  const bridge = require('../routes/bridge')(db);
  app.use('/api/bridge', bridge);
  return { app, db };
}

async function seedComponentRecipe(app, db) {
  let rawWh = db.prepare("SELECT id FROM warehouse WHERE lower(code)='raw'").get();
  if (!rawWh) {
    const wh = await request(app).post('/api/erp/warehouses').send({ code: 'raw', name: 'Raw' });
    rawWh = wh.body;
  }
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
  return { rawWh, rawItem };
}

describe('ERP shopfloor postings queue', () => {
  let app;
  let db;

  beforeEach(() => {
    ({ app, db } = buildApp());
  });

  afterEach(() => db.close());

  test('record is idempotent per job_id', async () => {
    await seedComponentRecipe(app, db);
    const a = recordShopfloorPosting(db, {
      job_id: 42, part_id: 1, printer_id: 1, qty: 2, note: 'first',
    });
    expect(a.created).toBe(true);
    expect(a.posting.status).toBe('pending');
    expect(a.posting.erp_sku).toBe('COMP-BRACKET');

    const b = recordShopfloorPosting(db, {
      job_id: 42, part_id: 1, printer_id: 1, qty: 2, note: 'second',
    });
    expect(b.created).toBe(false);
    expect(b.posting.id).toBe(a.posting.id);

    const rows = listPostings(db, { status: 'pending' });
    expect(rows).toHaveLength(1);
  });

  test('confirm posts stock and double-confirm returns 409', async () => {
    await seedComponentRecipe(app, db);
    const { posting } = recordShopfloorPosting(db, {
      job_id: 7, part_id: 1, qty: 1, note: 'set-ready',
    });

    const res = await request(app)
      .post(`/api/erp/postings/${posting.id}/confirm`)
      .send({});
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('posted');

    const moves = db.prepare('SELECT * FROM stock_move WHERE note LIKE ?').all(`%posting #${posting.id}%`);
    expect(moves.length).toBeGreaterThanOrEqual(2); // issue + receive

    const again = await request(app)
      .post(`/api/erp/postings/${posting.id}/confirm`)
      .send({});
    expect(again.status).toBe(409);
  });

  test('dismiss removes from pending without stock moves', async () => {
    await seedComponentRecipe(app, db);
    const { posting } = recordShopfloorPosting(db, { job_id: 9, part_id: 1, qty: 1 });
    const before = db.prepare('SELECT COUNT(*) AS n FROM stock_move').get().n;

    const res = await request(app)
      .post(`/api/erp/postings/${posting.id}/dismiss`)
      .send({ note: 'not needed' });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('dismissed');
    expect(db.prepare('SELECT COUNT(*) AS n FROM stock_move').get().n).toBe(before);
  });

  test('shortage requires acknowledge_shortage then allows negative stock', async () => {
    await seedComponentRecipe(app, db);
    // Drain almost all raw so one unit of component (100g = 0.1 kg) still fits,
    // but qty=1000 will be short.
    const { posting } = recordShopfloorPosting(db, {
      job_id: 11, part_id: 1, qty: 1000, note: 'big',
    });

    const blocked = await request(app)
      .post(`/api/erp/postings/${posting.id}/confirm`)
      .send({});
    expect(blocked.status).toBe(409);
    expect(blocked.body.acknowledge_required).toBe(true);
    expect(blocked.body.missing?.length).toBeGreaterThan(0);

    const ok = await request(app)
      .post(`/api/erp/postings/${posting.id}/confirm`)
      .send({ acknowledge_shortage: true });
    expect(ok.status).toBe(200);
    expect(ok.body.status).toBe('posted');
  });

  test('bridge units-completed creates pending posting without touching completed_qty', async () => {
    await seedComponentRecipe(app, db);
    const beforeQty = db.prepare('SELECT completed_qty FROM parts WHERE id = 1').get().completed_qty;

    const res = await request(app).post('/api/bridge/units-completed').send({
      sku: 'COMP-BRACKET', qty: 3, shopfloor_job_ref: 99,
    });
    expect([200, 201]).toContain(res.status);
    expect(res.body.posting.status).toBe('pending');
    expect(res.body.posting.qty).toBe(3);

    const afterQty = db.prepare('SELECT completed_qty FROM parts WHERE id = 1').get().completed_qty;
    expect(afterQty).toBe(beforeQty);

    // Idempotent re-post same job
    const again = await request(app).post('/api/bridge/units-completed').send({
      sku: 'COMP-BRACKET', qty: 3, shopfloor_job_ref: 99,
    });
    expect(again.status).toBe(200);
    expect(again.body.created).toBe(false);
  });

  test('dashboard exposes pending_postings count', async () => {
    await seedComponentRecipe(app, db);
    recordShopfloorPosting(db, { job_id: 1, part_id: 1, qty: 1 });
    recordShopfloorPosting(db, { job_id: 2, part_id: 1, qty: 1 });
    const res = await request(app).get('/api/erp/dashboard');
    expect(res.status).toBe(200);
    expect(res.body.counts.pending_postings).toBe(2);
  });

  test('confirmPosting helper and dismiss helper edge cases', () => {
    expect(() => confirmPosting(db, 99999)).toThrow(/not found/i);
    expect(() => dismissPosting(db, 99999)).toThrow(/not found/i);
  });

  test('measured telemetry values inventory at actual cost; otherwise standard', async () => {
    await seedComponentRecipe(app, db);
    db.exec(`
      CREATE TABLE IF NOT EXISTS jobs (
        id INTEGER PRIMARY KEY,
        printing_seconds REAL DEFAULT 0,
        material_grams_actual REAL,
        energy_kwh REAL,
        telemetry_quality TEXT DEFAULT 'none'
      );
    `);
    // 60 minutes printing for qty=1 vs std 30 min → actual time cost doubles
    db.prepare(`
      INSERT INTO jobs (id, printing_seconds, material_grams_actual, energy_kwh, telemetry_quality)
      VALUES (55, 3600, 100, 0, 'measured')
    `).run();

    const { posting } = recordShopfloorPosting(db, {
      job_id: 55, part_id: 1, printer_id: 1, qty: 1,
    });
    expect(posting.telemetry_quality).toBe('measured');
    expect(posting.actual_minutes).toBe(60);

    const preview = await request(app).get(`/api/erp/postings/${posting.id}`);
    expect(preview.status).toBe(200);
    expect(preview.body.cost_basis).toBe('actual');
    expect(preview.body.actual_unit_cost).toBeGreaterThan(preview.body.std_unit_cost);

    const confirmed = await request(app)
      .post(`/api/erp/postings/${posting.id}/confirm`)
      .send({});
    expect(confirmed.status).toBe(200);
    expect(confirmed.body.cost_basis).toBe('actual');

    // Fallback path: no measured quality
    db.prepare(`
      INSERT INTO jobs (id, printing_seconds, telemetry_quality)
      VALUES (56, 10, 'none')
    `).run();
    const { posting: p2 } = recordShopfloorPosting(db, {
      job_id: 56, part_id: 1, qty: 1,
    });
    const prev2 = await request(app).get(`/api/erp/postings/${p2.id}`);
    expect(prev2.body.cost_basis).toBe('standard');
  });

  test('cost-variance and analytics reports return rows shape', async () => {
    await seedComponentRecipe(app, db);
    db.exec(`
      CREATE TABLE IF NOT EXISTS printers (
        id INTEGER PRIMARY KEY, name TEXT, is_active INTEGER DEFAULT 1
      );
      CREATE TABLE IF NOT EXISTS projects (
        id INTEGER PRIMARY KEY, name TEXT
      );
      CREATE TABLE IF NOT EXISTS jobs (
        id INTEGER PRIMARY KEY,
        part_id INTEGER, printer_id INTEGER, status TEXT,
        parts_per_plate INTEGER DEFAULT 1,
        printing_seconds REAL DEFAULT 0, energy_kwh REAL,
        material_grams_actual REAL,
        finished_at INTEGER, started_at INTEGER, created_at INTEGER
      );
      CREATE TABLE IF NOT EXISTS printer_status_history (
        id INTEGER PRIMARY KEY, printer_id INTEGER, status TEXT,
        started_at INTEGER, ended_at INTEGER, duration_ms INTEGER
      );
    `);
    const cv = await request(app).get('/api/erp/reports/cost-variance');
    expect(cv.status).toBe(200);
    expect(Array.isArray(cv.body.rows)).toBe(true);
    const pf = await request(app).get('/api/erp/reports/profitability');
    expect(pf.status).toBe(200);
    const oee = await request(app).get('/api/erp/reports/machine-oee');
    expect(oee.status).toBe(200);
    expect(Array.isArray(oee.body.rows)).toBe(true);
  });
});
