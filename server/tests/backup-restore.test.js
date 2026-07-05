const request  = require('supertest');
const express  = require('express');
const path     = require('path');
const fs       = require('fs');
const Database = require('better-sqlite3');

const backupRouter = require('../routes/backup');

const GCODE_DIR = path.join(__dirname, '..', 'gcode');

// Restore prepares each table's INSERT eagerly, so the columns it names must exist even
// though these tests only send empty row arrays. Payloads with empty arrays skip the
// inserts; the AUTOINCREMENT keys back the sqlite_sequence resync.
function makeDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE printers (
      id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, ip TEXT, api_key TEXT,
      group_name TEXT, type TEXT, model TEXT, status TEXT, is_held INTEGER,
      is_active INTEGER, created_at INTEGER, decommissioned_at INTEGER,
      decommission_note TEXT, job_name TEXT, job_progress REAL, job_time_remaining INTEGER
    );
    CREATE TABLE projects (
      id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, description TEXT, status TEXT,
      priority INTEGER, created_at INTEGER, updated_at INTEGER
    );
    CREATE TABLE parts (
      id INTEGER PRIMARY KEY AUTOINCREMENT, project_id INTEGER, name TEXT, target_qty INTEGER,
      completed_qty INTEGER, status TEXT, created_at INTEGER, updated_at INTEGER, sort_order INTEGER
    );
    CREATE TABLE gcodes (
      id INTEGER PRIMARY KEY AUTOINCREMENT, part_id INTEGER, printer_model TEXT, filename TEXT,
      filepath TEXT, parts_per_plate INTEGER, est_print_secs INTEGER, created_at INTEGER
    );
    CREATE TABLE jobs (
      id INTEGER PRIMARY KEY AUTOINCREMENT, part_id INTEGER, printer_id INTEGER, gcode_id INTEGER,
      parts_per_plate INTEGER, status TEXT, started_at INTEGER, finished_at INTEGER, created_at INTEGER
    );
    CREATE TABLE printer_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT, printer_id INTEGER, event_type TEXT, note TEXT, created_at INTEGER
    );
  `);
  return db;
}

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/backup', backupRouter(makeDb()));
  return app;
}

beforeAll(() => {
  if (!fs.existsSync(GCODE_DIR)) fs.mkdirSync(GCODE_DIR, { recursive: true });
});

function post(app, backup) {
  return request(app)
    .post('/api/backup/restore')
    .attach('file', Buffer.from(JSON.stringify(backup)), 'backup.json');
}

describe('POST /api/backup/restore — gcode_files path handling', () => {
  const leaked = path.resolve(GCODE_DIR, '..', '..', 'pwned-by-test.js');

  afterEach(() => {
    for (const p of [leaked, path.join(GCODE_DIR, 'pwned-by-test.js'), path.join(GCODE_DIR, 'safe.gcode')]) {
      if (fs.existsSync(p)) fs.unlinkSync(p);
    }
  });

  test('rejects a traversal key and writes nothing outside GCODE_DIR', async () => {
    const res = await post(makeApp(), {
      version: 1,
      printers: [],
      gcode_files: { '../../pwned-by-test.js': Buffer.from('owned').toString('base64') },
    });

    expect(res.status).toBe(400);
    expect(fs.existsSync(leaked)).toBe(false);
  });

  test('rejects a bare ".." key', async () => {
    const res = await post(makeApp(), {
      version: 1,
      printers: [],
      gcode_files: { '..': Buffer.from('owned').toString('base64') },
    });
    expect(res.status).toBe(400);
  });

  test('writes a normal filename inside GCODE_DIR', async () => {
    const res = await post(makeApp(), {
      version: 1,
      printers: [], projects: [], parts: [], gcodes: [], jobs: [], printer_events: [],
      gcode_files: { 'safe.gcode': Buffer.from('hello').toString('base64') },
    });

    expect(res.status).toBe(200);
    expect(fs.readFileSync(path.join(GCODE_DIR, 'safe.gcode'), 'utf8')).toBe('hello');
  });
});
