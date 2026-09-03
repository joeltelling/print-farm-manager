// Tests for the sliced-.3mf validation on POST /api/gcodes/upload.
//
// Regression context: a project .3mf exported without slicing (no
// Metadata/plate_1.gcode inside) uploads fine, dispatches fine, and then the
// printer silently ignores the print command because the archive has no G-code
// to print. The job sits in 'printing' forever against an idle machine. Seen on
// a real farm three times in one day before the cause was found. The upload
// endpoint now rejects such files with an instructive error, which the upload
// form already displays inline.

const request  = require('supertest');
const express  = require('express');
const path     = require('path');
const fs       = require('fs');
const Database = require('better-sqlite3');

const GCODE_DIR = path.join(__dirname, '..', 'gcode');

let db;
let app;

beforeAll(() => {
  if (!fs.existsSync(GCODE_DIR)) fs.mkdirSync(GCODE_DIR, { recursive: true });

  db = new Database(':memory:');
  db.exec(`
    CREATE TABLE printer_models (model_id TEXT PRIMARY KEY, connector TEXT, display_name TEXT);
    CREATE TABLE gcodes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      part_id INTEGER NOT NULL, printer_model TEXT NOT NULL,
      filename TEXT NOT NULL, filepath TEXT NOT NULL,
      parts_per_plate INTEGER NOT NULL, est_print_secs INTEGER,
      material_grams REAL, ams_slot INTEGER, allowed_groups TEXT,
      required_material TEXT, required_color TEXT,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE jobs (
      id INTEGER PRIMARY KEY AUTOINCREMENT, gcode_id INTEGER, status TEXT
    );
  `);
  db.prepare("INSERT INTO printer_models (model_id, connector, display_name) VALUES ('p1s', 'bambu', 'P1S')").run();
  db.prepare("INSERT INTO printer_models (model_id, connector, display_name) VALUES ('mk4s', 'prusa', 'MK4S')").run();

  app = express();
  app.use(express.json());
  app.use('/api/gcodes', require('../routes/gcodes')(db));
});

beforeEach(() => {
  db.prepare('DELETE FROM gcodes').run();
});

afterAll(() => {
  // Remove any files multer wrote for accepted uploads during these tests
  for (const f of fs.readdirSync(GCODE_DIR)) {
    if (f.includes('slicetest')) fs.unlinkSync(path.join(GCODE_DIR, f));
  }
});

const { buildZip } = require('./helpers/build-zip');

function upload(filename, buffer) {
  return request(app)
    .post('/api/gcodes/upload')
    .field('part_id', '1')
    .field('parts_per_plate', '1')
    .field('printer_model', 'p1s')
    .attach('file', buffer, filename);
}

describe('POST /api/gcodes/upload — .3mf slice validation', () => {
  test('accepts a sliced .3mf containing Metadata/plate_1.gcode', async () => {
    const zip = buildZip({
      'Metadata/plate_1.gcode': 'G28\nG1 X10\n',
      'Metadata/plate_1.json': '{}',
      '3D/3dmodel.model': '<model/>',
    });
    const res = await upload('slicetest_ok.3mf', zip);
    expect(res.status).toBe(201);
    expect(db.prepare('SELECT COUNT(*) AS n FROM gcodes').get().n).toBe(1);
  });

  test('rejects an unsliced project .3mf with an instructive message', async () => {
    const zip = buildZip({
      'Metadata/plate_1.png': 'png',
      'Metadata/plate_1.json': '{}',
      '3D/3dmodel.model': '<model/>',
      'Metadata/project_settings.config': '{}',
    });
    const res = await upload('slicetest_unsliced.3mf', zip);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/no sliced G-code/);
    expect(res.body.error).toMatch(/Export plate sliced file/);
    expect(db.prepare('SELECT COUNT(*) AS n FROM gcodes').get().n).toBe(0);
  });

  test('rejects a .3mf whose only sliced plate is not plate_1', async () => {
    const zip = buildZip({
      'Metadata/plate_7.gcode': 'G28\n',
      '3D/3dmodel.model': '<model/>',
    });
    const res = await upload('slicetest_plate7.3mf', zip);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/plate_7\.gcode/);
    expect(res.body.error).toMatch(/plate_1/);
  });

  test('rejects a .3mf that is not a valid ZIP archive', async () => {
    const res = await upload('slicetest_garbage.3mf', Buffer.from('this is not a zip file at all'));
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/not a readable \.3mf/);
  });

  test('deletes the rejected file from disk', async () => {
    const before = fs.readdirSync(GCODE_DIR).length;
    await upload('slicetest_cleanup.3mf', Buffer.from('junk'));
    expect(fs.readdirSync(GCODE_DIR).length).toBe(before);
  });

  test('does not validate non-.3mf uploads (Prusa .bgcode unaffected)', async () => {
    const res = await request(app)
      .post('/api/gcodes/upload')
      .field('part_id', '1')
      .field('parts_per_plate', '1')
      .field('printer_model', 'mk4s')
      .attach('file', Buffer.from('binary gcode bytes, not a zip'), 'slicetest_part.bgcode');
    expect(res.status).toBe(201);
  });

  test('extension check is case-insensitive (.3MF validated too)', async () => {
    const res = await upload('slicetest_upper.3MF', Buffer.from('junk'));
    expect(res.status).toBe(400);
  });
});
