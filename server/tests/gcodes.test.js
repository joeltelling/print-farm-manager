const request = require('supertest');
const path    = require('path');
const fs      = require('fs');
const os      = require('os');

// ── Minimal in-memory DB so tests don't touch the real database ──────────────
const Database = require('better-sqlite3');
let db;

const GCODE_DIR = path.join(__dirname, '..', 'gcode');

beforeAll(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE projects (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      status TEXT DEFAULT 'draft',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE parts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id INTEGER NOT NULL REFERENCES projects(id),
      name TEXT NOT NULL,
      target_qty INTEGER NOT NULL,
      completed_qty INTEGER DEFAULT 0,
      status TEXT DEFAULT 'open',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE gcodes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      part_id INTEGER NOT NULL REFERENCES parts(id),
      printer_model TEXT NOT NULL,
      filename TEXT NOT NULL,
      filepath TEXT NOT NULL,
      parts_per_plate INTEGER NOT NULL,
      est_print_secs INTEGER,
      material_grams REAL,
      ams_slot INTEGER,
      allowed_groups TEXT,
      required_material TEXT,
      required_color TEXT,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE printers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      ip TEXT NOT NULL,
      api_key TEXT NOT NULL,
      model TEXT NOT NULL,
      status TEXT DEFAULT 'UNKNOWN',
      is_held INTEGER DEFAULT 1,
      is_active INTEGER DEFAULT 1,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE jobs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      part_id INTEGER NOT NULL REFERENCES parts(id),
      printer_id INTEGER NOT NULL REFERENCES printers(id),
      gcode_id INTEGER REFERENCES gcodes(id),
      parts_per_plate INTEGER NOT NULL,
      status TEXT DEFAULT 'queued',
      started_at INTEGER,
      finished_at INTEGER,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE printer_models (
      model_id  TEXT PRIMARY KEY,
      label     TEXT NOT NULL,
      connector TEXT NOT NULL
    );
  `);

  // Seed models used by upload tests
  db.exec(`INSERT INTO printer_models VALUES ('mk4s', 'MK4S',       'prusa')`);
  db.exec(`INSERT INTO printer_models VALUES ('c1',   'Core One',   'prusa')`);
  db.exec(`INSERT INTO printer_models VALUES ('x1c',  'X1 Carbon',  'bambu')`);
  db.exec(`INSERT INTO printer_models VALUES ('a1',   'A1',         'bambu')`);
  db.exec(`INSERT INTO printer_models VALUES ('p1s',  'P1S',        'bambu')`);

  if (!fs.existsSync(GCODE_DIR)) fs.mkdirSync(GCODE_DIR, { recursive: true });

  const now = Date.now();
  db.prepare('INSERT INTO projects (name, created_at, updated_at) VALUES (?, ?, ?)').run('Test Project', now, now);
  db.prepare('INSERT INTO parts (project_id, name, target_qty, created_at, updated_at) VALUES (1, ?, 10, ?, ?)').run('Test Part', now, now);
  db.prepare('INSERT INTO printers (name, ip, api_key, model, created_at) VALUES (?, ?, ?, ?, ?)').run('Test Printer', '192.168.1.1', 'key', 'mk4s', now);
});

// ── Build a minimal express app wired to the in-memory DB ────────────────────
const express     = require('express');
const gcodesRouter = require('../routes/gcodes');

let app;
beforeAll(() => {
  app = express();
  app.use(express.json());
  app.use('/api/gcodes', gcodesRouter(db));
});

// ── Helpers ──────────────────────────────────────────────────────────────────

// Creates a real temp file to upload
function makeTempGcode(name = 'test.bgcode') {
  const p = path.join(os.tmpdir(), name);
  fs.writeFileSync(p, Buffer.from('fake gcode content'));
  return p;
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('POST /api/gcodes/parse-filename', () => {
  test('parses a valid filename', async () => {
    const res = await request(app)
      .post('/api/gcodes/parse-filename')
      .send({ filename: '4x Left Bracket_0.20n_0.40mm_PLA_MK4S_5h11m.bgcode' });
    expect(res.status).toBe(200);
    expect(res.body.parse_failed).toBe(false);
    expect(res.body.parts_per_plate).toBe(4);
    expect(res.body.printer_model).toBe('mk4s');
  });

  test('returns parse_failed for unrecognised filename', async () => {
    const res = await request(app)
      .post('/api/gcodes/parse-filename')
      .send({ filename: 'random_file.bgcode' });
    expect(res.status).toBe(200);
    expect(res.body.parse_failed).toBe(true);
  });

  test('parses filename with trailing _Ngrams material token', async () => {
    const res = await request(app)
      .post('/api/gcodes/parse-filename')
      .send({ filename: '10x XRP Servo Mount_0.4n_0.2mm_PLA_COREONE_1h14m_37grams.bgcode' });
    expect(res.status).toBe(200);
    expect(res.body.parse_failed).toBe(false);
    expect(res.body.parts_per_plate).toBe(10);
    expect(res.body.est_print_secs).toBe(1 * 3600 + 14 * 60); // 4440
    expect(res.body.material_grams).toBeCloseTo(37);
  });

  test('parses material_grams from "Ng" shorthand in filename', async () => {
    const res = await request(app)
      .post('/api/gcodes/parse-filename')
      .send({ filename: '4x Left Bracket_0.20n_0.40mm_PLA_MK4S_5h11m_45g.bgcode' });
    expect(res.status).toBe(200);
    expect(res.body.material_grams).toBeCloseTo(45);
  });

  test('extracts material_grams even when main parse fails', async () => {
    // Filename does not match the structured pattern but contains a grams token
    const res = await request(app)
      .post('/api/gcodes/parse-filename')
      .send({ filename: 'my_custom_file_37grams.bgcode' });
    expect(res.status).toBe(200);
    expect(res.body.parse_failed).toBe(true);
    expect(res.body.material_grams).toBeCloseTo(37);
  });
});

describe('POST /api/gcodes/upload', () => {
  let uploadedPath;

  afterEach(() => {
    // Clean up any uploaded files
    if (uploadedPath && fs.existsSync(uploadedPath)) {
      fs.unlinkSync(uploadedPath);
      uploadedPath = null;
    }
  });

  test('uploads a file and creates a DB record', async () => {
    const tmpFile = makeTempGcode('upload_test.bgcode');

    const res = await request(app)
      .post('/api/gcodes/upload')
      .attach('file', tmpFile)
      .field('part_id', '1')
      .field('parts_per_plate', '4')
      .field('printer_model', 'mk4s');

    fs.unlinkSync(tmpFile);

    expect(res.status).toBe(201);
    expect(res.body.printer_model).toBe('mk4s');
    expect(res.body.parts_per_plate).toBe(4);
    uploadedPath = res.body.filepath;
  });

  test('stored filename is always a basename (defense-in-depth)', async () => {
    // Busboy already basenames multipart filenames (preservePath off), so a path-bearing
    // name arrives here stripped; path.basename in the storage callback locks that in.
    // Dedicated model so the (part_id, printer_model) pair is unique among these tests.
    db.prepare(`INSERT OR IGNORE INTO printer_models VALUES ('trav', 'Traversal', 'prusa')`).run();
    const tmpFile = makeTempGcode('traversal_src.bgcode');

    const res = await request(app)
      .post('/api/gcodes/upload')
      .attach('file', tmpFile, { filename: '../../../pwned.bgcode' })
      .field('part_id', '1')
      .field('parts_per_plate', '4')
      .field('printer_model', 'trav');

    fs.unlinkSync(tmpFile);

    expect(res.status).toBe(201);
    expect(res.body.filepath).not.toMatch(/[\\/]/);
    expect(res.body.filepath).toMatch(/pwned\.bgcode$/);

    const stored = path.join(GCODE_DIR, res.body.filepath);
    expect(fs.existsSync(stored)).toBe(true);
    expect(fs.existsSync(path.resolve(GCODE_DIR, '..', '..', '..', 'pwned.bgcode'))).toBe(false);

    uploadedPath = stored;
  });

  test('rejects more than one file per request (files limit)', async () => {
    const a = makeTempGcode('multi_a.bgcode');
    const b = makeTempGcode('multi_b.bgcode');

    const res = await request(app)
      .post('/api/gcodes/upload')
      .attach('file', a)
      .attach('file', b)
      .field('part_id', '1')
      .field('parts_per_plate', '4')
      .field('printer_model', 'mk4s');

    fs.unlinkSync(a);
    fs.unlinkSync(b);

    expect(res.status).toBe(400);
  });

  test('returns 400 when no file is attached', async () => {
    const res = await request(app)
      .post('/api/gcodes/upload')
      .field('part_id', '1')
      .field('parts_per_plate', '4')
      .field('printer_model', 'mk4s');

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/no file/i);
  });

  test('returns 400 for invalid model', async () => {
    const tmpFile = makeTempGcode('bad_model.bgcode');

    const res = await request(app)
      .post('/api/gcodes/upload')
      .attach('file', tmpFile)
      .field('part_id', '1')
      .field('parts_per_plate', '4')
      .field('printer_model', 'invalidmodel');

    fs.unlinkSync(tmpFile);

    expect(res.status).toBe(400);
  });

  test('stores ams_slot when provided', async () => {
    const tmpFile = makeTempGcode('bambu_ams.3mf');

    const res = await request(app)
      .post('/api/gcodes/upload')
      .attach('file', tmpFile)
      .field('part_id', '1')
      .field('parts_per_plate', '1')
      .field('printer_model', 'x1c')
      .field('ams_slot', '2');

    fs.unlinkSync(tmpFile);

    expect(res.status).toBe(201);
    expect(res.body.ams_slot).toBe(2);
    uploadedPath = res.body.filepath;
  });

  test('stores ams_slot -1 for external spool', async () => {
    const tmpFile = makeTempGcode('bambu_ext.3mf');

    const res = await request(app)
      .post('/api/gcodes/upload')
      .attach('file', tmpFile)
      .field('part_id', '1')
      .field('parts_per_plate', '1')
      .field('printer_model', 'a1')        // distinct model to avoid 409
      .field('ams_slot', '-1');

    fs.unlinkSync(tmpFile);

    expect(res.status).toBe(201);
    expect(res.body.ams_slot).toBe(-1);
    uploadedPath = res.body.filepath;
  });

  test('ams_slot is null when not provided (non-Bambu upload)', async () => {
    const tmpFile = makeTempGcode('prusa_no_ams.bgcode');

    const res = await request(app)
      .post('/api/gcodes/upload')
      .attach('file', tmpFile)
      .field('part_id', '1')
      .field('parts_per_plate', '3')
      .field('printer_model', 'p1s');   // distinct model to avoid 409

    fs.unlinkSync(tmpFile);

    expect(res.status).toBe(201);
    expect(res.body.ams_slot).toBeNull();
    uploadedPath = res.body.filepath;
  });

  test('returns 409 on duplicate (part_id, printer_model)', async () => {
    const tmpFile1 = makeTempGcode('dup1.bgcode');
    const tmpFile2 = makeTempGcode('dup2.bgcode');

    const first = await request(app)
      .post('/api/gcodes/upload')
      .attach('file', tmpFile1)
      .field('part_id', '1')
      .field('parts_per_plate', '2')
      .field('printer_model', 'c1');

    fs.unlinkSync(tmpFile1);
    if (first.body.filepath) uploadedPath = first.body.filepath;

    const second = await request(app)
      .post('/api/gcodes/upload')
      .attach('file', tmpFile2)
      .field('part_id', '1')
      .field('parts_per_plate', '2')
      .field('printer_model', 'c1');

    fs.unlinkSync(tmpFile2);

    expect(first.status).toBe(201);
    expect(second.status).toBe(409);
    expect(second.body.error).toMatch(/already has a G-code/i);
  });
});

// ── Helper: insert a gcode row directly and write its file to disk ────────────
function insertGcode(filename, filepath) {
  const now = Date.now();
  const row = db.prepare(`
    INSERT INTO gcodes (part_id, printer_model, filename, filepath, parts_per_plate, created_at)
    VALUES (1, 'mk4s', ?, ?, 1, ?)
  `).run(filename, filepath, now);
  return row.lastInsertRowid;
}

describe('DELETE /api/gcodes/:id', () => {
  test('returns 404 for unknown id', async () => {
    const res = await request(app).delete('/api/gcodes/99999');
    expect(res.status).toBe(404);
  });

  test('deletes DB record and removes file from disk', async () => {
    const filename = `del_test_${Date.now()}.bgcode`;
    const filePath = path.join(GCODE_DIR, filename);
    fs.writeFileSync(filePath, 'fake gcode');
    const id = insertGcode(filename, filename);

    const res = await request(app).delete(`/api/gcodes/${id}`);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(db.prepare('SELECT id FROM gcodes WHERE id = ?').get(id)).toBeUndefined();
    expect(fs.existsSync(filePath)).toBe(false);
  });

  test('succeeds even when file is already missing from disk', async () => {
    const id = insertGcode('ghost.bgcode', 'ghost.bgcode');
    // No file written — simulates a file that was manually removed

    const res = await request(app).delete(`/api/gcodes/${id}`);

    expect(res.status).toBe(200);
    expect(db.prepare('SELECT id FROM gcodes WHERE id = ?').get(id)).toBeUndefined();
  });

  test('resolves file correctly when filepath is an old absolute path', async () => {
    const filename = `abs_path_test_${Date.now()}.bgcode`;
    const filePath = path.join(GCODE_DIR, filename);
    fs.writeFileSync(filePath, 'fake gcode');
    // Simulate an old DB row with a Unix absolute path (pre-portable-path migration)
    const oldAbsPath = `/Users/olduser/dev/print-farm-manager/server/gcode/${filename}`;
    const id = insertGcode(filename, oldAbsPath);

    const res = await request(app).delete(`/api/gcodes/${id}`);

    expect(res.status).toBe(200);
    expect(fs.existsSync(filePath)).toBe(false);
  });

  test('returns 409 when an active job references the gcode', async () => {
    const filename = `active_job_${Date.now()}.bgcode`;
    const id = insertGcode(filename, filename);
    const now = Date.now();
    db.prepare(`
      INSERT INTO jobs (part_id, printer_id, gcode_id, parts_per_plate, status, created_at)
      VALUES (1, 1, ?, 1, 'printing', ?)
    `).run(id, now);

    const res = await request(app).delete(`/api/gcodes/${id}`);

    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/active job/i);
    // Record should still exist
    expect(db.prepare('SELECT id FROM gcodes WHERE id = ?').get(id)).toBeDefined();
  });

  test('nulls out gcode_id on terminal jobs and deletes successfully', async () => {
    const filename = `terminal_job_${Date.now()}.bgcode`;
    const id = insertGcode(filename, filename);
    const now = Date.now();
    const jobRow = db.prepare(`
      INSERT INTO jobs (part_id, printer_id, gcode_id, parts_per_plate, status, created_at)
      VALUES (1, 1, ?, 1, 'finished', ?)
    `).run(id, now);
    const jobId = jobRow.lastInsertRowid;

    const res = await request(app).delete(`/api/gcodes/${id}`);

    expect(res.status).toBe(200);
    expect(db.prepare('SELECT id FROM gcodes WHERE id = ?').get(id)).toBeUndefined();
    // Job history preserved, gcode_id cleared
    const job = db.prepare('SELECT gcode_id FROM jobs WHERE id = ?').get(jobId);
    expect(job).toBeDefined();
    expect(job.gcode_id).toBeNull();
  });
});
