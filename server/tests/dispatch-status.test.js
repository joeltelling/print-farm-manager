// Tests for GET /api/parts/:id/dispatch-status: the operator-facing diagnostic
// that mirrors the scheduler's own eligibility rules (see the CLAUDE.md sync-pairs
// table: scheduler.js candidate SQL must stay in sync with this route). Covers the
// project-level allowed_groups cascade added alongside required_material/color.

const request  = require('supertest');
const express  = require('express');
const Database = require('better-sqlite3');

let db;
let app;

beforeEach(() => {
  db = new Database(':memory:');
  db.exec(`
    CREATE TABLE printers (
      id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT,
      model TEXT NOT NULL, group_name TEXT, loaded_material TEXT, loaded_color TEXT,
      status TEXT DEFAULT 'IDLE', is_held INTEGER DEFAULT 0, is_active INTEGER DEFAULT 1
    );
    CREATE TABLE projects (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL, status TEXT DEFAULT 'active',
      priority INTEGER DEFAULT 0, created_at INTEGER DEFAULT 0,
      required_material TEXT, required_color TEXT, allowed_groups TEXT
    );
    CREATE TABLE parts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id INTEGER NOT NULL, name TEXT NOT NULL,
      target_qty INTEGER NOT NULL, completed_qty INTEGER DEFAULT 0,
      status TEXT DEFAULT 'open', sort_order INTEGER DEFAULT 0,
      print_time_seconds INTEGER,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
    CREATE TABLE gcodes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      part_id INTEGER NOT NULL, printer_model TEXT NOT NULL,
      filename TEXT NOT NULL, filepath TEXT NOT NULL, parts_per_plate INTEGER NOT NULL,
      est_print_secs INTEGER, allowed_groups TEXT, required_material TEXT, required_color TEXT,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE jobs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      part_id INTEGER NOT NULL, printer_id INTEGER, status TEXT DEFAULT 'queued', parts_per_plate INTEGER NOT NULL
    );
  `);

  // routes/parts.js declares its Express router at module scope, like every route
  // file in this codebase. Node's require() cache means a second require() in the
  // same process would reuse that router with a stale db closure from a previous
  // test's beforeEach. jest.resetModules() forces a fresh module (and router)
  // each time. See the identical note in backup-restore.test.js.
  jest.resetModules();
  app = express();
  app.use(express.json());
  app.use('/api/parts', require('../routes/parts')(db));
});

const now = Date.now();

function seedProject(overrides = {}) {
  const stmt = db.prepare(`
    INSERT INTO projects (name, status, priority, required_material, required_color, allowed_groups)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  const r = stmt.run(
    overrides.name ?? 'Proj',
    overrides.status ?? 'active',
    overrides.priority ?? 0,
    overrides.required_material ?? null,
    overrides.required_color ?? null,
    overrides.allowed_groups ?? null,
  );
  return r.lastInsertRowid;
}

function seedPart(projectId, overrides = {}) {
  const r = db.prepare(`
    INSERT INTO parts (project_id, name, target_qty, completed_qty, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(projectId, overrides.name ?? 'Part', overrides.target_qty ?? 10, overrides.completed_qty ?? 0, overrides.status ?? 'open', now, now);
  return r.lastInsertRowid;
}

function seedGcode(partId, overrides = {}) {
  db.prepare(`
    INSERT INTO gcodes (part_id, printer_model, filename, filepath, parts_per_plate, allowed_groups, required_material, required_color, created_at)
    VALUES (?, ?, 'f.gcode', 'f.gcode', 1, ?, ?, ?, ?)
  `).run(partId, overrides.printer_model ?? 'mk4s', overrides.allowed_groups ?? null,
         overrides.required_material ?? null, overrides.required_color ?? null, now);
}

function seedPrinter(overrides = {}) {
  db.prepare(`
    INSERT INTO printers (name, model, group_name, loaded_material, loaded_color, status, is_held, is_active)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    overrides.name ?? 'P1',
    overrides.model ?? 'mk4s', overrides.group_name ?? null,
    overrides.loaded_material ?? null, overrides.loaded_color ?? null,
    overrides.status ?? 'IDLE', overrides.is_held ?? 0, overrides.is_active ?? 1,
  );
}

describe('GET /api/parts/:id/dispatch-status', () => {
  test('404 for an unknown part', async () => {
    const res = await request(app).get('/api/parts/999/dispatch-status');
    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/not found/i);
  });

  test('blocks when the project is not active', async () => {
    const projectId = seedProject({ status: 'paused' });
    const partId = seedPart(projectId);
    const res = await request(app).get(`/api/parts/${partId}/dispatch-status`);
    expect(res.status).toBe(200);
    expect(res.body.dispatchable).toBe(false);
    expect(res.body.reasons.join(' ')).toMatch(/not Active/i);
  });

  test('blocks when no gcode is uploaded', async () => {
    const projectId = seedProject();
    const partId = seedPart(projectId);
    const res = await request(app).get(`/api/parts/${partId}/dispatch-status`);
    expect(res.status).toBe(200);
    expect(res.body.dispatchable).toBe(false);
    expect(res.body.reasons.join(' ')).toMatch(/No G-code uploaded/i);
  });

  test('dispatchable when a matching idle printer exists and nothing restricts it', async () => {
    const projectId = seedProject();
    const partId = seedPart(projectId);
    seedGcode(partId);
    seedPrinter();
    const res = await request(app).get(`/api/parts/${partId}/dispatch-status`);
    expect(res.status).toBe(200);
    expect(res.body.dispatchable).toBe(true);
    expect(res.body.reasons).toEqual([]);
  });

  test('a gcode with no allowed_groups inherits the project-level restriction and reports no match', async () => {
    const projectId = seedProject({ allowed_groups: JSON.stringify(['Rack A']) });
    const partId = seedPart(projectId);
    seedGcode(partId); // no per-gcode allowed_groups, must inherit the project's
    seedPrinter({ group_name: 'Rack B' }); // wrong group

    const res = await request(app).get(`/api/parts/${partId}/dispatch-status`);
    expect(res.status).toBe(200);
    expect(res.body.dispatchable).toBe(false);
    expect(res.body.reasons.join(' ')).toMatch(/no printers in allowed group\(s\) Rack A/i);
  });

  test('a gcode inheriting the project group restriction dispatches once a matching printer exists', async () => {
    const projectId = seedProject({ allowed_groups: JSON.stringify(['Rack A']) });
    const partId = seedPart(projectId);
    seedGcode(partId);
    seedPrinter({ group_name: 'Rack A' });

    const res = await request(app).get(`/api/parts/${partId}/dispatch-status`);
    expect(res.status).toBe(200);
    expect(res.body.dispatchable).toBe(true);
  });

  test('a gcode-level allowed_groups overrides the project default entirely', async () => {
    const projectId = seedProject({ allowed_groups: JSON.stringify(['Rack A']) });
    const partId = seedPart(projectId);
    seedGcode(partId, { allowed_groups: JSON.stringify(['Rack B']) });
    // Printer matches the gcode's own restriction, not the project's.
    seedPrinter({ group_name: 'Rack B' });

    const res = await request(app).get(`/api/parts/${partId}/dispatch-status`);
    expect(res.status).toBe(200);
    expect(res.body.dispatchable).toBe(true);
  });

  test('this is the original bug scenario: a project-referenced group with zero matching printers is reported by name, not silently treated as unrestricted', async () => {
    const projectId = seedProject({ allowed_groups: JSON.stringify(['Rack A']) });
    const partId = seedPart(projectId);
    seedGcode(partId);
    // No printer anywhere carries "Rack A": this used to be indistinguishable
    // from "no restriction" in the UI before the group registry existed.
    seedPrinter({ group_name: 'Rack Z' });

    const res = await request(app).get(`/api/parts/${partId}/dispatch-status`);
    expect(res.status).toBe(200);
    expect(res.body.dispatchable).toBe(false);
    expect(res.body.reasons.join(' ')).toContain('Rack A');
  });

  // The printer list is what makes "ready" actionable: the reported trigger was a part
  // the check called ready with no way to see which printer was the match.
  describe('per-printer match list', () => {
    test('lists every active printer of the model with its match state and loaded filament', async () => {
      const projectId = seedProject({ required_material: 'PETG' });
      const partId = seedPart(projectId);
      seedGcode(partId);
      seedPrinter({ name: 'A-ready', loaded_material: 'PETG' });
      seedPrinter({ name: 'B-pla', loaded_material: 'PLA' });
      seedPrinter({ name: 'C-busy', loaded_material: 'PETG', status: 'PRINTING' });
      seedPrinter({ name: 'D-held', loaded_material: 'PETG', status: 'FINISHED', is_held: 1 });
      seedPrinter({ name: 'E-other-model', model: 'xl', loaded_material: 'PETG' });

      const res = await request(app).get(`/api/parts/${partId}/dispatch-status`);
      expect(res.status).toBe(200);
      expect(res.body.gcodes).toHaveLength(1);
      const g = res.body.gcodes[0];
      expect(g.required_material).toBe('PETG');
      expect(g.printers.map(p => [p.name, p.state])).toEqual([
        ['A-ready', 'ready'], ['B-pla', 'wrong_filament'], ['C-busy', 'busy'], ['D-held', 'held'],
      ]);
      expect(g.printers[1].loaded_material).toBe('PLA');
      expect(g.printers[0].next_up).toMatchObject({ part_id: partId, is_this_part: true });
    });

    test('a ready printer whose next candidate is a higher-priority part says so', async () => {
      const urgent = seedProject({ name: 'Urgent', priority: 0 });
      const urgentPart = seedPart(urgent, { name: 'Urgent part' });
      seedGcode(urgentPart);
      const later = seedProject({ name: 'Later', priority: 1 });
      const laterPart = seedPart(later);
      seedGcode(laterPart);
      seedPrinter();

      const res = await request(app).get(`/api/parts/${laterPart}/dispatch-status`);
      expect(res.body.dispatchable).toBe(true);
      const p = res.body.gcodes[0].printers[0];
      expect(p.next_up).toMatchObject({ part_id: urgentPart, part_name: 'Urgent part', project_name: 'Urgent', is_this_part: false });
      expect(res.body.notes.join(' ')).toMatch(/higher-priority work/i);
    });

    test('a higher-priority part already covered by in-progress jobs is skipped, as the scheduler does', async () => {
      const urgent = seedProject({ name: 'Urgent', priority: 0 });
      const urgentPart = seedPart(urgent, { target_qty: 1 });
      seedGcode(urgentPart);
      db.prepare("INSERT INTO jobs (part_id, status, parts_per_plate) VALUES (?, 'printing', 1)").run(urgentPart);
      const later = seedProject({ name: 'Later', priority: 1 });
      const laterPart = seedPart(later);
      seedGcode(laterPart);
      seedPrinter();

      const res = await request(app).get(`/api/parts/${laterPart}/dispatch-status`);
      expect(res.body.gcodes[0].printers[0].next_up).toMatchObject({ part_id: laterPart, is_this_part: true });
      expect(res.body.notes).toEqual([]);
    });

    test('non-ready printers carry no next_up', async () => {
      const projectId = seedProject();
      const partId = seedPart(projectId);
      seedGcode(partId);
      seedPrinter({ status: 'PRINTING' });
      const res = await request(app).get(`/api/parts/${partId}/dispatch-status`);
      expect(res.body.gcodes[0].printers[0]).toMatchObject({ state: 'busy', next_up: null });
    });
  });
});
