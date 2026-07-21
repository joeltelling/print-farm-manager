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

  CREATE TABLE IF NOT EXISTS printer_events (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    printer_id  INTEGER NOT NULL,
    event_type  TEXT NOT NULL,
    note        TEXT,
    created_at  INTEGER NOT NULL
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
try { db.exec("ALTER TABLE printers ADD COLUMN serial_number TEXT DEFAULT ''"); } catch (_) {}
try { db.exec('ALTER TABLE gcodes ADD COLUMN ams_slot INTEGER'); } catch (_) {}
try { db.exec('CREATE INDEX IF NOT EXISTS idx_jobs_printer_started ON jobs(printer_id, started_at DESC)'); } catch (_) {}
try { db.exec('ALTER TABLE parts ADD COLUMN print_time_seconds INTEGER'); } catch (_) {}
try { db.exec('ALTER TABLE parts ADD COLUMN material_grams REAL'); } catch (_) {}
try { db.exec('ALTER TABLE gcodes ADD COLUMN material_grams REAL'); } catch (_) {}
try { db.exec('ALTER TABLE printers ADD COLUMN loaded_material TEXT'); } catch (_) {}
try { db.exec('ALTER TABLE printers ADD COLUMN loaded_color TEXT'); } catch (_) {}
try { db.exec('ALTER TABLE gcodes ADD COLUMN allowed_groups TEXT'); } catch (_) {}
try { db.exec('ALTER TABLE gcodes ADD COLUMN required_material TEXT'); } catch (_) {}
try { db.exec('ALTER TABLE gcodes ADD COLUMN required_color TEXT'); } catch (_) {}
try { db.exec('ALTER TABLE projects ADD COLUMN required_material TEXT'); } catch (_) {}
try { db.exec('ALTER TABLE projects ADD COLUMN required_color TEXT'); } catch (_) {}
try { db.exec('ALTER TABLE projects ADD COLUMN allowed_groups TEXT'); } catch (_) {}

// Printer models — source of truth for which models this farm supports.
// New installs start empty; operator adds models in Settings.
// Existing installs auto-seed from models already referenced in the live DB.
try {
  db.exec(`CREATE TABLE IF NOT EXISTS printer_models (
    model_id   TEXT PRIMARY KEY,
    label      TEXT NOT NULL,
    connector  TEXT NOT NULL
  )`);
} catch (_) {}

try {
  const KNOWN_MODEL_META = {
    'mk4':             { label: 'MK4',            connector: 'prusa' },
    'mk4s':            { label: 'MK4S',           connector: 'prusa' },
    'c1':              { label: 'Core One',        connector: 'prusa' },
    'c1l':             { label: 'Core 1L',         connector: 'prusa' },
    'xl':              { label: 'XL',              connector: 'prusa' },
    'centauri-carbon': { label: 'Centauri Carbon', connector: 'elegoo-centauri' },
    'x1c':             { label: 'X1 Carbon',       connector: 'bambu' },
    'p1s':             { label: 'P1S',             connector: 'bambu' },
    'p1p':             { label: 'P1P',             connector: 'bambu' },
    'a1':              { label: 'A1',              connector: 'bambu' },
    'a1-mini':         { label: 'A1 Mini',         connector: 'bambu' },
  };
  // Collect every distinct model already in use across printers + gcodes
  const inUse = db.prepare(`
    SELECT DISTINCT model AS m FROM printers WHERE model IS NOT NULL AND model != ''
    UNION
    SELECT DISTINCT printer_model AS m FROM gcodes WHERE printer_model IS NOT NULL AND printer_model != ''
  `).all().map(r => r.m);

  const insertModel = db.prepare(
    'INSERT OR IGNORE INTO printer_models (model_id, label, connector) VALUES (?, ?, ?)'
  );
  for (const modelId of inUse) {
    const meta = KNOWN_MODEL_META[modelId];
    insertModel.run(modelId, meta?.label || modelId, meta?.connector || 'prusa');
  }
} catch (_) {}

// Printer groups: persisted registry, independent of which printers currently
// carry a given group_name. Without this, a group referenced only by a gcode's
// or project's allowed_groups (every printer since reassigned elsewhere) used
// to vanish from every picker with no UI trace, while the scheduler kept
// silently enforcing the now-unfillable restriction forever. New installs
// start empty; operator adds groups in Settings, or one is auto-registered the
// moment it's typed on a printer. Existing installs auto-seed below from every
// group name already referenced anywhere in the live DB.
try {
  db.exec(`CREATE TABLE IF NOT EXISTS printer_groups (
    name        TEXT PRIMARY KEY,
    created_at  INTEGER NOT NULL
  )`);
} catch (_) {}

try {
  const now = Date.now();
  const insertGroup = db.prepare(
    'INSERT OR IGNORE INTO printer_groups (name, created_at) VALUES (?, ?)'
  );

  for (const row of db.prepare(
    "SELECT DISTINCT group_name AS g FROM printers WHERE group_name IS NOT NULL AND group_name != ''"
  ).all()) {
    insertGroup.run(row.g, now);
  }

  // Recover any group name that only survives inside a JSON allowed_groups
  // array (gcodes and, once the ALTER above has run, projects). This is the
  // exact scenario that used to leave a restriction with no visible name
  // anywhere to reassign a printer back into. Parsed per row in JS, not one
  // big SQL json_each UNION: a single malformed value must not abort the
  // whole seed and silently leave every other row unrecovered.
  for (const table of ['gcodes', 'projects']) {
    const hasColumn = db.prepare(`PRAGMA table_info(${table})`).all()
      .some((c) => c.name === 'allowed_groups');
    if (!hasColumn) continue;

    for (const row of db.prepare(
      `SELECT allowed_groups AS ag FROM ${table} WHERE allowed_groups IS NOT NULL`
    ).all()) {
      try {
        const names = JSON.parse(row.ag);
        if (Array.isArray(names)) {
          for (const name of names) {
            if (name) insertGroup.run(name, now);
          }
        }
      } catch (_) {
        // One row's malformed JSON doesn't block recovering the rest.
      }
    }
  }
} catch (_) {}

// Filament library — canonical lists managed in Settings
try {
  db.exec(`CREATE TABLE IF NOT EXISTS filament_types (
    id    INTEGER PRIMARY KEY AUTOINCREMENT,
    name  TEXT NOT NULL UNIQUE
  )`);
} catch (_) {}

try {
  db.exec(`CREATE TABLE IF NOT EXISTS filament_colors (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    type_id   INTEGER NOT NULL REFERENCES filament_types(id),
    name      TEXT NOT NULL,
    hex_color TEXT,
    UNIQUE(type_id, name)
  )`);
} catch (_) {}

// Add type_id to filament_colors if missing (existing installs that predate this column)
try {
  const hasTypeId = db.prepare("PRAGMA table_info(filament_colors)").all().some(c => c.name === 'type_id');
  if (!hasTypeId) {
    db.exec(`
      PRAGMA foreign_keys = OFF;
      CREATE TABLE filament_colors_new (
        id        INTEGER PRIMARY KEY AUTOINCREMENT,
        type_id   INTEGER NOT NULL REFERENCES filament_types(id),
        name      TEXT NOT NULL,
        hex_color TEXT,
        UNIQUE(type_id, name)
      );
      DROP TABLE filament_colors;
      ALTER TABLE filament_colors_new RENAME TO filament_colors;
      PRAGMA foreign_keys = ON;
    `);
    console.log('[db] Migrated filament_colors — added type_id (existing colors cleared)');
  }
} catch (_) {}

// Settings table — key/value store for operator-configurable options
try {
  db.exec(`CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
} catch (_) {}
// Seed defaults (INSERT OR IGNORE so existing values are never overwritten)
try {
  db.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES ('dispatch_batch_size', '10')").run();
} catch (_) {}

// Make jobs.gcode_id nullable so gcodes can be deleted after jobs have run
const gcodeIdCol = db.prepare("PRAGMA table_info(jobs)").all().find(c => c.name === 'gcode_id');
if (gcodeIdCol && gcodeIdCol.notnull === 1) {
  db.exec(`
    PRAGMA foreign_keys = OFF;
    CREATE TABLE jobs_migrated (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      part_id          INTEGER NOT NULL REFERENCES parts(id),
      printer_id       INTEGER NOT NULL REFERENCES printers(id),
      gcode_id         INTEGER REFERENCES gcodes(id),
      parts_per_plate  INTEGER NOT NULL,
      status           TEXT DEFAULT 'queued',
      started_at       INTEGER,
      finished_at      INTEGER,
      created_at       INTEGER NOT NULL
    );
    INSERT INTO jobs_migrated SELECT * FROM jobs;
    DROP TABLE jobs;
    ALTER TABLE jobs_migrated RENAME TO jobs;
    PRAGMA foreign_keys = ON;
  `);
}

// Backfill decommission events for printers that were decommissioned before the
// printer_events table existed. Runs once per printer (checked via event absence).
// Uses decommissioned_at as the event timestamp so the timeline is accurate.
try {
  const decomms = db.prepare(`
    SELECT id, name, decommissioned_at, decommission_note
    FROM printers
    WHERE is_active = 0 AND decommissioned_at IS NOT NULL
  `).all();

  const hasEvent = db.prepare(
    `SELECT 1 FROM printer_events WHERE printer_id = ? AND event_type = 'decommission' LIMIT 1`
  );
  const insertBackfill = db.prepare(
    `INSERT INTO printer_events (printer_id, event_type, note, created_at) VALUES (?, 'decommission', ?, ?)`
  );

  for (const p of decomms) {
    if (!hasEvent.get(p.id)) {
      insertBackfill.run(p.id, p.decommission_note ?? null, p.decommissioned_at);
      console.log(`[db] Backfilled decommission event for ${p.name}`);
    }
  }
} catch (_) {}

module.exports = db;
