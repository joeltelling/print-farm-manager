# Print Farm Manager — Architecture & Requirements

> **For Claude Code:** Start with [Section 12](#12-claude-code-briefing--phase-2) if Phase 1 is already complete. Read it in full before writing any code. Build Phase 2 only.

---

## Table of Contents

1. [Project Overview](#1-project-overview)
2. [Supported Printer Fleet](#2-supported-printer-fleet)
3. [Core Data Concepts](#3-core-data-concepts)
4. [System Architecture](#4-system-architecture)
5. [Printer Status Model](#5-printer-status-model)
6. [Job Scheduling Logic](#6-job-scheduling-logic)
7. [User Interface — Screen Inventory](#7-user-interface--screen-inventory)
8. [Development Phases](#8-development-phases)
9. [Resolved Design Decisions](#9-resolved-design-decisions)
10. [Recommended Next Steps](#10-recommended-next-steps)
11. [Claude Code Briefing — Phase 1](#11-claude-code-briefing--phase-1)
12. [Claude Code Briefing — Phase 2](#12-claude-code-briefing--phase-2)
13. [Phase 6 — Multi-Brand Printer Support](#13-phase-6--multi-brand-printer-support)

---

## 1. Project Overview

Print Farm Manager is a locally-hosted web application designed to replace manual USB-based job distribution across a 50+ printer Prusa fleet. The system leverages the PrusaLink REST API already running on each printer to enable centralized batch job management, real-time status monitoring, and intelligent job routing based on printer model compatibility.

**The core problem being solved:** distributing 1,000+ print jobs across a mixed fleet (MK4S, Core One, Core 1L, XL) currently requires manual USB file copying and individual printer interaction. Print Farm Manager eliminates this entirely.

---

## 2. Supported Printer Fleet

Each printer model requires its own sliced G-code — files are not interchangeable between models.

| Model | Internal ID | G-Code Profile | Notes |
|---|---|---|---|
| Prusa MK4S | `mk4s` | MK4S-specific | Most common workhorse model |
| Prusa Core One | `core1` | Core One-specific | Enclosed, ABS/ASA capable |
| Prusa Core 1L | `core1l` | Core 1L-specific | Large-format enclosed |
| Prusa XL | `xl` | XL-specific | Multi-tool, large bed |

---

## 3. Core Data Concepts

### 3.1 Printer

A Printer is a single physical machine registered in the system. Each printer record contains:

- A human-readable name (e.g. `MK4S_07`)
- Its model type (`mk4s`, `core1`, `core1l`, `xl`)
- Its local IP address and PrusaLink API key — imported from the existing spreadsheet
- Its current status as reported by PrusaLink (see Section 5)
- A location/bay label (optional) for physical organization

> The printer registry is importable directly from the existing IP/key spreadsheet via CSV upload. No manual re-entry required.

### 3.2 Project

A Project is the top-level organizational unit. It represents a named production run — e.g. "XRP Kit Run — March". A project contains:

- A name and description
- One or more Parts (see 3.3)
- A status: `draft` | `active` | `paused` | `completed`
- A rollup progress view across all Parts — each Part tracked individually

> A Project is complete when every Part within it reaches Closed state. There is no single project-level quantity — progress is understood by looking at each Part's individual completion status.

### 3.3 Part

A Part is the core unit of production tracking. It lives inside a Project and represents one distinct physical component. Each Part contains:

- A **name** — entered manually by the operator at creation time (e.g. "XRP Chassis")
- A **target_qty** — the total number of this part needed, set at creation time and immutable after the Part is Open
- A **completed_qty** — incremented automatically each time a job finishes successfully, by the plate's `parts_per_plate` count
- A **state**: `open` or `closed`
- One G-code file per compatible printer model — at most one G-code per model per Part

#### Part State: Open vs. Closed

A Part is **Open** when `completed_qty < target_qty` and jobs may be dispatched. A Part automatically transitions to **Closed** when `completed_qty >= target_qty`.

`completed_qty` is allowed to exceed `target_qty` — this is expected due to plate-based printing (see Section 3.5).

> **Example:** `target_qty` is 1,000 and `parts_per_plate` is 10. When `completed_qty` reaches 995, one final plate is dispatched. That plate completes and adds 10, bringing `completed_qty` to 1,005. The Part closes at 1,005/1,000. This is correct — never half a plate.

#### Manual Override of completed_qty

An operator may manually edit `completed_qty` at any time to correct for miscounts, parts produced outside the system, or failed plates the system counted incorrectly.

Guardrails:
- Any edit requires an **"Are you sure?"** confirmation prompt
- If the new value is less than `target_qty` and the Part is **Closed**, prompt: *"This will reopen the Part and resume dispatching. Confirm?"*
- If the new value is >= `target_qty` and the Part is **Open**, prompt: *"This will close the Part and stop all dispatching. Confirm?"*
- Jobs actively printing at the time of a manual edit are **not interrupted** — they run to completion and their plate quantity is added to `completed_qty` normally

> The system treats `completed_qty` as a simple counter. Operator adjustments and successful job completions are both valid inputs to the same number.

### 3.4 G-Code File

A G-code file is uploaded by the operator and attached to a Part + machine model combination.

**Upload flow:**

1. Operator selects a G-code file (`.bgcode` or `.gcode`)
2. System parses the filename and pre-fills: `parts_per_plate` (from the `NNx` prefix), printer model (from the model token), estimated print time — all editable before saving
3. System asks: **which Part is this for?** Existing Parts in the project are shown as a dropdown. If none match, the operator types a new Part name and sets `target_qty` — creating the Part in the same step
4. System validates: does this Part already have a G-code for this machine model? If yes, operator is warned and must confirm replacement
5. File is stored and associated. The Part now accepts dispatch jobs to any printer of the matching model type

> A single Part may hold one G-code per supported machine model. For example, the "XRP Chassis" Part can hold one MK4S G-code and one Core One G-code simultaneously. Both dispatch from the same Part and increment the same `completed_qty` counter.

### 3.5 Ceiling Dispatch Math

The scheduler always rounds up when calculating how many jobs remain for a Part:

```
jobs_remaining = ceil((target_qty - completed_qty) / parts_per_plate)
```

When `jobs_remaining` reaches 0 (i.e. `completed_qty >= target_qty`), the Part closes automatically and no further jobs are dispatched for it.

### 3.6 Job

A Job is a single print instance — one Part, on one printer, one time. Each job tracks:

- Which Part it belongs to
- Which printer it was sent to, and that printer's model type
- Which G-code file was used
- The `parts_per_plate` count at the time of dispatch (snapshot)
- Status: `queued` → `uploading` → `printing` → `finished` | `failed` | `cancelled`
- `started_at`, `finished_at`, duration

On `finished`: `completed_qty` for the parent Part is incremented by `parts_per_plate`.

> Failed or cancelled jobs do not increment `completed_qty`. The scheduler will re-queue them so the target quantity is still reached.

---

## 4. System Architecture

### 4.1 Technology Stack

| Layer | Choice | Notes |
|---|---|---|
| Backend runtime | Node.js (LTS) | Windows-first; no native addons |
| HTTP server | Express | REST API |
| Database | better-sqlite3 | Zero-config SQLite, synchronous |
| File uploads | multer | Multipart G-code uploads |
| HTTP client | axios | PrusaLink API calls |
| Frontend | React + Vite | SPA served separately in dev |
| CSV parsing | papaparse | Printer import spreadsheet |
| Dev runner | concurrently | Runs server + client together |

### 4.2 Component Layers

```
┌─────────────────────────────────────────────────────────┐
│  UI Layer       React Web App                           │
│                 Dashboard · Fleet · Projects · Jobs     │
├─────────────────────────────────────────────────────────┤
│  API Layer      Express REST API                        │
│                 /api/printers · /projects · /parts      │
│                 /gcodes · /jobs                         │
├─────────────────────────────────────────────────────────┤
│  Service Layer  JobScheduler · PrinterPoller            │
│                 GCodeManager · StatusAggregator         │
├─────────────────────────────────────────────────────────┤
│  Data/External  SQLite DB · Local G-code Files          │
│                 PrusaLink APIs (one per printer)        │
└─────────────────────────────────────────────────────────┘
```

### 4.3 PrusaLink API Integration

| Endpoint | Method | Purpose |
|---|---|---|
| `/api/v1/status` | GET | Printer state, temps, current job progress |
| `/api/v1/files/usb` | POST (multipart) | Upload G-code file to printer |
| `/api/v1/job` | POST | Start printing an uploaded file |
| `/api/v1/job` | DELETE | Cancel the current job |
| `/api/v1/printer` | GET | Hardware info and capabilities |

Authentication: pass the printer's `api_key` as the `X-Api-Key` request header on every call.

---

## 5. Printer Status Model

| PrusaLink State | System Interpretation | Automated Action |
|---|---|---|
| `IDLE` | Available | Eligible for next queued job — scheduler assigns immediately |
| `PRINTING` | Busy | Monitor progress %; update job record |
| `FINISHED` | Job done | Increment Part `completed_qty` by `parts_per_plate`; check if Part should close; assign next job |
| `PAUSED` | Needs attention | Flag in UI; hold queue for this printer |
| `ERROR` | Fault | Mark job failed; alert operator; do not assign new jobs |
| `ATTENTION` | Needs filament/action | Flag in UI; hold queue for this printer |
| `OFFLINE` | Unreachable | Set when polling fails; do not assign jobs |

---

## 6. Job Scheduling Logic

### 6.1 Dispatch Rules

When a printer transitions to `IDLE`, the scheduler applies these rules in order:

- **Rule 1 — Model match required:** Only dispatch a G-code to a printer whose model matches the G-code's target model. An MK4S G-code never goes to a Core One.
- **Rule 2 — Fill idle machines:** Any idle printer of a compatible model receives the next available job immediately. No artificial throttling or pool splitting. Both MK4S and Core One machines pull from the same Part's job pool and increment the same `completed_qty` counter.
- **Rule 3 — Part is Open:** Jobs are only dispatched for Parts where `completed_qty < target_qty`. Once a Part closes it is removed from the dispatch pool entirely.
- **Rule 4 — FIFO within Part:** Jobs for the same Part dispatch in the order they were queued.
- **Rule 5 — Project priority:** When multiple Active projects exist, higher-priority project dispatches first. *(v2 feature — FIFO across projects in v1)*

> The fill-idle-machines approach means the farm always runs at maximum throughput. If 30 MK4S and 10 Core One machines are all idle and a Part has G-code for both models, all 40 machines receive jobs simultaneously and race toward the same `completed_qty` target.

### 6.2 Part Completion & Automatic Progression

After every job completion:

1. Increment `Part.completed_qty` by `parts_per_plate`
2. If `completed_qty >= target_qty`: close the Part, cancel any queued-but-not-dispatched jobs for it, remove from dispatch pool
3. Printers that finish the now-closed Part re-enter the dispatch loop for the next Open Part in the project
4. If all Parts in a Project are Closed: mark Project as `completed`

> Jobs actively printing when a Part closes are never interrupted. They run to completion and their plate quantity still increments `completed_qty` — even if this pushes it above `target_qty`. This is correct behavior.

### 6.3 Queue Management

Operator can intervene at any time:

- **Pause a project** — stops dispatching for all Parts; in-progress prints finish normally
- **Cancel a project** — stops dispatching; in-progress prints complete; no new jobs sent
- **Hold a printer** — remove from dispatch pool without deleting from registry
- **Manually assign** — force a specific job to a specific compatible printer
- **Edit completed_qty** — manual count correction (see Section 3.3 guardrails)

---

## 7. User Interface — Screen Inventory

### 7.1 Dashboard
- Fleet summary: X printing, X idle, X errored
- Active projects with per-Part progress bars
- Recent alerts (errors, attention states, completed projects)
- Quick actions: Dispatch Project, Pause All, View Queue

### 7.2 Fleet
- Grid/list of all 50+ printers
- Each card: name, model, IP, status, current job name, % complete
- Color coding: green (printing), gray (idle), yellow (attention/paused), red (error), dark (offline)
- Click printer → full job history + manual assign

### 7.3 Project Manager
- Create/edit Projects and Parts
- Upload G-code files per Part per printer model
- Set target quantities
- Per-project progress: parts completed, parts remaining
- Dispatch a project to begin printing

### 7.4 Job Queue
- All queued, in-progress, completed, and failed jobs
- Filterable by project, printer, status, date
- Manual assign override

### 7.5 Settings
- Printer registry: CSV import, add/edit/remove
- Polling interval configuration
- G-code storage path display

---

## 8. Development Phases

| Phase | Name | Deliverables |
|---|---|---|
| 1 | Foundation | Project scaffold, SQLite schema, printer registry with CSV import, PrusaLink polling loop, live status display |
| 2 | Core Scheduler | Part/Project/G-code management, job queue, automated dispatch, FINISHED → next job logic |
| 3 | Full UI | Dashboard, fleet grid, project manager, job queue UI, error/attention handling, notifications |
| 4 | Hardening | Error recovery, retry logic, logging, performance testing at 50+ concurrent printers |
| 5 | ~~Mobile Web~~ | ~~Responsive UI polish, mobile dashboard for status checking from phone~~ — **Deferred.** Fleet UI already works well on iPhone; no pressing need identified. |
| 6 | Multi-Brand Support | Printer driver abstraction layer; Elegoo Centauri Carbon as first non-Prusa brand (see Section 13) |

---

## 9. Resolved Design Decisions

### 9.1 Printer Spreadsheet / CSV Import Format

| Column | Example | Notes |
|---|---|---|
| `name` | `MK4S_01` | Display name — used throughout UI |
| `ip` | `192.168.15.194` | Base URL for all PrusaLink API calls |
| `api_key` | `aauukLtMLUTqq6e` | PrusaLink auth key |
| `group` | `MK4S Farm` | Logical grouping for fleet filter sidebar |
| `type` | `prusa` | Vendor identifier; reserved for future use |

### 9.2 Printer Naming Conventions

| Model | Convention | Examples |
|---|---|---|
| MK4S | `MK4S_XX` (incrementing number) | `MK4S_01`, `MK4S_17` |
| Core One | My Little Pony character names | `Twilight`, `Rarity` |
| Core 1L | My Little Pony character names | `Applejack`, `Rainbow` |
| XL | Random / ad hoc | No fixed pattern |

### 9.3 Project Priority
FIFO across projects in v1. Project-level priority (integer field, drag-to-reorder UI) deferred to v2.

### 9.4 Error Notifications
Layered alerting on ERROR or ATTENTION state:
- Browser Notification API (native OS popup, visible when tab is not in focus)
- Audio alert via Web Audio API
- Dashboard tab title updates: `(3 errors) Print Farm Manager`
- Persistent red banner until all errors acknowledged

### 9.5 G-Code File Naming Convention

Example: `1x XRP Chassis_0.4n_0.2mm_PLA_MK4S_5h11m.bgcode`

Parsed fields: qty per plate (`1`), part name (`XRP Chassis`), nozzle (`0.4n`), layer (`0.2mm`), material (`PLA`), printer model (`MK4S`), est. time (`5h11m`).

Parser regex:
```
/^(\d+)x\s+(.+?)_(\d+\.\d+n)_(\d+\.\d+mm)_([A-Z]+)_([A-Za-z0-9]+)_(\d+h\d+m)\.bgcode$/
```

If parsing fails (no `NNx` prefix), operator is prompted to enter `parts_per_plate` manually.

### 9.6 Multi-Part Plates
Fully supported. `parts_per_plate` is parsed from filename prefix, pre-filled for operator confirmation, and used as the increment value on every successful job completion. Operator must enter manually if filename parsing fails.

---

## 10. Recommended Next Steps

1. Open VS Code in an empty `print-farm-manager/` folder
2. Place this file (`ARCHITECTURE.md`) in the project root
3. Open Claude Code and say: *"Read ARCHITECTURE.md and implement Phase 1 as defined in Section 11. Do not build beyond Phase 1 scope."*
4. Validate against real printers on the local network before declaring Phase 1 complete
5. Return to update this document with a Phase 2 briefing once Phase 1 passes all acceptance criteria

---

## 11. Claude Code Briefing — Phase 1

> **Read this section in full before writing any code. Build Phase 1 only. Do not implement anything listed in Section 11.7.**

### 11.1 Project Scaffold

Create this folder structure exactly:

```
print-farm-manager/
├── server/
│   ├── index.js              # Express app entry point
│   ├── db.js                 # SQLite connection + schema init
│   ├── poller.js             # Printer polling loop
│   ├── routes/
│   │   ├── printers.js       # GET/POST/PUT/DELETE /api/printers
│   │   ├── projects.js       # GET/POST/PUT/DELETE /api/projects
│   │   ├── parts.js          # GET/POST/PUT/DELETE /api/parts
│   │   ├── gcodes.js         # POST /api/gcodes (upload)
│   │   └── jobs.js           # GET /api/jobs
│   ├── gcode/                # G-code file storage (gitignored)
│   └── data/
│       └── farm.db           # SQLite database file (gitignored)
├── client/
│   ├── index.html
│   ├── src/
│   │   ├── main.jsx
│   │   ├── App.jsx
│   │   └── pages/
│   │       ├── Dashboard.jsx
│   │       ├── Fleet.jsx
│   │       ├── Projects.jsx
│   │       ├── Jobs.jsx
│   │       └── Settings.jsx
│   └── package.json          # Vite + React
├── package.json              # Root — runs both server and client
├── ARCHITECTURE.md           # This file
└── README.md
```

### 11.2 Tech Stack — Exact Packages

| Layer | Package | Notes |
|---|---|---|
| Backend runtime | Node.js (LTS) | Windows-first; no native addons that break on Windows |
| HTTP server | `express` | REST API on port 3000 |
| Database | `better-sqlite3` | Synchronous SQLite — no async complexity for DB layer |
| File uploads | `multer` | Handles multipart G-code file uploads |
| HTTP client | `axios` | PrusaLink API calls from server to printers |
| Frontend | `react` + `vite` | Vite dev server on port 5173; proxies `/api` to port 3000 |
| CSV parsing | `papaparse` | Parses printer import spreadsheet |
| Dev runner | `concurrently` | Runs server and client together with one `npm run dev` |

### 11.3 Database Schema

Create all tables in `db.js` on startup using `CREATE TABLE IF NOT EXISTS`. Use `INTEGER PRIMARY KEY AUTOINCREMENT` for all IDs. Timestamps are Unix epoch milliseconds (`INTEGER`). Booleans are `INTEGER` (0/1).

#### Table: printers
```sql
CREATE TABLE IF NOT EXISTS printers (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT NOT NULL UNIQUE,
  ip          TEXT NOT NULL,
  api_key     TEXT NOT NULL,
  group_name  TEXT,
  type        TEXT DEFAULT 'prusa',
  model       TEXT NOT NULL,   -- mk4s | core1 | core1l | xl
  status      TEXT DEFAULT 'UNKNOWN',
  is_held     INTEGER DEFAULT 0,
  created_at  INTEGER NOT NULL
);
```

> The `model` field is not in the source CSV — infer it from `name` at import time. Rules: name starts with `MK4S_` → `mk4s`; `CoreOne_` or `Core1_` → `core1`; `Core1L_` → `core1l`; `XL_` → `xl`. Names not matching any pattern must be flagged — prompt the operator to select the model manually before that row is saved.

#### Table: projects
```sql
CREATE TABLE IF NOT EXISTS projects (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT NOT NULL,
  description TEXT,
  status      TEXT DEFAULT 'draft',  -- draft | active | paused | completed
  priority    INTEGER DEFAULT 0,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);
```

#### Table: parts
```sql
CREATE TABLE IF NOT EXISTS parts (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id     INTEGER NOT NULL REFERENCES projects(id),
  name           TEXT NOT NULL,
  target_qty     INTEGER NOT NULL,
  completed_qty  INTEGER DEFAULT 0,
  status         TEXT DEFAULT 'open',  -- open | closed
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL
);
```

#### Table: gcodes
```sql
CREATE TABLE IF NOT EXISTS gcodes (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  part_id          INTEGER NOT NULL REFERENCES parts(id),
  printer_model    TEXT NOT NULL,  -- mk4s | core1 | core1l | xl
  filename         TEXT NOT NULL,
  filepath         TEXT NOT NULL,  -- absolute path on disk under server/gcode/
  parts_per_plate  INTEGER NOT NULL,
  est_print_secs   INTEGER,
  created_at       INTEGER NOT NULL
);
```

> Enforce uniqueness on `(part_id, printer_model)` at the **application layer**, not as a DB constraint — so a clear, specific error message can be shown to the operator when they attempt to upload a duplicate.

#### Table: jobs
```sql
CREATE TABLE IF NOT EXISTS jobs (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  part_id          INTEGER NOT NULL REFERENCES parts(id),
  printer_id       INTEGER NOT NULL REFERENCES printers(id),
  gcode_id         INTEGER NOT NULL REFERENCES gcodes(id),
  parts_per_plate  INTEGER NOT NULL,  -- snapshot at dispatch time
  status           TEXT DEFAULT 'queued',
                   -- queued | uploading | printing | finished | failed | cancelled
  started_at       INTEGER,
  finished_at      INTEGER,
  created_at       INTEGER NOT NULL
);
```

### 11.4 Polling Architecture

Implement a **single shared polling loop** in `poller.js`. Do not create one loop per printer.

- On server start, load all printers from the database
- Every 15 seconds (use a `POLL_INTERVAL_MS` constant), iterate all non-held printers
- For each printer, fire `GET http://{ip}/api/v1/status` with header `X-Api-Key: {api_key}`
- Use `Promise.allSettled()` to fire all printer polls **concurrently** within each tick — all 50+ printers are polled in parallel, but only one timer drives the loop
- Update each printer's `status` field in the database with the response
- Emit a status-change event via Node.js `EventEmitter` — the scheduler will listen for `IDLE` transitions in Phase 2
- If a printer is unreachable (timeout or connection refused), set its status to `OFFLINE` — do **not** crash the loop or affect other printers

### 11.5 CSV Import Logic

The printer import CSV has exactly these columns in this order: `name, ip, api_key, group, type`

Import rules:
- Parse with `papaparse` on the server after `multer` receives the file
- Infer `model` from `name` using the rules in Section 11.3 (printers table note)
- Any row where model cannot be inferred is **flagged** in the response — not saved until operator resolves it
- Duplicate `name` values (matching an existing printer in DB) are **skipped** with a warning, not overwritten
- Return a detailed import summary: `{ imported: N, skipped: N, flagged: [ ...rows ] }`

### 11.6 Phase 1 Acceptance Criteria

Phase 1 is complete when **all 7** of the following pass. Do not declare Phase 1 done until every item is confirmed:

| # | Acceptance Criterion |
|---|---|
| 1 | `npm run dev` from the project root starts both Express (port 3000) and Vite (port 5173) with one command |
| 2 | SQLite database is created automatically on first run with all five tables present and correct |
| 3 | A CSV matching the known column format can be uploaded via the Settings screen and all valid rows are imported as printer records |
| 4 | The polling loop starts on server boot and queries every imported printer every 15 seconds |
| 5 | The Fleet screen displays all printers with their live PrusaLink status updating in real time |
| 6 | A printer that is unreachable shows as `OFFLINE` without crashing the server or affecting other printers |
| 7 | The app is usable on a mobile browser (basic responsive layout — not polished, just functional) |

### 11.7 What NOT to Build in Phase 1

Explicitly out of scope. Do not implement any of the following until Phase 2:

- Job scheduling or dispatch logic
- Project, Part, or G-code management UI
- G-code file upload
- Any queue management
- Error notification / sound alerts
- Manual `completed_qty` editing
- Part Open/Closed state transitions

> The only user-facing screens needed in Phase 1 are **Fleet** (live printer status) and **Settings** (CSV import, polling interval). All other nav items can be placeholder pages with "Coming in Phase 2."

---

## 12. Claude Code Briefing — Phase 2

> **Read this section in full before writing any code. Phase 1 is already complete — do not re-implement or modify anything from Phase 1 unless explicitly noted. Build Phase 2 only. Do not implement anything listed in Section 12.8.**

### 12.1 Phase 1 Amendments

The following decisions were revised during Phase 1 implementation. Treat these as ground truth — they supersede any conflicting values in earlier sections of this document.

**Model internal IDs** (updated from original spec):

| CSV value | Internal ID | Printer |
|---|---|---|
| `MK4` | `mk4` | Prusa MK4 |
| `MK4S` | `mk4s` | Prusa MK4S |
| `C1` | `c1` | Prusa Core One |
| `C1L` | `c1l` | Prusa Core 1L |
| `XL` | `xl` | Prusa XL |

**CSV format** now includes an explicit `model` column (positioned second): `name, model, ip, api_key, group, type`. Model is read directly from this column; name-based inference is the fallback only. The live fleet CSV is `3dpn-prusa-farm-info.csv` in the project root — 46 MK4S + 6 Core One printers.

### 12.2 New Files to Create

Add the following files. Do not modify the existing Phase 1 file structure except where noted.

```
server/
├── scheduler.js              # Job dispatch service — new
└── routes/
    ├── gcodes.js             # Replace stub with full upload handler
    └── jobs.js               # Replace stub with full job management
client/src/pages/
    ├── Projects.jsx          # Replace placeholder with full UI
    └── Jobs.jsx              # Replace placeholder with full UI
```

Also update `server/index.js` to instantiate and start the scheduler alongside the poller.

### 12.3 G-Code Upload — Server

**Route:** `POST /api/gcodes/upload` (multipart, field name `file`)

**Additional body fields** (sent alongside the file):
- `part_id` — integer, required
- `parts_per_plate` — integer, required (pre-filled from filename parse, but operator-confirmed)
- `est_print_secs` — integer, optional

**Implementation in `server/routes/gcodes.js`:**

1. `multer` saves the file to `server/gcode/` — use `multer.diskStorage` with `destination: server/gcode/` and `filename: Date.now() + '_' + originalname`
2. Check for duplicate `(part_id, printer_model)` in the `gcodes` table. If one exists, return `409` with message: `"This Part already has a G-code for {model}. Delete the existing one before uploading a replacement."`
3. Parse the model from the uploaded filename using this regex (from Section 9.5):
   ```
   /^(\d+)x\s+(.+?)_(\d+\.\d+n)_(\d+\.\d+mm)_([A-Z]+)_([A-Za-z0-9]+)_(\d+h\d+m)\.(bgcode|gcode)$/i
   ```
   - Group 1 → `parts_per_plate` (use as default; operator may override)
   - Group 6 → printer model token — map to internal ID using the table in 12.1
   - Group 7 → estimated time, parse `Hh Mm` → total seconds for `est_print_secs`
   - If regex fails: return a `parse_failed: true` flag in the response — the client must then collect `parts_per_plate` and `printer_model` from the operator before re-submitting
4. Insert into `gcodes` table. Return the created record.

**Route:** `DELETE /api/gcodes/:id`

Deletes the DB record and the file from disk (`fs.unlinkSync`). Returns `404` if not found.

**Route:** `GET /api/gcodes` (already exists as stub — keep as-is)

### 12.4 Job Scheduler — `server/scheduler.js`

Create a `JobScheduler` class that extends `EventEmitter`. It receives the `db` instance and the `poller` instance at construction. Wire it up in `server/index.js` after the poller is started:

```js
const scheduler = new JobScheduler(db, poller);
scheduler.start();
```

#### Scheduler startup

On `scheduler.start()`:
1. Listen on `poller.on('printerIdle', ...)` for future idle transitions
2. Listen on `poller.on('statusChange', ...)` for `FINISHED` transitions
3. Run an **initial dispatch sweep**: query all non-held printers with status `IDLE` and call `_dispatchToPrinter(printer)` for each — this handles printers that were already idle before the scheduler started

#### Dispatch: `_dispatchToPrinter(printer)`

Called when a printer is idle and ready for work. Synchronous DB operations first, then async PrusaLink calls.

```
1. Find the best open Part for this printer:
   SELECT parts
   JOIN gcodes ON gcodes.part_id = parts.id
   JOIN projects ON projects.id = parts.project_id
   WHERE parts.status = 'open'
     AND projects.status = 'active'
     AND gcodes.printer_model = {printer.model}
   ORDER BY projects.created_at ASC   ← FIFO across projects
   LIMIT 1

2. If no Part found → do nothing (printer stays idle)

3. Fetch the matching gcode record for this part + model

4. Synchronously INSERT a job record into the jobs table with status = 'uploading'
   (This must happen before any async work — it acts as a lock so concurrent
   printerIdle events for other printers of the same model don't pick the same Part
   and over-dispatch beyond what's needed.)

5. Check ceiling: jobs_remaining = ceil((part.target_qty - part.completed_qty) / gcode.parts_per_plate)
   Count active jobs for this Part (status IN 'uploading','printing')
   If active_jobs >= jobs_remaining:
     DELETE the job just inserted (we don't need it)
     Return — Part is covered

6. Async: upload G-code file to printer via PrusaLink
   POST http://{printer.ip}/api/v1/files/usb
   Headers: X-Api-Key: {printer.api_key}
   Body: multipart — the file from gcode.filepath

7. Async: start the print job
   POST http://{printer.ip}/api/v1/job
   Headers: X-Api-Key: {printer.api_key}
   Body: { "file": { "path": "/usb/{gcode.filename}" } }

8. On success: UPDATE job SET status = 'printing', started_at = now
9. On any failure: UPDATE job SET status = 'failed'
   Log the error. Do NOT retry automatically in Phase 2.
```

#### FINISHED handling: `_handleFinished(printer)`

Called when `statusChange` fires with `newStatus === 'FINISHED'`.

```
1. Find the job for this printer with status = 'printing'
   If none found → log warning and return (printer may have been printing
   something outside the system)

2. UPDATE job SET status = 'finished', finished_at = now

3. Increment Part.completed_qty += job.parts_per_plate
   UPDATE parts SET
     completed_qty = completed_qty + {parts_per_plate},
     updated_at = now
   WHERE id = {part_id}

4. Re-fetch the Part. If completed_qty >= target_qty:
   a. UPDATE parts SET status = 'closed', updated_at = now
   b. Cancel all queued jobs for this Part (status = 'queued' only —
      do NOT touch uploading or printing jobs)
      UPDATE jobs SET status = 'cancelled' WHERE part_id = ? AND status = 'queued'
   c. Check if all Parts in the Project are closed:
      If yes: UPDATE projects SET status = 'completed', updated_at = now

5. Printer is now IDLE — call _dispatchToPrinter(printer) to assign the next job
```

#### Concurrency note

`better-sqlite3` is synchronous, so the INSERT in step 4 of dispatch acts as a mutex. Two concurrent `printerIdle` events (e.g. two MK4S printers finishing at the same moment) will serialize their DB writes. The ceiling check in step 5 ensures neither over-dispatches. Do not add any additional locking mechanism.

### 12.5 Updated Job Routes — `server/routes/jobs.js`

Replace the existing stub with a full implementation:

**`GET /api/jobs`** — already exists, keep query filter params (`printer_id`, `part_id`, `status`). Add `project_id` as an additional filter (join through parts).

**`DELETE /api/jobs/:id`** (cancel a queued job)
- Only allow cancellation if `status = 'queued'`
- Return `409` if the job is already `uploading`, `printing`, `finished`, or `failed`
- UPDATE status to `cancelled`

### 12.6 Projects UI — `client/src/pages/Projects.jsx`

Replace the placeholder. This is the primary operator screen for setting up and launching print runs.

#### Project list view (default)

- List all projects with name, status badge, and Part count
- "New Project" button → inline form: name + optional description → `POST /api/projects`
- Click a project → Project detail view

#### Project detail view

Shows one project at a time. Contains:

**Header:** project name, status badge, "Activate" / "Pause" / "Complete" action button
- `draft` → show "Activate" button → `PUT /api/projects/:id { status: 'active' }` + trigger initial dispatch sweep via `POST /api/scheduler/dispatch` (see below)
- `active` → show "Pause" button → `PUT /api/projects/:id { status: 'paused' }`
- `paused` → show "Resume" button → same as Activate
- `completed` → no action button

**Parts table:** one row per Part showing:
- Name
- Progress: `completed_qty / target_qty` as both a number and a progress bar
- Status badge: `open` (blue) or `closed` (green)
- G-codes attached: one chip per model that has a G-code uploaded (e.g. `mk4s`, `c1`)
- Edit `completed_qty` button (see guardrails below)

**"Add Part" form** (inline, below the table):
- Fields: Part name, target quantity
- `POST /api/parts { project_id, name, target_qty }`

**G-code upload panel** (per Part, expandable):
- File picker (`.bgcode`, `.gcode`)
- On file selection: send to `POST /api/gcodes/parse-filename` — a lightweight endpoint that just runs the regex and returns the parsed fields without saving anything. Pre-fill the form fields.
- Editable fields: `parts_per_plate`, `printer_model` (dropdown: `mk4`, `mk4s`, `c1`, `c1l`, `xl`)
- "Upload" button → `POST /api/gcodes/upload` (multipart)
- On `409` duplicate: show the warning message inline, do not clear the form

**`completed_qty` edit guardrails** (match Section 3.3 exactly):
- Clicking edit opens an inline number input pre-filled with current value
- On submit: show "Are you sure?" confirm dialog
- If new value < target_qty AND Part is closed: show "This will reopen the Part and resume dispatching. Confirm?"
- If new value >= target_qty AND Part is open: show "This will close the Part and stop all dispatching. Confirm?"
- On confirm: `PUT /api/parts/:id { completed_qty: newValue }` — the server updates `status` automatically based on the new value

#### Server-side: `completed_qty` update logic

When `PUT /api/parts/:id` is called with a `completed_qty` value, the server must:
1. Update `completed_qty`
2. Recalculate status: if `completed_qty >= target_qty` → `closed`; else → `open`
3. Update `updated_at`

Do this in the existing `server/routes/parts.js` — add this logic to the PUT handler.

#### Server-side: dispatch trigger endpoint

Add `POST /api/scheduler/dispatch` — no body required. Triggers an immediate dispatch sweep for all currently idle non-held printers. Mount this route in `server/index.js`. The scheduler instance must be accessible to this route (pass it in, same pattern as `db`).

### 12.7 Jobs UI — `client/src/pages/Jobs.jsx`

Replace the placeholder with a job queue table.

**Columns:** Job ID, Part name, Project name, Printer name, Model, Status, Started, Duration (if finished), actions

**Filters** (top of page): status (all / queued / uploading / printing / finished / failed / cancelled), project dropdown, printer dropdown

**Data:** `GET /api/jobs` with query params matching active filters. Poll every 15 seconds (same pattern as Fleet).

**Actions column:**
- `queued` jobs: "Cancel" button → `DELETE /api/jobs/:id`
- All other statuses: no action

**Status color coding** (consistent with Fleet page colors):
- `queued` → gray
- `uploading` → blue
- `printing` → green
- `finished` → muted green
- `failed` → red
- `cancelled` → dark gray

### 12.8 What NOT to Build in Phase 2

Explicitly out of scope. Do not implement any of the following:

- Error notifications (browser notifications, audio alerts, tab title badge) — Phase 3
- Automatic job retry on failure — Phase 3
- Project priority ordering / drag-to-reorder — deferred (FIFO across projects is correct for now)
- Manual job assignment override — Phase 3
- Printer detail view / per-printer job history — Phase 3
- Any changes to the Fleet or Settings pages

### 12.9 Phase 2 Acceptance Criteria

Phase 2 is complete when **all 8** of the following pass:

| # | Acceptance Criterion |
|---|---|
| 1 | A G-code file with a correctly formatted filename can be uploaded and associated with a Part + model. Parsed fields (parts_per_plate, model, est. time) are pre-filled and editable before saving. |
| 2 | A G-code with a non-standard filename can still be uploaded after the operator manually enters `parts_per_plate` and selects the model. |
| 3 | Uploading a second G-code for the same Part + model shows a clear error and does not overwrite the existing file. |
| 4 | A Project can be created with multiple Parts, each with a target quantity and one or more G-codes attached. |
| 5 | Activating a project immediately dispatches jobs to all currently idle compatible printers. |
| 6 | When a printer transitions to `FINISHED`, `completed_qty` is incremented correctly, and the printer immediately receives its next job if the Part is still open. |
| 7 | When `completed_qty >= target_qty`, the Part closes, queued jobs for it are cancelled, and the scheduler moves on to the next open Part. |
| 8 | Manually editing `completed_qty` triggers the correct confirmation dialogs and correctly opens or closes the Part. |

---

## 13. Phase 6 — Multi-Brand Printer Support

> **Status: Planned — do not implement until explicitly instructed.**
> This section documents the design intent and the specific changes needed. Read it before starting Phase 6, then build only what is scoped here.

### 13.1 Background

The system was built on PrusaLink (Prusa's REST API), but the `type` column on the `printers` table has always anticipated future brands. Phase 6 introduces the driver abstraction layer to make that column meaningful.

The first non-Prusa target is the **Elegoo Centauri Carbon**, an FDM printer that uses a proprietary WebSocket-based protocol (SDCP v3) rather than a REST API. Supporting it requires decoupling the polling and dispatch logic from PrusaLink specifics.

### 13.2 Protocol Comparison

| Capability | PrusaLink (Prusa) | SDCP (Elegoo Centauri Carbon) |
|---|---|---|
| Status | `GET /api/v1/status` every 15s | WebSocket request/response over port 3030 |
| File upload | `PUT /api/v1/files/usb/{filename}` | `POST http://{ip}/uploadFile/upload` (multipart) |
| Print trigger | `Print-After-Upload: 1` header (implicit) | WebSocket command after upload |
| Authentication | `X-Api-Key` request header | None — LAN network access only |
| File format | `.bgcode` or `.gcode` | `.gcode` only |
| Printer discovery | Manual IP entry | UDP broadcast to port 3000 (optional) |
| 409 conflict | File transfer already in progress | Not applicable |

Community documentation for SDCP: [cassini](https://github.com/vvuk/cassini), [elegoo-homeassistant](https://github.com/danielcherubini/elegoo-homeassistant), [RemmyLee/carbon](https://github.com/RemmyLee/carbon), [OpenCentauri API docs](https://docs.opencentauri.cc/software/api/).

### 13.3 Canonical Status Model

Rather than exposing brand-specific state names to the poller and scheduler, introduce a normalized internal state set. Each driver maps its own states to these:

| Canonical State | PrusaLink source | SDCP source |
|---|---|---|
| `IDLE` | `IDLE` | Not printing, no error, cause code 0 |
| `PRINTING` | `PRINTING` | Active print job in progress |
| `FINISHED` | `FINISHED` | Print completed, awaiting operator |
| `PAUSED` | `PAUSED` | Paused by user or system |
| `ERROR` | `ERROR`, `ATTENTION` | Temperature, jam, homing, or other fault |
| `OFFLINE` | Timeout / connection refused | Timeout / WebSocket unreachable |

The poller, scheduler, and UI all continue using these canonical states. They do not need to know which brand they are talking to.

### 13.4 New: Driver Abstraction Layer

Create `server/drivers/` with three files:

#### `server/drivers/index.js` — Driver registry

```js
const drivers = {
  prusa:            require('./prusa'),
  'elegoo-centauri': require('./elegoo-centauri'),
};

module.exports = {
  getDriver(type) {
    return drivers[type] ?? drivers.prusa;
  },
};
```

#### `server/drivers/prusa.js` — Extract existing PrusaLink logic

Move all PrusaLink-specific HTTP calls out of `poller.js` and `scheduler.js` into this module. Expose:

```js
// Returns normalized { status, jobName, progress, timeRemaining }
async function getStatus(printer) { ... }

// Uploads gcode file and triggers print. Resolves when print is confirmed started.
// Handles pre-upload DELETE and 409 retry already in scheduler.js — move that logic here.
async function uploadAndPrint(printer, filePath, filename) { ... }

// Cancels the current job.
async function cancelJob(printer) { ... }

module.exports = { getStatus, uploadAndPrint, cancelJob };
```

`getStatus` replaces the direct `axios.get(http://${printer.ip}/api/v1/status ...)` calls in `poller.js` and `routes/printers.js`. `uploadAndPrint` replaces `_uploadGCode()` in `scheduler.js`.

#### `server/drivers/elegoo-centauri.js` — New Elegoo implementation

Implement the same three functions using SDCP over WebSocket. Key implementation notes:

- Maintain a **persistent WebSocket connection per printer** — open on first use, reconnect on drop. Store connections keyed by printer ID in a module-level Map so the poller and scheduler share the same socket.
- `getStatus` sends an SDCP status request message and returns the normalized response. If the socket is closed/errored, return `{ status: 'OFFLINE' }`.
- `uploadAndPrint` does two steps: (1) HTTP POST multipart to `http://{printer.ip}/uploadFile/upload`, then (2) send an SDCP print-start command over WebSocket with the uploaded filename.
- `api_key` is unused for Elegoo — the driver should not require it.
- SDCP message format: `{ Id: "<uuid>", Data: { Cmd: <int>, RequestID: "<uuid>", MainboardID: "<str>" }, Topic: "..." }`. Refer to the community documentation linked in Section 13.2 for specific command codes.

### 13.5 Changes to Existing Files

#### `server/poller.js`

- Import `getDriver` from `server/drivers/index.js`
- Replace `axios.get(http://${printer.ip}/api/v1/status ...)` with `driver.getStatus(printer)` where `driver = getDriver(printer.type)`
- The status normalization, hold logic, and event emission remain unchanged — they operate on canonical states

#### `server/scheduler.js`

- Import `getDriver` from `server/drivers/index.js`
- Replace `_uploadGCode(printer, gcode)` with `driver.uploadAndPrint(printer, gcode.filepath, gcode.filename)` where `driver = getDriver(printer.type)`
- The ceiling check, job record management, and FINISHED handling remain unchanged

#### `server/routes/printers.js`

- Add `'elegoo-centauri'` to `VALID_MODELS` (the brand-level type, not the printer model list)
- Add Elegoo Centauri Carbon as a valid `model` value: `'centauri-carbon'`
- Add name inference rule: names starting with `CC_` → `centauri-carbon`
- Make `api_key` optional in the add-printer and CSV import validation — Elegoo printers do not use one

#### `server/routes/gcodes.js`

- The Prusa Slicer filename regex (`^(\d+)x\s+.+bgcode$`) will not match Elegoo Slicer output. When parsing fails, the system already returns `parse_failed: true` and prompts the operator for manual input — this path already works correctly for Elegoo files.
- No code change required here for Phase 6. Operators enter `parts_per_plate` and model manually for Elegoo G-codes.

#### `client/src/pages/Fleet.jsx`

- Add `'centauri-carbon'` to `MODEL_ORDER` and `MODEL_LABELS` (label: `'Centauri Carbon'`)

#### `client/src/pages/Dashboard.jsx`

- Same `MODEL_ORDER` / `MODEL_LABELS` additions as Fleet.jsx

#### `client/src/pages/Settings.jsx`

- Add `'centauri-carbon'` to `MODEL_OPTIONS`
- When the selected printer `type` is `'elegoo-centauri'`, hide the API key field (not required)

### 13.6 Database Changes

No schema migration required. The existing columns are sufficient:

| Column | Elegoo usage |
|---|---|
| `type` | Store `'elegoo-centauri'` — was already reserved for this |
| `api_key` | Store empty string `''` — not used by the driver |
| `model` | Store `'centauri-carbon'` |
| `job_name`, `job_progress`, `job_time_remaining` | Populated from SDCP status response — same fields, different source |

### 13.7 New npm Dependency

The Elegoo driver will need `ws` (the `websocket` npm package) for Node.js WebSocket client support. Axios is HTTP-only.

```bash
npm install ws
```

### 13.8 What NOT to Build in Phase 6

- UDP auto-discovery of Elegoo printers — manual IP entry is sufficient and consistent with Prusa workflow
- Any Klipper/Moonraker compatibility layer — SDCP is the target protocol
- Support for Elegoo resin printers (Saturn, Mars series) — different protocol entirely
- Firmware flashing or configuration via the app

### 13.9 Phase 6 Acceptance Criteria

| # | Acceptance Criterion |
|---|---|
| 1 | An Elegoo Centauri Carbon can be added via the Settings page (no API key required) |
| 2 | The poller polls the Centauri Carbon via WebSocket and its canonical status appears correctly in the Fleet grid |
| 3 | Transitioning to `OFFLINE` when the printer is unreachable does not affect polling of Prusa printers |
| 4 | A `.gcode` file can be uploaded, associated with a Part at model `centauri-carbon`, and dispatched to the printer via `uploadAndPrint` |
| 5 | A Prusa printer and an Elegoo printer running simultaneously both report correct status and progress |
| 6 | All existing Prusa functionality is unaffected (run the full test suite) |
