// Verifies the TV dashboard endpoint does not leak the stored printer api_key.

const request  = require('supertest');
const express  = require('express');
const Database = require('better-sqlite3');

let db;
let app;

beforeAll(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE printers (
      id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, ip TEXT, api_key TEXT,
      status TEXT, is_held INTEGER DEFAULT 0, is_active INTEGER DEFAULT 1, created_at INTEGER
    );
    CREATE TABLE projects (
      id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, status TEXT, created_at INTEGER, updated_at INTEGER
    );
    CREATE TABLE parts (
      id INTEGER PRIMARY KEY AUTOINCREMENT, project_id INTEGER, name TEXT, target_qty INTEGER,
      completed_qty INTEGER DEFAULT 0, status TEXT, sort_order INTEGER DEFAULT 0, created_at INTEGER, updated_at INTEGER
    );
    CREATE TABLE gcodes (
      id INTEGER PRIMARY KEY AUTOINCREMENT, printer_model TEXT, material_grams REAL, parts_per_plate INTEGER
    );
    CREATE TABLE jobs (
      id INTEGER PRIMARY KEY AUTOINCREMENT, part_id INTEGER, printer_id INTEGER, gcode_id INTEGER,
      parts_per_plate INTEGER, status TEXT, started_at INTEGER, finished_at INTEGER, created_at INTEGER
    );
    CREATE TABLE printer_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT, printer_id INTEGER, created_at INTEGER
    );
  `);
  db.prepare(`INSERT INTO printers (name, ip, api_key, status, is_active, created_at) VALUES ('P1', '10.0.0.1', 'SECRET_KEY', 'IDLE', 1, ?)`).run(Date.now());

  app = express();
  app.use('/api/dashboard', require('../routes/dashboard')(db));
});

test('GET /api/dashboard omits api_key and reports has_api_key', async () => {
  const res = await request(app).get('/api/dashboard');
  expect(res.status).toBe(200);
  expect(res.body.printers.length).toBeGreaterThan(0);
  for (const p of res.body.printers) {
    expect(p).not.toHaveProperty('api_key');
    expect(p).toHaveProperty('has_api_key');
  }
  expect(res.body.printers.some(p => p.has_api_key === true)).toBe(true);
});
