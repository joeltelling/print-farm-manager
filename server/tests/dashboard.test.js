const request  = require('supertest');
const express  = require('express');
const Database = require('better-sqlite3');

let db;
let app;

beforeAll(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE projects (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      status TEXT DEFAULT 'draft',
      priority INTEGER DEFAULT 0,
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
      sort_order INTEGER NOT NULL DEFAULT 0,
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
      gcode_id INTEGER NOT NULL REFERENCES gcodes(id),
      parts_per_plate INTEGER NOT NULL,
      status TEXT DEFAULT 'queued',
      started_at INTEGER,
      finished_at INTEGER,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE printer_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      printer_id INTEGER NOT NULL,
      event_type TEXT NOT NULL,
      note TEXT,
      created_at INTEGER NOT NULL
    );
  `);

  app = express();
  app.use(express.json());
  app.use('/api/dashboard', require('../routes/dashboard')(db));
});

function seedProject(name, { status = 'active', priority = 0 } = {}) {
  const now = Date.now();
  const row = db.prepare(
    'INSERT INTO projects (name, status, priority, created_at, updated_at) VALUES (?, ?, ?, ?, ?)'
  ).run(name, status, priority, now, now);
  return row.lastInsertRowid;
}

describe('GET /api/dashboard: active project ordering', () => {
  test('orders active_projects by priority, not just by creation order', async () => {
    // Seed in creation order A, B, C but give C the highest priority (lowest number)
    // and B the middle one, so priority order (C, B, A) differs from creation order
    // (A, B, C). This is the exact shape of the reported bug: the Projects page and
    // scheduler both order by priority ASC, created_at ASC, but the dashboard ignored
    // priority and always showed oldest-first regardless of manual reordering.
    seedProject('A', { status: 'active', priority: 5 });
    seedProject('B', { status: 'active', priority: 1 });
    seedProject('C', { status: 'active', priority: 0 });

    const res = await request(app).get('/api/dashboard');
    expect(res.status).toBe(200);
    expect(res.body.active_projects.map(p => p.name)).toEqual(['C', 'B', 'A']);
  });

  test('falls back to created_at when priorities are equal', async () => {
    db.exec('DELETE FROM projects');
    const firstId  = seedProject('First',  { status: 'active', priority: 0 });
    const secondId = seedProject('Second', { status: 'active', priority: 0 });
    // Force a distinct created_at even if the inserts landed in the same millisecond.
    db.prepare('UPDATE projects SET created_at = ? WHERE id = ?').run(1000, firstId);
    db.prepare('UPDATE projects SET created_at = ? WHERE id = ?').run(2000, secondId);

    const res = await request(app).get('/api/dashboard');
    expect(res.body.active_projects.map(p => p.name)).toEqual(['First', 'Second']);
  });

  test('excludes non-active projects', async () => {
    db.exec('DELETE FROM projects');
    seedProject('Draft',     { status: 'draft' });
    seedProject('Paused',    { status: 'paused' });
    seedProject('Completed', { status: 'completed' });
    seedProject('Active',    { status: 'active' });

    const res = await request(app).get('/api/dashboard');
    expect(res.body.active_projects.map(p => p.name)).toEqual(['Active']);
  });
});
