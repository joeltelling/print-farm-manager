// Guards the Tier 1 connection-leak fix: every path that removes a printer from the
// fleet (delete + all four decommission routes) must call drivers.dropConnection with
// the printer row, so a stateful driver's socket + reconnect loop is torn down. Without
// these assertions, deleting any of the wiring lines in routes/printers.js is silent.

const request  = require('supertest');
const express  = require('express');
const Database = require('better-sqlite3');

const drivers = require('../drivers');

let db;
let app;
let dropSpy;

beforeAll(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE printers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE, ip TEXT NOT NULL, api_key TEXT NOT NULL DEFAULT '',
      group_name TEXT, type TEXT DEFAULT 'prusa', model TEXT NOT NULL,
      status TEXT DEFAULT 'UNKNOWN', is_held INTEGER DEFAULT 1, is_active INTEGER DEFAULT 1,
      decommissioned_at INTEGER, decommission_note TEXT, serial_number TEXT DEFAULT '',
      loaded_material TEXT, loaded_color TEXT,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE projects (
      id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, status TEXT DEFAULT 'active',
      priority INTEGER DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
    CREATE TABLE parts (
      id INTEGER PRIMARY KEY AUTOINCREMENT, project_id INTEGER NOT NULL REFERENCES projects(id),
      name TEXT NOT NULL, target_qty INTEGER NOT NULL, completed_qty INTEGER DEFAULT 0,
      status TEXT DEFAULT 'open', sort_order INTEGER DEFAULT 0,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
    CREATE TABLE gcodes (
      id INTEGER PRIMARY KEY AUTOINCREMENT, part_id INTEGER NOT NULL REFERENCES parts(id),
      printer_model TEXT NOT NULL, filename TEXT NOT NULL, filepath TEXT NOT NULL,
      parts_per_plate INTEGER NOT NULL, est_print_secs INTEGER, created_at INTEGER NOT NULL
    );
    CREATE TABLE jobs (
      id INTEGER PRIMARY KEY AUTOINCREMENT, part_id INTEGER NOT NULL REFERENCES parts(id),
      printer_id INTEGER NOT NULL REFERENCES printers(id), gcode_id INTEGER NOT NULL REFERENCES gcodes(id),
      parts_per_plate INTEGER NOT NULL, status TEXT DEFAULT 'queued',
      started_at INTEGER, finished_at INTEGER, created_at INTEGER NOT NULL
    );
    CREATE TABLE printer_models ( model_id TEXT PRIMARY KEY, label TEXT NOT NULL, connector TEXT NOT NULL );
  `);

  app = express();
  app.use(express.json());
  app.use('/api/printers', require('../routes/printers')(db));
});

beforeEach(() => {
  // Spy on the real registry singleton the router imported. dropConnection is a
  // no-op for stateless/unloaded drivers, but the spy still records the call.
  dropSpy = jest.spyOn(drivers, 'dropConnection').mockImplementation(() => {});
});

afterEach(() => dropSpy.mockRestore());

function seedPrinter(overrides = {}) {
  const now = Date.now();
  return db.prepare(
    `INSERT INTO printers (name, ip, type, model, status, is_held, is_active, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    overrides.name ?? `P_${now}_${Math.floor(Math.random() * 1e6)}`,
    overrides.ip ?? '10.0.0.9',
    overrides.type ?? 'prusa',
    overrides.model ?? 'mk4s',
    overrides.status ?? 'FINISHED',
    overrides.is_held ?? 1,
    overrides.is_active ?? 1,
    now
  ).lastInsertRowid;
}

function seedFinishedJob(printerId) {
  const now = Date.now();
  const proj = db.prepare(`INSERT INTO projects (name, status, created_at, updated_at) VALUES ('P','active',?,?)`).run(now, now).lastInsertRowid;
  const part = db.prepare(`INSERT INTO parts (project_id, name, target_qty, completed_qty, status, created_at, updated_at) VALUES (?, 'Part', 10, 4, 'open', ?, ?)`).run(proj, now, now).lastInsertRowid;
  const gc = db.prepare(`INSERT INTO gcodes (part_id, printer_model, filename, filepath, parts_per_plate, created_at) VALUES (?, 'mk4s', 'p.bgcode', '/x/p.bgcode', 4, ?)`).run(part, now).lastInsertRowid;
  db.prepare(`INSERT INTO jobs (printer_id, part_id, gcode_id, parts_per_plate, status, started_at, finished_at, created_at) VALUES (?, ?, ?, 4, 'finished', ?, ?, ?)`).run(printerId, part, gc, now - 3600000, now, now - 3600000);
}

test('DELETE /:id drops the connection, with the printer row (id + type)', async () => {
  const id = seedPrinter({ type: 'bambu', model: 'x1c' });
  const res = await request(app).delete(`/api/printers/${id}`);
  expect(res.status).toBe(200);
  expect(dropSpy).toHaveBeenCalledTimes(1);
  expect(dropSpy).toHaveBeenCalledWith(expect.objectContaining({ id, type: 'bambu' }));
});

test('POST /:id/decommission drops the connection', async () => {
  const id = seedPrinter();
  const res = await request(app).post(`/api/printers/${id}/decommission`);
  expect(res.status).toBe(200);
  expect(dropSpy).toHaveBeenCalledWith(expect.objectContaining({ id }));
});

test('POST /:id/complete-and-decommission drops the connection', async () => {
  const id = seedPrinter();
  seedFinishedJob(id);
  const res = await request(app).post(`/api/printers/${id}/complete-and-decommission`).send({ note: 'maint' });
  expect(res.status).toBe(200);
  expect(dropSpy).toHaveBeenCalledWith(expect.objectContaining({ id }));
});

test('POST /:id/mark-job-failure drops the connection', async () => {
  const id = seedPrinter();
  seedFinishedJob(id);
  const res = await request(app).post(`/api/printers/${id}/mark-job-failure`);
  expect(res.status).toBe(200);
  expect(dropSpy).toHaveBeenCalledWith(expect.objectContaining({ id }));
});

test('a 404 (unknown printer) does not call dropConnection', async () => {
  await request(app).delete('/api/printers/99999');
  await request(app).post('/api/printers/99999/decommission');
  expect(dropSpy).not.toHaveBeenCalled();
});

// --- PUT: connection-defining fields ---------------------------------------

test.each([
  ['ip', { ip: '10.0.0.99' }],
  ['api_key (access code)', { api_key: 'new-access-code' }],
  ['serial_number', { serial_number: 'SN-CHANGED' }],
])('PUT that changes %s drops the stale connection with the OLD printer row', async (_label, body) => {
  const id = seedPrinter({ type: 'bambu', model: 'x1c', ip: '10.0.0.9', api_key: 'old', serial_number: 'SN-OLD' });
  const res = await request(app).put(`/api/printers/${id}`).send(body);
  expect(res.status).toBe(200);
  // Dropped using the pre-update row (old type/id) so a driver change tears down
  // the connection under its previous driver.
  expect(dropSpy).toHaveBeenCalledWith(expect.objectContaining({ id, type: 'bambu' }));
});

test('PUT that changes only a non-connection field does NOT drop the connection', async () => {
  const id = seedPrinter({ type: 'bambu', model: 'x1c' });
  const res = await request(app).put(`/api/printers/${id}`).send({ group_name: 'Bay 4' });
  expect(res.status).toBe(200);
  expect(dropSpy).not.toHaveBeenCalled();
});
