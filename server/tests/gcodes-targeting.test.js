// Tests for gcode targeting fields:
//   POST /api/gcodes/upload  — allowed_groups, required_material, required_color
//   PUT  /api/gcodes/:id     — update and clear targeting fields

const request  = require('supertest');
const express  = require('express');
const Database = require('better-sqlite3');
const path     = require('path');
const fs       = require('fs');
const os       = require('os');

const GCODE_DIR = require('../paths').gcodeDir;

let db;
let app;
let uploadedFiles = [];

beforeAll(() => {
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
      file_size INTEGER,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE printers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL, ip TEXT NOT NULL, api_key TEXT NOT NULL,
      model TEXT NOT NULL, status TEXT DEFAULT 'UNKNOWN',
      is_held INTEGER DEFAULT 1, is_active INTEGER DEFAULT 1, created_at INTEGER NOT NULL
    );
    CREATE TABLE jobs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      part_id INTEGER NOT NULL REFERENCES parts(id),
      printer_id INTEGER NOT NULL REFERENCES printers(id),
      gcode_id INTEGER REFERENCES gcodes(id),
      parts_per_plate INTEGER NOT NULL, status TEXT DEFAULT 'queued',
      started_at INTEGER, finished_at INTEGER, created_at INTEGER NOT NULL
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

  app = express();
  app.use(express.json());
  app.use('/api/gcodes', require('../routes/gcodes')(db));
});

afterAll(() => {
  for (const f of uploadedFiles) {
    try { fs.unlinkSync(path.join(GCODE_DIR, f)); } catch (_) {}
  }
});

function makeTempFile(name = 'test.bgcode') {
  const p = path.join(os.tmpdir(), name);
  fs.writeFileSync(p, Buffer.from('G28\nG1 X0 Y0 Z0'));
  return p;
}

// ── POST /api/gcodes/upload — targeting fields ────────────────────────────────

describe('POST /api/gcodes/upload — targeting fields', () => {
  test('stores required_material and required_color', async () => {
    const tmp = makeTempFile('mat_color.bgcode');
    const res = await request(app)
      .post('/api/gcodes/upload')
      .field('part_id', '1')
      .field('parts_per_plate', '4')
      .field('printer_model', 'mk4s')
      .field('required_material', 'PLA')
      .field('required_color', 'Black')
      .attach('file', tmp);

    expect(res.status).toBe(201);
    expect(res.body.required_material).toBe('PLA');
    expect(res.body.required_color).toBe('Black');
    expect(res.body.allowed_groups).toBeNull();
    uploadedFiles.push(res.body.filepath);
  });

  test('stores allowed_groups as JSON string', async () => {
    // Need a new part so uniqueness constraint (part_id, printer_model) doesn't block
    const now = Date.now();
    const { lastInsertRowid: partId } = db.prepare(
      'INSERT INTO parts (project_id, name, target_qty, created_at, updated_at) VALUES (1, ?, 5, ?, ?)'
    ).run('Part Groups', now, now);

    const groups = JSON.stringify(['Rack A', 'Rack B']);
    const tmp = makeTempFile('groups_test.bgcode');
    const res = await request(app)
      .post('/api/gcodes/upload')
      .field('part_id', String(partId))
      .field('parts_per_plate', '2')
      .field('printer_model', 'mk4s')
      .field('allowed_groups', groups)
      .attach('file', tmp);

    expect(res.status).toBe(201);
    expect(res.body.allowed_groups).toBe(groups);
    expect(JSON.parse(res.body.allowed_groups)).toEqual(['Rack A', 'Rack B']);
    expect(res.body.required_material).toBeNull();
    uploadedFiles.push(res.body.filepath);
  });

  test('targeting fields default to null when omitted', async () => {
    const now = Date.now();
    const { lastInsertRowid: partId } = db.prepare(
      'INSERT INTO parts (project_id, name, target_qty, created_at, updated_at) VALUES (1, ?, 5, ?, ?)'
    ).run('Part NoTarget', now, now);

    const tmp = makeTempFile('no_target.bgcode');
    const res = await request(app)
      .post('/api/gcodes/upload')
      .field('part_id', String(partId))
      .field('parts_per_plate', '3')
      .field('printer_model', 'mk4s')
      .attach('file', tmp);

    expect(res.status).toBe(201);
    expect(res.body.allowed_groups).toBeNull();
    expect(res.body.required_material).toBeNull();
    expect(res.body.required_color).toBeNull();
    uploadedFiles.push(res.body.filepath);
  });
});

// ── PUT /api/gcodes/:id — update targeting fields ────────────────────────────

describe('PUT /api/gcodes/:id — targeting fields', () => {
  let gcodeId;

  beforeAll(() => {
    const now = Date.now();
    const { lastInsertRowid: partId } = db.prepare(
      'INSERT INTO parts (project_id, name, target_qty, created_at, updated_at) VALUES (1, ?, 5, ?, ?)'
    ).run('Part PUT', now, now);

    const row = db.prepare(`
      INSERT INTO gcodes (part_id, printer_model, filename, filepath, parts_per_plate, created_at)
      VALUES (?, 'mk4s', 'edit_me.bgcode', 'edit_me.bgcode', 4, ?)
    `).run(partId, now);
    gcodeId = row.lastInsertRowid;
  });

  test('sets required_material and required_color', async () => {
    const res = await request(app)
      .put(`/api/gcodes/${gcodeId}`)
      .send({ required_material: 'PETG', required_color: 'White' });
    expect(res.status).toBe(200);
    expect(res.body.required_material).toBe('PETG');
    expect(res.body.required_color).toBe('White');
  });

  test('sets allowed_groups as JSON string', async () => {
    const groups = JSON.stringify(['Rack A']);
    const res = await request(app)
      .put(`/api/gcodes/${gcodeId}`)
      .send({ allowed_groups: groups });
    expect(res.status).toBe(200);
    expect(res.body.allowed_groups).toBe(groups);
  });

  test('updating material does not clear color or groups', async () => {
    const res = await request(app)
      .put(`/api/gcodes/${gcodeId}`)
      .send({ required_material: 'ABS' });
    expect(res.status).toBe(200);
    expect(res.body.required_material).toBe('ABS');
    expect(res.body.required_color).toBe('White');
    expect(res.body.allowed_groups).toBe(JSON.stringify(['Rack A']));
  });

  test('clears required_material by sending null', async () => {
    const res = await request(app)
      .put(`/api/gcodes/${gcodeId}`)
      .send({ required_material: null });
    expect(res.status).toBe(200);
    expect(res.body.required_material).toBeNull();
    expect(res.body.required_color).toBe('White'); // unchanged
  });

  test('clears allowed_groups by sending null (reverts to all groups)', async () => {
    const res = await request(app)
      .put(`/api/gcodes/${gcodeId}`)
      .send({ allowed_groups: null });
    expect(res.status).toBe(200);
    expect(res.body.allowed_groups).toBeNull();
  });

  test('omitting targeting fields leaves them unchanged', async () => {
    // Set a known state first
    await request(app)
      .put(`/api/gcodes/${gcodeId}`)
      .send({ required_material: 'PLA', required_color: 'Red', allowed_groups: JSON.stringify(['Rack B']) });

    // Update only print_time — targeting fields should be untouched
    const res = await request(app)
      .put(`/api/gcodes/${gcodeId}`)
      .send({ print_time: '2h30m' });
    expect(res.status).toBe(200);
    expect(res.body.required_material).toBe('PLA');
    expect(res.body.required_color).toBe('Red');
    expect(res.body.allowed_groups).toBe(JSON.stringify(['Rack B']));
  });
});
