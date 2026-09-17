# Database

## Purpose

`server/db.js` manages the SQLite database. It opens the connection, sets pragmas, and runs `CREATE TABLE IF NOT EXISTS` for all tables on every startup. New columns on existing installs are added via `ALTER TABLE` migrations wrapped in `try/catch` — SQLite throws if the column already exists, which is silently ignored.

On startup, `db.js` also runs one-time idempotent data migrations: seeding `printer_models` from existing printer/gcode records, and backfilling `printer_events` decommission entries for printers that were decommissioned before the events table existed.

## Local Dataset Files

`server/database-path.js` selects one of two clearly named SQLite files. `PFM_DATASET=organic` opens `server/data/organic-data.db` and is the default. `PFM_DATASET=seed` opens `server/data/seed-data.db`. Any other value stops startup with an error instead of silently creating another database.

The seed file is generated or reset with `npm run seed:data`. That command loads the current schema from `server/db.js`, clears only the seed database, and inserts a repeatable fictional fleet. It never opens the organic database. Both files, including their WAL and shared-memory companions, stay under the Git-ignored `server/data/` directory.

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
  gcode_id         INTEGER REFERENCES gcodes(id),
  parts_per_plate  INTEGER NOT NULL,  -- snapshot of gcode.parts_per_plate at dispatch time
  status           TEXT DEFAULT 'queued',
                   -- queued | uploading | printing | finished | failed | cancelled
  started_at       INTEGER,
  finished_at      INTEGER,
  created_at       INTEGER NOT NULL,
  printing_seconds REAL NOT NULL DEFAULT 0,
  paused_seconds   REAL NOT NULL DEFAULT 0,
  sample_count     INTEGER NOT NULL DEFAULT 0,
  last_sample_at   INTEGER,
  material_grams_actual REAL,
  energy_kwh       REAL,
  telemetry_quality TEXT NOT NULL DEFAULT 'none'  -- none | partial | measured
);
```

`parts_per_plate` is snapshotted at dispatch time so changing the G-code record after dispatch doesn't retroactively affect in-flight jobs.

Telemetry columns are filled by `server/telemetry.js` while the poller sees PRINTING/PAUSED, and sealed when the scheduler closes the job. Gaps between samples are capped (`SAMPLE_GAP_CAP_MS`, 30 s) so a server restart mid-print cannot credit phantom hours. `telemetry_quality` is `measured` when sample coverage of the wall-clock print window is high enough for ERP actual costing.

### printer_status_history

One row per real status transition (not per 15 s poll). Used for utilization and OEE.

```sql
CREATE TABLE IF NOT EXISTS printer_status_history (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  printer_id  INTEGER NOT NULL,
  job_id      INTEGER,
  status      TEXT NOT NULL,
  started_at  INTEGER NOT NULL,
  ended_at    INTEGER,
  duration_ms INTEGER
);
```

### timelapses

JPEG frame captures for a job or a manual printer session. Video is rendered with the host `ffmpeg` binary when present.

```sql
CREATE TABLE IF NOT EXISTS timelapses (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id           INTEGER UNIQUE,
  printer_id       INTEGER NOT NULL,
  part_id          INTEGER,
  status           TEXT NOT NULL DEFAULT 'capturing',
                   -- capturing | rendering | ready | failed | discarded
  interval_seconds INTEGER NOT NULL DEFAULT 10,
  frame_count      INTEGER NOT NULL DEFAULT 0,
  dir_path         TEXT,
  video_path       TEXT,
  bytes            INTEGER,
  started_at       INTEGER NOT NULL,
  ended_at         INTEGER,
  render_error     TEXT
);
```

Optional printer camera overrides (any brand / MJPEG URL): `printers.camera_snapshot_url`, `printers.camera_stream_url`.

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

### erp_posting (embedded ERP)

Operator-confirmed queue linking shopfloor jobs to ERP stock moves. Created by Set Ready / bridge; confirmed on `/erp/postings`. Does not touch `parts.completed_qty`.

```sql
CREATE TABLE IF NOT EXISTS erp_posting (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id INTEGER UNIQUE,
  part_id INTEGER,
  printer_id INTEGER,
  erp_sku TEXT,
  qty REAL NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending',  -- pending | posted | dismissed
  created_at INTEGER NOT NULL,
  posted_at INTEGER,
  stock_move_id INTEGER,
  note TEXT,
  shortage_json TEXT,
  actual_minutes REAL,
  actual_grams REAL,
  actual_energy_kwh REAL,
  std_unit_cost REAL,
  actual_unit_cost REAL,
  cost_basis TEXT NOT NULL DEFAULT 'standard',  -- standard | actual
  telemetry_quality TEXT NOT NULL DEFAULT 'none'
);
```

When `telemetry_quality` on the linked job is `measured`, confirm values `stock_move.unit_cost` from actual minutes/grams/energy; otherwise the existing `mfg_component` standard cost is used.

Other ERP tables (`uom`, `warehouse`, `location`, `item`, `machine`, `bom`, `bom_line`, `stock_move`, `item_cost`, `mfg_component`, `work_order`, `wo_issue`, `wo_labor`, `pricing_config`, `sales_order`) are created by `server/erp/schema.js`. See [docs/erp/README.md](erp/README.md).

`machine` stores `rate_mode` (`manual` or `calculated`), `hourly_rate` (effective USD/h used by costing), `maintenance_rate`, and `power_kw`. Site electricity USD/kWh is `pricing_config` code `ELEC_KWH`.

### eBay Sell tables

Created by `server/ebay/schema.js` (invoked from `ensureErpSchema`). See [docs/erp/ebay.md](erp/ebay.md).

| Table | Role |
|---|---|
| `ebay_credential` | Single-row secrets (id=1). **Not exported in backup JSON.** Env vars override. |
| `ebay_listing` | Maps `item_id` to `ebay_sku` / `offer_id` for inventory push |
| `ebay_order` | Imported Fulfillment orders (`order_id` unique) |
| `ebay_order_line` | Line items (`line_item_id` unique); statuses `pending` / `auto_posted` / `posted` / `dismissed` |
| `ebay_sync_state` | Watermark and last-error key/value store |

Backup export includes `ebay_listing`, `ebay_order`, `ebay_order_line`, and `ebay_sync_state` as optional ERP tables (older backups without them still restore).

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
