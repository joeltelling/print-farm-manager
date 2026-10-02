// Regression tests for the dispatch sweep after a targeting edit.
//
// The real-world trigger: an operator set a project to PETG and loaded PETG on an idle
// printer, the "Why isn't this printing?" check said the part was ready, and nothing
// printed. An idle printer only asks the scheduler for work when the poller sees it
// transition into IDLE (the printerIdle event), so an edit that makes an already-idle
// printer a match was never acted on until some unrelated sweep ran. Each route that
// changes what a printer can print (printer filament/group/model, project filament and
// groups, per-G-code targeting) now sweeps.
//
// Every route file declares its Express router at module scope, so jest.resetModules()
// runs before each require to get a fresh router bound to this test's db and mock.

const request  = require('supertest');
const express  = require('express');
const Database = require('better-sqlite3');

let db;
let scheduler;

function buildApp(mount, routeFile) {
  jest.resetModules();
  const app = express();
  app.use(express.json());
  app.use(mount, require(routeFile)(db, scheduler));
  return app;
}

beforeEach(() => {
  scheduler = { sweepIdlePrinters: jest.fn() };
  db = new Database(':memory:');
  db.exec(`
    CREATE TABLE printers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE, ip TEXT NOT NULL, api_key TEXT NOT NULL DEFAULT '',
      group_name TEXT, type TEXT DEFAULT 'prusa', model TEXT NOT NULL,
      status TEXT DEFAULT 'IDLE', is_held INTEGER DEFAULT 0, is_active INTEGER DEFAULT 1,
      decommissioned_at INTEGER, decommission_note TEXT, serial_number TEXT DEFAULT '',
      loaded_material TEXT, loaded_color TEXT, created_at INTEGER NOT NULL
    );
    CREATE TABLE printer_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT, printer_id INTEGER NOT NULL,
      event_type TEXT NOT NULL, note TEXT, created_at INTEGER NOT NULL
    );
    CREATE TABLE printer_models (model_id TEXT PRIMARY KEY, label TEXT NOT NULL, connector TEXT NOT NULL);
    CREATE TABLE printer_groups (name TEXT PRIMARY KEY, created_at INTEGER NOT NULL);
    CREATE TABLE projects (
      id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, description TEXT,
      status TEXT DEFAULT 'active', priority INTEGER DEFAULT 0,
      required_material TEXT, required_color TEXT, allowed_groups TEXT,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
    CREATE TABLE parts (
      id INTEGER PRIMARY KEY AUTOINCREMENT, project_id INTEGER NOT NULL, name TEXT NOT NULL,
      target_qty INTEGER NOT NULL, completed_qty INTEGER DEFAULT 0, status TEXT DEFAULT 'open',
      sort_order INTEGER DEFAULT 0, print_time_seconds INTEGER,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
    CREATE TABLE gcodes (
      id INTEGER PRIMARY KEY AUTOINCREMENT, part_id INTEGER NOT NULL, printer_model TEXT NOT NULL,
      filename TEXT NOT NULL, filepath TEXT NOT NULL, parts_per_plate INTEGER NOT NULL,
      est_print_secs INTEGER, material_grams REAL, ams_slot INTEGER,
      allowed_groups TEXT, required_material TEXT, required_color TEXT, created_at INTEGER NOT NULL
    );
    CREATE TABLE jobs (
      id INTEGER PRIMARY KEY AUTOINCREMENT, part_id INTEGER, printer_id INTEGER, gcode_id INTEGER,
      parts_per_plate INTEGER, status TEXT DEFAULT 'queued',
      started_at INTEGER, finished_at INTEGER, created_at INTEGER
    );
    INSERT INTO printer_models VALUES ('mk4s', 'MK4S', 'prusa');
  `);
  const now = Date.now();
  db.prepare("INSERT INTO printers (name, ip, model, created_at) VALUES ('P1', '10.0.0.1', 'mk4s', ?)").run(now);
  db.prepare("INSERT INTO projects (name, created_at, updated_at) VALUES ('Proj', ?, ?)").run(now, now);
  db.prepare("INSERT INTO parts (project_id, name, target_qty, created_at, updated_at) VALUES (1, 'Part', 5, ?, ?)").run(now, now);
  db.prepare("INSERT INTO gcodes (part_id, printer_model, filename, filepath, parts_per_plate, created_at) VALUES (1, 'mk4s', 'f.gcode', 'f.gcode', 1, ?)").run(now);
});

describe('PUT /api/printers/:id', () => {
  test('sweeps when loaded material changes on an idle printer', async () => {
    const app = buildApp('/api/printers', '../routes/printers');
    const res = await request(app).put('/api/printers/1').send({ loaded_material: 'PETG' });
    expect(res.status).toBe(200);
    expect(scheduler.sweepIdlePrinters).toHaveBeenCalledTimes(1);
  });

  test('sweeps when group or color changes', async () => {
    const app = buildApp('/api/printers', '../routes/printers');
    await request(app).put('/api/printers/1').send({ group_name: 'Rack A' });
    await request(app).put('/api/printers/1').send({ loaded_color: 'Black' });
    expect(scheduler.sweepIdlePrinters).toHaveBeenCalledTimes(2);
  });

  test('does not sweep for an edit that cannot change eligibility', async () => {
    const app = buildApp('/api/printers', '../routes/printers');
    await request(app).put('/api/printers/1').send({ name: 'Renamed' });
    expect(scheduler.sweepIdlePrinters).not.toHaveBeenCalled();
  });

  test('does not sweep when the filament is re-saved unchanged', async () => {
    db.prepare("UPDATE printers SET loaded_material = 'PETG' WHERE id = 1").run();
    const app = buildApp('/api/printers', '../routes/printers');
    await request(app).put('/api/printers/1').send({ loaded_material: 'PETG' });
    expect(scheduler.sweepIdlePrinters).not.toHaveBeenCalled();
  });

  test('trims loaded material so "PETG " still matches a PETG requirement', async () => {
    const app = buildApp('/api/printers', '../routes/printers');
    const res = await request(app).put('/api/printers/1').send({ loaded_material: ' PETG ', loaded_color: '  ' });
    expect(res.body.loaded_material).toBe('PETG');
    expect(res.body.loaded_color).toBeNull();
  });

  test('404 for an unknown printer, with no sweep', async () => {
    const app = buildApp('/api/printers', '../routes/printers');
    const res = await request(app).put('/api/printers/999').send({ loaded_material: 'PETG' });
    expect(res.status).toBe(404);
    expect(scheduler.sweepIdlePrinters).not.toHaveBeenCalled();
  });
});

describe('project targeting routes', () => {
  test('PUT /api/projects/:id/filament sweeps', async () => {
    const app = buildApp('/api/projects', '../routes/projects');
    const res = await request(app).put('/api/projects/1/filament').send({ required_material: 'PETG' });
    expect(res.status).toBe(200);
    expect(res.body.required_material).toBe('PETG');
    expect(scheduler.sweepIdlePrinters).toHaveBeenCalledTimes(1);
  });

  test('PUT /api/projects/:id/groups sweeps', async () => {
    const app = buildApp('/api/projects', '../routes/projects');
    const res = await request(app).put('/api/projects/1/groups').send({ allowed_groups: ['Rack A'] });
    expect(res.status).toBe(200);
    expect(scheduler.sweepIdlePrinters).toHaveBeenCalledTimes(1);
  });

  test('404 on an unknown project does not sweep', async () => {
    const app = buildApp('/api/projects', '../routes/projects');
    const res = await request(app).put('/api/projects/999/filament').send({ required_material: 'PETG' });
    expect(res.status).toBe(404);
    expect(scheduler.sweepIdlePrinters).not.toHaveBeenCalled();
  });
});

describe('PUT /api/gcodes/:id', () => {
  test('sweeps when G-code targeting changes', async () => {
    const app = buildApp('/api/gcodes', '../routes/gcodes');
    const res = await request(app).put('/api/gcodes/1').send({ required_material: 'PETG' });
    expect(res.status).toBe(200);
    expect(scheduler.sweepIdlePrinters).toHaveBeenCalledTimes(1);
  });

  test('does not sweep for an estimate-only edit', async () => {
    const app = buildApp('/api/gcodes', '../routes/gcodes');
    const res = await request(app).put('/api/gcodes/1').send({ print_time: '2h' });
    expect(res.status).toBe(200);
    expect(scheduler.sweepIdlePrinters).not.toHaveBeenCalled();
  });
});
