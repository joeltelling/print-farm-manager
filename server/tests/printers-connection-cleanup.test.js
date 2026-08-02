// Regression test for GitHub issue #45: a decommissioned printer kept its
// persistent driver connection (Bambu MQTT, Elegoo websocket) alive, so the
// underlying client library kept reconnecting and flooding logs forever
// after decommission. Every code path that sets is_active = 0 must drop the
// connection cache. Uses an in-memory SQLite DB; the driver registry and
// event log are mocked so no real network connection is opened.

const request  = require('supertest');
const express  = require('express');
const Database = require('better-sqlite3');

jest.mock('../drivers', () => ({
  getDriver: jest.fn(),
  dropConnection: jest.fn(),
}));
jest.mock('../events', () => ({ insert: jest.fn() }));

const { dropConnection } = require('../drivers');

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

  app = express();
  app.use(express.json());
  app.use('/api/printers', require('../routes/printers')(db));
});

beforeEach(() => {
  dropConnection.mockClear();
});

function seedPrinter(overrides = {}) {
  const now = Date.now();
  const r = db.prepare(`
    INSERT INTO printers (name, ip, type, model, status, is_held, is_active, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    overrides.name    ?? `Printer_${now}_${Math.random()}`,
    overrides.ip      ?? '10.0.0.1',
    overrides.type    ?? 'bambu',
    overrides.model   ?? 'x1c',
    overrides.status  ?? 'FINISHED',
    overrides.is_held  ?? 1,
    overrides.is_active ?? 1,
    now
  );
  return r.lastInsertRowid;
}

function seedProject() {
  const now = Date.now();
  return db.prepare(
    `INSERT INTO projects (name, status, created_at, updated_at) VALUES ('Test Project', 'active', ?, ?)`
  ).run(now, now).lastInsertRowid;
}

function seedPart(projectId, targetQty = 10, completedQty = 0) {
  const now = Date.now();
  return db.prepare(
    `INSERT INTO parts (project_id, name, target_qty, completed_qty, status, created_at, updated_at)
     VALUES (?, 'Test Part', ?, ?, 'open', ?, ?)`
  ).run(projectId, targetQty, completedQty, now, now).lastInsertRowid;
}

function seedGcode(partId) {
  const now = Date.now();
  return db.prepare(
    `INSERT INTO gcodes (part_id, printer_model, filename, filepath, parts_per_plate, created_at)
     VALUES (?, 'x1c', 'part.3mf', '/fake/path/part.3mf', 4, ?)`
  ).run(partId, now).lastInsertRowid;
}

function seedJob(printerId, partId, gcodeId, status = 'finished', partsPerPlate = 4) {
  const now = Date.now();
  return db.prepare(
    `INSERT INTO jobs (printer_id, part_id, gcode_id, parts_per_plate, status, started_at, finished_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(printerId, partId, gcodeId, partsPerPlate, status, now - 3600000, status === 'finished' ? now : null, now - 3600000)
    .lastInsertRowid;
}

test('POST /:id/decommission drops the driver connection cache', async () => {
  const printerId = seedPrinter();

  const res = await request(app).post(`/api/printers/${printerId}/decommission`);
  expect(res.status).toBe(200);
  expect(dropConnection).toHaveBeenCalledWith(expect.objectContaining({ id: printerId }));
});

test('POST /:id/complete-and-decommission drops the driver connection cache', async () => {
  const projectId = seedProject();
  const partId    = seedPart(projectId, 10, 4);
  const gcodeId   = seedGcode(partId);
  const printerId = seedPrinter();
  seedJob(printerId, partId, gcodeId, 'finished', 4);

  const res = await request(app).post(`/api/printers/${printerId}/complete-and-decommission`);
  expect(res.status).toBe(200);
  expect(dropConnection).toHaveBeenCalledWith(expect.objectContaining({ id: printerId }));
});

test('POST /:id/mark-job-failure drops the driver connection cache (no tracked job)', async () => {
  const printerId = seedPrinter();

  const res = await request(app).post(`/api/printers/${printerId}/mark-job-failure`);
  expect(res.status).toBe(200);
  expect(dropConnection).toHaveBeenCalledWith(expect.objectContaining({ id: printerId }));
});

test('POST /:id/mark-job-failure drops the driver connection cache (tracked job failed)', async () => {
  const projectId = seedProject();
  const partId    = seedPart(projectId, 10, 4);
  const gcodeId   = seedGcode(partId);
  const printerId = seedPrinter();
  seedJob(printerId, partId, gcodeId, 'finished', 4);

  const res = await request(app).post(`/api/printers/${printerId}/mark-job-failure`);
  expect(res.status).toBe(200);
  expect(dropConnection).toHaveBeenCalledWith(expect.objectContaining({ id: printerId }));
});
