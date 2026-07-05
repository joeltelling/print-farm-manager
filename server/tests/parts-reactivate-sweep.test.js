// Unit tests for the scheduler sweep triggered by POST /api/parts when adding a part
// reactivates a completed project (see server/routes/parts.js).
//
// server/routes/parts.js declares its Express router at module scope (outside the
// exported factory), like every other route file in this codebase. That's harmless in
// production (each route module is require()d exactly once for the server's lifetime),
// but a hazard here: this file needs several independent router instances, each bound to
// a different scheduler mock, within the same test process. Node's require() cache means
// a second require('../routes/parts') would reuse the same module-level router, and only
// the first-ever-registered handler for a given path would run. jest.resetModules() before
// each require forces a fresh module (and therefore a fresh router) every time.

const request  = require('supertest');
const express  = require('express');
const Database = require('better-sqlite3');

let db;

function seedProject(status) {
  const now = Date.now();
  const row = db.prepare(
    'INSERT INTO projects (name, status, created_at, updated_at) VALUES (?, ?, ?, ?)'
  ).run(`Project (${status})`, status, now, now);
  return row.lastInsertRowid;
}

// A closed part at target, belonging to the given project — the fixture for PUT
// /api/parts/:id reopen tests (raising target_qty above completed_qty).
function seedClosedPart(projectId) {
  const now = Date.now();
  const row = db.prepare(`
    INSERT INTO parts (project_id, name, target_qty, completed_qty, status, created_at, updated_at)
    VALUES (?, 'Closed Part', 5, 5, 'closed', ?, ?)
  `).run(projectId, now, now);
  return row.lastInsertRowid;
}

// Builds a fresh Express app around a fresh instance of the parts router, bound to the
// given scheduler mock (or none). jest.resetModules() ensures each call gets its own
// module-level router rather than reusing one from a previous call in this file.
function buildApp(scheduler) {
  jest.resetModules();
  const partsRouterFactory = require('../routes/parts');
  const app = express();
  app.use(express.json());
  app.use('/api/parts', scheduler !== undefined ? partsRouterFactory(db, scheduler) : partsRouterFactory(db));
  return app;
}

beforeEach(() => {
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
});

describe('POST /api/parts — sweeps for idle printers on reactivation', () => {
  test('calls sweepIdlePrinters when adding a part reactivates a completed project', async () => {
    const sweepIdlePrinters = jest.fn();
    const app = buildApp({ sweepIdlePrinters });
    const projectId = seedProject('completed');

    const res = await request(app)
      .post('/api/parts')
      .send({ project_id: projectId, name: 'Sweep Part', target_qty: 1 });

    expect(res.status).toBe(201);
    expect(sweepIdlePrinters).toHaveBeenCalledTimes(1);
  });

  test('does not call sweepIdlePrinters when the project is already active', async () => {
    const sweepIdlePrinters = jest.fn();
    const app = buildApp({ sweepIdlePrinters });
    const projectId = seedProject('active');

    const res = await request(app)
      .post('/api/parts')
      .send({ project_id: projectId, name: 'Another Part', target_qty: 1 });

    expect(res.status).toBe(201);
    expect(sweepIdlePrinters).not.toHaveBeenCalled();
  });

  test('does not throw when no scheduler is provided', async () => {
    const app = buildApp(null);
    const projectId = seedProject('completed');

    const res = await request(app)
      .post('/api/parts')
      .send({ project_id: projectId, name: 'No Scheduler Part', target_qty: 1 });

    expect(res.status).toBe(201);
    const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(projectId);
    expect(project.status).toBe('active');
  });
});

describe('PUT /api/parts/:id — sweeps for idle printers when reopening reactivates a project', () => {
  test('calls sweepIdlePrinters when raising target_qty reactivates a completed project', async () => {
    const sweepIdlePrinters = jest.fn();
    const app = buildApp({ sweepIdlePrinters });
    const projectId = seedProject('completed');
    const partId = seedClosedPart(projectId);

    // Operator raises target_qty above completed_qty — the client sends both fields
    // together (see saveQtys() in client/src/pages/Projects.jsx).
    const res = await request(app)
      .put(`/api/parts/${partId}`)
      .send({ completed_qty: 5, target_qty: 10 });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('open');
    const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(projectId);
    expect(project.status).toBe('active');
    expect(sweepIdlePrinters).toHaveBeenCalledTimes(1);
  });

  test('does not call sweepIdlePrinters when the part stays closed', async () => {
    const sweepIdlePrinters = jest.fn();
    const app = buildApp({ sweepIdlePrinters });
    const projectId = seedProject('completed');
    const partId = seedClosedPart(projectId);

    // completed_qty still meets target — part stays closed, project stays completed.
    const res = await request(app)
      .put(`/api/parts/${partId}`)
      .send({ name: 'Renamed, still closed' });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('closed');
    expect(sweepIdlePrinters).not.toHaveBeenCalled();
  });

  test('does not throw when no scheduler is provided', async () => {
    const app = buildApp(null);
    const projectId = seedProject('completed');
    const partId = seedClosedPart(projectId);

    const res = await request(app)
      .put(`/api/parts/${partId}`)
      .send({ completed_qty: 5, target_qty: 10 });

    expect(res.status).toBe(200);
    const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(projectId);
    expect(project.status).toBe('active');
  });
});
