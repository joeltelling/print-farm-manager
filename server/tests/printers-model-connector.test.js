// Regression tests (PR review): a printer's model must belong to its connector on
// every write path (single add, update, CSV import). The Settings UI already filters
// model pickers by connector, but a direct API/CSV write could previously pair, for
// example, a keyless creality printer with the prusa 'mk4s' model; the scheduler
// selects G-code by printer.model alone, so that mismatch dispatches incompatible
// G-code to physical hardware.

const request  = require('supertest');
const express  = require('express');
const Database = require('better-sqlite3');

let db;
let app;

beforeAll(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE printers (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      name             TEXT NOT NULL UNIQUE,
      ip               TEXT NOT NULL,
      api_key          TEXT NOT NULL DEFAULT '',
      group_name       TEXT,
      type             TEXT DEFAULT 'prusa',
      model            TEXT NOT NULL,
      status           TEXT DEFAULT 'UNKNOWN',
      is_held          INTEGER DEFAULT 1,
      is_active        INTEGER DEFAULT 1,
      decommissioned_at INTEGER,
      decommission_note TEXT,
      serial_number    TEXT DEFAULT '',
      loaded_material  TEXT,
      loaded_color     TEXT,
      created_at       INTEGER NOT NULL
    );
    CREATE TABLE printer_models (
      model_id  TEXT PRIMARY KEY,
      label     TEXT NOT NULL,
      connector TEXT NOT NULL
    );
    CREATE TABLE printer_groups (
      name       TEXT PRIMARY KEY,
      created_at INTEGER NOT NULL
    );
  `);

  db.prepare("INSERT INTO printer_models (model_id, label, connector) VALUES ('mk4s', 'MK4S', 'prusa')").run();
  db.prepare("INSERT INTO printer_models (model_id, label, connector) VALUES ('k1', 'K1', 'creality')").run();
  db.prepare("INSERT INTO printer_models (model_id, label, connector) VALUES ('k1-max', 'K1 Max', 'creality')").run();

  app = express();
  app.use(express.json());
  app.use('/api/printers', require('../routes/printers')(db));
});

let nextName = 1;
function seedPrinter(overrides = {}) {
  const now = Date.now();
  const r = db.prepare(`
    INSERT INTO printers (name, ip, type, model, is_active, created_at)
    VALUES (?, ?, ?, ?, 1, ?)
  `).run(
    overrides.name  ?? `MC_Printer_${nextName++}`,
    overrides.ip    ?? '10.0.0.1',
    overrides.type  ?? 'creality',
    overrides.model ?? 'k1',
    now
  );
  return r.lastInsertRowid;
}

// ── POST /api/printers ────────────────────────────────────────────────────────

describe('POST /api/printers model-connector validation', () => {
  test("rejects a creality printer with another connector's model", async () => {
    const res = await request(app)
      .post('/api/printers')
      .send({ name: 'BadPair', ip: '10.0.0.2', type: 'creality', model: 'mk4s' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/connector/);
    expect(db.prepare("SELECT COUNT(*) AS c FROM printers WHERE name = 'BadPair'").get().c).toBe(0);
  });

  test("rejects a prusa printer with a creality model", async () => {
    const res = await request(app)
      .post('/api/printers')
      .send({ name: 'BadPair2', ip: '10.0.0.3', api_key: 'k', type: 'prusa', model: 'k1' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/connector/);
  });

  test('accepts a matching pair (creality + k1, no api_key)', async () => {
    const res = await request(app)
      .post('/api/printers')
      .send({ name: 'GoodPair', ip: '10.0.0.4', type: 'creality', model: 'k1' });
    expect(res.status).toBe(201);
    expect(res.body.model).toBe('k1');
  });
});

// ── PUT /api/printers/:id ─────────────────────────────────────────────────────

describe('PUT /api/printers/:id model-connector validation', () => {
  test('rejects a connector change that leaves the old connector model in place', async () => {
    const id = seedPrinter();
    const res = await request(app).put(`/api/printers/${id}`).send({ type: 'prusa' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/connector/);
    expect(db.prepare('SELECT type FROM printers WHERE id = ?').get(id).type).toBe('creality');
  });

  test("rejects a model change to another connector's model", async () => {
    const id = seedPrinter();
    const res = await request(app).put(`/api/printers/${id}`).send({ model: 'mk4s' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/connector/);
    expect(db.prepare('SELECT model FROM printers WHERE id = ?').get(id).model).toBe('k1');
  });

  test('accepts changing connector and model together', async () => {
    const id = seedPrinter();
    const res = await request(app).put(`/api/printers/${id}`).send({ type: 'prusa', model: 'mk4s', api_key: 'k' });
    expect(res.status).toBe(200);
    expect(res.body.type).toBe('prusa');
    expect(res.body.model).toBe('mk4s');
  });

  test('accepts a model change within the same connector', async () => {
    const id = seedPrinter();
    const res = await request(app).put(`/api/printers/${id}`).send({ model: 'k1-max' });
    expect(res.status).toBe(200);
    expect(res.body.model).toBe('k1-max');
  });

  test('leaves unrelated edits alone (no type/model in body, even with legacy mismatched data)', async () => {
    const id = seedPrinter({ type: 'prusa', model: 'k1' }); // legacy bad pair already in the DB
    const res = await request(app).put(`/api/printers/${id}`).send({ name: 'RenamedLegacy' });
    expect(res.status).toBe(200);
    expect(res.body.name).toBe('RenamedLegacy');
  });
});

// ── POST /api/printers/import (CSV) ───────────────────────────────────────────

describe('CSV import model-connector validation', () => {
  test('flags mismatched rows and imports matching ones', async () => {
    const csv = [
      'name,ip,api_key,type,model',
      'CSV_Good,10.0.1.1,,creality,k1',
      'CSV_Bad,10.0.1.2,,creality,mk4s',
    ].join('\n');

    const res = await request(app)
      .post('/api/printers/import')
      .attach('file', Buffer.from(csv), 'printers.csv');

    expect(res.status).toBe(200);
    expect(res.body.imported).toBe(1);
    expect(res.body.flagged).toHaveLength(1);
    expect(res.body.flagged[0].reason).toMatch(/connector/);
    expect(db.prepare("SELECT COUNT(*) AS c FROM printers WHERE name = 'CSV_Good'").get().c).toBe(1);
    expect(db.prepare("SELECT COUNT(*) AS c FROM printers WHERE name = 'CSV_Bad'").get().c).toBe(0);
  });
});
