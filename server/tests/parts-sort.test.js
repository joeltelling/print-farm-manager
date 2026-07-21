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
  // Two projects so we can confirm sort_order is per-project
  db.prepare('INSERT INTO projects (name, created_at, updated_at) VALUES (?, ?, ?)').run('Project A', now, now);
  db.prepare('INSERT INTO projects (name, created_at, updated_at) VALUES (?, ?, ?)').run('Project B', now, now);

  app = express();
  app.use(express.json());
  app.use('/api/parts', require('../routes/parts')(db));
});

describe('POST /api/parts — sort_order assignment', () => {
  test('first part in a project gets sort_order 0', async () => {
    const res = await request(app)
      .post('/api/parts')
      .send({ project_id: 1, name: 'Part Alpha', target_qty: 10 });
    expect(res.status).toBe(201);
    expect(res.body.sort_order).toBe(0);
  });

  test('second part gets sort_order 1', async () => {
    const res = await request(app)
      .post('/api/parts')
      .send({ project_id: 1, name: 'Part Beta', target_qty: 10 });
    expect(res.status).toBe(201);
    expect(res.body.sort_order).toBe(1);
  });

  test('third part gets sort_order 2', async () => {
    const res = await request(app)
      .post('/api/parts')
      .send({ project_id: 1, name: 'Part Gamma', target_qty: 10 });
    expect(res.status).toBe(201);
    expect(res.body.sort_order).toBe(2);
  });

  test('sort_order resets independently for a different project', async () => {
    const res = await request(app)
      .post('/api/parts')
      .send({ project_id: 2, name: 'Part Delta', target_qty: 5 });
    expect(res.status).toBe(201);
    expect(res.body.sort_order).toBe(0);
  });

  test('GET returns parts in sort_order ASC', async () => {
    const res = await request(app).get('/api/parts?project_id=1');
    expect(res.status).toBe(200);
    const orders = res.body.map(p => p.sort_order);
    expect(orders).toEqual([...orders].sort((a, b) => a - b));
  });

  test('returns 400 when required fields are missing', async () => {
    const res = await request(app)
      .post('/api/parts')
      .send({ project_id: 1, name: 'No Qty' });
    expect(res.status).toBe(400);
  });
});

describe('POST /api/parts — reactivates a completed project', () => {
  test('adding a part to a completed project flips it back to active', async () => {
    const now = Date.now();
    const projRow = db.prepare(
      "INSERT INTO projects (name, status, created_at, updated_at) VALUES ('Done Project', 'completed', ?, ?)"
    ).run(now, now);
    const projectId = projRow.lastInsertRowid;

    const res = await request(app)
      .post('/api/parts')
      .send({ project_id: projectId, name: 'New Part', target_qty: 1 });
    expect(res.status).toBe(201);

    const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(projectId);
    expect(project.status).toBe('active');
  });

  test('adding a part to an already-active project leaves it active', async () => {
    const now = Date.now();
    const projRow = db.prepare(
      "INSERT INTO projects (name, status, created_at, updated_at) VALUES ('Active Project', 'active', ?, ?)"
    ).run(now, now);
    const projectId = projRow.lastInsertRowid;

    await request(app)
      .post('/api/parts')
      .send({ project_id: projectId, name: 'Another Part', target_qty: 1 });

    const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(projectId);
    expect(project.status).toBe('active');
  });
});
