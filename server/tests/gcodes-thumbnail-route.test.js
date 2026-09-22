// Tests for GET /api/gcodes/:id/thumbnail against the real router, a real
// in-memory DB, and a real file written to server/gcode/ (same GCODE_DIR the
// route itself reads from), not just gcode-thumbnail.js's pure functions in
// isolation, so this also covers the route's own file-lookup and error
// handling (missing gcode row, missing file on disk, no thumbnail found).

const request  = require('supertest');
const express  = require('express');
const Database = require('better-sqlite3');
const path     = require('path');
const fs       = require('fs');
const { buildBgcode, buildZip } = require('./support/gcode-fixtures');

const GCODE_DIR = path.join(__dirname, '..', 'gcode');
const writtenFiles = [];

let db;
let app;

beforeAll(() => {
  db = new Database(':memory:');
  db.exec(`
    CREATE TABLE gcodes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      part_id INTEGER NOT NULL,
      printer_model TEXT NOT NULL,
      filename TEXT NOT NULL,
      filepath TEXT NOT NULL,
      parts_per_plate INTEGER NOT NULL,
      created_at INTEGER NOT NULL
    );
  `);

  if (!fs.existsSync(GCODE_DIR)) fs.mkdirSync(GCODE_DIR, { recursive: true });

  app = express();
  app.use('/api/gcodes', require('../routes/gcodes')(db));
});

afterAll(() => {
  for (const f of writtenFiles) { try { fs.unlinkSync(f); } catch (_) {} }
});

// Writes a real file to GCODE_DIR (the route reads gcodes.filepath from
// there, same as a real upload would have left it) and seeds a gcodes row
// pointing at it.
function seedGcode({ filename, storedName, data }) {
  const fullPath = path.join(GCODE_DIR, storedName);
  fs.writeFileSync(fullPath, data);
  writtenFiles.push(fullPath);
  const r = db.prepare(`
    INSERT INTO gcodes (part_id, printer_model, filename, filepath, parts_per_plate, created_at)
    VALUES (1, 'mk4s', ?, ?, 1, ?)
  `).run(filename, storedName, Date.now());
  return r.lastInsertRowid;
}

describe('GET /api/gcodes/:id/thumbnail', () => {
  test('404s for an unknown gcode id', async () => {
    const res = await request(app).get('/api/gcodes/99999/thumbnail');
    expect(res.status).toBe(404);
  });

  test('returns the embedded PNG for a .bgcode file with a thumbnail block', async () => {
    const png = Buffer.from('REAL_ROUTE_TEST_PNG_BYTES');
    const id = seedGcode({
      filename: 'part_MK4S.bgcode',
      storedName: `route_test_${Date.now()}.bgcode`,
      data: buildBgcode([{ type: 5, format: 0, width: 100, height: 100, data: png }]),
    });

    const res = await request(app).get(`/api/gcodes/${id}/thumbnail`);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/^image\/png/);
    expect(Buffer.compare(res.body, png)).toBe(0);
  });

  test('returns the embedded PNG for a .3mf file (Metadata/plate_1.png)', async () => {
    const png = Buffer.from('REAL_ROUTE_TEST_3MF_PNG');
    const id = seedGcode({
      filename: 'part_X1C.3mf',
      storedName: `route_test_${Date.now()}.3mf`,
      data: buildZip([{ name: 'Metadata/plate_1.png', data: png }]),
    });

    const res = await request(app).get(`/api/gcodes/${id}/thumbnail`);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/^image\/png/);
    expect(Buffer.compare(res.body, png)).toBe(0);
  });

  test('404s for a plain .gcode file (never has an embedded thumbnail)', async () => {
    const id = seedGcode({
      filename: 'part_voron.gcode',
      storedName: `route_test_${Date.now()}.gcode`,
      data: Buffer.from('G28\nG1 X10\n'),
    });

    const res = await request(app).get(`/api/gcodes/${id}/thumbnail`);
    expect(res.status).toBe(404);
  });

  test('404s when the gcode row exists but the file is missing from disk', async () => {
    const r = db.prepare(`
      INSERT INTO gcodes (part_id, printer_model, filename, filepath, parts_per_plate, created_at)
      VALUES (1, 'mk4s', 'ghost.bgcode', 'does_not_exist_on_disk.bgcode', 1, ?)
    `).run(Date.now());

    const res = await request(app).get(`/api/gcodes/${r.lastInsertRowid}/thumbnail`);
    expect(res.status).toBe(404);
  });

  test('sets a long-lived cache header, since a gcode file never changes after upload', async () => {
    const id = seedGcode({
      filename: 'part_MK4S.bgcode',
      storedName: `route_test_cache_${Date.now()}.bgcode`,
      data: buildBgcode([{ type: 5, format: 0, width: 10, height: 10, data: Buffer.from('X') }]),
    });

    const res = await request(app).get(`/api/gcodes/${id}/thumbnail`);
    expect(res.headers['cache-control']).toMatch(/max-age=31536000/);
  });
});
