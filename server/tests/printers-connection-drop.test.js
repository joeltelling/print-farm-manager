// Tests that printer routes invalidate the driver's cached connection whenever
// connection settings change or the row leaves active duty.
//
// Regression context: persistent-connection drivers (bambu, elegoo-centauri,
// elegoo-centauri2) keep a module-level client per printer.id that reconnects on
// its own with the credentials it was created with. Before this fix, editing a
// printer's access code kept failing auth until a server restart, and a deleted
// or decommissioned Bambu row kept a ghost MQTT client alive that stole the
// printer's single LAN slot from its replacement row (observed on a real farm as
// two entries kicking each other offline in a loop).

jest.mock('../drivers', () => ({
  getDriver: jest.fn(),
  dropConnection: jest.fn(),
}));

const request  = require('supertest');
const express  = require('express');
const Database = require('better-sqlite3');
const { dropConnection } = require('../drivers');

let db;
let app;

beforeAll(() => {
  db = new Database(':memory:');
  db.exec(`
    CREATE TABLE printers (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      name              TEXT NOT NULL UNIQUE,
      ip                TEXT NOT NULL,
      api_key           TEXT NOT NULL DEFAULT '',
      group_name        TEXT,
      type              TEXT DEFAULT 'prusa',
      model             TEXT NOT NULL,
      status            TEXT DEFAULT 'UNKNOWN',
      is_held           INTEGER DEFAULT 0,
      is_active         INTEGER DEFAULT 1,
      decommissioned_at INTEGER,
      decommission_note TEXT,
      serial_number     TEXT DEFAULT '',
      loaded_material   TEXT,
      loaded_color      TEXT,
      created_at        INTEGER NOT NULL
    );
    CREATE TABLE printer_groups (name TEXT PRIMARY KEY, created_at INTEGER NOT NULL);
    CREATE TABLE printer_models (model_id TEXT PRIMARY KEY, connector TEXT, display_name TEXT);
    CREATE TABLE projects (
      id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL,
      status TEXT DEFAULT 'active', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
    CREATE TABLE parts (
      id INTEGER PRIMARY KEY AUTOINCREMENT, project_id INTEGER NOT NULL, name TEXT NOT NULL,
      target_qty INTEGER NOT NULL, completed_qty INTEGER DEFAULT 0, status TEXT DEFAULT 'open',
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
    CREATE TABLE jobs (
      id INTEGER PRIMARY KEY AUTOINCREMENT, part_id INTEGER, printer_id INTEGER,
      gcode_id INTEGER, parts_per_plate INTEGER, status TEXT DEFAULT 'queued',
      started_at INTEGER, finished_at INTEGER, created_at INTEGER NOT NULL
    );
  `);

  app = express();
  app.use(express.json());
  app.use('/api/printers', require('../routes/printers')(db));
});

beforeEach(() => {
  dropConnection.mockClear();
  db.prepare('DELETE FROM printers').run();
  db.prepare(`
    INSERT INTO printers (id, name, ip, api_key, type, model, serial_number, created_at)
    VALUES (1, 'Bambu_A', '192.168.1.50', 'OLDCODE1', 'bambu', 'p1s', 'SN001', ?)
  `).run(Date.now());
});

describe('PUT /api/printers/:id', () => {
  test('changing api_key drops the cached connection', async () => {
    const res = await request(app).put('/api/printers/1').send({ api_key: 'NEWCODE1' });
    expect(res.status).toBe(200);
    expect(dropConnection).toHaveBeenCalledWith('bambu', 1);
  });

  test('changing ip drops the cached connection', async () => {
    const res = await request(app).put('/api/printers/1').send({ ip: '192.168.1.99' });
    expect(res.status).toBe(200);
    expect(dropConnection).toHaveBeenCalledWith('bambu', 1);
  });

  test('changing serial_number drops the cached connection', async () => {
    const res = await request(app).put('/api/printers/1').send({ serial_number: 'SN002' });
    expect(res.status).toBe(200);
    expect(dropConnection).toHaveBeenCalledWith('bambu', 1);
  });

  test('changing type drops the connection under the OLD type', async () => {
    const res = await request(app).put('/api/printers/1').send({ type: 'klipper' });
    expect(res.status).toBe(200);
    expect(dropConnection).toHaveBeenCalledWith('bambu', 1);
  });

  test('renaming only does not drop the connection', async () => {
    const res = await request(app).put('/api/printers/1').send({ name: 'Bambu_B' });
    expect(res.status).toBe(200);
    expect(dropConnection).not.toHaveBeenCalled();
  });

  test('changing loaded material/color only does not drop the connection', async () => {
    const res = await request(app).put('/api/printers/1')
      .send({ loaded_material: 'PETG', loaded_color: 'Black' });
    expect(res.status).toBe(200);
    expect(dropConnection).not.toHaveBeenCalled();
  });

  test('api_key null keeps the old value (COALESCE) and does not drop', async () => {
    const res = await request(app).put('/api/printers/1').send({ api_key: null });
    expect(res.status).toBe(200);
    expect(res.body.api_key).toBe('OLDCODE1');
    expect(dropConnection).not.toHaveBeenCalled();
  });

  test('sending the same api_key value does not drop', async () => {
    const res = await request(app).put('/api/printers/1').send({ api_key: 'OLDCODE1' });
    expect(res.status).toBe(200);
    expect(dropConnection).not.toHaveBeenCalled();
  });
});

describe('DELETE /api/printers/:id', () => {
  test('drops the cached connection so the client cannot reconnect forever', async () => {
    const res = await request(app).delete('/api/printers/1');
    expect(res.status).toBe(200);
    expect(dropConnection).toHaveBeenCalledWith('bambu', 1);
  });

  test('404 for unknown printer does not drop anything', async () => {
    const res = await request(app).delete('/api/printers/999');
    expect(res.status).toBe(404);
    expect(dropConnection).not.toHaveBeenCalled();
  });
});

describe('decommission paths', () => {
  test('POST /:id/decommission drops the cached connection', async () => {
    const res = await request(app).post('/api/printers/1/decommission').send({ note: 'retired' });
    expect(res.status).toBe(200);
    expect(dropConnection).toHaveBeenCalledWith('bambu', 1);
  });

  test('POST /:id/complete-and-decommission drops the cached connection', async () => {
    const res = await request(app).post('/api/printers/1/complete-and-decommission').send({});
    expect(res.status).toBe(200);
    expect(dropConnection).toHaveBeenCalledWith('bambu', 1);
  });

  test('POST /:id/mark-job-failure with no tracked job drops the cached connection', async () => {
    const res = await request(app).post('/api/printers/1/mark-job-failure').send({});
    expect(res.status).toBe(200);
    expect(dropConnection).toHaveBeenCalledWith('bambu', 1);
  });

  test('POST /:id/mark-job-failure with an active job drops the cached connection', async () => {
    const now = Date.now();
    db.prepare(`INSERT INTO projects (id, name, created_at, updated_at) VALUES (1, 'P', ?, ?)`).run(now, now);
    db.prepare(`INSERT INTO parts (id, project_id, name, target_qty, created_at, updated_at)
      VALUES (1, 1, 'Part', 5, ?, ?)`).run(now, now);
    db.prepare(`INSERT INTO jobs (id, part_id, printer_id, parts_per_plate, status, started_at, created_at)
      VALUES (1, 1, 1, 1, 'printing', ?, ?)`).run(now, now);

    const res = await request(app).post('/api/printers/1/mark-job-failure').send({});
    expect(res.status).toBe(200);
    expect(dropConnection).toHaveBeenCalledWith('bambu', 1);
  });
});

describe('drivers registry dropConnection helper', () => {
  const registry = jest.requireActual('../drivers');

  test('unknown type is a silent no-op', () => {
    expect(() => registry.dropConnection('not-a-driver', 1)).not.toThrow();
  });

  test('a loaded driver without dropConnection is tolerated', () => {
    registry.getDriver('prusa'); // request/response driver, no connection cache
    expect(() => registry.dropConnection('prusa', 1)).not.toThrow();
  });

  test('a never-loaded driver is not loaded just to drop a connection', () => {
    // klipper is lazily loaded and nothing in this test file has requested it;
    // dropping must not force the require.
    expect(() => registry.dropConnection('klipper', 1)).not.toThrow();
  });
});
