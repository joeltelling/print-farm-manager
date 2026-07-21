// Tests for PUT /api/projects/:id/groups: sets the project-level allowed_groups
// default that gcodes.allowed_groups falls back to (see scheduler.js's
// COALESCE(gcodes.allowed_groups, projects.allowed_groups), tested end to end in
// scheduler-targeting.test.js and dispatch-status.test.js). This file covers the
// route's own contract in isolation: request/response shape, 404, and the
// empty-array-clears-to-NULL behavior the cascade depends on.

const request  = require('supertest');
const express  = require('express');
const Database = require('better-sqlite3');

let db;
let app;

beforeEach(() => {
  db = new Database(':memory:');
  db.exec(`
    CREATE TABLE projects (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      name           TEXT NOT NULL,
      description    TEXT,
      status         TEXT DEFAULT 'draft',
      priority       INTEGER DEFAULT 0,
      required_material TEXT,
      required_color TEXT,
      allowed_groups TEXT,
      created_at     INTEGER NOT NULL,
      updated_at     INTEGER NOT NULL
    );
  `);

  // routes/projects.js declares its Express router at module scope, like every
  // route file in this codebase. Node's require() cache means a second require()
  // in the same process would reuse that router with a stale db closure from a
  // previous test's beforeEach. jest.resetModules() forces a fresh module (and
  // router) each time. See the identical note in backup-restore.test.js.
  jest.resetModules();
  app = express();
  app.use(express.json());
  app.use('/api/projects', require('../routes/projects')(db));
});

function seedProject() {
  const now = Date.now();
  const r = db.prepare(`
    INSERT INTO projects (name, status, created_at, updated_at) VALUES ('Proj', 'active', ?, ?)
  `).run(now, now);
  return r.lastInsertRowid;
}

describe('PUT /api/projects/:id/groups', () => {
  test('404 for an unknown project', async () => {
    const res = await request(app).put('/api/projects/999/groups').send({ allowed_groups: ['Rack A'] });
    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/not found/i);
  });

  test('stores the array as a JSON string and returns the updated project', async () => {
    const id = seedProject();
    const res = await request(app).put(`/api/projects/${id}/groups`).send({ allowed_groups: ['Rack A', 'Rack B'] });
    expect(res.status).toBe(200);
    expect(res.body.allowed_groups).toBe(JSON.stringify(['Rack A', 'Rack B']));

    const row = db.prepare('SELECT allowed_groups FROM projects WHERE id = ?').get(id);
    expect(row.allowed_groups).toBe(JSON.stringify(['Rack A', 'Rack B']));
  });

  test('an empty array clears the restriction to NULL, not "[]"', async () => {
    const id = seedProject();
    await request(app).put(`/api/projects/${id}/groups`).send({ allowed_groups: ['Rack A'] });

    const res = await request(app).put(`/api/projects/${id}/groups`).send({ allowed_groups: [] });
    expect(res.status).toBe(200);
    expect(res.body.allowed_groups).toBeNull();

    // Load-bearing for the scheduler's COALESCE cascade: '[]' is non-NULL and
    // would match zero printers, silently freezing dispatch for the project.
    const row = db.prepare('SELECT allowed_groups FROM projects WHERE id = ?').get(id);
    expect(row.allowed_groups).toBeNull();
  });

  test('an omitted allowed_groups body field also clears to NULL', async () => {
    const id = seedProject();
    await request(app).put(`/api/projects/${id}/groups`).send({ allowed_groups: ['Rack A'] });

    const res = await request(app).put(`/api/projects/${id}/groups`).send({});
    expect(res.status).toBe(200);
    expect(res.body.allowed_groups).toBeNull();
  });

  test('trims whitespace and drops empty entries from the array', async () => {
    const id = seedProject();
    const res = await request(app).put(`/api/projects/${id}/groups`).send({ allowed_groups: [' Rack A ', '', '  '] });
    expect(res.status).toBe(200);
    expect(res.body.allowed_groups).toBe(JSON.stringify(['Rack A']));
  });

  test('does not touch other project fields', async () => {
    const id = seedProject();
    const before = db.prepare('SELECT * FROM projects WHERE id = ?').get(id);

    const res = await request(app).put(`/api/projects/${id}/groups`).send({ allowed_groups: ['Rack A'] });
    expect(res.status).toBe(200);
    expect(res.body.name).toBe(before.name);
    expect(res.body.status).toBe(before.status);
  });
});
