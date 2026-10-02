// POST /api/gcodes/upload reads the print time and material weight out of the sliced file
// itself, so the schedule gets real block lengths without the operator retyping what the
// slicer already computed.
//
// The precedence that matters: what the file says beats what the client inferred from the
// filename. The client posts filename-derived values (see GcodeUploadPanel in
// client/src/pages/Projects.jsx), and a filename convention is a weaker source than the
// slicer's own numbers.

const request  = require('supertest');
const express  = require('express');
const Database = require('better-sqlite3');
const path     = require('path');
const fs       = require('fs');

const { buildZip, buildSliceInfoConfig } = require('./helpers/build-zip');

const GCODE_DIR = path.join(__dirname, '..', 'gcode');
const uploadedFiles = [];

let db;
let app;

function buildApp() {
  jest.resetModules();
  const app = express();
  app.use(express.json());
  app.use('/api/gcodes', require('../routes/gcodes')(db, null));
  return app;
}

function upload(filename, buffer, fields = {}) {
  const req = request(app)
    .post('/api/gcodes/upload')
    .field('part_id', '1')
    .field('parts_per_plate', '1')
    .field('printer_model', 'mk4s');
  for (const [k, v] of Object.entries(fields)) req.field(k, v);
  return req.attach('file', buffer, filename);
}

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE projects (
      id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL,
      status TEXT DEFAULT 'draft', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
    CREATE TABLE parts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id INTEGER NOT NULL REFERENCES projects(id),
      name TEXT NOT NULL, target_qty INTEGER NOT NULL, completed_qty INTEGER DEFAULT 0,
      status TEXT DEFAULT 'open', sort_order INTEGER NOT NULL DEFAULT 0,
      print_time_seconds INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
    CREATE TABLE gcodes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      part_id INTEGER NOT NULL REFERENCES parts(id),
      printer_model TEXT NOT NULL, filename TEXT NOT NULL, filepath TEXT NOT NULL,
      parts_per_plate INTEGER NOT NULL, est_print_secs INTEGER, material_grams REAL,
      ams_slot INTEGER, allowed_groups TEXT, required_material TEXT, required_color TEXT,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE jobs (
      id INTEGER PRIMARY KEY AUTOINCREMENT, part_id INTEGER, gcode_id INTEGER,
      printer_id INTEGER, parts_per_plate INTEGER, status TEXT, created_at INTEGER
    );
    CREATE TABLE printer_models (
      model_id TEXT PRIMARY KEY, label TEXT NOT NULL, connector TEXT NOT NULL
    );
    INSERT INTO printer_models VALUES ('mk4s', 'MK4S', 'prusa');
    INSERT INTO projects (name, created_at, updated_at) VALUES ('Proj', 1, 1);
    INSERT INTO parts (project_id, name, target_qty, created_at, updated_at)
      VALUES (1, 'Bracket', 10, 1, 1);
  `);
  if (!fs.existsSync(GCODE_DIR)) fs.mkdirSync(GCODE_DIR, { recursive: true });
  app = buildApp();
});

afterAll(() => {
  for (const f of uploadedFiles) { try { fs.unlinkSync(path.join(GCODE_DIR, f)); } catch (_) {} }
});

function track(res) {
  if (res.body?.filepath) uploadedFiles.push(res.body.filepath);
  return res;
}

describe('estimates read from the uploaded file', () => {
  test('a sliced .3mf supplies its own time and weight', async () => {
    const buf = buildZip({
      'Metadata/slice_info.config': buildSliceInfoConfig({ predictionSecs: 4383, weightGrams: 17.24 }),
      'Metadata/plate_1.gcode': 'G28\n',
      '3D/3dmodel.model': '<model/>',
    }, { deflate: true });

    const res = track(await upload('orca_export.3mf', buf));
    expect(res.status).toBe(201);
    expect(res.body.est_print_secs).toBe(4383);
    expect(res.body.material_grams).toBeCloseTo(17.24, 5);
  });

  test('the file wins over the filename-derived values the client posted', async () => {
    const buf = buildZip({
      'Metadata/slice_info.config': buildSliceInfoConfig({ predictionSecs: 1200, weightGrams: 5.5 }),
      'Metadata/plate_1.gcode': 'G28\n',
    }, { deflate: true });

    const res = track(await upload('bracket_9h9m_999g.3mf', buf, {
      est_print_secs: '32940',
      material_grams: '999',
    }));
    expect(res.status).toBe(201);
    expect(res.body.est_print_secs).toBe(1200);
    expect(res.body.material_grams).toBeCloseTo(5.5, 5);
  });

  test('a plain .gcode footer is read too', async () => {
    const body = Buffer.from(
      'G28\nG1 X0\n; total filament used [g] = 21.5\n' +
      '; estimated printing time (normal mode) = 2h 30m 0s\n'
    );
    const res = track(await upload('bracket.gcode', body));
    expect(res.status).toBe(201);
    expect(res.body.est_print_secs).toBe(9000);
    expect(res.body.material_grams).toBeCloseTo(21.5, 5);
  });

  test('posted values are kept when the file carries nothing (Prusa .bgcode)', async () => {
    const res = track(await upload('bracket.bgcode', Buffer.from('binary, not parseable'), {
      est_print_secs: '4440',
      material_grams: '37',
    }));
    expect(res.status).toBe(201);
    expect(res.body.est_print_secs).toBe(4440);
    expect(res.body.material_grams).toBeCloseTo(37, 5);
  });

  test('a file with a time but no weight keeps the posted weight', async () => {
    const buf = buildZip({
      'Metadata/slice_info.config': buildSliceInfoConfig({ predictionSecs: 600, weightGrams: null }),
      'Metadata/plate_1.gcode': 'G28\n',
    }, { deflate: true });

    const res = track(await upload('part.3mf', buf, { material_grams: '12.5' }));
    expect(res.status).toBe(201);
    expect(res.body.est_print_secs).toBe(600);
    expect(res.body.material_grams).toBeCloseTo(12.5, 5);
  });

  test('nothing anywhere leaves both estimates null for the schedule to default', async () => {
    const res = track(await upload('plain.gcode', Buffer.from('G28\nG1 X0 Y0\n')));
    expect(res.status).toBe(201);
    expect(res.body.est_print_secs).toBeNull();
    expect(res.body.material_grams).toBeNull();
  });
});
