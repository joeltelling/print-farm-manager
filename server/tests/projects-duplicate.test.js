const request  = require('supertest');
const express  = require('express');
const Database = require('better-sqlite3');
const path     = require('path');
const fs       = require('fs');

const GCODE_DIR = require('../paths').gcodeDir;

let db, app;

// Track files created during tests so we can clean them up.
const createdFiles = [];

function touchGcode(basename) {
  const fullPath = path.join(GCODE_DIR, basename);
  fs.writeFileSync(fullPath, 'fake gcode content');
  createdFiles.push(fullPath);
  return fullPath;
}

beforeAll(() => {
  if (!fs.existsSync(GCODE_DIR)) fs.mkdirSync(GCODE_DIR, { recursive: true });

  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE projects (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      name        TEXT NOT NULL,
      description TEXT,
      status      TEXT DEFAULT 'draft',
      priority    INTEGER DEFAULT 0,
      created_at  INTEGER NOT NULL,
      updated_at  INTEGER NOT NULL
    );
    CREATE TABLE parts (
      id                 INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id         INTEGER NOT NULL REFERENCES projects(id),
      name               TEXT NOT NULL,
      target_qty         INTEGER NOT NULL,
      completed_qty      INTEGER DEFAULT 0,
      status             TEXT DEFAULT 'open',
      sort_order         INTEGER NOT NULL DEFAULT 0,
      print_time_seconds INTEGER,
      material_grams     REAL,
      created_at         INTEGER NOT NULL,
      updated_at         INTEGER NOT NULL
    );
    CREATE TABLE gcodes (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      part_id          INTEGER NOT NULL REFERENCES parts(id),
      printer_model    TEXT NOT NULL,
      filename         TEXT NOT NULL,
      filepath         TEXT NOT NULL,
      parts_per_plate  INTEGER NOT NULL,
      est_print_secs   INTEGER,
      material_grams   REAL,
      ams_slot         INTEGER,
      allowed_groups   TEXT,
      required_material TEXT,
      required_color   TEXT,
      created_at       INTEGER NOT NULL
    );
  `);

  app = express();
  app.use(express.json());
  app.use('/api/projects', require('../routes/projects')(db, null));
});

afterAll(() => {
  for (const f of createdFiles) {
    if (fs.existsSync(f)) fs.unlinkSync(f);
  }
});

// ── Seed helpers ──────────────────────────────────────────────────────────────

function seedProject(overrides = {}) {
  const now = Date.now();
  const row = db.prepare(`
    INSERT INTO projects (name, description, status, priority, created_at, updated_at)
    VALUES (?, ?, ?, 0, ?, ?)
  `).run(
    overrides.name        ?? 'June',
    overrides.description ?? 'June batch',
    overrides.status      ?? 'active',
    now, now
  );
  return row.lastInsertRowid;
}

function seedPart(projectId, overrides = {}) {
  const now = Date.now();
  const row = db.prepare(`
    INSERT INTO parts (project_id, name, target_qty, completed_qty, status, sort_order,
                       print_time_seconds, material_grams, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    projectId,
    overrides.name               ?? 'Bracket',
    overrides.target_qty         ?? 50,
    overrides.completed_qty      ?? 20,
    overrides.status             ?? 'open',
    overrides.sort_order         ?? 0,
    overrides.print_time_seconds ?? 3600,
    overrides.material_grams     ?? 45.5,
    now, now
  );
  return row.lastInsertRowid;
}

function seedGcode(partId, basename, overrides = {}) {
  const now = Date.now();
  const row = db.prepare(`
    INSERT INTO gcodes (part_id, printer_model, filename, filepath, parts_per_plate,
                        est_print_secs, material_grams, ams_slot, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    partId,
    overrides.printer_model   ?? 'mk4s',
    overrides.filename        ?? basename,
    overrides.filepath        ?? basename,
    overrides.parts_per_plate ?? 4,
    overrides.est_print_secs  ?? 18660,
    overrides.material_grams  ?? 45.5,
    overrides.ams_slot        ?? null,
    now
  );
  return row.lastInsertRowid;
}

// ─── 404 ──────────────────────────────────────────────────────────────────────

describe('POST /api/projects/:id/duplicate — 404', () => {
  test('returns 404 for unknown project', async () => {
    const res = await request(app).post('/api/projects/99999/duplicate').send({});
    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/not found/i);
  });
});

// ─── New project shape ────────────────────────────────────────────────────────

describe('POST /api/projects/:id/duplicate — new project', () => {
  let sourceId;

  beforeEach(() => {
    db.exec('DELETE FROM gcodes; DELETE FROM parts; DELETE FROM projects;');
    sourceId = seedProject({ name: 'June', description: 'June batch', status: 'active' });
  });

  test('returns 201', async () => {
    const res = await request(app).post(`/api/projects/${sourceId}/duplicate`).send({ name: 'July' });
    expect(res.status).toBe(201);
  });

  test('new project has status draft', async () => {
    const res = await request(app).post(`/api/projects/${sourceId}/duplicate`).send({ name: 'July' });
    expect(res.body.project.status).toBe('draft');
  });

  test('uses provided name', async () => {
    const res = await request(app).post(`/api/projects/${sourceId}/duplicate`).send({ name: 'July' });
    expect(res.body.project.name).toBe('July');
  });

  test('defaults to "Copy of <source>" when no name provided', async () => {
    const res = await request(app).post(`/api/projects/${sourceId}/duplicate`).send({});
    expect(res.body.project.name).toBe('Copy of June');
  });

  test('defaults to "Copy of <source>" when name is whitespace', async () => {
    const res = await request(app).post(`/api/projects/${sourceId}/duplicate`).send({ name: '   ' });
    expect(res.body.project.name).toBe('Copy of June');
  });

  test('copies description from source', async () => {
    const res = await request(app).post(`/api/projects/${sourceId}/duplicate`).send({ name: 'July' });
    expect(res.body.project.description).toBe('June batch');
  });

  test('new project appears in the DB', async () => {
    const res  = await request(app).post(`/api/projects/${sourceId}/duplicate`).send({ name: 'July' });
    const newId = res.body.project.id;
    const row   = db.prepare('SELECT * FROM projects WHERE id = ?').get(newId);
    expect(row).toBeDefined();
    expect(row.name).toBe('July');
  });

  test('source project is not modified', async () => {
    const before = db.prepare('SELECT * FROM projects WHERE id = ?').get(sourceId);
    await request(app).post(`/api/projects/${sourceId}/duplicate`).send({ name: 'July' });
    const after = db.prepare('SELECT * FROM projects WHERE id = ?').get(sourceId);
    expect(after.name).toBe(before.name);
    expect(after.status).toBe(before.status);
    expect(after.description).toBe(before.description);
  });
});

// ─── Parts copying ────────────────────────────────────────────────────────────

describe('POST /api/projects/:id/duplicate — parts', () => {
  let sourceId, partA, partB;

  beforeEach(() => {
    db.exec('DELETE FROM gcodes; DELETE FROM parts; DELETE FROM projects;');
    sourceId = seedProject();
    partA = seedPart(sourceId, {
      name: 'Bracket', target_qty: 50, completed_qty: 30, status: 'open',
      sort_order: 0, print_time_seconds: 3600, material_grams: 45.5,
    });
    partB = seedPart(sourceId, {
      name: 'Cap', target_qty: 20, completed_qty: 20, status: 'closed',
      sort_order: 1, print_time_seconds: 1800, material_grams: 12.0,
    });
  });

  test('copies all parts', async () => {
    const res    = await request(app).post(`/api/projects/${sourceId}/duplicate`).send({ name: 'July' });
    const newId  = res.body.project.id;
    const newParts = db.prepare('SELECT * FROM parts WHERE project_id = ?').all(newId);
    expect(newParts).toHaveLength(2);
    expect(res.body.copied_parts).toBe(2);
  });

  test('copies part name and target_qty', async () => {
    const res    = await request(app).post(`/api/projects/${sourceId}/duplicate`).send({ name: 'July' });
    const newId  = res.body.project.id;
    const newParts = db.prepare('SELECT * FROM parts WHERE project_id = ? ORDER BY sort_order ASC').all(newId);
    expect(newParts[0].name).toBe('Bracket');
    expect(newParts[0].target_qty).toBe(50);
    expect(newParts[1].name).toBe('Cap');
    expect(newParts[1].target_qty).toBe(20);
  });

  test('preserves sort_order', async () => {
    const res    = await request(app).post(`/api/projects/${sourceId}/duplicate`).send({ name: 'July' });
    const newId  = res.body.project.id;
    const newParts = db.prepare('SELECT * FROM parts WHERE project_id = ? ORDER BY sort_order ASC').all(newId);
    expect(newParts[0].sort_order).toBe(0);
    expect(newParts[1].sort_order).toBe(1);
  });

  test('copies print_time_seconds and material_grams', async () => {
    const res    = await request(app).post(`/api/projects/${sourceId}/duplicate`).send({ name: 'July' });
    const newId  = res.body.project.id;
    const newParts = db.prepare('SELECT * FROM parts WHERE project_id = ? ORDER BY sort_order ASC').all(newId);
    expect(newParts[0].print_time_seconds).toBe(3600);
    expect(newParts[0].material_grams).toBeCloseTo(45.5);
    expect(newParts[1].print_time_seconds).toBe(1800);
    expect(newParts[1].material_grams).toBeCloseTo(12.0);
  });

  test('new parts have completed_qty = 0', async () => {
    const res    = await request(app).post(`/api/projects/${sourceId}/duplicate`).send({ name: 'July' });
    const newId  = res.body.project.id;
    const newParts = db.prepare('SELECT * FROM parts WHERE project_id = ?').all(newId);
    for (const p of newParts) expect(p.completed_qty).toBe(0);
  });

  test('new parts have status = open even when source part was closed', async () => {
    const res    = await request(app).post(`/api/projects/${sourceId}/duplicate`).send({ name: 'July' });
    const newId  = res.body.project.id;
    const newParts = db.prepare('SELECT * FROM parts WHERE project_id = ?').all(newId);
    for (const p of newParts) expect(p.status).toBe('open');
  });

  test('source parts are not modified', async () => {
    const beforeA = db.prepare('SELECT * FROM parts WHERE id = ?').get(partA);
    const beforeB = db.prepare('SELECT * FROM parts WHERE id = ?').get(partB);
    await request(app).post(`/api/projects/${sourceId}/duplicate`).send({ name: 'July' });
    const afterA = db.prepare('SELECT * FROM parts WHERE id = ?').get(partA);
    const afterB = db.prepare('SELECT * FROM parts WHERE id = ?').get(partB);
    expect(afterA.completed_qty).toBe(beforeA.completed_qty);
    expect(afterA.status).toBe(beforeA.status);
    expect(afterB.completed_qty).toBe(beforeB.completed_qty);
    expect(afterB.status).toBe(beforeB.status);
  });

  test('new parts belong to the new project, not the source', async () => {
    const res    = await request(app).post(`/api/projects/${sourceId}/duplicate`).send({ name: 'July' });
    const newId  = res.body.project.id;
    const newParts = db.prepare('SELECT * FROM parts WHERE project_id = ?').all(newId);
    for (const p of newParts) expect(p.project_id).toBe(newId);
    // Source parts unchanged
    const sourceParts = db.prepare('SELECT * FROM parts WHERE project_id = ?').all(sourceId);
    expect(sourceParts).toHaveLength(2);
  });
});

// ─── G-code DB copying ────────────────────────────────────────────────────────

describe('POST /api/projects/:id/duplicate — gcode DB records', () => {
  let sourceId, sourcePartId, gcodeId;

  beforeEach(() => {
    db.exec('DELETE FROM gcodes; DELETE FROM parts; DELETE FROM projects;');
    sourceId     = seedProject();
    sourcePartId = seedPart(sourceId);
    gcodeId      = seedGcode(sourcePartId, 'test_mk4s.bgcode', {
      printer_model: 'mk4s', parts_per_plate: 4,
      est_print_secs: 18660, material_grams: 45.5, ams_slot: null,
    });
  });

  test('creates a new gcode row for the duplicated part', async () => {
    const res    = await request(app).post(`/api/projects/${sourceId}/duplicate`).send({ name: 'July' });
    const newId  = res.body.project.id;
    const newPartId = db.prepare('SELECT id FROM parts WHERE project_id = ?').get(newId).id;
    const newGcode  = db.prepare('SELECT * FROM gcodes WHERE part_id = ?').get(newPartId);
    expect(newGcode).toBeDefined();
    expect(res.body.copied_gcodes).toBe(1);
  });

  test('copies printer_model, parts_per_plate, est_print_secs, material_grams', async () => {
    const res       = await request(app).post(`/api/projects/${sourceId}/duplicate`).send({ name: 'July' });
    const newId     = res.body.project.id;
    const newPartId = db.prepare('SELECT id FROM parts WHERE project_id = ?').get(newId).id;
    const newGcode  = db.prepare('SELECT * FROM gcodes WHERE part_id = ?').get(newPartId);
    expect(newGcode.printer_model).toBe('mk4s');
    expect(newGcode.parts_per_plate).toBe(4);
    expect(newGcode.est_print_secs).toBe(18660);
    expect(newGcode.material_grams).toBeCloseTo(45.5);
  });

  test('copies ams_slot (null)', async () => {
    const res       = await request(app).post(`/api/projects/${sourceId}/duplicate`).send({ name: 'July' });
    const newId     = res.body.project.id;
    const newPartId = db.prepare('SELECT id FROM parts WHERE project_id = ?').get(newId).id;
    const newGcode  = db.prepare('SELECT * FROM gcodes WHERE part_id = ?').get(newPartId);
    expect(newGcode.ams_slot).toBeNull();
  });

  test('copies ams_slot when set (Bambu AMS)', async () => {
    db.prepare('UPDATE gcodes SET ams_slot = 2 WHERE id = ?').run(gcodeId);
    const res       = await request(app).post(`/api/projects/${sourceId}/duplicate`).send({ name: 'July' });
    const newId     = res.body.project.id;
    const newPartId = db.prepare('SELECT id FROM parts WHERE project_id = ?').get(newId).id;
    const newGcode  = db.prepare('SELECT * FROM gcodes WHERE part_id = ?').get(newPartId);
    expect(newGcode.ams_slot).toBe(2);
  });

  test('copies filename', async () => {
    const res       = await request(app).post(`/api/projects/${sourceId}/duplicate`).send({ name: 'July' });
    const newId     = res.body.project.id;
    const newPartId = db.prepare('SELECT id FROM parts WHERE project_id = ?').get(newId).id;
    const newGcode  = db.prepare('SELECT * FROM gcodes WHERE part_id = ?').get(newPartId);
    expect(newGcode.filename).toBe('test_mk4s.bgcode');
  });

  test('new gcode row belongs to the new part, not the source part', async () => {
    const res       = await request(app).post(`/api/projects/${sourceId}/duplicate`).send({ name: 'July' });
    const newId     = res.body.project.id;
    const newPartId = db.prepare('SELECT id FROM parts WHERE project_id = ?').get(newId).id;
    const newGcode  = db.prepare('SELECT * FROM gcodes WHERE part_id = ?').get(newPartId);
    expect(newGcode.part_id).toBe(newPartId);
    expect(newGcode.part_id).not.toBe(sourcePartId);
  });

  test('source gcode row is not removed', async () => {
    await request(app).post(`/api/projects/${sourceId}/duplicate`).send({ name: 'July' });
    const srcGcode = db.prepare('SELECT * FROM gcodes WHERE id = ?').get(gcodeId);
    expect(srcGcode).toBeDefined();
    expect(srcGcode.part_id).toBe(sourcePartId);
  });

  test('multiple gcodes on one part are all copied', async () => {
    // Add a second gcode (different model) to the same part
    seedGcode(sourcePartId, 'test_x1c.3mf', { printer_model: 'x1c', ams_slot: 1 });

    const res       = await request(app).post(`/api/projects/${sourceId}/duplicate`).send({ name: 'July' });
    const newId     = res.body.project.id;
    const newPartId = db.prepare('SELECT id FROM parts WHERE project_id = ?').get(newId).id;
    const newGcodes = db.prepare('SELECT * FROM gcodes WHERE part_id = ?').all(newPartId);
    expect(newGcodes).toHaveLength(2);
    expect(res.body.copied_gcodes).toBe(2);
  });
});

// ─── G-code file copying ──────────────────────────────────────────────────────

describe('POST /api/projects/:id/duplicate — gcode file copies', () => {
  let sourceId, sourcePartId;

  beforeEach(() => {
    db.exec('DELETE FROM gcodes; DELETE FROM parts; DELETE FROM projects;');
    sourceId     = seedProject();
    sourcePartId = seedPart(sourceId);
  });

  test('physically copies the gcode file to a new path', async () => {
    const basename = `dup_file_test_${Date.now()}.bgcode`;
    touchGcode(basename);
    const gcodeId = seedGcode(sourcePartId, basename, { filepath: basename });

    const res       = await request(app).post(`/api/projects/${sourceId}/duplicate`).send({ name: 'July' });
    const newId     = res.body.project.id;
    const newPartId = db.prepare('SELECT id FROM parts WHERE project_id = ?').get(newId).id;
    const newGcode  = db.prepare('SELECT * FROM gcodes WHERE part_id = ?').get(newPartId);

    const destPath  = path.join(GCODE_DIR, newGcode.filepath);
    expect(fs.existsSync(destPath)).toBe(true);
    createdFiles.push(destPath);
  });

  test('source gcode file still exists after duplication', async () => {
    const basename = `dup_safety_test_${Date.now()}.bgcode`;
    const srcPath  = touchGcode(basename);
    seedGcode(sourcePartId, basename, { filepath: basename });

    await request(app).post(`/api/projects/${sourceId}/duplicate`).send({ name: 'July' });

    // CRITICAL: source file must still be on disk
    expect(fs.existsSync(srcPath)).toBe(true);

    // Clean up the copy too
    const newId     = db.prepare('SELECT id FROM projects ORDER BY id DESC LIMIT 1').get().id;
    const newPartId = db.prepare('SELECT id FROM parts WHERE project_id = ?').get(newId).id;
    const newGcode  = db.prepare('SELECT * FROM gcodes WHERE part_id = ?').get(newPartId);
    if (newGcode) createdFiles.push(path.join(GCODE_DIR, newGcode.filepath));
  });

  test('copied file has different filepath than source', async () => {
    const basename = `dup_diff_path_${Date.now()}.bgcode`;
    touchGcode(basename);
    const gcodeId = seedGcode(sourcePartId, basename, { filepath: basename });

    const res       = await request(app).post(`/api/projects/${sourceId}/duplicate`).send({ name: 'July' });
    const newId     = res.body.project.id;
    const newPartId = db.prepare('SELECT id FROM parts WHERE project_id = ?').get(newId).id;
    const newGcode  = db.prepare('SELECT * FROM gcodes WHERE part_id = ?').get(newPartId);
    const srcGcode  = db.prepare('SELECT * FROM gcodes WHERE id = ?').get(gcodeId);

    expect(newGcode.filepath).not.toBe(srcGcode.filepath);
    createdFiles.push(path.join(GCODE_DIR, newGcode.filepath));
  });

  test('copied file has the same content as the source', async () => {
    const content  = 'G28 ; home all axes\nG1 X50 Y50 Z5 F4000';
    const basename = `dup_content_test_${Date.now()}.bgcode`;
    const srcPath  = path.join(GCODE_DIR, basename);
    fs.writeFileSync(srcPath, content);
    createdFiles.push(srcPath);

    seedGcode(sourcePartId, basename, { filepath: basename });

    const res       = await request(app).post(`/api/projects/${sourceId}/duplicate`).send({ name: 'July' });
    const newId     = res.body.project.id;
    const newPartId = db.prepare('SELECT id FROM parts WHERE project_id = ?').get(newId).id;
    const newGcode  = db.prepare('SELECT * FROM gcodes WHERE part_id = ?').get(newPartId);

    const destPath  = path.join(GCODE_DIR, newGcode.filepath);
    expect(fs.readFileSync(destPath, 'utf8')).toBe(content);
    createdFiles.push(destPath);
  });

  test('gracefully handles missing source file — DB record still created', async () => {
    // Insert a gcode row pointing to a file that does not exist on disk
    seedGcode(sourcePartId, 'ghost_file.bgcode', { filepath: 'ghost_file.bgcode' });

    const res       = await request(app).post(`/api/projects/${sourceId}/duplicate`).send({ name: 'July' });
    expect(res.status).toBe(201);
    const newId     = res.body.project.id;
    const newPartId = db.prepare('SELECT id FROM parts WHERE project_id = ?').get(newId).id;
    const newGcode  = db.prepare('SELECT * FROM gcodes WHERE part_id = ?').get(newPartId);
    expect(newGcode).toBeDefined();
    expect(res.body.copied_gcodes).toBe(1);
  });
});

// ─── Edge cases ───────────────────────────────────────────────────────────────

describe('POST /api/projects/:id/duplicate — edge cases', () => {
  beforeEach(() => {
    db.exec('DELETE FROM gcodes; DELETE FROM parts; DELETE FROM projects;');
  });

  test('works on a project with no parts', async () => {
    const emptyId = seedProject({ name: 'Empty' });
    const res     = await request(app).post(`/api/projects/${emptyId}/duplicate`).send({ name: 'Empty Copy' });
    expect(res.status).toBe(201);
    expect(res.body.copied_parts).toBe(0);
    expect(res.body.copied_gcodes).toBe(0);
    const newParts = db.prepare('SELECT * FROM parts WHERE project_id = ?').all(res.body.project.id);
    expect(newParts).toHaveLength(0);
  });

  test('works on a project with parts that have no gcodes', async () => {
    const projId = seedProject({ name: 'No Gcodes' });
    seedPart(projId, { name: 'Widget' });
    const res    = await request(app).post(`/api/projects/${projId}/duplicate`).send({ name: 'Copy' });
    expect(res.status).toBe(201);
    expect(res.body.copied_parts).toBe(1);
    expect(res.body.copied_gcodes).toBe(0);
  });

  test('response includes copied_parts and copied_gcodes counts', async () => {
    const projId = seedProject();
    const pA     = seedPart(projId, { name: 'A', sort_order: 0 });
    const pB     = seedPart(projId, { name: 'B', sort_order: 1 });

    const basename1 = `count_test1_${Date.now()}.bgcode`;
    const basename2 = `count_test2_${Date.now()}.bgcode`;
    touchGcode(basename1);
    touchGcode(basename2);
    seedGcode(pA, basename1, { filepath: basename1 });
    seedGcode(pB, basename2, { filepath: basename2 });

    const res = await request(app).post(`/api/projects/${projId}/duplicate`).send({ name: 'Counted' });
    expect(res.body.copied_parts).toBe(2);
    expect(res.body.copied_gcodes).toBe(2);

    // Clean up copies
    const newId = res.body.project.id;
    const newParts = db.prepare('SELECT id FROM parts WHERE project_id = ?').all(newId);
    for (const p of newParts) {
      const gc = db.prepare('SELECT * FROM gcodes WHERE part_id = ?').get(p.id);
      if (gc) createdFiles.push(path.join(GCODE_DIR, gc.filepath));
    }
  });

  test('duplicating a completed project still produces a draft', async () => {
    const projId = seedProject({ status: 'completed' });
    const res    = await request(app).post(`/api/projects/${projId}/duplicate`).send({ name: 'Retry' });
    expect(res.status).toBe(201);
    expect(res.body.project.status).toBe('draft');
  });

  test('two duplicates of the same project do not share gcode rows', async () => {
    const projId = seedProject();
    const pId    = seedPart(projId);
    const base   = `two_dup_${Date.now()}.bgcode`;
    touchGcode(base);
    seedGcode(pId, base, { filepath: base });

    const r1 = await request(app).post(`/api/projects/${projId}/duplicate`).send({ name: 'Copy 1' });
    const r2 = await request(app).post(`/api/projects/${projId}/duplicate`).send({ name: 'Copy 2' });

    const partId1 = db.prepare('SELECT id FROM parts WHERE project_id = ?').get(r1.body.project.id).id;
    const partId2 = db.prepare('SELECT id FROM parts WHERE project_id = ?').get(r2.body.project.id).id;
    const gc1     = db.prepare('SELECT * FROM gcodes WHERE part_id = ?').get(partId1);
    const gc2     = db.prepare('SELECT * FROM gcodes WHERE part_id = ?').get(partId2);

    expect(gc1.id).not.toBe(gc2.id);
    expect(gc1.filepath).not.toBe(gc2.filepath);

    createdFiles.push(path.join(GCODE_DIR, gc1.filepath));
    createdFiles.push(path.join(GCODE_DIR, gc2.filepath));
  });
});
