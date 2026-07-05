// Unit tests for the scheduler sweep triggered by POST /api/gcodes/upload — a part only
// becomes a real dispatch candidate once it has a matching gcodes row (the scheduler's
// candidate query joins on it), so the sweep on the part/project reactivation paths alone
// can't pick up a brand-new part until its first G-code is uploaded.
//
// Uses jest.resetModules() before each require, same as parts-reactivate-sweep.test.js:
// server/routes/gcodes.js declares its Express router at module scope like every route
// file in this codebase, so a second require('../routes/gcodes') in the same process
// would otherwise reuse that router and only the first-registered handler would run.

const request  = require('supertest');
const express  = require('express');
const Database = require('better-sqlite3');
const path     = require('path');
const fs       = require('fs');
const os       = require('os');

const GCODE_DIR = path.join(__dirname, '..', 'gcode');

let db;
const uploadedFiles = [];

function makeTempFile(name) {
  const p = path.join(os.tmpdir(), name);
  fs.writeFileSync(p, Buffer.from('G28\nG1 X0 Y0 Z0'));
  return p;
}

function buildApp(scheduler) {
  jest.resetModules();
  const gcodesRouterFactory = require('../routes/gcodes');
  const app = express();
  app.use(express.json());
  app.use('/api/gcodes', scheduler !== undefined ? gcodesRouterFactory(db, scheduler) : gcodesRouterFactory(db));
  return app;
}

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE projects (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL, status TEXT DEFAULT 'draft',
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
    CREATE TABLE parts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id INTEGER NOT NULL REFERENCES projects(id),
      name TEXT NOT NULL, target_qty INTEGER NOT NULL,
      completed_qty INTEGER DEFAULT 0, status TEXT DEFAULT 'open',
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
    CREATE TABLE gcodes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      part_id INTEGER NOT NULL REFERENCES parts(id),
      printer_model TEXT NOT NULL,
      filename TEXT NOT NULL, filepath TEXT NOT NULL,
      parts_per_plate INTEGER NOT NULL,
      est_print_secs INTEGER, material_grams REAL, ams_slot INTEGER,
      allowed_groups TEXT, required_material TEXT, required_color TEXT,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE printer_models (
      model_id TEXT PRIMARY KEY, label TEXT NOT NULL, connector TEXT NOT NULL
    );
    INSERT INTO printer_models VALUES ('mk4s', 'MK4S', 'prusa');
  `);

  const now = Date.now();
  db.prepare('INSERT INTO projects (name, created_at, updated_at) VALUES (?, ?, ?)').run('Proj', now, now);
  db.prepare('INSERT INTO parts (project_id, name, target_qty, created_at, updated_at) VALUES (1, ?, 10, ?, ?)').run('Part A', now, now);

  if (!fs.existsSync(GCODE_DIR)) fs.mkdirSync(GCODE_DIR, { recursive: true });
});

afterAll(() => {
  for (const f of uploadedFiles) {
    try { fs.unlinkSync(path.join(GCODE_DIR, f)); } catch (_) {}
  }
});

describe('POST /api/gcodes/upload — sweeps for idle printers', () => {
  test('calls sweepIdlePrinters after a successful upload', async () => {
    const sweepIdlePrinters = jest.fn();
    const app = buildApp({ sweepIdlePrinters });

    const tmp = makeTempFile('sweep_test.bgcode');
    const res = await request(app)
      .post('/api/gcodes/upload')
      .field('part_id', '1')
      .field('parts_per_plate', '4')
      .field('printer_model', 'mk4s')
      .attach('file', tmp);

    expect(res.status).toBe(201);
    uploadedFiles.push(res.body.filepath);
    expect(sweepIdlePrinters).toHaveBeenCalledTimes(1);
  });

  test('does not call sweepIdlePrinters when the upload is rejected (missing fields)', async () => {
    const sweepIdlePrinters = jest.fn();
    const app = buildApp({ sweepIdlePrinters });

    const tmp = makeTempFile('sweep_reject.bgcode');
    const res = await request(app)
      .post('/api/gcodes/upload')
      .field('part_id', '1')
      // parts_per_plate omitted — should 400 before ever reaching the sweep
      .field('printer_model', 'mk4s')
      .attach('file', tmp);

    expect(res.status).toBe(400);
    expect(sweepIdlePrinters).not.toHaveBeenCalled();
  });

  test('does not throw when no scheduler is provided', async () => {
    const app = buildApp(null);

    const tmp = makeTempFile('sweep_none.bgcode');
    const res = await request(app)
      .post('/api/gcodes/upload')
      .field('part_id', '1')
      .field('parts_per_plate', '4')
      .field('printer_model', 'mk4s')
      .attach('file', tmp);

    expect(res.status).toBe(201);
    uploadedFiles.push(res.body.filepath);
  });
});
