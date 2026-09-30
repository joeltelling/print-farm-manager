const request  = require('supertest');
const express  = require('express');
const Database = require('better-sqlite3');

// ── In-memory DB ──────────────────────────────────────────────────────────────
let db;
let app;

beforeAll(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE projects (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      description TEXT,
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
      sort_order INTEGER DEFAULT 0,
      print_time_seconds INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE jobs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      part_id INTEGER NOT NULL REFERENCES parts(id),
      printer_id INTEGER NOT NULL,
      gcode_id INTEGER,
      parts_per_plate INTEGER NOT NULL,
      status TEXT DEFAULT 'queued',
      started_at INTEGER,
      finished_at INTEGER,
      created_at INTEGER NOT NULL
    );
  `);

  const now = Date.now();
  db.prepare('INSERT INTO projects (name, created_at, updated_at) VALUES (?, ?, ?)').run('Original Project', now, now);
  db.prepare('INSERT INTO parts (project_id, name, target_qty, created_at, updated_at) VALUES (1, ?, 50, ?, ?)').run('Original Part', now, now);

  const projectsRouter = require('../routes/projects');
  const partsRouter    = require('../routes/parts');

  app = express();
  app.use(express.json());
  app.use('/api/projects', projectsRouter(db));
  app.use('/api/parts',    partsRouter(db));
});

// ── Project rename ────────────────────────────────────────────────────────────

describe('PUT /api/projects/:id — rename', () => {
  test('renames a project', async () => {
    const res = await request(app)
      .put('/api/projects/1')
      .send({ name: 'Renamed Project' });

    expect(res.status).toBe(200);
    expect(res.body.name).toBe('Renamed Project');
  });

  test('returned project reflects updated name on subsequent GET', async () => {
    await request(app).put('/api/projects/1').send({ name: 'Final Name' });

    const res = await request(app).get('/api/projects/1');
    expect(res.status).toBe(200);
    expect(res.body.name).toBe('Final Name');
  });

  test('omitting name leaves existing name intact (COALESCE)', async () => {
    const before = await request(app).get('/api/projects/1');
    const currentName = before.body.name;

    const res = await request(app)
      .put('/api/projects/1')
      .send({ status: 'active' });

    expect(res.status).toBe(200);
    expect(res.body.name).toBe(currentName);
  });

  test('returns 404 for unknown project id', async () => {
    const res = await request(app)
      .put('/api/projects/9999')
      .send({ name: 'Ghost' });

    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/not found/i);
  });
});

// ── Part rename ───────────────────────────────────────────────────────────────

describe('PUT /api/parts/:id — rename', () => {
  test('renames a part', async () => {
    const res = await request(app)
      .put('/api/parts/1')
      .send({ name: 'Renamed Part' });

    expect(res.status).toBe(200);
    expect(res.body.name).toBe('Renamed Part');
  });

  test('returned part reflects updated name on subsequent GET', async () => {
    await request(app).put('/api/parts/1').send({ name: 'Final Part Name' });

    const res = await request(app).get('/api/parts/1');
    expect(res.status).toBe(200);
    expect(res.body.name).toBe('Final Part Name');
  });

  test('omitting name leaves existing name intact (COALESCE)', async () => {
    const before = await request(app).get('/api/parts/1');
    const currentName = before.body.name;

    const res = await request(app)
      .put('/api/parts/1')
      .send({ completed_qty: 5 });

    expect(res.status).toBe(200);
    expect(res.body.name).toBe(currentName);
  });

  test('returns 404 for unknown part id', async () => {
    const res = await request(app)
      .put('/api/parts/9999')
      .send({ name: 'Ghost Part' });

    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/not found/i);
  });
});
