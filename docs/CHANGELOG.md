# Changelog

---

## 2026-04-01 — Fleet cards: print progress bar and job info while printing

### Job progress stored on every poll (`server/poller.js`, `server/db.js`)
Three new columns added to the printers table via migration: `job_name TEXT`, `job_progress REAL`, `job_time_remaining INTEGER`. The poller now reads `data.job.display_name`, `data.job.progress`, and `data.job.time_remaining` from the PrusaLink `/api/v1/status` response on every tick while a printer is PRINTING, and persists them to the DB. All three fields are cleared when the printer transitions out of PRINTING state.

### Printing cards show job name, progress bar, time remaining (`client/src/pages/Fleet.jsx`)
When a printer is PRINTING its card now shows: the job filename in monospace (truncated), a left-to-right blue progress bar, and percentage + time remaining below it. IP address removed from all cards. Model chip and group name remain. Non-printing cards are otherwise unchanged.

**Files changed:** `server/db.js`, `server/poller.js`, `client/src/pages/Fleet.jsx`

---

## 2026-04-01 — Part priority ordering with up/down buttons

### sort_order column on parts (`server/db.js`)
Added `sort_order INTEGER NOT NULL DEFAULT 0` to the parts table via ALTER TABLE migration. Existing parts all start at 0 (tiebroken by `created_at`).

### Reorder endpoint (`server/routes/parts.js`)
`PUT /api/parts/reorder` accepts `{ ids: [...] }` — an ordered array of part IDs. Assigns `sort_order = index` for each in a single transaction. Parts GET query updated to `ORDER BY sort_order ASC, created_at ASC`.

### Scheduler respects part order (`server/scheduler.js`)
Candidate query now orders by `parts.sort_order ASC, parts.created_at ASC` within a project, so the highest-priority part always gets the next idle machine.

### Up/Down buttons in part rows (`client/src/pages/Projects.jsx`)
▲ and ▼ buttons appear next to each part name. Top part hides ▲, bottom part hides ▼. Clicking immediately reorders local state (optimistic update) then persists to the server in the background.

**Files changed:** `server/db.js`, `server/routes/parts.js`, `server/scheduler.js`, `client/src/pages/Projects.jsx`

---

## 2026-04-01 — Part Details panel: editable quantities, G-code management

### Details panel replaces inline editing (`client/src/pages/Projects.jsx`)
The "G-code" toggle button on each part row has been renamed "Details". Clicking it opens a consolidated `PartDetailsPanel` component with three sections:

- **Quantities** — editable Have (completed_qty) and Need (target_qty) fields with a single Save button. Status change confirmations apply (closing/reopening the part triggers a confirm dialog).
- **G-code Files** — lists every uploaded G-code with its filename and target printer model. Each row has an × delete button with confirmation.
- **Upload G-code** — the existing upload form (file picker, parts-per-plate, model selector).

The main part row is now read-only: it shows name, progress bar, status badge, and model chips (no delete buttons). All editing is consolidated behind the Details button.

The `target_qty` field was already accepted by `PUT /api/parts/:id` — no server changes were needed.

**Files changed:** `client/src/pages/Projects.jsx`

---

## 2026-03-31 — Fleet UI: status color alignment and confirmation button guard

### Status colors aligned to Prusa (`client/src/pages/Fleet.jsx`)
Updated `STATUS_COLORS` to match Prusa's own color language: PRINTING is blue (was green), IDLE is grey (was blue), FINISHED stays green, ATTENTION and ERROR unchanged (yellow and red). READY/Prepared is muted grey since PrusaLink has no distinct color for it.

Filter chips in the Fleet header now derive their text color from `STATUS_COLORS` directly rather than hardcoded hex values, ensuring chips and badges always stay in sync.

### Confirmation buttons hidden for non-completable states (`client/src/pages/Fleet.jsx`)
"Set Ready" and "Bad Print" buttons previously appeared on any held printer regardless of status — including ATTENTION and ERROR. A filament-runout (ATTENTION) would show the confirmation UI even though no print completed.

`needsConfirmation` now requires `status === 'FINISHED' || status === 'IDLE'` in addition to `is_held === 1`. The `awaitingConfirmation` banner count uses the same guard. Cards in ATTENTION, ERROR, OFFLINE, or PAUSED no longer show the green highlight, Include checkbox, or action buttons.

**Files changed:** `client/src/pages/Fleet.jsx`

---

## 2026-03-31 — Recommission auto-dispatch; Sweep for Jobs button on Fleet

### Recommission triggers immediate dispatch (`server/index.js`)
The recommission endpoint was moved from `routes/printers.js` to `index.js` so it has access to the scheduler. After returning the printer to the active fleet (`is_active = 1`, `is_held = 0`), it immediately calls `_dispatchToPrinter` — the machine gets a job without any operator nudge required. If no job is available right now it logs cleanly and waits for the next natural dispatch event.

### "Sweep for Jobs" button on Fleet (`client/src/pages/Fleet.jsx`)
A button in the Fleet page header that calls `POST /api/scheduler/dispatch` — the same sweep used when activating a project. Useful as a general manual trigger: after a server restart, after recommissioning, after any situation where machines are ready but idle. Removes the need to navigate to Projects and use Pause/Resume as a workaround.

**Files changed:** `server/index.js`, `server/routes/printers.js`, `client/src/pages/Fleet.jsx`

---

## 2026-03-31 — Upload retries, re-hold on failure, batched bulk Set Ready

### Upload retry with re-hold on failure (`server/scheduler.js`)
`_dispatchToPrinter` now retries the file upload up to 2 additional times (3 total attempts) with a 5-second delay between each, before giving up. This self-heals transient network timeouts that are common when many printers start simultaneously.

If all attempts fail: the job is marked `failed`, `is_held = 1` is set on the printer, and `null` is returned. The printer reappears in the Fleet UI with Set Ready / Bad Print buttons so the operator can inspect and retry. Previously, a failed upload left the printer in a stuck state with no action buttons and no path to re-dispatch.

Also fixed: `_dispatchToPrinter` previously returned `jobId` even on failure (outside the try/catch), causing a misleading "dispatched — job N" log. It now returns `null` on failure.

### Bulk Set Ready routes through batched sweep (`server/index.js`, `client/src/pages/Fleet.jsx`)
The "Set Ready (N)" bulk action previously fired N simultaneous HTTP requests — one per printer — bypassing the batch logic entirely and causing all printers to receive files at the same time. This was the root cause of the timeout failures.

New endpoint `POST /api/printers/set-ready-batch` accepts an array of printer IDs, clears `is_held` for all of them, then passes the printers directly to `scheduler._sweepInBatches()`. Files are now dispatched 10 at a time, waiting for each group to reach `printing` state before sending to the next 10.

The individual "Set Ready" button on each card is unchanged — it still dispatches a single printer immediately.

**Files changed:** `server/scheduler.js`, `server/index.js`, `client/src/pages/Fleet.jsx`

---

## 2026-03-31 — Decommissioned printers page

Decommissioned printers are no longer shown in the Fleet. They have their own page accessible from the sidebar.

- `GET /api/printers` now returns only `is_active = 1` printers
- New `GET /api/printers/decommissioned` returns inactive printers ordered by decommission date
- Two new columns on `printers`: `decommissioned_at` (epoch ms) and `decommission_note` (text). Added via ALTER TABLE migration.
- Decommission endpoint now records `decommissioned_at = Date.now()`
- Recommission endpoint clears `decommissioned_at` and `decommission_note`, and sets `is_held = 1` so the printer must be explicitly set ready before receiving jobs
- New `client/src/pages/Decommissioned.jsx`: list of decommissioned printers, each showing name/model/IP, decommission timestamp, an editable investigation note field (saved via PUT), and a Recommission button with confirmation dialog
- `Fleet.jsx` simplified — decommissioned rendering removed entirely

**Files changed:** `server/db.js`, `server/routes/printers.js`, `client/src/pages/Fleet.jsx`, `client/src/pages/Decommissioned.jsx` (new), `client/src/App.jsx`

---

## 2026-03-31 — Safety: hold-on-error policy, bad print decommissions printer

### Bad Print now decommissions the printer
`mark-job-failure` no longer releases the hold. Instead it sets `is_active = 0`, decommissioning the printer. A failed print is treated as an investigation event — the machine must be manually recommissioned once confirmed safe.

**Why:** Releasing the hold after a failure was dangerous. A failed print could indicate a mechanical issue, a bed obstruction, or a calibration problem. Automatically making the machine available for the next job risks repeating or compounding the problem.

### Hold on any non-normal printer state
The poller now sets `is_held = 1` whenever a printer enters any state outside `{IDLE, PRINTING, FINISHED, READY}`. This includes: `ERROR`, `OFFLINE`, `ATTENTION`, `PAUSED`, and any unrecognized state.

**Why:** Any unexpected state could mean the printer requires physical intervention. The poller cannot know if the bed is clear, if a print is still on the plate, or if calibration was lost. Human sign-off is the only safe option.

The scheduler's `_handlePrinterUnavailable` also explicitly sets `is_held = 1` as defense in depth when a printer goes `ERROR` or `OFFLINE`.

**Files changed:** `server/routes/printers.js`, `server/poller.js`, `server/scheduler.js`, `client/src/pages/Fleet.jsx`

---

## 2026-03-31 — Bugfix: cold-start dispatch to printers that finished while server was offline

**Problem:** If the server was shut down while printers were printing, and printers finished overnight, the server would dispatch a new job to those printers immediately on startup — bypassing operator confirmation.

**Root cause:** The poller only set `is_held = 1` when it observed a `FINISHED` transition. If the server was offline when a print completed, the `PRINTING → FINISHED → IDLE` path was compressed into a single `PRINTING → IDLE` observed transition at server startup, which set no hold.

**Fix 1 (`server/poller.js`):** `is_held = 1` is now also set when a printer transitions from `PRINTING` directly to `IDLE` — covering the cold-start case where `FINISHED` was never observed.

**Fix 2 (`server/scheduler.js`):** `_dispatchToPrinter` now re-reads `is_held` from the DB at the top of every call, rather than relying on the (potentially stale) printer object passed in via the event. This is defense-in-depth — the poller fix is the primary gate.

---

## 2026-03-30 — Post-Phase 2: Operator confirmation, batched dispatch, decommission

### Operator confirmation flow

Printers now require explicit human sign-off before receiving a new job after any print finishes.

- `is_held` default changed to `1` — all printers start held on import; a human must explicitly set them ready before any job ever dispatches
- Poller automatically sets `is_held = 1` whenever a printer transitions to `FINISHED`
- Fleet UI shows "Set Ready" and "Bad Print" buttons on any held printer card, with a green banner showing count and bulk "Select All / Set Ready (N)" action
- "Set Ready" releases the hold and immediately dispatches the next job to that printer
- "Bad Print" marks the last finished job as `failed`, undoes `completed_qty`, reopens the Part (and Project if needed), then releases the hold

### Batched dispatch

`sweepIdlePrinters` now dispatches in batches of 10 rather than firing all uploads simultaneously.

- Each batch of up to 10 printers is dispatched concurrently
- The sweep waits for all jobs in the batch to reach `printing` or a terminal state (polling the jobs table every 3 seconds, timeout 3 minutes) before sending the next batch
- `_dispatchToPrinter` returns its job ID (or `null`) so the batch sweep can track progress

### PrusaLink upload fix

- Changed from `POST /api/v1/files/usb` (multipart) to `PUT /api/v1/files/usb/{filename}` (raw binary stream) — the v1 API on firmware 6.x requires PUT
- Added `Print-After-Upload: 1` request header — the printer starts the print immediately on upload completion, eliminating the need for a separate `POST /api/v1/job` call
- Pre-upload `DELETE /api/v1/files/usb/{filename}` clears any stale copy of the file before uploading, preventing 409 conflicts

### Decommission / recommission

- Added `is_active` column to `printers` table (default `1`). Existing installs get the column via `ALTER TABLE` migration in `db.js`.
- Decommissioned printers (`is_active = 0`) are skipped by the poller and excluded from dispatch
- Fleet UI shows a "Decommission" button on every active printer card. Decommissioned cards are grayed out with a "↩ Recommission" button
- New endpoints: `POST /api/printers/:id/decommission`, `POST /api/printers/:id/recommission`

### READY state clarification

- PrusaLink `READY` state = "Prepared" (a print is loaded, waiting to be started manually) — NOT the same as idle
- `READY` is shown as a distinct "Prepared" badge in the Fleet UI (lighter blue) and is NOT eligible for dispatch
- Only `IDLE` printers receive jobs

### Printer inspection

- Clicking any printer card in Fleet logs the full raw PrusaLink `/api/v1/status` response to the browser console via a server-side proxy endpoint `GET /api/printers/:id/raw-status`

### Test suite

- Added `jest` and `supertest` as dev dependencies
- `server/tests/gcodes.test.js` — 6 passing tests covering parse-filename, upload success, no-file 400, invalid model 400, and duplicate 409
- `npm test` runs the suite

### Files changed

`server/scheduler.js`, `server/poller.js`, `server/db.js`, `server/index.js`, `server/routes/printers.js`, `server/routes/gcodes.js`, `client/src/pages/Fleet.jsx`, `package.json`

---

## 2026-03-30 — Phase 2: Job Scheduling & Production UI

### Job Scheduler (`server/scheduler.js`)

New `JobScheduler` class extending `EventEmitter`. Receives the `db` and `poller` instances at construction and is started alongside the poller in `server/index.js`.

- Listens to `printerIdle` events from the poller and dispatches the next eligible job automatically
- `_dispatchToPrinter(printer)`: queries open parts in active projects that have a matching G-code for the printer's model, ordered FIFO by project creation date. Inserts the job synchronously as `uploading` to act as a concurrency lock, then performs a ceiling check (uploads needed vs. active jobs already running). If over ceiling, deletes the just-inserted job and returns. Otherwise uploads the file to PrusaLink and starts the print.
- `_handleFinished(printer)`: marks the job `finished`, increments `completed_qty` on the part, closes the part if qty ≥ target (auto-cancelling any queued jobs for it), and checks whether all parts in the project are now closed (marks project `completed` if so). Then dispatches the next job.
- `_handlePrinterUnavailable(printer)`: marks any active job on that printer as `failed` when the printer goes `ERROR` or `OFFLINE`.
- `sweepIdlePrinters()`: queries all currently idle, non-held printers and dispatches to each. Called at server start and when a project is activated via the UI.

### G-code Upload API (`server/routes/gcodes.js`)

Replaced the GET-only stub with a full implementation:

- `POST /api/gcodes/parse-filename` — runs the filename regex and returns parsed fields (`parts_per_plate`, `printer_model`, `est_print_secs`, `part_name_hint`) without saving anything. Returns `{ parse_failed: true }` on no match.
- `POST /api/gcodes/upload` — multipart upload (field name `file`) using multer diskStorage to `server/gcode/`. Enforces uniqueness on `(part_id, printer_model)` at the application layer; returns `409` with a descriptive message on duplicate.
- `DELETE /api/gcodes/:id` — removes the DB record and the file from disk.

Filename regex: `^(\d+)x\s+(.+?)_(\d+\.\d+n)_(\d+\.\d+mm)_([A-Za-z]+)_([A-Za-z0-9]+)_(\d+h\d+m)\.(bgcode|gcode)$`

### Jobs API (`server/routes/jobs.js`)

Replaced the stub with a full implementation:

- `GET /api/jobs` — filtered list with JOINs returning `part_name`, `project_name`, `printer_name`, `printer_model`. Supports `?status`, `?project_id`, `?printer_id`, `?part_id` query params.
- `GET /api/jobs/:id` — single job with same JOINs.
- `DELETE /api/jobs/:id` — cancels a job; returns `409` if status is not `queued`.

### Parts API update (`server/routes/parts.js`)

`PUT /api/parts/:id` now auto-calculates `status` when `completed_qty` is provided: `closed` if `completed_qty >= target_qty`, otherwise `open`. If `completed_qty` is not in the payload, the caller can still set `status` explicitly.

### Dispatch trigger endpoint

`POST /api/scheduler/dispatch` — no body required. Calls `scheduler.sweepIdlePrinters()`. Mounted in `server/index.js`. Called by the Projects UI when a project is activated or resumed.

### Projects screen (`client/src/pages/Projects.jsx`)

Full replacement of the Phase 1 placeholder:

- **List view**: all projects with name, status badge, click to open detail.
- **New Project form**: inline, name + optional description, `POST /api/projects`.
- **Detail view**:
  - Header with project name, status badge, and context-sensitive action button: Activate (draft), Pause (active), Resume (paused). Activate/Resume triggers `POST /api/scheduler/dispatch`.
  - Parts table: name, progress bar (`completed_qty / target_qty`), status badge (`open` / `closed`), G-code chips per uploaded model (with × delete button), Edit qty button.
  - `completed_qty` editing with guardrails: inline number input, confirm dialog on submit. Special messages when the edit would reopen a closed part or close an open one.
  - Per-part expandable G-code upload panel: file picker, auto-fill from `POST /api/gcodes/parse-filename` on file select, editable `parts_per_plate` and model dropdown, 409 error shown inline without clearing the form.
  - Add Part inline form: name + target quantity, `POST /api/parts`.

### Jobs screen (`client/src/pages/Jobs.jsx`)

Full replacement of the Phase 1 placeholder:

- Table columns: ID, Part, Project, Printer, Model, Status, Started, Duration, Actions.
- Filter bar: status dropdown (all / queued / uploading / printing / finished / failed / cancelled), project dropdown, printer dropdown.
- Polls `GET /api/jobs` every 15 seconds with active filters as query params.
- Cancel button on `queued` rows → `DELETE /api/jobs/:id` with confirm dialog.
- Status color coding consistent with Fleet page.

### Dependencies added

- `form-data` ^4.0.0 (server) — multipart form construction for PrusaLink file uploads

---

## 2026-03-30 — Explicit model column in CSV; canonical model value set

**What:** Redesigned model resolution for CSV import. The `model` column in the CSV is now the authoritative source. Valid values: `MK4`, `MK4S`, `C1`, `C1L`, `XL` (case-insensitive, normalized to lowercase internally). Name-based inference is retained as a fallback for CSVs without the column.

Internal model IDs updated from `core1` / `core1l` to `c1` / `c1l` to match the canonical value set. `mk4` added as a distinct model alongside `mk4s`.

**Why:** Name inference is brittle — it requires naming conventions to be followed and breaks for any free-form printer names (e.g. MLP character names for Core One machines). An explicit column makes any printer name valid and removes the inference logic as a maintenance burden.

**Files changed:** `server/routes/printers.js`, `client/src/pages/Settings.jsx`, `docs/database.md`, `docs/api.md`

---

## 2026-03-30 — Phase 1: Foundation

### Project scaffold

Created the full project directory structure as specified in `ARCHITECTURE.md` Section 11.1:

- `server/` with `index.js`, `db.js`, `poller.js`, and `routes/` subfolder
- `client/` with Vite + React setup, `src/pages/` for all five screens
- Root `package.json` wiring both processes together via `concurrently`
- `.gitignore` excluding `node_modules/`, `server/data/`, `server/gcode/`, `dist/`

### Database (`server/db.js`)

Created SQLite database with all five tables using `better-sqlite3`:

- `printers` — printer registry with model, IP, API key, status, hold flag
- `projects` — production run tracking (draft/active/paused/completed)
- `parts` — per-project components with target/completed quantity
- `gcodes` — G-code files per part+model combination with plate metadata
- `jobs` — individual print instances with lifecycle status

WAL journal mode and foreign key enforcement enabled at startup. Database file and gcode directory auto-created on first run.

### Printer polling loop (`server/poller.js`)

Implemented `PrinterPoller` class extending `EventEmitter`:

- Single 15-second `setInterval` drives polls for the entire fleet (not one timer per printer)
- `Promise.allSettled()` fires all printer polls concurrently — one unreachable printer never blocks others
- Reads `data.printer.state` from PrusaLink `GET /api/v1/status` endpoint
- Network failures (timeout, refused) → status set to `OFFLINE`
- Status changes written to DB and emitted as `statusChange` events
- `printerIdle` event emitted when a printer transitions into IDLE (hook point for Phase 2 scheduler)
- Individual printer poll timeout: 8 seconds

### Printer registry API (`server/routes/printers.js`)

Full CRUD plus CSV bulk import:

- `GET /api/printers` — list all, ordered by name
- `GET /api/printers/:id` — single printer
- `POST /api/printers` — create single printer with model validation
- `PUT /api/printers/:id` — partial update (all fields including `is_held`)
- `DELETE /api/printers/:id`
- `POST /api/printers/import` — multipart CSV upload via multer + papaparse
  - Model inferred from name prefix (`MK4S_`, `CoreOne_/Core1_`, `Core1L_`, `XL_`)
  - Duplicate names skipped with count; unrecognized model names flagged for manual resolution
  - Returns `{ imported, skipped, flagged }` summary

### Stub API routes

Created minimal implementations for Phase 2 endpoints:

- `server/routes/projects.js` — full CRUD (no dispatch logic)
- `server/routes/parts.js` — full CRUD (no state machine)
- `server/routes/gcodes.js` — `GET` only stub
- `server/routes/jobs.js` — `GET` only stub with query filters

### Web app: Fleet screen (`client/src/pages/Fleet.jsx`)

Live printer grid:

- Polls `GET /api/printers` every 15 seconds
- Status filter chips with live counts (All / Printing / Idle / Error / Attention / Offline)
- Search filter on name, IP, group name
- Printers grouped by model in fixed order: MK4S → Core One → Core 1L → XL → Other
- Color-coded status badges per PrusaLink state

### Web app: Settings screen (`client/src/pages/Settings.jsx`)

CSV import UI:

- File picker + Import button → calls `POST /api/printers/import`
- Displays imported/skipped/flagged summary after upload
- Flagged rows with unrecognized model names show inline model dropdown + Save button
- Saving a flagged row calls `POST /api/printers` and removes the row from the flagged list

### Web app: Dashboard (`client/src/pages/Dashboard.jsx`)

Fleet summary showing six stat cards: Total, Printing, Idle, Error, Attention, Offline. Polls every 15 seconds.

### Web app: Placeholder pages

`Projects.jsx` and `Jobs.jsx` show "Coming in Phase 2" notices.

### Responsive layout (`client/src/App.jsx`)

- Desktop (>600px): fixed 180px left sidebar with nav links
- Mobile (≤600px): sidebar hidden, horizontal top nav bar displayed instead
- CSS media query in inline `<style>` block within `App.jsx`

### Dependencies added

**Root (server):**
- `express` ^4.19.2
- `better-sqlite3` ^9.6.0
- `multer` ^2.1.1 (upgraded from 1.x to patch known vulnerabilities)
- `papaparse` ^5.4.1
- `axios` ^1.7.2
- `concurrently` ^8.2.2

**Client:**
- `react` ^18.3.1
- `react-dom` ^18.3.1
- `react-router-dom` ^6.24.0
- `vite` ^5.3.1
- `@vitejs/plugin-react` ^4.3.1
