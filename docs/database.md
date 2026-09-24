# Database

## Purpose

`server/db.js` manages the SQLite database. It opens the connection, sets pragmas, and runs `CREATE TABLE IF NOT EXISTS` for all tables on every startup. New columns on existing installs are added via `ALTER TABLE` migrations wrapped in `try/catch` — SQLite throws if the column already exists, which is silently ignored.

On startup, `db.js` also runs one-time idempotent data migrations: seeding `printer_models` from existing printer/gcode records, and backfilling `printer_events` decommission entries for printers that were decommissioned before the events table existed. It also creates `part_qty_ledger` and rebuilds a ledger for any part that has none yet (see below).

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
  ip                  TEXT NOT NULL,             -- e.g. "192.168.1.100"
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

### printer_groups

A persisted registry of group names, independent of which printers currently carry a given `group_name`. `printers.group_name` stays plain free text (matched by string equality, not a foreign key), so nothing else in the schema changes: this table exists purely so a group used to restrict dispatch (see `gcodes.allowed_groups` / `projects.allowed_groups` below) can never silently disappear from every picker just because every printer that carried it was reassigned elsewhere.

```sql
CREATE TABLE IF NOT EXISTS printer_groups (
  name        TEXT PRIMARY KEY,
  created_at  INTEGER NOT NULL
);
```

Populated two ways: automatically, whenever a non-empty `group_name` is written on a printer (create, update, bulk-edit, or CSV import) that isn't already registered; or explicitly, via Settings → Groups. Deleting a group (`DELETE /api/groups/:name`) is blocked while any active printer, G-code, or project still references it.

### projects

Top-level organizational unit for a production run.

```sql
CREATE TABLE IF NOT EXISTS projects (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  name              TEXT NOT NULL,
  description       TEXT,
  status            TEXT DEFAULT 'draft',   -- draft | active | paused | completed
  priority          INTEGER DEFAULT 0,      -- reserved for Phase 2 priority ordering
  required_material TEXT,                   -- optional project-wide default; gcode-level overrides
  required_color    TEXT,                   -- optional project-wide default; gcode-level overrides
  allowed_groups    TEXT,                   -- nullable JSON array; optional project-wide default; gcode-level overrides
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL
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
  print_time_seconds  INTEGER,               -- legacy; superseded by gcodes.est_print_secs
  material_grams      REAL,                  -- legacy; superseded by gcodes.material_grams
  created_at          INTEGER NOT NULL,
  updated_at          INTEGER NOT NULL
);
```

A Part is **open** while `completed_qty < target_qty`. It transitions to **closed** automatically when `completed_qty >= target_qty`. `completed_qty` is allowed to exceed `target_qty` (expected due to plate-based printing — never dispatch half a plate).

`sort_order` controls dispatch priority within a project — the scheduler picks the lowest `sort_order` part first. Set via `PUT /api/parts/reorder`. New parts default to `0` and fall back to `created_at` as a tiebreaker.

`completed_qty` is never written directly: every change goes through `adjustPartQty()` in `server/partLedger.js`, which also appends a `part_qty_ledger` row (see below). `server/tests/part-ledger-guard.test.js` fails if any other server file assigns `completed_qty` in an UPDATE.

`print_time_seconds` and `material_grams` on parts are legacy columns retained for schema compatibility but no longer written to. Time and material estimates are now stored per-gcode (see below) so they can vary by printer model.

### gcodes

A G-code file attached to a specific Part + printer model combination.

```sql
CREATE TABLE IF NOT EXISTS gcodes (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  part_id            INTEGER NOT NULL REFERENCES parts(id),
  printer_model      TEXT NOT NULL,      -- mk4s | core1 | core1l | xl
  filename           TEXT NOT NULL,
  filepath           TEXT NOT NULL,      -- absolute path under server/gcode/
  parts_per_plate    INTEGER NOT NULL,
  est_print_secs     INTEGER,            -- nullable; per-plate print time in seconds
  material_grams     REAL,              -- nullable; per-plate filament weight in grams
  ams_slot           INTEGER,            -- Bambu only: -1=external spool, 0-N=AMS slot, NULL=non-Bambu
  allowed_groups     TEXT,               -- nullable JSON array e.g. '["Rack A","Rack B"]'; NULL = no restriction
  required_material  TEXT,               -- nullable; overrides the project default below when set
  required_color     TEXT,               -- nullable; overrides the project default below when set
  created_at         INTEGER NOT NULL
);
```

**Uniqueness on `(part_id, printer_model)`** is enforced at the application layer, not as a DB constraint, so the error message shown to the operator is clear and specific.

`est_print_secs` and `material_grams` are **per-plate** values (i.e., covering all parts on one plate, not one part). They are auto-populated from the filename on upload when the Bambu-style naming convention is detected, and can be edited later via `PUT /api/gcodes/:id`. Since each gcode belongs to one `printer_model`, the stats system can break down elapsed time and material used by model across a project's completed jobs.

**Targeting cascade (`allowed_groups`, `required_material`, `required_color`):** all three follow the same gcode-overrides-project pattern. The scheduler's dispatch candidate query and the `GET /api/parts/:id/dispatch-status` diagnostic both evaluate `COALESCE(gcodes.X, projects.X)`: a value set on the gcode always wins; otherwise the project's default (if any) applies; if neither is set, the field is unrestricted. `allowed_groups` differs from the material/color pair only in shape: it is a JSON array (a gcode or project can allow multiple groups), matched with `EXISTS (SELECT 1 FROM json_each(...) WHERE value = ?)` against the candidate printer's `group_name`, instead of a scalar equality check.

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

### part_qty_ledger

Append-only audit trail behind `parts.completed_qty`: one row per change, recording which job and printer it came from and why. The schema lives in `server/partLedger.js` (`ensureSchema`), not inline in `db.js`, so there is one definition.

```sql
CREATE TABLE IF NOT EXISTS part_qty_ledger (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  part_id        INTEGER NOT NULL,   -- no FK; rows are deleted with their part
  job_id         INTEGER,            -- null for manual edits and baseline rows
  printer_id     INTEGER,            -- no FK; history survives printer deletion
  printer_name   TEXT,               -- snapshot at write time, survives rename/delete
  gcode_id       INTEGER,
  delta          INTEGER NOT NULL,   -- change actually applied (after the zero clamp)
  balance_after  INTEGER NOT NULL,   -- completed_qty right after this change
  source         TEXT NOT NULL,      -- see table below
  note           TEXT,               -- human-readable detail
  created_at     INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_part_qty_ledger_part ON part_qty_ledger(part_id, created_at);
```

**Invariant:** for every part, `SUM(delta)` equals `completed_qty`. `adjustPartQty()` runs the `parts` UPDATE and the ledger INSERT in one transaction, and records the change that actually happened, so a clamped deduction (for example `-4` against a count of `3`) is stored as `-3`.

The ledger never credits anything on its own. Rows are written only from inside the existing events that already change the count, so it inherits their protection against double-firing across restarts, MQTT reconnects, and poll flaps.

| `source` | Written by | Meaning |
|---|---|---|
| `print_finished` | `scheduler.js` `_handleFinished` | Printer reported FINISHED; full plate credited automatically |
| `operator_confirm` | `index.js` set-ready (missed finish, connection-drop recovery, stopped on printer, stalled upload); `printers.js` complete-and-decommission (missed finish) | Operator confirmed a job the scheduler never credited |
| `operator_adjust` | `index.js` set-ready and `printers.js` complete-and-decommission (normal finish, count changed) | Operator corrected the count of an already-credited plate, e.g. 24 of 25 good |
| `marked_failed` | `printers.js` mark-job-failure (finished job) | Credited plate marked as a failed print; plate deducted |
| `manual_edit` | `parts.js` `PUT /api/parts/:id` | Operator typed a new completed count (only written when the value actually changes) |
| `rebuilt_job` | `rebuildMissingLedgers()` | One-time: a finished (or legacy `done`) job that predates the ledger |
| `baseline` | `rebuildMissingLedgers()` | One-time: balances rebuilt rows against `completed_qty` for history the old schema never stored |

**One-time rebuild:** on every startup, `db.js` calls `rebuildMissingLedgers()` for parts with no ledger rows. On the first start after upgrading, that is every existing part with a count or finished jobs; afterwards, parts always have rows from their first credit, so it finds nothing. Each finished job becomes a `rebuilt_job` row at its `finished_at`. Failed jobs are not rebuilt as deductions: the old schema cannot tell a job that was credited then marked failed from one that was never credited, and the net effect is zero either way. The old schema also never stored operator count corrections or manual edits, so when the rebuilt rows do not add up to `completed_qty`, one `baseline` row (dated at the rebuild) covers the difference. The rebuild never changes `completed_qty`. Backup restore runs the same rebuild for parts restored from a backup that predates the ledger.

**Deletes:** part delete and draft project delete remove the part's rows; backup restore replaces the whole table. `seed-demo.js` clears it so the next start rebuilds from the seeded jobs.

**Checking it:** `node server/scripts/audit-dry-run.js` snapshots the live DB and runs the rebuild on the snapshot only; `--check` is a read-only reconciliation of a DB that already has a ledger (exit code 1 on any mismatch); `--part <id>` prints one part's timeline. Run with `--help` for details.

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
