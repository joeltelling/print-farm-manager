// Tests for GET /api/parts/queue: the Print Queue page's data. Every open part of every
// active project in the scheduler's candidate order, with the printers that match each
// part or, when none do, the reasons why. The per-part rules are shared with
// GET /api/parts/:id/dispatch-status (routes/parts.js, diagnosePart), so these tests
// cover what the queue adds on top: selection, ordering, match lists, no-match reasons.

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
      part_id INTEGER NOT NULL, printer_id INTEGER, status TEXT DEFAULT 'queued',
      parts_per_plate INTEGER NOT NULL, started_at INTEGER, created_at INTEGER DEFAULT 0
    );
  `);

  // Fresh router per test: routes/parts.js holds its router at module scope, so a cached
  // module would keep the previous test's db. Same note as dispatch-status.test.js.
  jest.resetModules();
  app = express();
  app.use(express.json());
  app.use('/api/parts', require('../routes/parts')(db));
});

const now = Date.now();

function seedProject(overrides = {}) {
  return db.prepare(`
    INSERT INTO projects (name, status, priority, created_at, required_material, required_color, allowed_groups)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    overrides.name ?? 'Proj', overrides.status ?? 'active', overrides.priority ?? 0,
    overrides.created_at ?? 0, overrides.required_material ?? null,
    overrides.required_color ?? null, overrides.allowed_groups ?? null,
  ).lastInsertRowid;
}

function seedPart(projectId, overrides = {}) {
  return db.prepare(`
    INSERT INTO parts (project_id, name, target_qty, completed_qty, status, sort_order, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    projectId, overrides.name ?? 'Part', overrides.target_qty ?? 10, overrides.completed_qty ?? 0,
    overrides.status ?? 'open', overrides.sort_order ?? 0, now, now,
  ).lastInsertRowid;
}

function seedGcode(partId, overrides = {}) {
  db.prepare(`
    INSERT INTO gcodes (part_id, printer_model, filename, filepath, parts_per_plate, allowed_groups, required_material, required_color, created_at)
    VALUES (?, ?, ?, 'f.gcode', 1, ?, ?, ?, ?)
  `).run(
    partId, overrides.printer_model ?? 'mk4s', overrides.filename ?? 'f.gcode',
    overrides.allowed_groups ?? null, overrides.required_material ?? null,
    overrides.required_color ?? null, now,
  );
}

function seedPrinter(overrides = {}) {
  return db.prepare(`
    INSERT INTO printers (name, model, group_name, loaded_material, loaded_color, status, is_held, is_active)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    overrides.name ?? 'P1', overrides.model ?? 'mk4s', overrides.group_name ?? null,
    overrides.loaded_material ?? null, overrides.loaded_color ?? null,
    overrides.status ?? 'IDLE', overrides.is_held ?? 0, overrides.is_active ?? 1,
  ).lastInsertRowid;
}

describe('GET /api/parts/queue', () => {
  test('is not shadowed by /:id and returns an empty queue with a version', async () => {
    const res = await request(app).get('/api/parts/queue');
    expect(res.status).toBe(200);
    expect(res.body.parts).toEqual([]);
    expect(typeof res.body.version).toBe('string');
  });

  test('lists only open parts of active projects, in candidate order', async () => {
    const low   = seedProject({ name: 'Low',   priority: 2 });
    const high  = seedProject({ name: 'High',  priority: 1 });
    const draft = seedProject({ name: 'Draft', priority: 0, status: 'draft' });
    seedPart(low,  { name: 'low-a' });
    seedPart(high, { name: 'high-second', sort_order: 1 });
    seedPart(high, { name: 'high-first',  sort_order: 0 });
    seedPart(high, { name: 'high-done',   status: 'complete', completed_qty: 10 });
    seedPart(draft, { name: 'draft-part' });

    const res = await request(app).get('/api/parts/queue');
    expect(res.status).toBe(200);
    expect(res.body.parts.map(p => p.part_name)).toEqual(['high-first', 'high-second', 'low-a']);
    expect(res.body.parts.map(p => p.position)).toEqual([1, 2, 3]);
    expect(res.body.parts[0].project_name).toBe('High');
  });

  test('matches include free, busy, and held printers but not mismatched ones', async () => {
    const projectId = seedProject({ required_material: 'PETG' });
    const partId = seedPart(projectId);
    seedGcode(partId);
    seedPrinter({ name: 'Free',  loaded_material: 'PETG' });
    seedPrinter({ name: 'Busy',  loaded_material: 'PETG', status: 'PRINTING' });
    seedPrinter({ name: 'Held',  loaded_material: 'PETG', status: 'FINISHED', is_held: 1 });
    seedPrinter({ name: 'Wrong', loaded_material: 'PLA' });
    seedPrinter({ name: 'Other model', model: 'xl', loaded_material: 'PETG' });

    const res = await request(app).get('/api/parts/queue');
    const [part] = res.body.parts;
    const byName = Object.fromEntries(part.matches.map(m => [m.name, m.state]));
    expect(byName).toEqual({ Busy: 'busy', Free: 'ready', Held: 'held' });
    expect(part.no_match_reasons).toEqual([]);
    expect(part.dispatchable).toBe(true);
    // The free printer would print this part next, and the page shows that on its tag.
    expect(part.matches.find(m => m.name === 'Free').next_up.is_this_part).toBe(true);
  });

  test('a printer holding an active job row is busy even while its polled status is IDLE', async () => {
    const projectId = seedProject();
    const partId = seedPart(projectId);
    seedGcode(partId);
    const printerId = seedPrinter({ name: 'Just dispatched', status: 'IDLE' });
    db.prepare("INSERT INTO jobs (part_id, printer_id, status, parts_per_plate) VALUES (?, ?, 'uploading', 1)")
      .run(partId, printerId);

    const res = await request(app).get('/api/parts/queue');
    const [part] = res.body.parts;
    expect(part.matches).toHaveLength(1);
    expect(part.matches[0].state).toBe('busy');
    expect(part.dispatchable).toBe(false);
  });

  test('explains a part with no G-code', async () => {
    const projectId = seedProject();
    seedPart(projectId);
    seedPrinter();

    const res = await request(app).get('/api/parts/queue');
    const [part] = res.body.parts;
    expect(part.matches).toEqual([]);
    expect(part.no_match_reasons).toHaveLength(1);
    expect(part.no_match_reasons[0]).toMatch(/No G-code uploaded/);
    expect(part.blockers).toEqual([]);
  });

  test('explains missing model, group, and filament per G-code', async () => {
    const projectId = seedProject();
    const partId = seedPart(projectId);
    seedGcode(partId, { printer_model: 'xl',   filename: 'xl.gcode' });
    seedGcode(partId, { printer_model: 'mk4s', filename: 'grp.gcode', allowed_groups: JSON.stringify(['Lab']) });
    seedGcode(partId, { printer_model: 'mini', filename: 'fil.gcode', required_material: 'ASA', required_color: 'Black' });
    seedPrinter({ model: 'mk4s', group_name: 'Shop' });
    seedPrinter({ model: 'mini', loaded_material: 'PLA' });

    const res = await request(app).get('/api/parts/queue');
    const [part] = res.body.parts;
    expect(part.matches).toEqual([]);
    const reasons = part.no_match_reasons.join('\n');
    expect(reasons).toMatch(/xl\.gcode: no active printers of model "xl"/);
    expect(reasons).toMatch(/grp\.gcode: no printers in allowed group\(s\) Lab/);
    expect(reasons).toMatch(/fil\.gcode: no printer has ASA \/ Black loaded/);
  });

  test('no-match reasons stay empty when any G-code has a match', async () => {
    const projectId = seedProject();
    const partId = seedPart(projectId);
    seedGcode(partId, { printer_model: 'xl' });
    seedGcode(partId, { printer_model: 'mk4s' });
    seedPrinter({ model: 'mk4s' });

    const res = await request(app).get('/api/parts/queue');
    const [part] = res.body.parts;
    expect(part.matches.map(m => m.model)).toEqual(['mk4s']);
    expect(part.no_match_reasons).toEqual([]);
  });

  test('reports a part whose remaining quantity is already printing as a blocker', async () => {
    const projectId = seedProject();
    const partId = seedPart(projectId, { target_qty: 1 });
    seedGcode(partId);
    const printerId = seedPrinter({ status: 'PRINTING' });
    db.prepare("INSERT INTO jobs (part_id, printer_id, status, parts_per_plate) VALUES (?, ?, 'printing', 1)")
      .run(partId, printerId);

    const res = await request(app).get('/api/parts/queue');
    const [part] = res.body.parts;
    expect(part.active_qty).toBe(1);
    expect(part.blockers.join(' ')).toMatch(/already printing cover the remaining 1/);
    expect(part.matches).toHaveLength(1);
  });

  test('version changes when a queue input changes', async () => {
    const projectId = seedProject();
    seedPart(projectId);
    const before = (await request(app).get('/api/parts/queue')).body.version;
    seedPrinter({ loaded_material: 'PLA' });
    const after = (await request(app).get('/api/parts/queue')).body.version;
    expect(after).not.toBe(before);
  });
});
