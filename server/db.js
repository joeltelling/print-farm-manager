const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const dataDir = path.join(__dirname, 'data');
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

const gcodeDir = path.join(__dirname, 'gcode');
if (!fs.existsSync(gcodeDir)) {
  fs.mkdirSync(gcodeDir, { recursive: true });
}

const db = new Database(path.join(dataDir, 'farm.db'));

// Enable WAL mode for better concurrent read performance
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS printers (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT NOT NULL UNIQUE,
    ip          TEXT NOT NULL,
    api_key     TEXT NOT NULL,
    group_name  TEXT,
    type        TEXT DEFAULT 'prusa',
    model       TEXT NOT NULL,
    status      TEXT DEFAULT 'UNKNOWN',
    is_held     INTEGER DEFAULT 1,
    is_active   INTEGER DEFAULT 1,
    created_at  INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS projects (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT NOT NULL,
    description TEXT,
    status      TEXT DEFAULT 'draft',
    priority    INTEGER DEFAULT 0,
    created_at  INTEGER NOT NULL,
    updated_at  INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS parts (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id     INTEGER NOT NULL REFERENCES projects(id),
    name           TEXT NOT NULL,
    target_qty     INTEGER NOT NULL,
    completed_qty  INTEGER DEFAULT 0,
    status         TEXT DEFAULT 'open',
    created_at     INTEGER NOT NULL,
    updated_at     INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS gcodes (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    part_id          INTEGER NOT NULL REFERENCES parts(id),
    printer_model    TEXT NOT NULL,
    filename         TEXT NOT NULL,
    filepath         TEXT NOT NULL,
    parts_per_plate  INTEGER NOT NULL,
    est_print_secs   INTEGER,
    created_at       INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS jobs (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    part_id          INTEGER NOT NULL REFERENCES parts(id),
    printer_id       INTEGER NOT NULL REFERENCES printers(id),
    gcode_id         INTEGER NOT NULL REFERENCES gcodes(id),
    parts_per_plate  INTEGER NOT NULL,
    status           TEXT DEFAULT 'queued',
    started_at       INTEGER,
    finished_at      INTEGER,
    created_at       INTEGER NOT NULL
  );
`);

// Migrations for existing installs
try { db.exec('ALTER TABLE printers ADD COLUMN is_active INTEGER DEFAULT 1'); } catch (_) {}
try { db.exec('ALTER TABLE printers ADD COLUMN decommissioned_at INTEGER'); } catch (_) {}
try { db.exec('ALTER TABLE printers ADD COLUMN decommission_note TEXT'); } catch (_) {}
try { db.exec('ALTER TABLE parts ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0'); } catch (_) {}
try { db.exec('ALTER TABLE printers ADD COLUMN job_name TEXT'); } catch (_) {}
try { db.exec('ALTER TABLE printers ADD COLUMN job_progress REAL'); } catch (_) {}
try { db.exec('ALTER TABLE printers ADD COLUMN job_time_remaining INTEGER'); } catch (_) {}

module.exports = db;
