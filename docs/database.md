# Database

## Purpose

`server/db.js` manages the SQLite database. It opens the connection, sets pragmas, and runs `CREATE TABLE IF NOT EXISTS` for all tables on every startup. New columns on existing installs are added via `ALTER TABLE` migrations wrapped in `try/catch` — SQLite throws if the column already exists, which is silently ignored.

On startup, `db.js` also runs one-time idempotent data migrations: seeding `printer_models` from existing printer/gcode records, and backfilling `printer_events` decommission entries for printers that were decommissioned before the events table existed.

## Driver

`better-sqlite3` — synchronous SQLite. All queries are blocking calls that return results directly (no promises, no callbacks). This simplifies the entire server-side codebase: no `async/await` is needed for database operations.

Pragmas set at startup:
- `journal_mode = WAL` — improves concurrent read performance
- `foreign_keys = ON` — enforces referential integrity on all FK relationships

## Tables

### printers

Stores the physical printer registry imported from the CSV spreadsheet.

```sql
CREATE TABLE IF NOT EXISTS printers (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  name                TEXT NOT NULL UNIQUE,      -- e.g. "MK4S_07", "Twilight"
  ip                  TEXT NOT NULL,             -- e.g. "192.168.15.194"
  api_key             TEXT NOT NULL,             -- PrusaLink X-Api-Key header value
  group_name          TEXT,                      -- e.g. "MK4S Farm" (optional)
  type                TEXT DEFAULT 'prusa',      -- vendor; reserved for future use
  model               TEXT NOT NULL,             -- mk4 | mk4s | c1 | c1l | xl
  status              TEXT DEFAULT 'UNKNOWN',    -- live PrusaLink state
  is_held             INTEGER DEFAULT 1,         -- 1 = will not receive dispatch
  is_active           INTEGER DEFAULT 1,         -- 0 = decommissioned; skipped by poller
  decommissioned_at   INTEGER,                   -- epoch ms; set on decommission
  decommission_note   TEXT,                      -- optional operator note
  job_name            TEXT,                      -- filename of current print job (PRINTING only)
  job_progress        REAL,                      -- 0–100 from PrusaLink (PRINTING only)
  job_time_remaining  INTEGER,                   -- seconds remaining (PRINTING only)
  created_at          INTEGER NOT NULL           -- Unix epoch ms
);
```

The `job_name`, `job_progress`, and `job_time_remaining` columns are written on every poll cycle while `status = 'PRINTING'` and cleared to NULL the moment the printer leaves that state. `job_name` is sourced from our own `jobs`/`gcodes` tables (PrusaLink does not return a filename in its status response).

**Model resolution:** The `model` column in the CSV is the preferred source. Accepted values (case-insensitive): `MK4`, `MK4S`, `C1`, `C1L`, `XL`. These are normalized to lowercase as the internal ID.

If the `model` column is absent or blank, the import falls back to name-based inference:
- `MK4S_*` → `mk4s`
- `MK4_*` → `mk4`
- `Core1L_*`, `C1L *` → `c1l`
- `CoreOne_*`, `Core1_*`, `C1 *` → `c1`
- `XL_*` → `xl`
- No match → row is flagged; operator must resolve manually

If a `model` column is present, name inference is skipped entirely — any printer name is valid.

### projects

Top-level organizational unit for a production run.

```sql
CREATE TABLE IF NOT EXISTS projects (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT NOT NULL,
  description TEXT,
  status      TEXT DEFAULT 'draft',   -- draft | active | paused | completed
  priority    INTEGER DEFAULT 0,      -- reserved for Phase 2 priority ordering
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);
```

### parts

A distinct physical component within a project. Tracks production quantity progress.

```sql
CREATE TABLE IF NOT EXISTS parts (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id          INTEGER NOT NULL REFERENCES projects(id),
  name                TEXT NOT NULL,
  target_qty          INTEGER NOT NULL,
  completed_qty       INTEGER DEFAULT 0,
  status              TEXT DEFAULT 'open',   -- open | closed
  sort_order          INTEGER NOT NULL DEFAULT 0,
  print_time_seconds  INTEGER,               -- nullable; per-part print time in seconds
  material_grams      REAL,                  -- nullable; per-part filament usage in grams
  created_at          INTEGER NOT NULL,
  updated_at          INTEGER NOT NULL
);
```

A Part is **open** while `completed_qty < target_qty`. It transitions to **closed** automatically when `completed_qty >= target_qty`. `completed_qty` is allowed to exceed `target_qty` (expected due to plate-based printing — never dispatch half a plate).

`sort_order` controls dispatch priority within a project — the scheduler picks the lowest `sort_order` part first. Set via `PUT /api/parts/reorder`. New parts default to `0` and fall back to `created_at` as a tiebreaker.

`print_time_seconds` and `material_grams` are optional operator-supplied estimates for a single part. The dashboard uses these to project remaining time and material across each project. Both can be set manually via `PUT /api/parts/:id` (the server normalizes human-readable input like `"2h15m"` or `"45g"`) or populated via `POST /api/parts/:id/parse-gcode`, which attempts to extract the values from a gcode filename.

### gcodes

A G-code file attached to a specific Part + printer model combination.

```sql
CREATE TABLE IF NOT EXISTS gcodes (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  part_id          INTEGER NOT NULL REFERENCES parts(id),
  printer_model    TEXT NOT NULL,      -- mk4s | core1 | core1l | xl
  filename         TEXT NOT NULL,
  filepath         TEXT NOT NULL,      -- absolute path under server/gcode/
  parts_per_plate  INTEGER NOT NULL,
  est_print_secs   INTEGER,            -- nullable; parsed from filename
  ams_slot         INTEGER,            -- Bambu only: -1=external spool, 0–N=AMS slot, NULL=non-Bambu
  created_at       INTEGER NOT NULL
);
```

**Uniqueness on `(part_id, printer_model)`** is enforced at the application layer, not as a DB constraint, so the error message shown to the operator is clear and specific.

### jobs

A single print instance — one G-code file sent to one printer, one time.

```sql
CREATE TABLE IF NOT EXISTS jobs (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  part_id          INTEGER NOT NULL REFERENCES parts(id),
  printer_id       INTEGER NOT NULL REFERENCES printers(id),
  gcode_id         INTEGER NOT NULL REFERENCES gcodes(id),
  parts_per_plate  INTEGER NOT NULL,  -- snapshot of gcode.parts_per_plate at dispatch time
  status           TEXT DEFAULT 'queued',
                   -- queued | uploading | printing | finished | failed | cancelled
  started_at       INTEGER,
  finished_at      INTEGER,
  created_at       INTEGER NOT NULL
);
```

`parts_per_plate` is snapshotted at dispatch time so changing the G-code record after dispatch doesn't retroactively affect in-flight jobs.

### printer_events

Permanent audit log for each printer. Events are never deleted and survive printer deletion (no FK constraint on `printer_id`).

```sql
CREATE TABLE IF NOT EXISTS printer_events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  printer_id  INTEGER NOT NULL,   -- no FK — history survives printer deletion
  event_type  TEXT NOT NULL,      -- decommission | recommission | job_finished | job_failed | note
  note        TEXT,               -- human-readable detail; null for recommission
  created_at  INTEGER NOT NULL
);
```

**Event types and when they are written:**

| `event_type` | Written by | Note content |
|---|---|---|
| `job_finished` | `scheduler.js` `_handleFinished` | `"Job N — Part Name (M parts)"` |
| `job_failed` | `printers.js` `mark-job-failure` | Job ID + part name, or `"No tracked job"` |
| `decommission` | `printers.js` decommission route | Operator's decommission note (if any) |
| `recommission` | `index.js` recommission route | `null` |
| `note` | Events route (`POST /api/printers/:id/events`) | Operator-entered text |

**Backfill migration:** on first server start after this table was introduced, any printer with `is_active = 0` and `decommissioned_at` set automatically receives a synthetic `decommission` event using the stored timestamp and note — idempotent across restarts.

## Conventions

- All IDs: `INTEGER PRIMARY KEY AUTOINCREMENT`
- All timestamps: Unix epoch milliseconds (`INTEGER`) — use `Date.now()` in application code
- Booleans: `INTEGER` with values `0` (false) and `1` (true)
- All queries use `?` positional parameters — no string interpolation
- `COALESCE(?, column)` pattern used for partial updates (PUT endpoints) so omitting a field leaves the existing value intact

## File Locations

- Database: `server/data/farm.db` (gitignored)
- G-code storage: `server/gcode/` (gitignored)

Both directories are created automatically on first startup if they don't exist.
