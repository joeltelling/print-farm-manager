// Regression tests (PR review): printer lifecycle operations must drop the Creality
// driver's cached persistent connection. Before this, deleting, decommissioning, or
// re-typing a Creality printer left its WebSocket, heartbeat, and reconnect loop
// running in the driver's module-level map until the server restarted.
//
// The creality driver is mocked; these tests assert the routes call disposeConnection()
// at the right moments. Driver-side disposal behavior is covered in creality-driver.test.js.

jest.mock('../drivers/creality', () => ({
  getStatus: jest.fn(),
  uploadAndPrint: jest.fn(),
  cancelJob: jest.fn(),
  checkIfPrinting: jest.fn(),
  disposeConnection: jest.fn(),
  disposeAllConnections: jest.fn(),
}));

const request  = require('supertest');
const express  = require('express');
const Database = require('better-sqlite3');
const { disposeConnection } = require('../drivers/creality');

// ── In-memory DB setup ────────────────────────────────────────────────────────

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
    CREATE TABLE projects (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      status TEXT DEFAULT 'active',
      priority INTEGER DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE parts (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id    INTEGER NOT NULL REFERENCES projects(id),
      name          TEXT NOT NULL,
      target_qty    INTEGER NOT NULL,
      completed_qty INTEGER DEFAULT 0,
      status        TEXT DEFAULT 'open',
      sort_order    INTEGER DEFAULT 0,
      created_at    INTEGER NOT NULL,
      updated_at    INTEGER NOT NULL
    );
    CREATE TABLE gcodes (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      part_id         INTEGER NOT NULL REFERENCES parts(id),
      printer_model   TEXT NOT NULL,
      filename        TEXT NOT NULL,
      filepath        TEXT NOT NULL,
      parts_per_plate INTEGER NOT NULL,
      est_print_secs  INTEGER,
      created_at      INTEGER NOT NULL
    );
    CREATE TABLE jobs (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      part_id         INTEGER NOT NULL REFERENCES parts(id),
      printer_id      INTEGER NOT NULL REFERENCES printers(id),
      gcode_id        INTEGER NOT NULL REFERENCES gcodes(id),
      parts_per_plate INTEGER NOT NULL,
      status          TEXT DEFAULT 'queued',
      started_at      INTEGER,
      finished_at     INTEGER,
      created_at      INTEGER NOT NULL
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

  // Models must be registered (and belong to the right connector) for the
  // create/update routes' model-connector validation to pass.
  db.prepare("INSERT INTO printer_models (model_id, label, connector) VALUES ('k1', 'K1', 'creality')").run();
  db.prepare("INSERT INTO printer_models (model_id, label, connector) VALUES ('mk4s', 'MK4S', 'prusa')").run();

  app = express();
  app.use(express.json());
  app.use('/api/printers', require('../routes/printers')(db));
});

beforeEach(() => {
  jest.clearAllMocks();
});

// ── Seed helper ───────────────────────────────────────────────────────────────

let nextName = 1;
function seedPrinter(overrides = {}) {
  const now = Date.now();
  const r = db.prepare(`
    INSERT INTO printers (name, ip, type, model, status, is_held, is_active, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    overrides.name      ?? `Printer_${nextName++}`,
    overrides.ip        ?? '10.0.0.1',
    overrides.type      ?? 'creality',
    overrides.model     ?? 'k1',
    overrides.status    ?? 'IDLE',
    overrides.is_held   ?? 0,
    overrides.is_active ?? 1,
    now
  );
  return r.lastInsertRowid;
}

// ── Lifecycle operations drop the driver connection ───────────────────────────

describe('printer lifecycle drops the Creality driver connection', () => {
  test('DELETE /api/printers/:id', async () => {
    const id = seedPrinter();
    const res = await request(app).delete(`/api/printers/${id}`);
    expect(res.status).toBe(200);
    expect(disposeConnection).toHaveBeenCalledWith(id);
  });

  test('POST /api/printers/:id/decommission', async () => {
    const id = seedPrinter();
    const res = await request(app).post(`/api/printers/${id}/decommission`);
    expect(res.status).toBe(200);
    expect(disposeConnection).toHaveBeenCalledWith(id);
  });

  test('POST /api/printers/:id/complete-and-decommission', async () => {
    const id = seedPrinter();
    const res = await request(app).post(`/api/printers/${id}/complete-and-decommission`);
    expect(res.status).toBe(200);
    expect(disposeConnection).toHaveBeenCalledWith(id);
  });

  test('POST /api/printers/:id/mark-job-failure (no tracked job still decommissions)', async () => {
    const id = seedPrinter();
    const res = await request(app).post(`/api/printers/${id}/mark-job-failure`);
    expect(res.status).toBe(200);
    expect(disposeConnection).toHaveBeenCalledWith(id);
  });

  test('PUT /api/printers/:id switching the connector type off creality', async () => {
    const id = seedPrinter();
    // The model must move with the connector: model-connector validation rejects
    // a type change that leaves the printer on the other connector's model.
    const res = await request(app).put(`/api/printers/${id}`).send({ type: 'prusa', model: 'mk4s' });
    expect(res.status).toBe(200);
    expect(disposeConnection).toHaveBeenCalledWith(id);
  });
});

// ── Operations that must NOT drop the connection ──────────────────────────────

describe('non-lifecycle updates keep the connection', () => {
  test('PUT /api/printers/:id editing other fields leaves the connection alone', async () => {
    const id = seedPrinter();
    // An IP change is intentionally excluded too: the driver itself re-keys its
    // connection when the stored host stops matching (see creality-driver.test.js).
    const res = await request(app).put(`/api/printers/${id}`).send({ name: 'K1_renamed', ip: '10.0.0.99' });
    expect(res.status).toBe(200);
    expect(disposeConnection).not.toHaveBeenCalled();
  });

  test('lifecycle operations on a non-creality printer never touch the creality driver', async () => {
    const id = seedPrinter({ type: 'prusa', model: 'mk4s' });
    await request(app).post(`/api/printers/${id}/decommission`);
    const res = await request(app).delete(`/api/printers/${id}`);
    expect(res.status).toBe(200);
    expect(disposeConnection).not.toHaveBeenCalled();
  });
});
