const request  = require('supertest');
const express  = require('express');
const Database = require('better-sqlite3');

let db;
let app;

beforeAll(() => {
  db = new Database(':memory:');
  db.exec(`
    CREATE TABLE printer_groups (
      name       TEXT PRIMARY KEY,
      created_at INTEGER NOT NULL
    )
  `);
  db.exec(`
    CREATE TABLE printers (
      id         INTEGER PRIMARY KEY,
      group_name TEXT,
      is_active  INTEGER NOT NULL DEFAULT 1
    )
  `);
  db.exec(`
    CREATE TABLE gcodes (
      id             INTEGER PRIMARY KEY,
      allowed_groups TEXT
    )
  `);
  db.exec(`
    CREATE TABLE projects (
      id             INTEGER PRIMARY KEY,
      allowed_groups TEXT
    )
  `);

  app = express();
  app.use(express.json());
  app.use('/api/groups', require('../routes/groups')(db));
});

beforeEach(() => {
  db.exec('DELETE FROM printers');
  db.exec('DELETE FROM gcodes');
  db.exec('DELETE FROM projects');
  db.exec('DELETE FROM printer_groups');
});

// ── GET /api/groups ────────────────────────────────────────────────────────

describe('GET /api/groups', () => {
  test('returns empty array when no groups registered', async () => {
    const res = await request(app).get('/api/groups');
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  test('returns all groups ordered by name, including one with no printers', async () => {
    db.exec(`INSERT INTO printer_groups (name, created_at) VALUES ('Rack B', 1)`);
    db.exec(`INSERT INTO printer_groups (name, created_at) VALUES ('Rack A', 1)`);
    // Rack A has zero printers: this is the exact scenario the registry fixes,
    // it must still be listed, not silently derived away.
    const res = await request(app).get('/api/groups');
    expect(res.status).toBe(200);
    expect(res.body.map(g => g.name)).toEqual(['Rack A', 'Rack B']);
  });
});

// ── POST /api/groups ───────────────────────────────────────────────────────

describe('POST /api/groups', () => {
  test('creates a group and returns 201 with the new record', async () => {
    const res = await request(app).post('/api/groups').send({ name: 'Rack A' });
    expect(res.status).toBe(201);
    expect(res.body.name).toBe('Rack A');
    expect(res.body.created_at).toEqual(expect.any(Number));
  });

  test('trims whitespace from name', async () => {
    const res = await request(app).post('/api/groups').send({ name: '  Rack A  ' });
    expect(res.status).toBe(201);
    expect(res.body.name).toBe('Rack A');
  });

  test('rejects an empty name', async () => {
    const res = await request(app).post('/api/groups').send({ name: '   ' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/required/i);
  });

  test('rejects a missing name', async () => {
    const res = await request(app).post('/api/groups').send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/required/i);
  });

  test('returns 409 on duplicate name', async () => {
    db.exec(`INSERT INTO printer_groups (name, created_at) VALUES ('Rack A', 1)`);
    const res = await request(app).post('/api/groups').send({ name: 'Rack A' });
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/already exists/i);
  });
});

// ── DELETE /api/groups/:name ───────────────────────────────────────────────

describe('DELETE /api/groups/:name', () => {
  test('deletes an unreferenced group and returns ok', async () => {
    db.exec(`INSERT INTO printer_groups (name, created_at) VALUES ('Rack A', 1)`);
    const res = await request(app).delete(`/api/groups/${encodeURIComponent('Rack A')}`);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(db.prepare('SELECT * FROM printer_groups WHERE name = ?').get('Rack A')).toBeUndefined();
  });

  test('returns 404 for a non-existent group', async () => {
    const res = await request(app).delete('/api/groups/does-not-exist');
    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/not found/i);
  });

  test('blocks delete when an active printer carries the group', async () => {
    db.exec(`INSERT INTO printer_groups (name, created_at) VALUES ('Rack A', 1)`);
    db.exec(`INSERT INTO printers (group_name, is_active) VALUES ('Rack A', 1)`);
    const res = await request(app).delete(`/api/groups/${encodeURIComponent('Rack A')}`);
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/active printer/i);
  });

  test('allows delete when only an inactive (decommissioned) printer carries the group', async () => {
    db.exec(`INSERT INTO printer_groups (name, created_at) VALUES ('Rack A', 1)`);
    db.exec(`INSERT INTO printers (group_name, is_active) VALUES ('Rack A', 0)`);
    const res = await request(app).delete(`/api/groups/${encodeURIComponent('Rack A')}`);
    expect(res.status).toBe(200);
  });

  // This is the bug scenario: no printer needs to carry the group for the
  // restriction to still count as in use.
  test('blocks delete when a gcode allowed_groups references the group', async () => {
    db.exec(`INSERT INTO printer_groups (name, created_at) VALUES ('Rack A', 1)`);
    db.exec(`INSERT INTO gcodes (allowed_groups) VALUES ('["Rack A","Rack B"]')`);
    const res = await request(app).delete(`/api/groups/${encodeURIComponent('Rack A')}`);
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/G-code restriction/i);
  });

  test('blocks delete when a project allowed_groups references the group', async () => {
    db.exec(`INSERT INTO printer_groups (name, created_at) VALUES ('Rack A', 1)`);
    db.exec(`INSERT INTO projects (allowed_groups) VALUES ('["Rack A"]')`);
    const res = await request(app).delete(`/api/groups/${encodeURIComponent('Rack A')}`);
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/project restriction/i);
  });

  test('does not block delete when the group only appears as a substring of another gcode allowed_groups entry', async () => {
    db.exec(`INSERT INTO printer_groups (name, created_at) VALUES ('Rack A', 1)`);
    db.exec(`INSERT INTO gcodes (allowed_groups) VALUES ('["Rack A2"]')`);
    const res = await request(app).delete(`/api/groups/${encodeURIComponent('Rack A')}`);
    expect(res.status).toBe(200);
  });
});
