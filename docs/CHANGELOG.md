# Changelog

---

## 2026-04-08 — Phase 6B: Elegoo Centauri Carbon support

Adds full support for the Elegoo Centauri Carbon FDM printer via the SDCP WebSocket protocol (V3.0.0). Prusa printers are completely unaffected.

### New files
- `server/drivers/elegoo-centauri.js` — SDCP driver implementing `getStatus`, `uploadAndPrint`, `cancelJob`, `checkIfPrinting`. Uses the `sdcp` npm package for WebSocket connection management, message framing, and request/response correlation. Connections are kept alive in a module-level Map (one per printer ID) with `AutoReconnect = 5000` so drops are handled transparently between poll ticks.

### Modified files
- `server/drivers/index.js` — registered `'elegoo-centauri'` type → `elegoo-centauri` driver
- `server/routes/printers.js` — added `'centauri-carbon'` to `VALID_MODELS`; `api_key` is now optional for Elegoo printer types (stored as empty string); validation is brand-aware in both manual add and CSV import
- `client/src/pages/Settings.jsx` — Add Printer form now has a Brand selector (Prusa/Elegoo); model list filters to the selected brand; API Key field is hidden for Elegoo; default model auto-selects on brand change
- `client/src/pages/Fleet.jsx` — `centauri-carbon` added to `MODEL_ORDER` and `MODEL_LABELS` ("Centauri Carbon")
- `client/src/pages/Dashboard.jsx` — same model additions

### New dependency
- `sdcp` (npm) — Node.js SDCP protocol client by blakejrobinson. Handles WebSocket framing, UUID-matched request/response, and reconnection. Replaces the need for `ws` + raw SDCP implementation.

### State mapping (SDCP status codes → canonical)
| SDCP code | Canonical |
|---|---|
| 0 | IDLE |
| 1 | PRINTING |
| 2 | PAUSED |
| 3 | FINISHED (stopped — requires operator confirmation) |
| 4 | FINISHED |
| 16+ | ERROR |

---

## 2026-04-08 — Missed-finish operator confirmation

Fixed a condition where a print that completed while the server was offline was left permanently unresolved and its output was never counted.

**Root cause:** When the server restarted and the poller saw `PRINTING → IDLE`, it correctly held the printer but the scheduler never resolved the stuck `printing` job — its `statusChange` handler only reacted to `FINISHED`, `ERROR`, and `OFFLINE`. The job stayed as `printing` forever, `completed_qty` was never credited, and the operator's "✓ Set Ready" and "✗ Bad Print" buttons both silently failed (both looked only for a `finished` job).

**Design principle enforced:** The server never assumes a print succeeded or failed. Every outcome requires an explicit operator confirmation.

**Changes (`server/index.js`, `server/routes/printers.js`):**

- `POST /api/printers/:id/set-ready` now handles two cases:
  - **Normal finish** (job already `finished`): existing delta-adjustment logic, unchanged.
  - **Missed finish** (job still `printing`): operator clicking Set Ready is the success confirmation. `completed_qty` is credited now (using `confirmed_qty` if provided, otherwise `parts_per_plate`), the job is marked `finished`, and the part is closed if the target is reached.
- `POST /api/printers/:id/mark-job-failure` now also finds jobs with `status = 'printing'` as a fallback. For a missed-finish job, it marks the job `failed` but skips the qty undo (nothing was ever credited, so there is nothing to reverse).
- `GET /api/printers` — `last_parts_per_plate` subquery now falls back to the most recent `printing` job when no `finished` job exists, so the confirmed-qty input renders correctly in the Fleet UI for missed-finish printers.

---

## 2026-04-08 — Phase 6A: Prusa driver abstraction layer

Extracted all PrusaLink-specific networking code into a new `server/drivers/` layer. No behavioral changes — all 52 Prusa printers continue to work exactly as before. This is the prerequisite for adding non-Prusa brands (Elegoo Centauri Carbon in Phase 6B).

### New files
- `server/drivers/prusa.js` — PrusaLink driver implementing `getStatus`, `uploadAndPrint`, `cancelJob` (stub), `checkIfPrinting`
- `server/drivers/index.js` — driver registry; maps `printer.type` string → driver module via `getDriver(type)`

### Modified files
- `server/poller.js` — replaced direct `axios` PrusaLink call with `getDriver(printer.type).getStatus(printer)`; removed `axios` import
- `server/scheduler.js` — replaced `_uploadGCode()` with `driver.uploadAndPrint(printer, gcodeFullPath, filename)`; replaced `_checkIfPrinting()` with `driver.checkIfPrinting(printer)`; removed both private methods; removed `axios` and `FormData` imports. Scheduler still resolves the full G-code path and checks file existence before calling the driver (file-system concern stays in scheduler, not the protocol driver).

### What did NOT change
- All polling, hold logic, cold-start handling, event emission — untouched in poller.js
- Dispatch batching, ceiling math, retry logic, 409 handling — untouched in scheduler.js
- DB schema, API routes, client UI — no changes

**New dependency:** None for Phase 6A. `ws` will be added in Phase 6B for the Elegoo SDCP WebSocket driver.

---

## 2026-04-08 — Dashboard shows all parts; update.bat reliability fixes

### Dashboard active projects — show all parts (`client/src/pages/Dashboard.jsx`)
Removed the 5-part cap and "+N more parts…" truncation from the Active Projects panel. All parts for each active project are now always visible.

### update.bat reliability (`update.bat`)
Fixed several issues that caused the update script to silently exit after the `git pull` step on Windows:
- Added `cd /d %~dp0` so the script always runs from the repo root regardless of where it was launched (double-click, shortcut, etc.)
- Replaced `npm install` with `call npm install` (and same for all other npm commands). `npm` on Windows is `npm.cmd` — calling a `.cmd` from a `.bat` without the `call` keyword causes the parent script to exit cleanly when the child finishes, silently skipping all remaining steps.
- Changed server kill from `taskkill /IM node.exe` (kills all Node processes, including the bat's own npm tree) to a targeted kill by port: finds the PID listening on port 3000 via `netstat` and kills only that process.
- Server now runs in the foreground of the same window (`node server\index.js`) so logs are visible and closing the window stops the server.

**Files changed:** `client/src/pages/Dashboard.jsx`, `update.bat`

---

## 2026-04-08 — Delete part, sweep dispatch serialization

### Delete part (`server/routes/parts.js`, `client/src/pages/Projects.jsx`)
`DELETE /api/parts/:id` now performs a safe cascade:
- Returns 409 if any job for the part is `uploading` or `printing` — deletion blocked while dispatch is active.
- Deletes all non-active jobs for the part. (`jobs.part_id` is NOT NULL so nulling it out is not possible; job history has no meaning without the part context anyway.)
- Deletes all G-code records belonging to the part, including their physical files on disk (same logic as `DELETE /api/gcodes/:id`).
- Deletes the part itself; all steps run in a single transaction.

A `×` delete button is added to each part row in the project detail view. Clicking it prompts for confirmation, shows an alert on 409 (active job), and refreshes the part list on success.

### Sweep dispatch serialization (`server/scheduler.js`, `server/index.js`)
Fixed a race condition where printers set ready during an in-progress batch sweep would start uploading concurrently instead of waiting their turn.

- `JobScheduler` gains `_isSweeping` (bool) and `_pendingPrinters` (array) instance state.
- `_sweepInBatches` now acts as a serialized queue: if called while a sweep is running, the incoming printers are pushed onto `_pendingPrinters`. After each full pass through `toDispatch`, any accumulated pending printers are drained and swept next — so they form additional batches at the tail, not concurrent uploads.
- New public method `scheduleForPrinter(printer)`: if a sweep is running, defers the printer to `_pendingPrinters`; otherwise dispatches immediately via `_dispatchToPrinter`. This is the correct entry point for single-printer dispatch.
- `POST /api/printers/:id/set-ready` and `POST /api/printers/:id/recommission` now call `scheduler.scheduleForPrinter()` instead of `scheduler._dispatchToPrinter()` directly.

**Files changed:** `server/routes/parts.js`, `client/src/pages/Projects.jsx`, `server/scheduler.js`, `server/index.js`

---

## 2026-04-08 — Phase 6 multi-brand planning (no code changes)

Documented the design for adding non-Prusa printer support (Phase 6). No code was written.

### What was decided

- Phase 6 introduces a **printer driver abstraction layer** (`server/drivers/`) so the poller and scheduler are decoupled from PrusaLink specifics.
- The **Elegoo Centauri Carbon** is the first non-Prusa target. It uses SDCP (a WebSocket-based protocol) rather than REST, which is the primary reason for the abstraction.
- A **canonical state set** (`IDLE`, `PRINTING`, `FINISHED`, `PAUSED`, `ERROR`, `OFFLINE`) is introduced so all business logic above the driver layer remains brand-agnostic.
- No DB schema changes are needed — the existing `type`, `api_key`, `model`, `job_name`, `job_progress`, `job_time_remaining` columns are all reusable.
- `api_key` will be optional for Elegoo printers (SDCP has no authentication).
- G-code filename parsing already handles parse failures gracefully, so no changes needed there for Elegoo.

### New documentation

- `docs/multi-brand.md` — Phase 6 design reference (driver architecture, file change list, Elegoo SDCP notes, external links)
- `ARCHITECTURE.md` Section 13 — full Phase 6 spec including acceptance criteria
- Phase 6 added to phase tables in `ARCHITECTURE.md` Section 8 and `docs/README.md`

**Files changed:** `ARCHITECTURE.md`, `docs/README.md`, `docs/CHANGELOG.md`, `docs/multi-brand.md` (new)

---

## 2026-04-07 — Project priority ordering (9 new tests, 69 total)

### Scheduler respects project priority (`server/scheduler.js`)
Changed `ORDER BY projects.created_at ASC` to `ORDER BY projects.priority ASC, projects.created_at ASC` in the candidate dispatch query. The existing `priority INTEGER DEFAULT 0` column was already in the schema but unused. All new projects default to `0` (equal priority); `created_at` remains the tiebreaker so existing behaviour is preserved when no reorder has been done.

### `PUT /api/projects/reorder` endpoint (`server/routes/projects.js`)
New endpoint, same pattern as `PUT /api/parts/reorder`. Accepts `{ ids: [...] }` ordered array; index position becomes the `priority` value for each project. Registered before `/:id` so Express doesn't match the string `"reorder"` as an id. `GET /api/projects` now returns projects in `priority ASC, created_at ASC` order so the list view reflects dispatch order.

### Up/down arrows in project list view (`client/src/pages/Projects.jsx`)
Priority arrows (▲ / ▼) added to each project row in the list view, same visual pattern as part ordering. Arrow clicks call `moveProject()` which optimistically reorders the local state then persists via `PUT /api/projects/reorder`. Click events on the arrows stop propagation so they don't navigate into the project.

### Tests (`server/tests/projects-reorder.test.js`, 9 tests)
- `PUT /api/projects/reorder`: 400 on missing/empty ids; priority assigned by index; `GET` returns projects in the new order.
- Scheduler candidate query (run directly against in-memory DB): lower priority number wins over higher number regardless of creation order; equal priorities fall back to `created_at`; paused projects are skipped entirely; no candidate returned when all projects are paused; `parts.sort_order` tiebreaks correctly within a project.

**Files changed:** `server/scheduler.js`, `server/routes/projects.js`, `client/src/pages/Projects.jsx`, `server/tests/projects-reorder.test.js` (new)

---

## 2026-04-07 — Test suite expansion (60 tests total)

### New test files
- **`server/tests/settings.test.js`** (6 tests) — `GET /api/settings` returns defaults; `PUT /api/settings/dispatch_batch_size` saves valid values and rejects out-of-range, non-numeric, empty, and unknown-key inputs.
- **`server/tests/parts-sort.test.js`** (6 tests) — consecutive `POST /api/parts` calls assign `sort_order` 0, 1, 2 …; sort_order is independent per project; `GET` returns parts in ascending sort_order; 400 on missing fields.
- **`server/tests/projects-status.test.js`** (11 tests) — `POST /complete`: 404/400 guards, sets project to completed, closes all open parts, cancels only queued/uploading jobs for open parts (not closed parts, not finished jobs). `POST /reactivate`: 404 guard, sets project active, reopens only closed parts with remaining qty, leaves fully-done parts closed, returns `nothing_to_reopen` without changing status when all parts are at target.

### Extended `server/tests/scheduler-file.test.js` (8 new tests)
- `UPLOAD_CONFLICT` thrown when PrusaLink DELETE returns 409 (PUT never called)
- `UPLOAD_CONFLICT` thrown when PrusaLink PUT returns 409
- Non-409 PUT errors propagate with their original message (not wrapped as UPLOAD_CONFLICT)
- `_checkIfPrinting` returns true for PRINTING, true for PAUSED, false for IDLE, false on network error, and is case-insensitive

### Route refactor for testability (`server/routes/projects.js`, `server/index.js`)
`complete` and `reactivate` handlers moved from the `app.listen()` callback in `index.js` into `server/routes/projects.js`, which now accepts an optional `scheduler` argument. `index.js` mounts the projects router inside the listen callback so it has scheduler access at runtime. Tests pass `null` for scheduler — no live poller dependency.

**Files changed:** `server/tests/settings.test.js` (new), `server/tests/parts-sort.test.js` (new), `server/tests/projects-status.test.js` (new), `server/tests/scheduler-file.test.js`, `server/routes/projects.js`, `server/index.js`

---

## 2026-04-07 — Project status dropdown (Option C), force-complete, re-activate with guardrails

### Project status as a clickable badge dropdown (`client/src/pages/Projects.jsx`, `server/index.js`)
Replaced the separate Active badge + Pause/Resume/Activate action buttons with a single clickable status badge (`● Active ▾`). Clicking it opens a context menu with the valid transitions for the current state:

| State | Menu options |
|---|---|
| Draft | Activate |
| Active | Pause project · Mark complete |
| Paused | Resume project · Mark complete |
| Completed | Re-activate |

"Mark complete" is styled in red to signal it is a consequential action and is separated from the primary option by a divider line.

### Force-complete a project (`POST /api/projects/:id/complete`, `server/index.js`)
Operators can now mark a project complete before all parts hit their target qty. The endpoint closes all open parts and cancels any `queued` or `uploading` jobs for those parts. A confirmation dialog shows how many open parts will be affected before proceeding.

### Re-activate a completed project with guardrails (`POST /api/projects/:id/reactivate`, `server/index.js`)
Completed projects can be re-activated. The endpoint finds closed parts where `completed_qty < target_qty` and reopens them, then sets the project to `active` and sweeps idle printers. Guardrail: if all parts are already at or above their target qty (nothing to reopen), the server returns `{ nothing_to_reopen: true }` and the UI shows an informational alert directing the operator to adjust part quantities first.

**Files changed:** `client/src/pages/Projects.jsx`, `server/index.js`

---

## 2026-04-07 — Dispatch hardening, 409 handling, configurable batch size, add-printer UI, part sort fix

### Configurable dispatch batch size (`server/routes/settings.js`, `server/db.js`, `server/scheduler.js`, `client/src/pages/Settings.jsx`)
Added a `settings` table (key/value) with a `dispatch_batch_size` key (default 10). A new `GET/PUT /api/settings` endpoint exposes it. `_sweepInBatches` reads the value from the DB at sweep time so changes take effect without a server restart. A "Dispatch Settings" panel in the Settings UI lets operators adjust the value (1–100) and save it live.

### 409 Conflict handling during upload (`server/scheduler.js`)
PrusaLink returns HTTP 409 when a file transfer is already in progress (e.g. a previous upload attempt timed out on our side but was still running on the printer). The scheduler now:
- Throws `UPLOAD_CONFLICT` (instead of a generic error) when the pre-upload DELETE or the PUT itself returns 409.
- Waits **60 seconds** before retrying on `UPLOAD_CONFLICT` vs the usual 5 seconds for other transient errors, giving the in-progress transfer time to complete.

### Post-failure printer status check (`server/scheduler.js`)
After exhausting all upload retries, the scheduler now calls PrusaLink directly (`_checkIfPrinting`) before marking the job as `failed`. If the printer is already `PRINTING` or `PAUSED` — meaning the file transfer succeeded but our HTTP request timed out — the job is recovered to `printing` status instead of being marked failed. This prevents the "3 failed jobs but still printing" scenario and ensures the Fleet view can show the correct filename on the printer badge.

### Upload timeout increased 2 min → 5 min; batch wait timeout increased 3 min → 10 min (`server/scheduler.js`)
Large files on congested farm networks can take several minutes to transfer. The axios upload timeout is now 300 s (was 120 s) and `_waitForBatch` gives up after 600 s (was 180 s), so the next batch does not fire prematurely while slow printers are still receiving files.

### Add single printer from Settings UI (`client/src/pages/Settings.jsx`)
A new "Add Printer" form in Settings lets operators add a printer by filling in Name, IP, API Key, Model, and optional Group — no CSV required. Posts to the existing `POST /api/printers` endpoint.

### New part added at bottom of project (`server/routes/parts.js`)
When a part is created, `sort_order` is now set to `MAX(sort_order) + 1` for that project instead of defaulting to 0. New parts always land at the lowest-priority position; operators can drag them up via the existing reorder UI.

**Files changed:** `server/db.js`, `server/routes/settings.js` (new), `server/routes/parts.js`, `server/scheduler.js`, `server/index.js`, `client/src/pages/Settings.jsx`

---

## 2026-04-06 — TV Command Center Dashboard

### New Dashboard page (`client/src/pages/Dashboard.jsx`, `server/routes/dashboard.js`)
Replaced the stub Dashboard with a full TV-optimized command center display. Designed to be shown on a large monitor or TV so operators can read fleet status at a glance from across the room.

**New `GET /api/dashboard` endpoint** returns all required data in one call: fleet stats, full printer list, active projects with parts, and recent activity (last 12 jobs). Single-endpoint design keeps the client simple and avoids N+1 fetches.

**Dashboard sections:**
- **Header:** "PRINT FARM / Command Center" branding with a blue accent bar, fleet utilization % in the center, live HH:MM:SS clock (ticks every second client-side), and a ⛶ TV Mode button that triggers browser fullscreen — the sidebar disappears and the dashboard fills the screen
- **4 hero stat cards:** Printing (blue), Idle (gray), Awaiting sign-off (green), Parts Today rolling 24h (purple) — all in large tabular-numeral figures
- **Fleet grid:** every active printer as a 54×44px color-coded cell, grouped by model row (MK4, MK4S, Core One, Core 1L, XL). Each row shows a per-row status summary badge strip (e.g. "9 PRINT · 2 AWAIT"). Color legend at the bottom. Held/awaiting printers render green regardless of underlying status
- **Active Projects:** all active projects with per-part progress bars that turn green at ≥75% completion, completion counts (`671 / 1000`), and DONE badges on closed parts. Shows up to 5 parts per project with overflow count
- **Recent Activity:** last 12 finished/failed jobs with green ✓ / red ✗, part name, qty, printer name in blue monospace, and relative timestamp ("5m ago")

**Parts Today** uses a rolling 24-hour window (not calendar-day), computed as `SUM(parts_per_plate)` on `finished` jobs with `finished_at >= now - 86400000`.

Poll rate matches the Fleet page (15 seconds).

**Files changed:** `server/routes/dashboard.js` (new), `server/index.js`, `client/src/pages/Dashboard.jsx`

---

## 2026-04-06 — Confirmed good-qty input on FINISHED printer cards

### Partial plate failure tracking (`client/src/pages/Fleet.jsx`, `server/index.js`, `server/routes/printers.js`)
When a print finishes, operators sometimes find that one of several parts on a bed failed while the rest are good (e.g. 24 of 25). Previously the only options were "full credit" (Set Ready) or "full failure" (Bad Print + decommission). Now there is a middle path.

**UI change:** a small `Good: [24] / 25` number input appears on FINISHED printer cards, pre-filled with `parts_per_plate` from the last finished job. The operator adjusts it before clicking ✓ Set Ready.

**Server change:** `POST /api/printers/:id/set-ready` now accepts an optional `confirmed_qty` body field. If provided and different from the job's `parts_per_plate`, the delta is applied to `completed_qty` (e.g. −1 for 24/25). If the auto-credit had closed the part, it is reopened.

**Batch safety:** the batch "Set Ready (N)" action always credits full `parts_per_plate`. If an operator reduces the confirmed qty below the plate count, the Include checkbox is hidden and the printer is auto-removed from the batch selection — it must be confirmed individually.

`GET /api/printers` now includes a `last_parts_per_plate` field (correlated subquery on the most recent finished job) so the Fleet UI can pre-fill the input without an extra fetch.

**Files changed:** `server/routes/printers.js`, `server/index.js`, `client/src/pages/Fleet.jsx`

---

## 2026-04-06 — Bugfix: parts reorder route shadowed by /:id handler

### `PUT /api/parts/reorder` always returned 404 (`server/routes/parts.js`)
Express matches routes in registration order. `PUT /:id` was registered before `PUT /reorder`, so the string `"reorder"` was matched as an ID, the part lookup returned 404, and the reorder never saved. Fixed by moving the `/reorder` route above `/:id`.

**Files changed:** `server/routes/parts.js`

---

## 2026-04-02 — Bugfixes: cross-platform filepath, gcode delete FK, file input re-select

### Cross-platform gcode path resolution (`server/scheduler.js`, `server/routes/gcodes.js`)
Both the scheduler and the delete route previously used `path.basename(filepath)` to strip the directory from stored paths. `path.basename` only recognises the current OS's separator — on Windows it silently fails to strip a Mac absolute path (e.g. `/Users/...`), and vice versa. Changed to `filepath.split(/[\\/]/).pop()` which handles both forward and backward slashes regardless of platform. Fixes "file cannot be found" errors on the Windows farm machine when the DB contained paths stored on a Mac dev machine.

### Gcode delete: FK constraint + active job guard (`server/routes/gcodes.js`, `server/db.js`)
`DELETE /api/gcodes/:id` was failing with `SQLiteError: FOREIGN KEY constraint failed` when any job (even a finished one) referenced the gcode. Two changes:
- `jobs.gcode_id` migrated from `NOT NULL` to nullable via a one-time schema migration in `db.js` (uses `PRAGMA table_info` to detect whether migration has already run).
- Delete route now checks for active jobs (`queued`/`uploading`/`printing`) first and returns `409` if any exist. For terminal jobs (`finished`/`failed`/`cancelled`) it nulls out `gcode_id` before deleting, preserving job history.

### File input re-select after upload (`client/src/pages/Projects.jsx`)
After uploading a G-code file, the React state reset (`setFile(null)`) but the underlying `<input type="file">` DOM element retained its value. If the user deleted the gcode and tried to re-upload the same file, the browser saw no change and silently skipped the `onChange` event. Fixed by adding a `ref` to the input and resetting `fileInputRef.current.value = ''` on successful upload.

### Tests (`server/tests/gcodes.test.js`, `server/tests/scheduler-file.test.js`)
- 5 new DELETE route tests: 404, success + file removed, missing file graceful, old absolute filepath resolved correctly, active job 409, terminal job FK nulling.
- 6 new scheduler file-handling tests: GCODE_MISSING thrown correctly, bare filename, old Unix absolute path, old Windows absolute path (key test for the cross-platform fix), missing basename.

**Files changed:** `server/scheduler.js`, `server/routes/gcodes.js`, `server/db.js`, `client/src/pages/Projects.jsx`, `server/tests/gcodes.test.js`, `server/tests/scheduler-file.test.js` (new)

---

## 2026-04-02 — Portable gcode paths, server alerts, startup sweep safety

### Portable gcode filepath (`server/routes/gcodes.js`, `server/scheduler.js`, `server/routes/backup.js`)
`filepath` in the `gcodes` table now stores only the filename (e.g. `1714903214387_4x Left Bracket.bgcode`), not an absolute path. The server resolves the full path at runtime using its own `server/gcode/` directory. Previously, absolute paths were stored — if the DB was copied to a machine with a different username or folder structure, the scheduler would fail to find the file and crash the server process.

The backup/restore flow already rewrote paths on restore, but that rewrite is now a no-op (basename only). Existing installations with absolute paths in the DB should run a one-time SQL fix before upgrading.

### Server alerts (`server/notifications.js`, `server/index.js`, `client/src/pages/Settings.jsx`)
Added an in-memory notification store that the scheduler writes to when it encounters a recoverable error. Currently used for missing G-code files: instead of crashing, the scheduler marks the job failed, re-holds the printer, and pushes an alert with the filename, part name, and project name.

- `GET /api/notifications` — list all alerts, newest first
- `DELETE /api/notifications/:id` — dismiss an alert
- Settings page shows a "Server Alerts" section (red border, polls every 15s) when alerts are present. Each alert is dismissible with ×.
- Missing-file errors skip retries (retrying won't fix a missing file).
- Notifications are lost on server restart; unresolved issues will surface again naturally on the next dispatch attempt.

### Startup sweep deferred until first poll (`server/poller.js`, `server/index.js`)
The startup `sweepIdlePrinters()` call is now deferred until after the first poller tick completes (`pollComplete` event). Previously, the sweep ran immediately on startup using stale DB state — if a printer started printing while the server was down, the DB still showed it as IDLE and the scheduler would attempt a second dispatch. The sweep now works from live printer state.

### Windows update script (`update.bat`)
Added `update.bat` to the project root. Double-click to pull latest code, install dependencies, rebuild the client, and restart PM2 — with error checking at each step.

**Files changed:** `server/routes/gcodes.js`, `server/scheduler.js`, `server/routes/backup.js`, `server/notifications.js` (new), `server/index.js`, `server/poller.js`, `client/src/pages/Settings.jsx`, `update.bat` (new)

---

## 2026-04-02 — Network access + Farm Backup/Restore

### Production static serving (`server/index.js`, `package.json`)
Express now serves the built React client from `client/dist/` on port 3000, with a SPA catch-all for client-side routes. This means the app can run headlessly on a dedicated machine (e.g. the Windows print farm laptop) and be accessed from any browser on the LAN at `http://[server-ip]:3000` — no Vite dev server required.

New scripts:
- `npm run build` — builds the React client into `client/dist/`
- `npm start` — starts Express only (production mode)

### Farm Backup/Restore (`server/routes/backup.js`, `client/src/pages/Settings.jsx`)
Added full farm export/import as a backup and migration tool.

- `GET /api/backup` — exports all 5 DB tables plus gcode file contents (base64) as a downloadable JSON bundle.
- `POST /api/backup/restore` — accepts the JSON bundle, clears all DB data, reinserts with original IDs (preserving FK relationships), writes gcode files to the local `server/gcode/` directory with corrected `filepath` values for the current machine. Auto-increment sequences are synced after restore.

UI: "Farm Backup" section in Settings — **Export Farm** button (triggers download) and **Restore Farm** file picker. Restore requires a confirmation prompt and shows a summary of restored counts on success.

**Files changed:** `server/index.js`, `server/routes/backup.js` (new), `package.json`, `client/src/pages/Settings.jsx`

---

## 2026-04-02 — Fleet UI: poll timer indicator

### Poll timer (`client/src/pages/Fleet.jsx`)
Added a small SVG circular progress indicator next to the "Fleet" heading. The arc fills over 15 seconds (matching the poller interval) and resets when fresh data lands — so it reflects actual data freshness, not a fixed countdown. Implemented as a `PollTimer` component driven by `lastPolled` state (set to `Date.now()` on each successful `fetchPrinters` response) and a 100ms `setInterval` for smooth animation. Hovering shows "Last polled Xs ago". Arc holds at full briefly while the request is in-flight, then snaps back to empty on response — natural feel with no perceived jank.

**Files changed:** `client/src/pages/Fleet.jsx`

---

## 2026-04-02 — Fleet UI: STOPPED status display and unknown status catch-all

### STOPPED status (`client/src/pages/Fleet.jsx`)
Added `STOPPED` to `STATUS_COLORS` (orange, `#fb923c`) so printers in a manually-stopped state show a distinct badge instead of falling back to "Unknown". A "Clear on printer screen to continue" note renders on the card while the printer is in STOPPED state — no action buttons are shown since the operator must physically interact with the machine. Once cleared, the printer transitions to IDLE with `is_held = 1` (set by the existing poller `SAFE_STATES` logic) and the normal Set Ready / Bad Print confirmation flow takes over. Poller required no changes.

### STOPPED filter chip (`client/src/pages/Fleet.jsx`)
Added a dedicated Stopped filter chip in the Fleet filter bar.

### Dynamic unknown status catch-all (`client/src/pages/Fleet.jsx`)
Added `KNOWN_STATUSES` (a `Set` of all keys in `STATUS_COLORS`). An "Unknown" filter chip renders only when at least one printer has a status not in that set, allowing operators to isolate printers reporting states not yet recognized by the app. The chip count and filter logic both use `!KNOWN_STATUSES.has(p.status)` so any future Prusa firmware state is caught automatically.

**Files changed:** `client/src/pages/Fleet.jsx`

---

## 2026-04-01 — Inline rename for projects and parts

### Project rename (`client/src/pages/Projects.jsx`)
A ✎ pencil button appears next to the project name in the detail view header. Clicking it replaces the `<h1>` with an inline text input pre-filled with the current name. Enter or blur saves; Escape cancels without saving. Calls the existing `PUT /api/projects/:id { name }` endpoint, then refreshes both the detail view and the project list so the new name is reflected everywhere immediately.

### Part rename (`client/src/pages/Projects.jsx` — `PartDetailsPanel`)
A new "Part Name" section at the top of the expanded Details panel shows the current part name with a ✎ pencil button. Same interaction model as project rename (Enter/blur saves, Escape cancels) → `PUT /api/parts/:id { name }`. The pencil is intentionally not shown on the main part row — the row remains fully read-only; all editing requires opening the Details panel first.

### Tests (`server/tests/rename.test.js`)
8 new tests covering both endpoints:
- Rename succeeds and the new name is returned in the response
- Updated name persists and is returned on a subsequent GET
- Omitting `name` from a PUT body leaves the existing name intact (COALESCE behavior)
- `PUT` with an unknown ID returns 404

**Files changed:** `client/src/pages/Projects.jsx`, `server/tests/rename.test.js`

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
