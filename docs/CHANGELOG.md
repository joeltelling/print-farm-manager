# Changelog

---

## 2026-07-04 — Fix: adding a part to a completed project couldn't be reactivated

Reported: adding a new part to a project that had already completed left the project stuck — clicking Re-activate returned "All parts are at target qty — adjust quantities first" even though the new part clearly had remaining qty (0/1).

Root cause: `POST /api/parts` never checked the parent project's status when inserting a new part, unlike `PUT /api/parts/:id` which already reactivates a completed project when a part transitions from closed back to open. A brand-new part always starts `open` with `completed_qty = 0`, so it never goes through that transition — the project was left `completed` with a genuinely unmet part sitting in it. `POST /api/projects/:id/reactivate` then only checked for *closed* parts with remaining qty, so it saw nothing eligible and reported `nothing_to_reopen`.

Fixed both ends: `POST /api/parts` now reactivates a `completed` parent project the same way the PUT handler does, and `POST /api/projects/:id/reactivate` now also counts already-open parts with remaining qty (not just closed ones) so it can't wrongly report nothing-to-reopen in any similar situation.

**Follow-up (PR review, round 1):** the initial version reactivated the project but never triggered a dispatch sweep — `POST /api/projects/:id/reactivate` calls `scheduler.sweepIdlePrinters()` after changing project status, but `POST /api/parts` didn't, so a printer already idle when the new part was added would sit unused until some later manual dispatch or unrelated status change. `parts.js` now takes an optional `scheduler` argument (same `(db, scheduler = null)` pattern already used by `projects.js`) and calls `sweepIdlePrinters()` right after reactivating. Since `scheduler` is only constructed inside the `app.listen()` callback, `parts.js` is now mounted there too (alongside `projects.js`) instead of at module load time.

**Follow-up (PR review, round 2):** two more sweep gaps in the same family:
- A brand-new part's sweep from `POST /api/parts` fires before any G-code exists for it — the scheduler's candidate query joins on `gcodes`, so a part with no G-code yet is never actually dispatchable regardless of the sweep. The real trigger point is the G-code upload, not the part creation. `gcodes.js` now also takes an optional `scheduler` argument and sweeps after a successful `POST /upload`, so an idle printer picks up the part as soon as it has a matching G-code rather than waiting for a manual dispatch or later printer status transition. `gcodes.js` is now mounted inside `app.listen()` too.
- `PUT /api/parts/:id` has its own, older reactivation branch (raising `target_qty` above `completed_qty` flips a `closed` part back to `open`, and reopens a `completed` parent project) that had the exact same sweep gap the first round fixed for `POST /api/parts`. It now calls `scheduler.sweepIdlePrinters()` too.

Verified live against a running instance for all three trigger points: adding a part, uploading its first G-code, and reopening an existing closed part via raised `target_qty` — each produces a fresh `[scheduler] Sweeping N eligible printer(s)...` log line immediately, distinct from the periodic 15s poll-driven sweep.

**Follow-up (PR review, round 3):**
- The Add Part flow in the client (`addPart()` in `Projects.jsx`) only called `fetchDetail(selectedId)` after `POST /api/parts`, not `fetchProjects()` — unlike every other status-changing action in this file, which refreshes both. Since adding a part can now flip the parent project from `completed` back to `active` server-side, the cached projects list kept showing "Completed" (with the Re-activate action still available) until some unrelated refresh happened. Fixed to refresh both, matching the existing pattern.
- The `POST /api/parts` wording in `docs/api.md` and the route comment in `parts.js` said the new part gets "picked up" / is "schedulable immediately" — true of the *project* reactivation, not the *part*, since (per round 2) the scheduler can't dispatch a part with no G-code yet. Reworded both to say the project reactivates immediately, but the part itself only becomes dispatchable once G-code is uploaded for it. The `PUT /api/parts/:id` reopen-existing-part wording was left as-is — that part necessarily already has G-code from before it was closed, so an immediate sweep genuinely can dispatch it.

**Follow-up (re-audit of the whole flow):** re-traced the client end to end and found the identical list-staleness bug on a second, sibling code path: `saveQtys()` (the Details panel's Have/Need editor, used to raise `target_qty` and reopen a closed part) shares the same `onRefresh` prop as `addPart()`, and that prop only ever called `fetchDetail`, never `fetchProjects` — same gap, just reached via a different UI action. Fixed the shared `onRefresh` to refresh both. Also found `docs/web-app.md`'s Projects page section was stale independent of this PR — it described the header status control as a single "context-sensitive action button" and claimed `completed` has "no button", when it's actually a dropdown (`STATUS_MENU` in `Projects.jsx`) with a `Re-activate` option for `completed`, plus `Delete project`/`Mark complete` options the doc didn't mention at all for the other statuses. Corrected, and expanded the Quantities/Upload G-code/Add Part descriptions to reflect the reactivation and sweep behavior from all three rounds above.

Verified all three trigger points again, this time driven through the actual browser UI rather than the API directly: adding a part, uploading its first G-code, and raising `target_qty` via the Details panel's Save button on a `completed` project. Each correctly reactivated the project, produced a fresh sweep log line, and updated the projects list immediately without a manual reload.

### Changes
- `server/routes/parts.js`: `POST /` reactivates the parent project if it's `completed` and sweeps; `PUT /:id` now also sweeps when its existing reactivation branch fires; reworded the `POST /` comment for accuracy.
- `server/routes/gcodes.js`: `POST /upload` sweeps for idle printers after a successful upload, via an optional `scheduler` argument.
- `server/index.js`: `partsRouter` and `gcodesRouter` moved from module-load-time instantiation to inside the `app.listen()` callback, passed `scheduler` like `projectsRouter` already was.
- `server/routes/projects.js`: `POST /:id/reactivate` also checks for open parts with `completed_qty < target_qty`.
- `client/src/pages/Projects.jsx`: `addPart()` refreshes `fetchProjects()` alongside `fetchDetail()`; `PartDetailsPanel`'s shared `onRefresh` prop (used by `saveQtys()`, `saveName()`, `deleteGcode()`) does too.
- `server/tests/parts-sort.test.js`, `server/tests/projects-status.test.js`: added coverage for the reactivation logic.
- `server/tests/parts-reactivate-sweep.test.js` (new, extended): covers `sweepIdlePrinters()` for both `POST /` and `PUT /:id` in `parts.js`.
- `server/tests/gcodes-upload-sweep.test.js` (new): covers `sweepIdlePrinters()` for `POST /api/gcodes/upload`.
- `docs/server.md`: documented the `(db, scheduler)` factory pattern (now covering `gcodes.js` too), why these routers are mounted inside `app.listen()`, and the module-scoped-router testing gotcha.
- `docs/api.md`: documented the reactivation/sweep behavior on `POST /api/parts`, `PUT /api/parts/:id`, and `POST /api/gcodes/upload`; corrected the `POST /api/parts` wording in round 3.
- `docs/web-app.md`: corrected the Projects page header/status-dropdown description (was stale independent of this PR) and expanded the Quantities/Upload G-code/Add Part descriptions to match the reactivation and sweep behavior.
## 2026-07-06 - update.bat: discard package-lock.json drift before pulling

`update.bat` runs `npm install`, which rewrites `package-lock.json` when the farm machine's npm version differs from the one that generated the lockfile. That local drift blocked `git pull` ("Your local changes ... would be overwritten by merge") the first time the lockfile changed upstream (the 2026-07-03 js-yaml bump). Hit on a real farm machine 2026-07-06.

### Changes
- `update.bat`: step 1 now runs `git checkout -- package-lock.json client/package-lock.json` before `git pull`. The farm checkout is a deploy target with no intentional local changes, so discarding lockfile drift is always safe there.
- `docs/installation.md`: documented the discard step and the manual `git restore package-lock.json` recovery for older copies of the script.

---

## 2026-07-04 — Farm Backup: fix missing printer models, filament library, and settings

`GET /api/backup` never included `printer_models`, `filament_types`, `filament_colors`, or `settings` — only `printers`, `projects`, `parts`, `gcodes`, `jobs`, and `printer_events`. Restoring a backup brought printers back with a `model` referencing a `printer_models` row that no longer existed, so those printers couldn't be edited or matched by new Add Printer submissions until the operator manually re-added every model (and re-entered the farm's filament library and farm name/dispatch batch size) by hand.

Fixed by adding all four to both export and restore. Restore deletes/reinserts `filament_colors` before `filament_types` (FK on `type_id`) and `printer_models` before `printers` (no enforced FK there, but restoring the models a printer's `model` column names first matches the natural order). Each of the four is only cleared and rewritten if that key is present in the uploaded backup, so restoring an older backup (from before this fix) can't wipe the farm's current printer models/filament library/settings with nothing to restore them from — it just leaves them alone.

The Settings page also now refreshes printer models, filament lists, farm name, and dispatch batch size immediately after a successful restore instead of requiring a manual page reload (same live-update approach as the recent farm name fix).

### Changes
- `server/routes/backup.js`: export/restore now include `printer_models`, `filament_types`, `filament_colors`, `settings`; guarded restore for backward compatibility with older backup files; response/log now report counts for all restored tables.
- `client/src/pages/Settings.jsx`: added restore-result chips for the three new counts; refetches models/filament lists/settings after a successful restore.
- `docs/api.md`: corrected the backup endpoint docs, which previously described the buggy behavior ("all 5 tables") as correct.

**Follow-up (PR review):** the restore side used a hand-maintained column list per table (`printers`, `projects`, `parts`, `gcodes`), which had drifted out of sync with migrations added to `server/db.js` over time — reviewer reproduced it directly: a backup containing Bambu/CC2 `serial_number`, printer `loaded_material`/`loaded_color`, project `required_material`/`required_color`, and gcode `ams_slot`/`material_grams`/`allowed_groups`/`required_material`/`required_color` restored successfully but silently dropped every one of those fields to null/default. A disaster-recovery restore could leave Bambu/CC2 printers unable to connect and lose the material/group constraints that keep jobs off the wrong machines.

Fixed by deriving each restore INSERT's column list from `PRAGMA table_info(table)` instead of a hardcoded list (`makeInserter()` in `backup.js`) — this makes the whole bug class structurally impossible going forward: a column a future migration adds is picked up automatically, with nothing in `backup.js` to remember to update. A property missing from a given row (an older backup predating a newer column) binds as `null` rather than throwing.

Added `server/tests/backup-restore.test.js` per the reviewer's request for a test that would fail if a migrated column were dropped again: seeds every one of the previously-affected columns, wipes them from the live DB, restores from a real export, and asserts they all come back — plus a backward-compatibility case confirming an older backup missing a since-added column restores as `null` instead of throwing. Also verified live against a running instance with the reviewer's exact repro shape (Bambu printer with serial number/loaded material/color, targeted project, targeted+AMS gcode) — full round trip, nothing dropped.

### Changes (follow-up)
- `server/routes/backup.js`: added `makeInserter()`, replaced all hardcoded restore `INSERT` column lists with it.
- `server/tests/backup-restore.test.js` (new): column round-trip regression coverage.
- `docs/api.md`: documented that restore now derives its column list from the live schema.

**Follow-up 2 (PR review, second round):**
- **[P1] Path traversal in `gcode_files` restore.** Restore wrote each `backup.gcode_files` key straight through `path.join(GCODE_DIR, key)` with no validation — reviewer showed a key like `../../server/poller.js` resolves outside `server/gcode/`, so a crafted backup could overwrite arbitrary files the server process can write to instead of only restoring gcode files. Fixed by rejecting any key that isn't a bare filename (contains `/`, `\`, or is `.`/`..`) with `400` before writing anything to disk.
- **[P2] `makeInserter()` bound missing columns as an explicit `NULL`.** That's fine for nullable columns but breaks `NOT NULL DEFAULT` columns like `parts.sort_order` — a backup row missing that column threw `NOT NULL constraint failed` instead of restoring with the default `0`, contradicting the older-backup compatibility path added in the first follow-up. Fixed by having `makeInserter()` take the actual rows being restored and omit any column absent from all of them from the generated `INSERT`, letting SQLite apply the column's own default rather than binding `null`.

### Changes (follow-up 2)
- `server/routes/backup.js`: `gcode_files` keys are validated as bare filenames before any write; `makeInserter()` now takes the table's rows and only includes columns present in the data, so columns missing from an older backup are left for SQLite's schema default instead of bound as `null`.
- `server/tests/backup-restore.test.js`: added coverage for a missing `NOT NULL DEFAULT` column (`parts.sort_order`) restoring to its default instead of throwing, and for `gcode_files` keys attempting path traversal (`../../server/index.js`, bare `..`) being rejected with `400` and never reaching `fs.writeFileSync`.
- `docs/api.md`: documented the `gcode_files` filename validation and the schema-default fallback for columns missing from a backup.

**Follow-up 3 (PR review, third round):**
- **[P2] No coverage for the config tables this PR added to backup/restore.** The regression suite exercised migrated columns on `printers`/`projects`/`parts`/`gcodes`, the missing `NOT NULL DEFAULT` case, and `gcode_files` validation, but never seeded or asserted `printer_models`/`filament_types`/`filament_colors`/`settings` — the four tables this PR originally added. Neither the round trip (including the `filament_colors` → `filament_types` FK order) nor the older-backup compatibility guard (missing keys must leave existing config alone) was tested for them.

### Changes (follow-up 3)
- `server/tests/backup-restore.test.js`: seeded two filament types/colors (not one) plus a printer model and two settings rows in `beforeEach`; added a describe block covering (1) export includes all four tables, (2) restore round-trips them and each restored `filament_colors` row resolves to the *correct* `filament_types` row by name (not just any row satisfying the FK), and (3) an older backup missing all four keys leaves the farm's current printer models/filament library/settings untouched. The round-trip case mutates the existing filament rows rather than deleting them first, so restore's own internal delete-then-insert runs against still-linked rows — verified by temporarily reversing the delete order in `backup.js` and confirming the test fails (500, FK violation) before reverting.
## 2026-07-06 - Driver authoring guide for third-party connector contributors

With the repo now public, printer manufacturers and community members may want to contribute connectors for new brands. The driver contract was previously folklore: spread across `multi-brand.md` brand notes, driver file comments, and hard-won lessons in this changelog. New `docs/driver-authoring.md` turns it into a spec someone outside the project can build against.

Covers: the four-function driver interface with exact return shapes and error contracts (`UPLOAD_CONFLICT`, never-throw `getStatus`, resolve-only-when-started `uploadAndPrint`), the `printer` row fields drivers may use, the canonical status table with what the poller/scheduler do on each transition, the no-double-credit rules for `FINISHED` (reconnect flapping, cold start, STOPPED vs ERROR disambiguation, synthesized FINISHED), the stateless vs persistent-connection patterns with named reference drivers, a six-step registration checklist (including every `Settings.jsx` touch point), a real-hardware test matrix, and dev-without-a-fleet tips.

No code changes. `docs/README.md` gained an index row; `CONTRIBUTING.md`'s Printer Drivers section now links to the guide.

---

## 2026-07-04 — CI: gate Docker publishing on the test suite

`.github/workflows/docker-publish.yml` could previously publish an image even if `server/tests/` was failing — nothing ran the suite. Added a `test` job (`npm ci` + `npm test` on `ubuntu-24.04`) that both `build` and the PR-only `pr_test_build` job now declare as a dependency (`needs: test`), so a red test suite blocks any image build, published or not. `merge` remains gated transitively via `needs: build`.

### Changes
- `.github/workflows/docker-publish.yml`: added the `test` job; `build` and `pr_test_build` now `needs: test`.
- `docs/docker-publish.md`: documented the test gate and updated the job breakdown.

---

## 2026-07-03 — README + install guide caught up to the OctoPrint connector

PR #4 added the OctoPrint driver with full docs coverage in `multi-brand.md` but did not touch the two user-facing entry docs. Synced them: README gains an OctoPrint row in Supported Printers, `octoprint` in the CSV `type` list, corrected `api_key` requirements, and the full six-driver list in Project Structure (`elegoo-centauri2.js` and `octoprint.js` were missing); `docs/installation.md` credential table gains an OctoPrint row (API key from **Settings → API**, port included in the IP field, e.g. `:5000`).

---

## 2026-07-03 — Remove dead HTTP-pull upload code from the CC2 path

The Elegoo Centauri Carbon 2 driver originally uploaded files by having the printer pull them from an HTTP URL served by the app (MQTT method 1057). That design was replaced by the chunked HTTP PUT push before the driver shipped, but two remnants survived: `getLanIp()` in `server/drivers/elegoo-centauri2.js` (never called) and the `GET /api/gcode-download/:filename` endpoint in `server/index.js` (nothing constructed URLs to it). The endpoint was a live unauthenticated file-download route kept for a design that no longer exists — removed as attack-surface cleanup. Also corrected the driver's header comment, which still described the pull design.

### Changes
- `server/index.js`: removed the `/api/gcode-download/:filename` route.
- `server/drivers/elegoo-centauri2.js`: removed `getLanIp()` and the `os` require; header comment now describes the chunked PUT upload.

---

## 2026-07-03 — OctoPrint connector (Phase 6D)

Added OctoPrint as a supported "Add Printer" brand, following the driver abstraction from Phase 6A. Covers any printer managed by OctoPrint/OctoPi (not brand-specific — a Prusa, Ender, or Voron all look the same to the farm manager once behind OctoPrint's REST API).

`server/drivers/octoprint.js` implements the shared driver interface (`getStatus`, `uploadAndPrint`, `cancelJob`, `checkIfPrinting`) against OctoPrint's REST API (`X-Api-Key` auth, plain HTTP polling — same stateless pattern as `prusa.js`/`klipper.js`, no persistent connection needed):

- Status: `GET /api/printer` (`state.flags`) + `GET /api/job` (`progress.completion`, `progress.printTimeLeft`, `job.file.name`).
- Upload: `POST /api/files/local` (multipart) with `select=true` and `print=true` — uploads and starts the print in a single call. A 409 (file mid-print) maps to `UPLOAD_CONFLICT`, same retry/backoff handling as Prusa.
- Cancel: `POST /api/job` `{"command":"cancel"}` — actually implemented, unlike PrusaLink's stub, since OctoPrint exposes a working cancel endpoint.
- FINISHED detection required a heuristic: OctoPrint doesn't hold a persistent "just completed" state like PrusaLink/Moonraker, so the driver infers it from not-printing + a loaded job file + `completion === 100`. Documented in `docs/multi-brand.md`.
- No dedicated port field added — OctoPrint commonly runs on `:5000` rather than `:80`, so the operator includes the port in the existing `ip` field (e.g. `192.168.1.50:5000`), same as Prusa's `ip` field already supports.

### Changes
- `server/drivers/octoprint.js` (new): driver implementation.
- `server/drivers/index.js`: registered `'octoprint'` in the driver `LOADERS` map.
- `server/routes/models.js`: added `'octoprint'` to `VALID_CONNECTORS`.
- `client/src/pages/Settings.jsx`: added OctoPrint to the brand dropdown, credential help text, and name placeholder. No change needed to `NO_API_KEY_TYPES` — OctoPrint requires a real API key.
- `server/tests/octoprint-driver.test.js` (new): 21 tests covering status mapping (including the FINISHED heuristic), upload conflict handling, cancel, and driver registry lookup.
- `docs/multi-brand.md`, `docs/README.md`: documented the new connector.

No DB schema changes and no changes to `Fleet.jsx`/`Dashboard.jsx` — both already derive brand/model display purely from the `printer_models` table (`connector` + `model_id`), which is populated via the existing Settings → Printer Models UI. No new npm dependencies — reuses `axios` and `form-data`, already present for the Klipper driver.

Verified in a `node:22-bookworm-slim` container (matching the project's Docker base image) rather than the host: full server test suite passes (378 tests, including the 21 new OctoPrint driver tests).

---

## 2026-07-03 — Docker production deployment

Added a container-based path to run the app in production, as an alternative to the bare-metal + PM2 setup. Requested to simplify deployment (no host Node.js/build-tooling install, consistent environment across machines) without changing any Phase 1 conventions — no DB migration system was introduced, and the SQLite/`better-sqlite3` synchronous-API convention is unaffected since the container just runs the existing `server/index.js` entry point.

Three-stage multi-stage `Dockerfile`:
1. `server-deps` — installs root `node_modules` with dev dependencies present so the `postinstall` script (`patch-package`) can apply `patches/sdcp+0.5.4.patch`; then `npm prune --omit=dev` drops `jest`/`supertest`/`patch-package` from what gets copied forward. Base image `node:22-bookworm-slim` matches the README's Node 22 LTS requirement; `python3 make g++` installed for `better-sqlite3`'s native build.
2. `client-build` — `npm ci` + `npm run build` for the Vite client, same as the existing bare-metal `npm run build` step.
3. `runtime` — copies the pruned `node_modules`, `server/`, and the built `client/dist` into a clean `node:22-bookworm-slim` image; no build tools in the final image. `server/data` (SQLite DB + hourly backups) and `server/gcode` (uploaded G-code) are created as mount points for volumes so they persist across container rebuilds.

`docker-compose.yml` wires up named volumes `farm-data` and `farm-gcode` for those two directories, publishes port 3000, and sets `restart: unless-stopped`.

`.dockerignore` excludes `node_modules`, build output, `server/data`/`server/gcode` (must come from volumes, not the image), git/editor/OS files, and docs/project-meta files not needed at runtime.

Verified locally: `docker compose up -d --build` builds cleanly, `/api/health` and the served client both return 200, and `jest`/`supertest`/`patch-package` are absent from the running container's `node_modules` while the `sdcp` patch is present.

### Changes
- `Dockerfile` (new): multi-stage build described above.
- `docker-compose.yml` (new): production service definition with persistent volumes.
- `.dockerignore` (new): build-context exclusions.
- `README.md`: "Installation (Production)" now leads with a Docker option (recommended) alongside the existing bare-metal option; Project Structure block lists the new files.

No new runtime dependencies — `patch-package` was already a devDependency (used by the existing bare-metal `npm install` too); the Dockerfile just isolates when its output is needed vs. pruned.

---

## 2026-07-02 — CSV import: Core One printers no longer inferred as Core 1L

`inferModel()` in `server/routes/printers.js` listed the `CoreOne_` prefix in both the `c1l` and `c1` patterns, and `c1l` was checked first — so a printer named `CoreOne_01` imported as a Core 1L instead of a Core One. The `c1l` pattern now uses `CoreOneL_` (alongside `Core1L_` and `C1L `); `CoreOne_` correctly falls through to `c1`.

---

## 2026-07-02 — Docs accuracy pass on README and installation guide (pre-release)

Verified every claim in `README.md` and `docs/installation.md` against the code ahead of the open-source release. Commands, ports, startup log lines, data paths, PM2 steps, and `update.bat` behavior all matched. Fixed the parts that didn't — all related to the Centauri Carbon 2 and the CSV import format:

- `README.md`: Elegoo protocol column now distinguishes SDCP WebSocket (Centauri Carbon) from MQTT (Centauri Carbon 2); CSV table gains the `serial_number` and optional `model` columns, the `elegoo-centauri2` type, and corrected `api_key` requirements (Prusa API key; Bambu/CC2 LAN access code).
- `docs/installation.md`: credential table splits Elegoo into Centauri Carbon (IP only) and Centauri Carbon 2 (IP + serial + access code); Bambu access-code location aligned with the in-app help text (Settings → WLAN / Settings → Device); Step 1 no longer claims "built-in" model IDs (a fresh install starts with an empty model list — the fixed IDs only matter for CSV name inference); Step 2 field notes reflect the Access Code label and CC2 serial requirement.

---

## 2026-07-01 — Stopped printers confirmable from Fleet (no printer reboot needed)

Follow-up to the Bambu STOPPED fix: a held + STOPPED printer showed no confirmation buttons — the card said "Clear on printer screen to continue," which is a dead end on Bambu (nothing to acknowledge on-screen; the printer latches the stopped state until the next print starts). The operator was deadlocked: the farm wouldn't dispatch until confirmed, the printer wouldn't leave STOPPED until the farm dispatched. Only a power cycle got out.

Fleet's confirmation UI (Set Ready / Bad Print) now also appears for held + STOPPED printers. Set Ready un-holds and dispatches — the new print snaps a Bambu out of its latched state. The Good-count input defaults to **0** for stopped printers (the operator deliberately stopped it; crediting parts must be an explicit choice). Bad Print already handled cancelled jobs.

Backend fix uncovered along the way: set-ready preferred *any* most-recent `finished` job over a newer `cancelled` one, so a qty adjustment on a stopped printer would misapply as a delta against the previous print's job (wrongly debiting/crediting its part). The cancelled job now takes precedence when it is newer than the last finished job and resolves via the existing "cancelled-confirmed-good" path.

Second gap found on the live farm: a STOPPED printer with **no hold** (its job was already resolved, e.g. by an earlier decommission/recommission cycle, or the stopped print was never a farm job) showed no confirmation UI *and* was invisible to dispatch — `sweepIdlePrinters` only selected `IDLE`/`FINISHED`, and the `printerIdle` event only fires on an IDLE transition, which a latched Bambu never makes. Unheld STOPPED printers are now sweep-eligible: no hold means no unresolved outcome, and dispatching is what returns a latched Bambu to service. They get picked up by the startup sweep, project activation, and Sweep for Jobs.

### Changes
- `client/src/pages/Fleet.jsx`: `needsConfirmation` includes `STOPPED`; Good-count defaults to 0 for stopped printers (also auto-excludes them from batch Set Ready via the existing partial-count rule); STOPPED hint text rewritten (held → "confirm outcome below", unheld → "returns to service on next dispatch").
- `server/index.js` (set-ready): a cancelled job newer than the last finished job takes precedence over the finished-job delta path.
- `server/scheduler.js` (`sweepIdlePrinters`): eligibility is now `IDLE`/`FINISHED`/`STOPPED` with `is_held = 0`.
- `server/routes/parts.js` (dispatch-status diagnostic): mirrors the new eligibility.
- `server/tests/set-ready.test.js`: replica updated to match; 4 new tests (no false delta against the old finished job, cancelled job resolved with confirmed qty, hold released, older cancelled job does not shadow a newer finish).

Deploy note: the production server serves the prebuilt client from `client/dist` — run `npm run build` in `client/` after pulling, then hard-refresh the browser.

---

## 2026-07-01 — Bambu: stop from printer screen no longer shows a false ERROR

Pressing **Stop** on a Bambu printer's own screen left the farm showing a persistent ERROR that decommission/recommission couldn't clear. Cause: Bambu reports a user-cancelled print as `gcode_state: FAILED` — the same state as a genuine failure — and keeps reporting it until the next print starts or a power cycle. The driver mapped any `FAILED` to `ERROR`, and since status always comes from the live MQTT report (not the DB), no farm-side action cleared it.

The driver now disambiguates via `print_error`: `50348044` (the user-cancel code, sent briefly after the stop) or `0` (a settled cancel) map `FAILED` → `STOPPED`; any other nonzero `print_error` remains `ERROR`. `STOPPED` is the existing canonical "operator stopped the print" status (Klipper already emits it): the scheduler marks the job `cancelled` rather than `failed`, and the poller holds the printer for operator sign-off. Cancel-code semantics verified against ha-bambulab's `pybambu/models.py`.

Part-count safety: unchanged. A cancelled job is excluded from the FINISHED-recovery fallback (which only recovers `failed` jobs), and a stopped Bambu never transitions to `FINISH`.

### Changes
- `server/drivers/bambu.js`: `getStatus()` remaps `FAILED` + (`print_error` 0 or 50348044) to `STOPPED`; added `BAMBU_USER_CANCELLED` constant and protocol notes.
- `server/tests/bambu-driver.test.js`: 5 new tests covering cancel code, settled cancel (0/missing `print_error`), genuine failure, and nonzero `print_error` during `RUNNING`.
- `docs/multi-brand.md`: documented the Bambu `gcode_state` mapping and `FAILED` disambiguation.

353/353 tests pass.

---

## 2026-07-01 — Fleet view shows in-flight uploads

While the scheduler transfers a file, the printer hardware still reports IDLE — so the Fleet view showed "Idle" for machines that were actually mid-dispatch, disagreeing with the Jobs page. Fleet cards now show a violet **Uploading** badge with the filename and "Sending file to printer…" during a healthy transfer, plus an "Uploading (N)" filter chip; uploading printers no longer inflate the Idle count.

Implementation is a display-only overlay (`displayStatus()` in Fleet.jsx): held + uploading means a *failed* upload and keeps the existing orange confirmation UI; the overlay never writes back to `printers.status`, leaving the poller/scheduler state machine untouched.

### Changes
- `server/routes/printers.js`: `GET /api/printers` now includes `uploading_job_name` (filename of the active uploading job, via gcodes join).
- `client/src/pages/Fleet.jsx`: `UPLOADING` status color (violet, matches Jobs page), `displayStatus()` helper, card upload block, counts/filter derive from display status, Uploading filter chip.
- `docs/api.md`, `docs/web-app.md`: documented the new field and overlay behavior.

Verified with demo-seeded screenshots showing a healthy upload (violet badge) and a failed upload (orange confirmation UI) side by side; 348/348 tests pass.

---

## 2026-07-01 — UX pass for first-time users (pre-release)

Full UI/UX review and improvement pass ahead of the open-source release, focused on the shift from "author who built it" to "stranger installing it fresh." Verified against the demo seed with screenshots at desktop and mobile widths; all 348 tests pass.

### Fixed
- `client/src/pages/Settings.jsx`: **crash bug** — the CSV flagged-row resolution dropdown referenced an undefined `MODEL_OPTIONS`, crashing the Settings page whenever an import produced flagged rows. Now derives options from the models table (`allModels`), and the fallback model is the first registered model instead of a hardcoded `mk4s`.
- `client/src/pages/Fleet.jsx`: `Set Ready` / batch Set Ready failures were silent — now surface an error toast with the server message.
- `client/src/pages/Dashboard.jsx`: per-model count chips rendered truncated words ("1 PRIN", "1 ERRO") via `s.slice(0,4)` — now full status words.

### First-run experience
- Settings sections reordered to match setup order: Printer Models → Filament Library → Add Printer → CSV Import → rest. Previously Add Printer appeared before the Models section it depends on.
- Add Printer form: per-brand credential help box (where to find PrusaLink API key, Bambu LAN access code/serial, Elegoo/Klipper no key) + inline hint when the selected brand has no models yet.
- New `client/src/components/EmptyState.jsx` — friendly empty-state card with optional action link. Applied to Fleet, Dashboard, Projects (teaches the Project → Parts → G-code → Jobs model), Jobs (distinguishes "no jobs yet" from "filters match nothing"), and PrinterDetail events.
- Jargon pass: tooltips on Set Ready, Bad Print, Sweep for Jobs, Link Job, and the Awaiting stat; renamed Fleet `Prepared` → `Ready`, Dashboard `Awaiting` → `Awaiting Sign-off`, part status `Closed` → `Complete`.
- G-code upload form: labeled fields with required markers, parts-per-plate tooltip, filename-convention tip, and a tooltip explaining Targeting.

### New
- **Dispatch diagnostic**: `GET /api/parts/:id/dispatch-status` mirrors the scheduler's eligibility rules; "Why isn't this printing?" button in the part details panel shows blockers (project inactive, part complete, no G-code, coverage) and per-G-code availability (model/group/material matches, busy/held printers).
- **Farm name setting**: `farm_name` key (Settings → Farm Name) replaces the hardcoded "3DPN" sidebar branding; falls back to "Print Farm".
- Fleet cards show a wall-clock ETA ("2h 5m left · done 5:12 PM", with tomorrow/weekday rollover).
- G-code uploads report progress (XHR `onprogress`): percentage in the button plus a thin progress bar.
- Jobs page: card layout under 700px (the 9-column table was unusable on phones); filters persist in the URL (`useSearchParams`).

### Polish & accessibility
- Global `:focus-visible` outline in `index.css` (uses `!important` to beat inline `outline: none`, which only exists to suppress mouse-click rings).
- `aria-label` on icon-only × delete buttons; drag handles marked `aria-hidden`; confirm modal gets `role="alertdialog"` + `aria-modal`.
- Jobs status colors aligned with Fleet (printing = blue, uploading = violet); cancelled gets line-through as a non-color cue.
- Part status chip restyled dot+text so it no longer reads as a button next to the Details toggle.
- Fleet zero-count filter chips hidden unless active; "Parse" button renamed "Parse filename" and enlarged; PrinterDetail pagination touch targets enlarged; PollTimer redraw interval 100ms → 500ms.
- Backend error detail surfaced in remaining generic handlers (Decommissioned note save).

### Docs
- `docs/api.md`: documented `GET /api/parts/:id/dispatch-status` and the Settings endpoints (`GET /api/settings`, `PUT /api/settings/:key` with allowed-keys table).
- `docs/web-app.md`: Settings section order, credential help, and Farm Name behavior.

---

## 2026-07-01 — Open-source release prep

Pre-release hardening pass before public open-source release.

### Changes
- `server/drivers/bambu.js`: fixed `ReferenceError` — `onPrinterName` was undefined in the MQTT `project_file` payload; corrected to `onPrinterFilename`. Bambu prints would have thrown after the FTPS upload completed.
- `server/tests/bambu-driver.test.js`: rewrote the stale `.gcode`/`.bgcode` test suite (4 tests that expected success) into a `non-.3mf rejection` suite (4 tests) that asserts the `.3mf`-only validation — no FTP or MQTT is attempted. All 20 Bambu driver tests pass.
- `docs/api.md`, `docs/database.md`, `README.md`, `ARCHITECTURE.md`: replaced real PrusaLink API keys and internal network IPs used as doc examples with clearly fictional values (`aK3jR7xQ2pLm9vN`, `192.168.1.100`, etc.).
- `ARCHITECTURE.md`: removed reference to the private fleet CSV filename and printer count.
- `docs/video-outline.md`: deleted (personal filming notes, not project documentation).
- `scripts/test-bambu-print.js`: deleted (temporary diagnostic script from `.3mf` debugging, superseded).
- `package.json`: added `author`, `license`, `repository`, `engines`, and `keywords` fields per OSS conventions.
- `README.md`: added security note warning against internet exposure — the app has no authentication and serves printer credentials to any connected client.
- `docs/README.md`: removed `video-outline.md` from the documentation index.

---

## 2026-06-23 — Bulk-assign printer group from the Printers page

The Printers bulk-edit bar can now set **Group** in addition to Material and Color. The group field is a free-text input with a `<datalist>` autocomplete of existing group names (derived from the loaded printers — no extra fetch), so you can reuse a group or type a new one. Use case: park low-spool machines in a dedicated group, then funnel tiny/small prints to them via the G-code's `allowed_groups` targeting.

Client-only — it reuses the existing `PUT /api/printers/:id` (which already accepts `group_name` and logs an `info_changed` event). Only non-empty bulk fields are sent, so empty fields are left unchanged. The single-`group_name` model is unchanged (multi-group was considered and declined).

### Changes
- `client/src/pages/Printers.jsx`: added `bulkGroup` state, a Group input + `<datalist>` of distinct existing groups, wired into `applyBulk`/`canApply`/`clearSelection`.
- `docs/web-app.md`: documented the bulk-edit bar including the new Group field.

When a printer finished a print and was held showing the green/red "Set Ready / Bad Print" buttons, clicking **Decommission** only asked for a reason and took the machine offline via the plain `/decommission` endpoint — it never resolved the pending confirmation and left `is_held = 1`. The cause: the decommission flow gated the "Was the last print successful?" dialog on `has_active_job`, which is false for a normally-finished printer (its job is already in `finished` status, not `uploading`/`printing`).

The gate now also considers `is_held`: a held printer is awaiting sign-off, so decommissioning it opens the success/failure dialog. *Succeeded* → `complete-and-decommission` (parts stay credited, hold cleared, machine offline); *failed* → `mark-job-failure` (credit undone). This is the common "good print, take the machine offline to swap filament" path.

The *succeeded* path also honors the partial-plate `Good: N / M` count. Previously that input only fed Set Ready (which re-queues the printer), so there was no way to credit a partial plate *and* take the machine offline — the only alternatives were re-queueing it or losing the adjustment. Now the count flows through as `confirmed_qty`, applied exactly like Set Ready (a delta against the full plate already booked at finish, or the credited amount on a missed-finish), with the machine decommissioned instead of re-queued. A reduced count that drops a part below target reopens the part (and reactivates a just-completed project) so it re-enters the queue.

### Changes
- `client/src/pages/Fleet.jsx`: `decommission()` computes `awaitingSignoff = has_active_job || is_held === 1` and routes held-for-sign-off printers through the resolution dialog; the card's Decommission button and `decommission()` now forward the `Good: N/M` count as `confirmed_qty` on the success path.
- `server/routes/printers.js`: `complete-and-decommission` accepts `confirmed_qty` and applies it as a delta (finished job) or credit (missed-finish) via a shared `settlePart` helper that closes/reopens the part and its project. Full-plate behavior is unchanged when no count is supplied.
- `server/tests/printers-decommission.test.js`: added a `complete-and-decommission` block (6 tests) covering normal finish, partial credit, part/project reopen, and missed-finish with/without a count.
- `docs/web-app.md`: documented the decommission sign-off resolution and partial-qty behavior.

---

## 2026-06-20 — Fleet card click opens printer detail

Clicking a printer card in the Fleet page now navigates to that printer's detail view (`/printers/:id`) instead of dumping raw status to the browser console. The old `inspectPrinter()` debug helper (which fetched `/api/printers/:id/raw-status` and `console.group`'d the result) has been removed. The batch-confirmation interaction is unchanged: a card awaiting sign-off (held + `FINISHED`/`IDLE`) still toggles batch "Set Ready" selection on click rather than navigating.

The `GET /api/printers/:id/raw-status` endpoint is intentionally left in place as a debugging aid.

### Changes
- `client/src/pages/Fleet.jsx`: removed `inspectPrinter()`; added `useNavigate`; `PrinterCard` takes an `onOpenDetail` prop and the card's non-confirmation click calls it; updated hover title text.
- `docs/web-app.md`: documented Fleet card click behavior and added Fleet as a PrinterDetail entry point.

---

## 2026-06-20 — Fix: recommission no longer re-holds the printer with a phantom "stale job"

Recommissioning a printer immediately dispatches a job to it. But a just-dispatched job is marked `printing` while the printer's *stored* status still reads `IDLE`/`FINISHED` until the next poll (≤15s, longer if the machine is still heating before it reports `PRINTING`). The stale-job guard in `_dispatchToPrinter` treated any active job on a non-`PRINTING` printer as orphaned and auto-failed it. If a second dispatch fired in that window — e.g. recommission queues a dispatch and the operator then clicks "Scan for Jobs", enqueuing the same printer twice — the second dispatch killed the job the first had just created and re-held the printer, surfacing the green/red confirmation buttons again with a "stale job automatically cancelled" notification.

The stale-job auto-fail is now gated on job age: a job younger than `STALE_JOB_GRACE_MS` (90s) is treated as freshly dispatched and skipped rather than failed. A genuinely orphaned job (missed `FINISHED` transition, print stopped on the machine) has always run for minutes, so it is well past the grace window and still auto-fails as before.

### Changes
- `server/scheduler.js`: added `STALE_JOB_GRACE_MS` constant; the `_dispatchToPrinter` stale-job guard now computes job age from `started_at ?? created_at` and only auto-fails when the job is older than the grace window.
- `server/tests/scheduler-file.test.js`: new `stale-job grace window` describe block — asserts a fresh job is left intact and the printer stays unheld, and that a >grace-old job still auto-fails and holds.

### Also fixed: scheduler test fixtures broken by the 2026-06-19 filament-defaults change
The 2026-06-19 change made the dispatch candidate query reference `projects.required_material`/`projects.required_color` (via `COALESCE`) but did not update the in-memory `projects` tables in the scheduler test fixtures. Any test reaching the candidate query threw `no such column: projects.required_material` — surfacing as 16 failures in `scheduler-targeting.test.js`, and as a hard Node crash in `scheduler-file.test.js` (the upload-lock test's un-awaited dispatch promise rejected with that error → unhandled rejection).
- `server/tests/scheduler-targeting.test.js`, `server/tests/scheduler-file.test.js`: added `required_material TEXT, required_color TEXT` to the `projects` fixture. Full suite now passes (339 tests, 22 suites).

---

## 2026-06-19 — Project-level filament defaults

Projects now have optional `required_material` and `required_color` fields. When set, they apply to every gcode in the project without having to set them per-gcode. Individual gcodes can still override with their own values — the scheduler uses `COALESCE(gcode, project)`, so gcode-level wins when explicitly set.

In the project detail view, a Filament row sits below the title/status bar with material and color selects that auto-save on change. The gcode targeting selects in upload and edit rows show "— project: PLA —" as the first option when a project default is active, making the inheritance clear. The color dropdown filters to the effective material (gcode value or project fallback). Filament types and colors are now fetched once at the Projects page level and passed as props rather than fetched per gcode row.

### Changes
- `server/db.js`: `ALTER TABLE projects ADD COLUMN required_material TEXT` and `required_color TEXT`.
- `server/routes/projects.js`: `PUT /api/projects/:id/filament` — dedicated endpoint that explicitly supports clearing to NULL (empty string → NULL).
- `server/scheduler.js`: gcode dispatch query uses `COALESCE(gcodes.required_material, projects.required_material)` and same for color.
- `client/src/pages/Projects.jsx`: filamentTypes/filamentColors fetched once in the Projects component and passed via props; project filament selects added to detail header; `GcodeUploadPanel` and `GcodeEstimateRow` accept filament and project props instead of fetching independently; targeting dropdowns show project default hint and filter colors by effective material.

---

## 2026-06-19 — Filament Library: colors are tied to their filament type

Colors now belong to a specific filament type. When a printer's loaded material is set to PLA, only PLA colors appear in the color dropdown. The color picker is disabled until a material type is chosen. Attempting to delete a type that still has colors assigned is blocked with an error.

### Changes
- `server/db.js`: `filament_colors` rebuilt with `type_id INTEGER NOT NULL` and `UNIQUE(type_id, name)` — existing rows cleared (migration logs a notice). New installs create the table with the correct schema.
- `server/routes/filaments.js`: `POST /api/filaments/colors` now requires `type_id`; `GET /api/filaments/colors` JOINs `filament_types` to include `type_name`; `DELETE /api/filaments/types/:id` blocked with 409 if colors belong to the type.
- `client/src/pages/Settings.jsx`: color add form requires selecting a type first; color table shows a Type column; add-printer form color picker filters by selected material and resets on material change.
- `client/src/pages/Printers.jsx`: bulk-edit color select filters by selected material, resets on material change.
- `client/src/pages/PrinterDetail.jsx`: same filter + reset; color select disabled when no material selected.
- `client/src/pages/Projects.jsx`: both `GcodeUploadPanel` and `GcodeEstimateRow` filter color options by selected material and reset color on material change. Color picker hidden entirely if no colors exist for the selected material.

---

## 2026-06-19 — Filament Library: admin-managed types and colors

### Feature: canonical filament type and color lists with swatch support

Adds a **Filament Library** to the Settings page where admins configure the filament types (PLA, PETG, ASA, …) and colors (Black, Galaxy Red, Hedgehog Make Galaxy Red, …) available in the farm. Colors optionally carry a hex code which is displayed as a color swatch in the library table.

All material and color pickers throughout the app — the Add Printer form, the Printers bulk-edit bar, the PrinterDetail edit form, and the G-code upload and edit rows in Projects — are now `<select>` dropdowns sourced from this canonical list instead of free-text `<input>` fields with datalist autocomplete.

### Changes
- `server/db.js`: added `filament_types (id, name)` and `filament_colors (id, name, hex_color)` tables via `CREATE TABLE IF NOT EXISTS`.
- `server/routes/filaments.js` (new): `GET/POST/DELETE /api/filaments/types` and `GET/POST/DELETE /api/filaments/colors`.
- `server/index.js`: mount `/api/filaments` router.
- `client/src/pages/Settings.jsx`: added Filament Library section (types table + add form; colors table with hex swatch + add form with color picker); swapped add-printer loaded material/color inputs to `<select>`.
- `client/src/pages/Printers.jsx`: replaced `/api/printers/filaments` fetch with canonical type/color fetches; bulk-edit bar material and color inputs changed to `<select>`.
- `client/src/pages/PrinterDetail.jsx`: same fetch swap; loaded material/color edit inputs changed to `<select>`.
- `client/src/pages/Projects.jsx`: same fetch swap in both `GcodeUploadPanel` and `GcodeEstimateRow`; targeting selects now sourced from canonical list.
- `docs/filaments.md` (new): documents tables, endpoints, and usage.

---

## 2026-06-16 — Fix: OFFLINE with no active job incorrectly held printers

### Bug: printers stuck held after going offline from a confirmed-finished state

When an operator confirmed a finished print (green button, no more jobs to dispatch) and the printer subsequently went OFFLINE (e.g. firmware upgrade), `_handlePrinterOffline` in the scheduler unconditionally set `is_held = 1` even though there was no active job to protect. When the printer came back IDLE and dispatch was attempted, it found `is_held = 1` and skipped — leaving the printer with stale green/red confirmation buttons and no way to self-resolve.

The poller had already been fixed (2026-06-11) to gate its own hold triggers on active-job presence, but `_handlePrinterOffline` in the scheduler was missed — it held unconditionally regardless of job state.

**Fix:** `_handlePrinterOffline` now only sets `is_held = 1` and logs the operator-review event when an active (`uploading` or `printing`) job exists. Without one, the printer simply transitions OFFLINE → IDLE and resumes normal dispatch.

### Changes
- `server/scheduler.js`: `_handlePrinterOffline` gates `is_held = 1` on active-job presence, matching the pattern already used by `_handleFinished` and `_handlePrinterUnavailable`.
- `server/poller.js`: updated comment to reflect that all three scheduler offline/unavailable handlers now do their own job lookup before holding.

---

## 2026-06-11 — Fix spurious confirmation buttons after recommission

### Bug: Fleet showed green/red job-confirm buttons on a printer whose job was already confirmed at decommission time

Two bugs combined to cause this:

**Bug 1 — `complete-and-decommission` left `is_held = 1`:** When an operator decommissions a printer via "Print succeeded — credit & decommission", the handler set `is_active = 0` but did not clear `is_held`. The flag was cleaned up by the recommission handler, but left the decommissioned record in a dirty state.

**Bug 2 — poller unconditionally re-held on any concerning status transition (root cause):** The poller set `is_held = 1` on transitions to FINISHED, missed-finish (PRINTING→IDLE), or any non-safe state — regardless of whether a tracked job existed. The specific failure mode: Prusa printers stay in FINISHED state until the display is cleared. A network blip causes FINISHED→OFFLINE→FINISHED; the second FINISHED re-entry re-holds the printer even though the job was already confirmed. An additional path: a recommissioned printer briefly appears OFFLINE during boot, and when it recovers to IDLE `is_held` was never cleared.

**Fix:** The poller now only holds on any status transition when there is a tracked active (`uploading` or `printing`) job. The hold exists to protect in-flight jobs — without one there is nothing for the operator to confirm. `_handleFinished` and `_handlePrinterUnavailable` in the scheduler do their own job lookups before setting `is_held`, so those paths are unaffected.

### Changes
- `server/routes/printers.js`: `complete-and-decommission` now sets `is_held = 0` when writing `is_active = 0`.
- `server/poller.js`: all hold triggers (FINISHED, missed-finish, OFFLINE/ERROR/PAUSED) are now gated on the presence of an active `uploading`/`printing` job. Previously only non-safe state transitions were gated (first fix); FINISHED re-entry was still unconditional and hit the Prusa FINISHED-state-persistence case.

---

## 2026-06-11 — Edit printer details (IP, API key, group, serial, model)

### Feature: inline edit form for all printer connection fields

Operators can now edit any printer's connection details directly from the Printer Detail page. Previously only the printer name could be renamed; IP, API key, serial number, group, and model were read-only after creation.

**Why:** Hardware replacement (e.g. logic board swap) gives a printer a new MAC address and therefore a new DHCP IP. The printer's history should stay with the original record; only the IP needs updating.

**UX:** The info row in the printer header card (IP / Model / Group / Connector) gains an "Edit" button. Clicking it expands an inline two-column form pre-filled with the current values. API key field is hidden for printer types that don't use one (Elegoo Centauri, Klipper). Saving calls the existing `PUT /api/printers/:id` endpoint; the poller picks up the new IP on its next cycle automatically.

### Changes
- `client/src/pages/PrinterDetail.jsx`: added `models`, `editingDetails`, `detailsDraft`, `detailsError`, `savingDetails` state; `startEditDetails` / `cancelEditDetails` / `submitEditDetails` handlers; inline edit form replacing the static info row; `/api/models` fetched alongside existing page data.

---

## 2026-06-07 — Fix spurious second "Set Ready" after upload-failure confirmation

### Bug: printer re-held after operator confirmed upload-stalled job complete

When an upload failed but the printer ran and completed the job, the operator was shown the amber "Upload failed — but printer shows job complete" card and clicked "Set Ready". Instead of resolving cleanly, the printer would flip to a green "Set Ready or Bad Print" card, requiring a second click.

**Root cause:** The `set-ready` handler checked for a `finished` job first. If the printer had a `finished` job from a *previous* print cycle AND the current `uploading` job, the handler took the normal-confirmation path (did nothing since `confirmed_qty` was null), cleared `is_held`, then called `scheduleForPrinter`. Inside `_dispatchToPrinter`, the still-`uploading` stale job was found, auto-failed as a stale job, and `is_held=1` was re-set — producing the spurious green panel.

**Fix:** Check for an `uploading` job first, before the `finished` job query. If an `uploading` job exists it always takes priority (the `finishedJob` query is skipped entirely), routing directly to the upload-stalled handler which marks the uploading job as `finished` and credits qty before `scheduleForPrinter` runs. `_dispatchToPrinter` then finds no stale active job and dispatches normally.

### Changes
- `server/index.js`: added `uploadingJobEarly` pre-check; `finishedJob` query skipped when an uploading job exists; upload-stalled section reuses the pre-fetched job instead of re-querying.

---

## 2026-05-29 — Per-gcode material + time estimates; actual elapsed stats on dashboard

### Feature: time and material estimates moved from parts to gcodes

Material and print time estimates now live on each G-code file, not on the part. Since a part can have one gcode per printer model, estimates can now vary by model and are tied to the exact gcode that ran each job.

**Why:** With multiple gcodes per part, a single `material_grams` value on the part is ambiguous — it can only represent one model. Moving the estimate to the gcode enables accurate per-job accounting: `job → gcode → material_grams` gives exact material used for each plate, broken down by printer model.

**Data model:** `gcodes.material_grams REAL` (new column, per-plate grams). `gcodes.est_print_secs` (existing column, per-plate seconds) is now also operator-editable. `parts.print_time_seconds` and `parts.material_grams` are retained for schema compatibility but are no longer written to.

**Projects UI:** The per-part "Print Estimate" section is removed. Each G-code row now shows inline time + material inputs with a "Parse" button that auto-fills from the filename, and a "Save" button that calls `PUT /api/gcodes/:id`. Values are per-plate (matching what the gcode actually prints). On file upload, `est_print_secs` and `material_grams` are auto-populated from the filename parse if detected.

**Dashboard:** Active Projects footer row now shows actual elapsed print time and material used (from completed jobs), not remaining estimates. Elapsed time = sum of `finished_at − started_at` for finished jobs plus `now − started_at` for any printing job. Material = sum of `gcode.material_grams / gcode.parts_per_plate * job.parts_per_plate` for finished jobs with a gcode that has `material_grams` set. If multiple printer models ran jobs, their IDs are listed.

### Changes

**`server/db.js`** — `ALTER TABLE gcodes ADD COLUMN material_grams REAL` migration.

**`server/routes/gcodes.js`** — `extractMaterialGramsFromFilename()`, `normalizePrintTime()`, `normalizeMaterialGrams()` helpers; `POST /parse-filename` now also returns `material_grams`; `POST /upload` accepts and stores `est_print_secs` and `material_grams`; new `PUT /:id` endpoint to update both fields (accepts human-readable strings).

**`server/routes/parts.js`** — Removed `parse-gcode` endpoint and `print_time`/`material` fields from `PUT /:id`. Removed all normalizer helper functions (now live in gcodes.js).

**`server/routes/dashboard.js`** — Per-project stats: `elapsed_secs` (wall-clock print time), `material_used_grams` (from gcode estimates × job quantities), `model_breakdown` (per-printer-model summary).

**`client/src/pages/Projects.jsx`** — Removed per-part estimate section from `PartDetailsPanel`. Added `GcodeEstimateRow` component with inline time/material inputs per gcode. Upload panel now captures and forwards `est_print_secs` and `material_grams` from filename parse.

**`client/src/pages/Dashboard.jsx`** — Active Projects footer replaced "total remaining" with "so far" showing elapsed time, material used, and contributing printer models.

---

## 2026-05-29 — Part print estimates; full-width Active Projects dashboard

### Feature: per-part print time and material estimates

Parts now optionally store `print_time_seconds` and `material_grams`. The dashboard uses these to show remaining print time and material on each part row and as a project-level total.

**How values are set (Projects → part Details panel):**
- New "Print Estimate (per part)" section with free-text inputs for print time and material.
- Server normalizes whatever the operator types: `"2h15m"`, `"90m"`, `"5400s"`, `"1:30:00"`, bare integer (seconds) for time; `"45g"`, `"45.5g"`, `"1.2kg"`, bare number (grams) for material. Returns `400` if non-empty input can't be parsed.
- **Parse from file** button: calls `POST /api/parts/:id/parse-gcode`, which reads the gcode filename attached to the part and extracts time (`2h15m` pattern) and material (`45g` / `1.2kg` pattern), dividing by `parts_per_plate` to get per-part values. Populates the inputs; operator reviews and clicks Save.

**Dashboard display:**
- When time or material is set and a part still has remaining qty, a compact info line appears below the progress bar: `~2h 15m remaining · ~450g remaining`.
- Each project card shows a footer row totalling remaining time and material across all open parts.

### Change: Active Projects goes full width

Removed the "Needs Attention" panel. Active Projects now occupies the full dashboard width. Printer attention states remain visible in the fleet grid cells and Fleet/Printers pages.

### Changes

**`server/db.js`** — two `ALTER TABLE` migrations: `print_time_seconds INTEGER` and `material_grams REAL` on `parts` (both nullable).

**`server/routes/parts.js`** — `normalizePrintTime()` and `normalizeMaterialGrams()` helpers; filename extractors `extractTimeSecsFromFilename()` / `extractMaterialGramsFromFilename()`; new `POST /:id/parse-gcode` endpoint; updated `PUT /:id` to accept `print_time` and `material` fields.

**`client/src/pages/Dashboard.jsx`** — removed `NeedsAttention`, `PanelShell`, and related helpers; Active Projects now full width; added `formatDuration()` / `formatMaterial()` helpers; per-part info lines and project total footer.

**`client/src/pages/Projects.jsx`** — `formatDurationForInput()` / `formatMaterialForInput()` helpers; Print Estimate section in `PartDetailsPanel` with time/material inputs, Parse from file button, and Save.

**`docs/database.md`** — updated `parts` schema with new columns.

**`docs/api.md`** — documented `print_time` / `material` fields on `PUT /api/parts/:id`; documented new `POST /api/parts/:id/parse-gcode` endpoint.

---

## 2026-05-27 — UI/UX fit-and-finish: Printers grouping, Dashboard panels, Decommissioned grid

Open-source-release polish pass on three high-traffic screens.

### Printers page — collapsible model groups

The flat printer list was fine at 12 printers but won't scale to hundreds. Reworked into a grouped, collapsible layout.

- Printers grouped by model with collapsible section headers; header shows count and per-status summary pills (e.g. `5 printing · 2 idle · 1 offline`).
- New toolbar: **Expand all / Collapse all** buttons and a **Show decommissioned** checkbox (hidden by default — decommissioned printers no longer pollute the active list).
- Collapse state persisted to `localStorage` (`printers.collapsedGroups`, `printers.showDecommissioned`).
- Search auto-expands groups with matches, hides empty groups, and shows a "N of M match" hint.
- "Model" column dropped from the per-row grid (redundant given the header), reclaiming horizontal space.

### Dashboard — replaced Recent Activity with two actionable panels

Recent Activity duplicated information already on the Jobs page and wasn't useful for a worker walking the floor. Bottom row is now a 3-column grid with two new panels.

- **Needs Attention** — every printer requiring a human, sorted by priority (AWAITING → ERROR → STOPPED → PAUSED → OFFLINE), then longest-waiting first. Each row: reason badge, printer name, wait time. Empty state renders a green "✓ All clear" badge — itself a status worth seeing on a TV.
- **Finishing Soon** — up to 10 currently-printing printers sorted by `job_time_remaining` ascending, with job filename, remaining time, and a mini progress bar. Lets workers pre-stage the next plate before a printer lands.
- Recent Activity removed from the dashboard UI (the `recent_activity` field is still in the `/api/dashboard` payload for compatibility).

### Decommissioned page — denser layout + Enter-to-save

Full-width cards wasted space and the note field required clicking a Save button to commit.

- Responsive grid of compact cards (`repeat(auto-fill, minmax(360px, 1fr))`) — 2-3 columns depending on viewport.
- Inline note area: click to edit; **Enter saves**, Shift+Enter newline, Esc cancels, blur auto-saves as backstop. Saves no-op when unchanged.
- Recommission and View History are now small icon buttons in the card's top-right.
- Recommission confirm now uses the styled `useConfirm` modal instead of `window.confirm`, matching the rest of the polish pass; success shows a toast.

### Changes

**`server/routes/dashboard.js`** — added `last_event_at` subquery per printer so the Needs Attention panel can compute waiting time without a second query.
**`client/src/pages/Printers.jsx`** — full rewrite: grouped sections, `GroupSection` subcomponent, localStorage-backed collapse state, show-decommissioned toggle, search-driven auto-expand.
**`client/src/pages/Dashboard.jsx`** — 3-column bottom row; added `NeedsAttention` and `FinishingSoon` panel components plus `formatRemaining` / `formatWait` helpers; removed Recent Activity render.
**`client/src/pages/Decommissioned.jsx`** — full rewrite: grid layout, `DecomCard` subcomponent, click-to-edit / Enter-saves note flow, `useConfirm` + `useToast` integration.
**`docs/web-app.md`** — updated Dashboard, Printers sections and added a Decommissioned Page section.
**`docs/api.md`** — documented `last_event_at` on `/api/dashboard` printers.

---

## 2026-05-12 — Feature: manual job linking for orphaned printers

When an upload appears to fail but the printer actually started printing, the job could end up in `failed` or `uploading` status while the printer shows `PRINTING` with no DB job associated — breaking part-count record keeping.

**Two new ways to link a job:**

1. **"Job Running" button now opens a job picker.** When an upload-stalled printer is confirmed as printing, a modal shows eligible jobs (failed/uploading, filtered to this printer's model). The printer's own stalled upload job is pre-selected. Confirming links that job to the printer and flips it to `printing` so the normal finish flow credits parts correctly. If no job is selected, the original "release hold" behaviour is preserved.

2. **"Link Job" recovery button on PRINTING cards with no active job.** For printers already in this orphaned state, a blue "Link Job" button appears on the card. Clicking it opens the same picker.

**New endpoints:**
- `GET /api/printers/:id/linkable-jobs` — returns failed/uploading jobs matching the printer's model.
- `POST /api/printers/:id/link-job` — sets job to `printing`, updates `printer_id`, releases hold.

### Changes
**`server/routes/printers.js`** — added `GET /:id/linkable-jobs` and `POST /:id/link-job`.  
**`client/src/pages/Fleet.jsx`** — `linkJobModal` state + `openLinkJobModal` / `submitLinkJob` functions + picker modal + "Link Job" card button + "Job Running" opens picker instead of calling set-ready directly.  
**`docs/api.md`** — documented both new endpoints.

---

## 2026-05-07 — UX: friendly startup error when client hasn't been built

A first-time installer who skipped `npm run build` and went straight to `npm start` saw a confusing in-browser `ENOENT: no such file or directory ... client\dist\index.html` only after opening localhost:3000. The server itself appeared to be running fine, so the cause was non-obvious.

`server/index.js` now checks for `client/dist/index.html` at startup. If missing, the server prints a clear instruction and exits 1 before opening the listening socket — there is no ambiguity about whether the server "started":

```
  ERROR: client/dist/index.html not found.
  The React client has not been built yet.

  Run this once before starting the server:
    npm run build
```

### Changes
**`server/index.js`** — added existence check for `client/dist/index.html` ahead of `express.static`; imports `fs`.

---

## 2026-05-07 — Security: clear all npm audit vulnerabilities for open-source release

`npm audit` reported 4 vulnerabilities (2 high, 2 moderate) on the server and 3 moderate on the client. All have been resolved so a fresh install reports `found 0 vulnerabilities` on both sides.

**Server (non-breaking transitive bumps via `npm audit fix`):**
- `axios` 1.14.0 → 1.16.0 (multiple SSRF, prototype pollution, header injection advisories)
- `basic-ftp` 5.2.1 → 5.3.1 (CRLF injection in MKD/credentials, DoS in `Client.list()`)
- `follow-redirects` 1.15.11 → 1.16.0 (auth header leakage on cross-domain redirect)
- `ip-address` 10.1.0 → 10.2.0 (XSS in `Address6` HTML emitters — transitive via mqtt → socks)

**Client (Vite major upgrade):**
- `vite` 5.4.21 → 7.3.3 and `@vitejs/plugin-react` 4.3.1 → 5.2.0 — fixes the dev-server `esbuild` advisory (any website could send requests to the dev server). Vite 7 was chosen over Vite 8 as a more conservative jump; the existing `vite.config.js` works unchanged.
- `postcss` bumped to 8.5.10 via `npm audit fix` (XSS via unescaped `</style>`).

### Verification
- `npm audit` → 0 vulnerabilities (server and client)
- `npm test` → 263/263 passing
- `npm run build` → succeeds on Vite 7
- `npm run dev` → Vite 7 dev server starts and serves index.html with HTTP 200

### Changes
**`client/package.json`** — bumped `vite` and `@vitejs/plugin-react` to current major versions.  
**`package-lock.json`** and **`client/package-lock.json`** — regenerated.  
No application source code changes were required.

---

## 2026-05-06 — Fix: cancelled jobs not credited or displayed correctly on Set Ready

Two related bugs triggered when an operator manually stops a print on the printer screen (`_handlePrinterStopped` marks the job `'cancelled'`):

**Bug 1 — wrong quantity shown (1/1 instead of 25/25):** The `last_parts_per_plate` subquery in `GET /api/printers` only matched `'finished'` or `'printing'` jobs. A `cancelled` job was invisible, so the query fell back to an older unrelated job with a different `parts_per_plate`.

**Bug 2 — no parts credited on green button:** The `set-ready` handler's missed-finish branch searched for `printing` and (session-gated) `failed` jobs, but not `cancelled` jobs. After a server restart (e.g. running `update.bat`), the `scheduler.startedAt` gate also blocked the failed-job fallback, so clicking green released the printer with zero parts credited.

**Fix 1:** Replaced the two-part COALESCE in `GET /api/printers` with a single subquery covering `finished`, `printing`, `failed`, and `cancelled`, ordered by `COALESCE(finished_at, started_at) DESC`.

**Fix 2:** Added a `cancelled` fallback to the `activeJob` lookup in `set-ready`, without a `startedAt` gate — a cancelled job that survived a server restart is still the right job to credit when the operator confirms it was good.

### Changes

**`server/routes/printers.js`** — updated `last_parts_per_plate` subquery; added `cancelled` fallback in `mark-job-failure` so the job is properly marked `failed` instead of hitting the "no tracked job" path  
**`server/index.js`** — added `cancelled` fallback in set-ready handler

---

## 2026-05-04 — Open-source release prep: LICENSE, demo seed, install docs, video outline

Prepared the project for open-source release and YouTube video production.

**MIT license** — Added `LICENSE` file. The README already stated MIT; now there is an actual license file for GitHub and package managers to pick up.

**Demo seed script** (`server/seed-demo.js`) — Seeds a fresh install with 12 fictional printers across all four brands (Prusa, Elegoo, Bambu, Klipper), 3 projects, 6 parts, 6 G-code files, and a realistic spread of job history. Printers are seeded in various states: 5 PRINTING at different progress levels, 1 FINISHED awaiting operator confirmation, 2 IDLE, 1 ERROR, 1 OFFLINE. Requires `--confirm` flag to prevent accidental data loss on a live install.

**DEMO_MODE** — Added `process.env.DEMO_MODE === 'true'` check in `server/poller.js`. When set, the poller skips all network calls and emits `pollComplete` without touching the DB — seeded statuses are preserved for filming without real hardware. Start with `DEMO_MODE=true npm start`.

**Installation docs** (`docs/installation.md`) — Fixed `YOUR-ORG` placeholder clone URLs → `joeltelling`. Added "What You Will Need From Each Printer" credential table (Prusa API key, Bambu LAN Mode / access code, Elegoo/Klipper IP-only). Added "First Run" walkthrough section covering printer model setup, adding the first printer, verifying connection, and CSV import.

**Video outline** (`docs/video-outline.md`) — Full YouTube filming outline with timestamps, talking points, and filming notes for each section.

### Changes

**`LICENSE`** — new file  
**`server/seed-demo.js`** — new file  
**`server/poller.js`** — DEMO_MODE skip in `_tick()`  
**`docs/installation.md`** — credential table, First Run section, URL fixes  
**`docs/video-outline.md`** — new file  
**`docs/README.md`** — updated documentation index

---

## 2026-04-30 — Decommission flow: "print good" vs "print bad" choice

Decommissioning a printer no longer assumes the last print was bad. The operator is now asked whether the print was successful before the machine goes offline.

**Problem:** The only way to take a printer offline after a successful print was to hit the green "good print" button (which credits the count and releases the machine to the queue) and then immediately decommission — a two-step dance with no clean single-action path.

**Solution:** The existing decommission dialog flow was updated. Step 1 now asks "Was the last print successful?" instead of "Did the last print fail?":
- **OK (succeeded)** → credits the print (if not already credited) and decommissions — machine goes offline for maintenance with the count intact.
- **Cancel (failed/unknown)** → calls `mark-job-failure` as before, undoing the count and decommissioning.

A new backend endpoint (`POST /api/printers/:id/complete-and-decommission`) handles the good-print path. For the normal FINISHED case the count is already credited by `_handleFinished`; for missed-finish cases (job still shows `printing`) it credits qty before decommissioning.

### Changes

**`server/routes/printers.js`** — new `POST /:id/complete-and-decommission` endpoint  
**`client/src/pages/Fleet.jsx`** — updated `decommission()` dialog wording and routing  
**`docs/api.md`** — documented the new endpoint

---

## 2026-04-27 — Klipper driver bug fixes (validated on Voron hardware)

Three bugs found and fixed while testing the Phase 6C Klipper driver against a real Voron printer.

**`VALID_CONNECTORS` missing `klipper`** — `server/routes/models.js` validated connector against `['prusa', 'elegoo-centauri', 'bambu']`, blocking addition of any Klipper printer model. Added `'klipper'` to the list.

**Moonraker params sent as null → empty `status` response** — axios drops `null`-valued params from the query string, so `/printer/objects/query` received no object names and returned `status: {}`. `print_stats.state` was `undefined`, mapping to `UNKNOWN`. Fixed by passing `''` instead of `null` so the keys appear in the query string.

**`print=true` passed as query param instead of form field** — Moonraker's `/server/files/upload` silently ignores query params; `print` must be a multipart form field. Upload succeeded (HTTP 200) but the print never started. Fixed by replacing `params: { print: 'true' }` with `form.append('print', 'true')`.

**IP stripping** — defensive: `base()` now strips any `http://` prefix and trailing slashes from the stored IP before building the Moonraker URL.

### Changes

**`server/routes/models.js`** — added `'klipper'` to `VALID_CONNECTORS`
**`server/drivers/klipper.js`** — IP stripping in `base()`; empty-string params for Moonraker query; `print` as form field in `uploadAndPrint`
**`server/tests/klipper-driver.test.js`** — new file, 19 tests covering all state mappings, upload correctness, IP stripping, and `print` form-field placement

---

## 2026-04-26 — Fleet card UX improvements

Four targeted improvements to the printer card in the Fleet view to reduce accidental taps.

**Whole card is the selection toggle.** When a printer is awaiting confirmation (FINISHED or held-IDLE), clicking anywhere on the card now toggles it in/out of the batch Set Ready selection. The selected state is shown with a brighter green border (2px, `#22c55e`). Previously the checkbox was a small target next to the green Set Ready button, making accidental button presses easy.

**Inline checkbox removed.** The "Include" checkbox label inside the confirmation area is gone — the card itself is the toggle now.

**Green/red buttons equal width.** Set Ready and Bad Print (and their equivalents in the offline/upload-stalled flows) now each take 50% of the card width via `flex: 1`, eliminating the size mismatch.

**Decommission hidden while printing.** The Decommission button is only rendered when `isPrinting` is false. It is not meaningful during an active print and was unnecessary visual noise on printing cards.

### Changes

**`client/src/pages/Fleet.jsx`**
- `PrinterCard`: `cardBorder()` helper drives border color (idle green / selected bright green / amber / default)
- Card `onClick` switches between `onToggleSelect` (when `needsConfirmation`) and `inspectPrinter` (all other states)
- Removed `<label>/<input type="checkbox">` from `needsConfirmation` block
- All three confirmation button pairs (`needsConfirmation`, `needsOfflineConfirmation`, `needsUploadConfirmation`) wrapped in `flex` row with `flex: 1` on each button
- Decommission div gated on `!isPrinting`

---

## 2026-04-20 — Klipper (Moonraker) driver — Phase 6C

Adds support for Klipper-firmware printers (Voron, etc.) via the Moonraker REST API. No new dependencies — Moonraker is plain HTTP on port 7125 using `axios` and `form-data`, both already present.

**Driver interface:**
- `getStatus`: queries `/printer/objects/query?print_stats&virtual_sdcard&webhooks`. Maps `print_stats.state` (standby/printing/paused/complete/error/cancelled) to canonical status. Reports OFFLINE if `webhooks.state` is not `ready`. Time remaining is estimated from elapsed `print_duration` and `virtual_sdcard.progress`.
- `uploadAndPrint`: multipart POST to `/server/files/gcodes/`, 1s delay, then POST to `/printer/print/start?filename=`. Moonraker overwrites on duplicate filename — no pre-delete needed.
- `cancelJob`: POST to `/printer/print/cancel`.
- `currentFile`: populated from `print_stats.filename` while printing.

**Status mapping:**

| Moonraker state | Canonical |
|---|---|
| `standby` | IDLE |
| `printing` | PRINTING |
| `paused` | PAUSED |
| `complete` | FINISHED |
| `error` | ERROR |
| `cancelled` | STOPPED |

**No API key required** — Moonraker on LAN has auth disabled by default. Klipper is added to `NO_API_KEY_TYPES` in `printers.js`; the API key field is hidden in the Settings UI.

### Changes

**`server/drivers/klipper.js`** — new file
**`server/drivers/index.js`** — registered `'klipper'` in LOADERS
**`server/routes/printers.js`** — renamed `ELEGOO_TYPES` → `NO_API_KEY_TYPES`; added `'klipper'`
**`client/src/pages/Settings.jsx`** — added Klipper to `CONNECTOR_OPTIONS`/`CONNECTOR_LABEL`; API key field hidden for `NO_API_KEY_TYPES`; Voron_01 name placeholder
**`docs/multi-brand.md`** — updated connector families table and phase status

---

## 2026-04-13 — Ceiling check: SUM(parts_per_plate) instead of COUNT(jobs)

The dispatch ceiling check now sums `parts_per_plate` across all active jobs for a part rather than counting jobs. The old COUNT approach used the *current dispatch's* `parts_per_plate` to compute `jobsRemaining`, which gave the wrong ceiling when a part's G-codes have different `parts_per_plate` on different printer models (e.g. XL=4ppp, MK4S=10ppp). In that case the ceiling was inflated — the scheduler would dispatch more printers than needed and significantly overshoot the target quantity.

**New logic:** after inserting the probe job, `inProgressParts = SUM(parts_per_plate)` across all `uploading`/`printing` jobs for the part (probe included). Ceiling is hit when `inProgressParts - probe.ppp >= remainingParts` — i.e. existing in-progress coverage (without this printer) already meets the target. For homogeneous fleets (all same ppp) the result is identical to the old logic; for mixed-ppp fleets it is strictly more accurate.

Log message now shows parts ("240 of 250 parts already in progress") instead of jobs ("3 of 4 jobs already active").

### Changes

**`server/scheduler.js`**
- `_dispatchToPrinter` ceiling check: replaced `COUNT(jobs)` + `ceil(remaining/ppp)` with `SUM(parts_per_plate)` across active jobs; condition changed from `activeCount > jobsRemaining` to `(inProgressParts - ppp) >= remainingParts`
- Ceiling log updated to report parts in-progress vs parts remaining

---

## 2026-04-13 — Handle STOPPED state; broaden stale-job detection; mark-job-failure scope fix

### Fix 3: STOPPED state not handled — job stayed `printing` after operator stop

When an operator stops a print from the printer's own screen, Prusa reports `STOPPED`. The poller correctly held the printer (STOPPED is not a SAFE_STATE), but the scheduler had no handler for it, leaving the active job stuck as `'printing'` in the DB and Jobs view.

Added `_handlePrinterStopped`: marks the active `'printing'` job as `'cancelled'` when `STOPPED` fires. The printer stays held (is_held=1 was already set by the poller) so the operator confirms before the next job dispatches.

Also expanded the stale-job detection condition in `_dispatchToPrinter` from `fresh.status === 'IDLE'` to `fresh.status !== 'PRINTING' && fresh.status !== 'PAUSED'`. This ensures any state where the printer isn't actively running (STOPPED, IDLE, FINISHED, ERROR, etc.) triggers the auto-fail safety net, rather than only IDLE.

### Fix 2: Stale job detection: auto-fail + mark-job-failure scope fix

### Problem

A printer with a stale `printing` job (IDLE printer, `printing` job in DB from a missed FINISHED transition) was permanently locked out of dispatch. Two bugs compounded:

1. **`_dispatchToPrinter`** found the stale job and held the printer, but left the stale job as `'printing'`. The operator's red button then hit a second bug in `mark-job-failure`.
2. **`mark-job-failure`** used `ORDER BY finished_at DESC, started_at DESC`. SQLite sorts NULLs last in DESC, so the stale `printing` job (NULL `finished_at`) lost to any older `finished` job, causing the wrong job to be failed and the wrong part's `completed_qty` to be decremented. The stale job was never cleaned up.
3. Even after fixing the ordering (two-query approach), the `finished` fallback query was still too broad — it could find old finished jobs from previous cycles and incorrectly decrement their part quantities.

### Fix

**`_dispatchToPrinter` — auto-fail stale job immediately**

When a stale job is detected (printer IDLE, active `printing`/`uploading` job in DB), the stale job is now automatically marked `failed` with a `finished_at` timestamp before holding the printer. Since a `printing` job is never credited to `completed_qty`, this has no qty side-effect. The printer is held with a notification, and the operator can use the normal green/red Fleet UI to resume — no special "resolve stale job" flow needed.

**`mark-job-failure` — narrow the `finished` fallback**

The `finished` fallback now includes a `NOT EXISTS` guard: it only matches a finished job if no subsequent job was created for this printer after it finished. This ensures the endpoint targets the job the printer is currently held for (the one `_handleFinished` just completed), not an older finished job from a previous cycle.

### Changes

**`server/scheduler.js`**
- `_dispatchToPrinter`: fresh DB read extended from `SELECT is_held` to `SELECT is_held, status`
- Stale job condition broadened: `status !== 'PRINTING' && status !== 'PAUSED'` (was `=== 'IDLE'`)
- Stale job detected: stale job auto-failed (`status='failed'`, `finished_at` stamped); printer held; operator notified
- Concurrent-dispatch case (PRINTING/PAUSED): existing "skipping duplicate dispatch" log unchanged
- Added `_handlePrinterStopped`: cancels active `'printing'` job when STOPPED status fires
- `start()`: wires `statusChange` → `_handlePrinterStopped` for `newStatus === 'STOPPED'`

**`server/routes/printers.js`**
- `POST /api/printers/:id/mark-job-failure`: two-query approach — active (`printing`/`uploading`) first; `finished` fallback now scoped with `NOT EXISTS (newer job created after finished_at)` to prevent incorrect qty decrements on old jobs

---

## 2026-04-11 — No automatic job failures; upload safety hardening

The server can no longer automatically mark a job as `failed` without an operator confirming it. Previously, exhausted upload retries and misconfigured/missing-file pre-flight errors could all silently write failed job records. These paths have been removed or rerouted to operator confirmation.

### Pre-flight checks before job creation

**Unknown printer type** — `getDriver()` is now resolved before any job row is inserted. If the printer type is unrecognised, the printer is held and no job is created. Previously a job was inserted then immediately marked failed.

**Missing G-code file** — File existence is now checked inside the candidate-selection loop, after the ceiling check, before the job row is ever committed. If a file is missing, the probe job is deleted and the part is skipped (same as a ceiling-hit). The printer falls through to its next eligible part instead of bailing entirely. No job record is left behind. Previously a job was inserted then immediately marked failed.

### Upload stall — operator confirmation instead of auto-fail

When all upload retries are exhausted and `checkIfPrinting` returns false, the server now holds the printer and leaves the job as `uploading` rather than marking it `failed`. The operator must verify the machine and confirm the outcome via the Fleet UI.

Two new card buttons appear on amber upload-stalled cards:
- **Job Running** — operator confirms the print is actually running; job changes from `uploading` → `printing` and resolves naturally when `_handleFinished` fires.
- **Upload Failed** — calls `mark-job-failure`; job is marked `failed`, printer is decommissioned.

An amber banner appears when any printer is in the upload-stalled state.

### Upload lock

A `_activeUploads` Set in the scheduler now tracks which printer IDs have an upload currently in flight. A new dispatch call for the same printer is skipped until the in-flight upload finishes. This prevents the 409-Conflict retry cycle where a slow transfer causes a retry that immediately hits the still-running first attempt.

### `_waitForBatch` — stalled uploads no longer block the batch

`_waitForBatch` joins the printers table and treats an `uploading` job with `is_held = 1` as settled. Previously the batch could block up to its 10-minute timeout waiting for a job that would never advance.

### `mark-job-failure` extended to `uploading` jobs

The endpoint now finds `finished`, `printing`, and `uploading` jobs (previously only the first two). For `uploading` jobs, nothing has been credited so there is nothing to undo — the printer is decommissioned with no qty side-effect.

### Changes

**`server/scheduler.js`**
- `_activeUploads = new Set()` added to constructor
- `_dispatchToPrinter`: driver resolved before while loop (no job created for unknown type); G-code check moved inside while loop with probe-job delete + skip on missing file; `_activeUploads` lock wraps `uploadAndPrint`; exhausted-retries path now holds printer + leaves job as `uploading` instead of marking `failed`
- `_waitForBatch`: joins printers table; `uploading + is_held = 1` treated as settled

**`server/routes/printers.js`**
- `GET /api/printers`: adds `has_uploading_job` field
- `POST /api/printers/:id/mark-job-failure`: query extended to include `uploading` status

**`server/index.js`**
- `POST /api/printers/:id/set-ready`: new `else` branch handles upload-stalled case — finds `uploading` job and changes it to `printing` when operator confirms Job Running

**`client/src/pages/Fleet.jsx`**
- `needsUploadConfirmation` condition: `is_held && has_uploading_job && status !== 'OFFLINE'`
- Amber card border/background for upload-stalled printers
- Amber banner for printers in upload-stalled state
- **Job Running** and **Upload Failed** buttons on affected cards
- `uploadFailed()` handler with appropriate confirm message (no qty deducted)

---

## 2026-04-11 — OFFLINE printers no longer auto-fail their active job

Previously, when a printer transitioned to `OFFLINE`, the scheduler immediately marked its active job as `failed` and held the printer. This was too aggressive — most OFFLINE events are transient network blips where the printer keeps printing uninterrupted.

The scheduler now distinguishes OFFLINE from ERROR:

- **OFFLINE with active job:** printer is held for operator review, but the job stays as `printing`. If the printer comes back as `PRINTING` on its own, the hold is released automatically — no operator action needed. If the operator needs to intervene, the Fleet UI shows amber **Job OK** / **Job Failed** buttons on the card.
- **OFFLINE without active job:** printer is held as before (no job to preserve).
- **ERROR:** unchanged — still fails the job immediately and holds the printer.

**Job OK** (green) releases the hold and lets the job continue to its natural finish. **Job Failed** (red) calls `mark-job-failure`, which marks the job failed and decommissions the printer for investigation.

The `set-ready` endpoint was also guarded: when an OFFLINE printer with a `printing` job calls set-ready, qty is not credited (the job hasn't finished — the operator is saying "resume", not "confirm finish").

### Changes

**`server/scheduler.js`**
- Added `_handlePrinterOffline(printer)` — holds printer, leaves job as `printing`, logs event
- Added `_handleRecoveredToPrinting(printer)` — auto-unhollds held printer when it comes back printing with an active job
- `statusChange` handler now routes `OFFLINE` to `_handlePrinterOffline` and `PRINTING` to `_handleRecoveredToPrinting`; `ERROR` continues to use `_handlePrinterUnavailable`

**`server/routes/printers.js`**
- `GET /api/printers` now includes `has_active_job` (1/0) — used by Fleet UI to distinguish held OFFLINE printers that have a job in progress

**`server/index.js`**
- `POST /api/printers/:id/set-ready` skips qty crediting and job-finish when the printer is `OFFLINE` with a `printing` job

**`client/src/pages/Fleet.jsx`**
- New `needsOfflineConfirmation` condition: `is_held === 1 && status === 'OFFLINE' && has_active_job === 1`
- Amber card border/background for offline-with-job printers
- Amber banner counts printers in this state with auto-clear note
- **Job OK** and **Job Failed** buttons on affected cards; no qty input or batch-select checkbox (each needs individual decision)

---

## 2026-04-11 — Ceiling-hit log message corrected

The scheduler's ceiling-hit log included the probe job in the active count, making it read "26 active jobs cover 25 remaining" when in reality 25 jobs were covering 25 slots. The probe is always inserted before the check and deleted on ceiling hit, so the correct message subtracts 1.

### Changes

**`server/scheduler.js`**
- Ceiling-hit log now reads `N of M jobs already active` where N is `activeCount - 1`

---

## 2026-04-11 — Active printing jobs shown in part progress bars

Part progress bars in the Projects page and Dashboard now display a third segment representing jobs that are currently printing (but not yet finished). Previously the bar was a single fill (green if closed, blue if open).

**Bar segments:**
- **Green** — `completed_qty` (confirmed done)
- **Blue** — `active_qty` (sum of `parts_per_plate` for all `uploading`/`printing` jobs on this part)
- **Dark background** — not yet started

When active jobs push the total past `target_qty` (due to batch ceiling rounding), the bar rescales against `max(target, completed + active)` and an amber tick mark appears at the target position.

**Number annotation:** `976 +24 printing / 1000` — the `+N printing` label is blue and only appears when active jobs exist. `Have` always reflects confirmed-complete qty, not the optimistic total.

### Changes

**`server/routes/parts.js`**
- All three `GET /api/parts` queries now include `active_qty` via a correlated subquery on `jobs` (status `uploading` or `printing`)

**`server/routes/dashboard.js`**
- Parts fetch in `GET /api/dashboard` includes the same `active_qty` subquery

**`client/src/pages/Projects.jsx`**
- 3-segment progress bar using absolute-positioned divs
- `+N printing` annotation in the count label
- Amber tick mark at target position when rescaled past 100%
- Status badge (Open/Closed) is now fixed 54px width so all bars end at the same point
- Printer model chips removed from the part row (still visible in the Details panel)

**`client/src/pages/Dashboard.jsx`**
- Same 3-segment bar treatment as Projects page

---

## 2026-04-11 — Batch set-ready log reads actual batch size from DB

The `[server] Batch set-ready` log message had "batches of 10" hardcoded. It now reads `dispatch_batch_size` from the settings table at log time, accurately reflecting whatever the operator has configured.

### Changes

**`server/index.js`**
- `POST /api/printers/set-ready-batch` reads `dispatch_batch_size` from DB before logging

---

## 2026-04-10 — Elegoo status 18 mapped to PRINTING

Status code 18 from the Elegoo SDCP protocol is a transient startup state (file loaded, `Progress=0`, `CurrentLayer=0`) observed on Centauri Carbon printers between `IDLE` and active printing. It now maps to `PRINTING` alongside codes 16 and 21, eliminating the spurious `IDLE → UNKNOWN → PRINTING` transition in the poller log.

### Changes

**`server/drivers/elegoo-centauri.js`**
- Added `case 18: return 'PRINTING'` to `mapStatus()`

---

## 2026-04-10 — Silence sdcp library debug log spam

The `sdcp` npm package had two unconditional `console.log()` calls in `SDCPPrinterWS.js` that dumped the full `Printer` object and `WebSocket` object to stdout on every connection attempt (every poll cycle per Elegoo printer). These were debug statements left in by the library author.

Patched via `patch-package` so the fix survives `npm install`. A `postinstall` script in `package.json` re-applies the patch automatically.

### Changes

**`patches/sdcp+0.5.4.patch`** — new file; removes two unconditional `console.log` calls from `SDCPPrinterWS.js`

**`package.json`**
- Added `"postinstall": "patch-package"` to scripts
- Added `patch-package ^8.0.1` to devDependencies

---

## 2026-04-10 — Scheduler cascades to next part when ceiling is hit

Previously, when a batch of printers was dispatched and the highest-priority part's remaining quota was already fully covered by active jobs (ceiling hit), surplus printers returned `null` and sat idle. They did not fall through to the next open part in the project.

Now `_dispatchToPrinter` walks candidates in priority order, skipping any part whose active job count already covers its remaining qty, until it finds a part that needs a job or exhausts all options. This means that in a large harvest (e.g. 55 printers set ready at once), machines that can't contribute to the top part automatically pick up work on the next part down the list.

### Changes

**`server/scheduler.js`**
- Replaced single `LIMIT 1` candidate query with a `while` loop that tracks `skippedPartIds` and re-queries with `NOT IN (...)` on ceiling hits
- Ceiling-hit path now logs and continues the loop instead of returning `null`

---

## 2026-04-10 — Parts list column alignment

The parts list in the Projects view had a staggered layout because the name column used `flex: '1 1 100px'`, causing it to grow to different widths across rows and pushing the progress bar to inconsistent starting positions. Row items could also wrap onto a second line.

### Changes

**`client/src/pages/Projects.jsx`**
- Name column: changed from `flex: '1 1 100px', minWidth: 80` to `width: 200, flexShrink: 0` (fixed width)
- Progress column: changed from `flex: '2 1 160px', minWidth: 120` to `flex: 1, minWidth: 0`
- Row container: removed `flexWrap: 'wrap'`

---

## 2026-04-09 — Inline rename on Printer detail page

Operators can now rename a printer from the Printer detail view. Clicking the **Rename** button next to the printer name swaps the header into an inline edit field with Save / Cancel controls (Escape also cancels). The save path `PUT /api/printers/:id` already supported `name` updates — this is a UI-only addition. Duplicate names surface the server's 409 error inline.

### Changes

**`client/src/pages/PrinterDetail.jsx`**
- Added `editingName`, `nameDraft`, `nameError`, `renaming` state
- Added `startRename` / `cancelRename` / `submitRename` handlers that PUT `/api/printers/:id`
- Header row conditionally renders either the name + Rename button or an inline form with an input, Save, Cancel

---

## 2026-04-09 — Fix phantom completion on server restart with held Bambu printer

Fixes a critical part-count bug: every time the server was restarted with a Bambu printer sitting in the `FINISHED` + held state (awaiting operator confirmation), the printer's completed print was re-credited to its Part, inflating the production count.

### Root cause

`scheduler._handleFinished` has a fallback (added in f86fe5b) that credits a recently-failed job when a Bambu printer transitions into `FINISHED` without an active `printing` job — this handles the legitimate case where a transient MQTT disconnect marks the job `failed` but the printer keeps printing and finishes.

The original query was `status = 'failed' AND started_at > now - 24h`, which matched **any** old failed job. On server restart:

1. Bambu printer was `FINISHED` + `is_held = 1` before shutdown; last job already credited normally.
2. First poll tick: Bambu MQTT not yet connected → driver returns `OFFLINE`. DB stamps `status = 'OFFLINE'`.
3. Second poll tick (~15 s later): MQTT reconnected, Bambu still reports `gcode_state = 'FINISH'` → `newStatus = 'FINISHED'`. `OFFLINE → FINISHED` transition fires `_handleFinished`.
4. No active printing job exists. The 24 h fallback matches any stale failed job sitting in the DB from prior runs and credits its `parts_per_plate` to the Part. Phantom completion.

The same unsafe query also existed in the `POST /api/printers/:id/set-ready` MQTT-recovery fallback.

### Fix

Gate the fallback on the current server process lifetime instead of a 24 h window. `JobScheduler` now stamps `this.startedAt = Date.now()` in `start()`, and both fallbacks filter with `finished_at > scheduler.startedAt`. Only jobs that `_handlePrinterUnavailable` failed **during this process run** can be recovered, so nothing from a prior session can be credited on reconnect.

This preserves the legitimate transient-MQTT-disconnect recovery path (the job is failed and then recovered inside the same process) while closing the restart re-credit path.

### Changes

**`server/scheduler.js`**
- Constructor: `this.startedAt = 0`
- `start()`: stamps `this.startedAt = Date.now()` before logging
- `_handleFinished` fallback query: `WHERE status = 'failed' AND finished_at > ?` bound to `this.startedAt`, ordered by `finished_at DESC`
- Updated inline comment explaining the gate and the bug it prevents

**`server/index.js`**
- `POST /api/printers/:id/set-ready` MQTT-recovery fallback: same gate, using `scheduler.startedAt`

**`server/tests/scheduler-finished.test.js`**
- `seedJob` now stamps `finished_at` on `'failed'` rows (mirrors `_handlePrinterUnavailable`)
- Replaced the "24 h window" describe block with a "session gating" block including:
  - `does not recover a failed job finished before the session started` (bug repro)
  - `does not mark a stale failed job as finished`
  - `does recover a failed job finished after the session started` (legit path)

**`server/tests/set-ready.test.js`**
- `makeApp` default scheduler now includes `startedAt: 0`
- Route handler copy updated to use `finished_at > scheduler.startedAt`
- `seedJob` stamps `finished_at` on `'failed'` rows
- Replaced the "older than 24 hours" test with `does not credit a failed job finished before the session started` (bug repro at the set-ready entry point)

### Verification

All 233 tests across 17 suites pass, including the three new bug-repro tests that would fail before this fix.

---

## 2026-04-09 — Dashboard refresh-countdown timer

Adds the circular refresh-countdown ring to the Dashboard header so operators watching the TV command center can see how long until the next data poll. Previously only the Fleet page exposed this indicator.

### Changes

**`client/src/components/PollTimer.jsx`** (new)
- Extracted the inline `PollTimer` from `Fleet.jsx` into a shared component
- Props: `lastPolled`, `intervalMs` (default 15000), `size` (default 20), `stroke`, `track`
- Stroke width scales with size (`max(2, size/8)`) so it looks right at both 20px (Fleet) and 28px (Dashboard)

**`client/src/pages/Dashboard.jsx`**
- Tracks `lastPolled` in state; stamped on each successful `/api/dashboard` fetch
- Renders `<PollTimer size={28} />` in the header between the clock and the TV-mode button
- `POLL_INTERVAL_MS` (15000) lifted to a constant so the fetch loop and the timer share one source

**`client/src/pages/Fleet.jsx`**
- Removed the local `PollTimer` definition; now imports the shared component
- Explicitly passes `intervalMs={15000}` to preserve existing behavior

**`docs/web-app.md`**
- Added the new `components/PollTimer.jsx` entry to the Key Files table

---

## 2026-04-09 — Bambu .3mf support + AMS slot selection

Adds full Bambu Lab print dispatch via `.3mf` files and live AMS slot selection in the upload form.

### Problem
`.gcode` files sent to Bambu printers via the `gcode_file` MQTT command always force printing from the external spool, ignoring any AMS configuration. `.3mf` files exported from Bambu Studio embed all slicer and AMS settings and use the `project_file` MQTT command, which respects those settings.

### Changes

**`server/drivers/bambu.js`**
- File type detection: `.3mf` uses `project_file` MQTT command + FTP root upload; `.gcode`/`.bgcode` use `gcode_file` + FTP root upload
- `project_file` payload: `url: ftp:///<filename>` (per OpenBambuAPI spec); `use_ams` and `ams_mapping` driven by `amsSlot` from gcode record
- New export: `getAmsSlots(printer)` — reads live AMS state from cached MQTT payload, returns slot list with type + color for each loaded tray plus external spool
- `uploadAndPrint` now accepts `options.amsSlot` (4th arg); `-1` = external spool, `0–N` = AMS tray, `null` = external (default)

**`server/db.js`**
- Migration: `ALTER TABLE gcodes ADD COLUMN ams_slot INTEGER` (nullable; `-1` = external, `0–N` = AMS slot, `null` = non-Bambu)

**`server/routes/printers.js`**
- New: `GET /api/printers/ams?model=...` — returns live slot list from any connected Bambu printer of that model; returns `[]` for non-Bambu models or no connected printer

**`server/routes/gcodes.js`**
- Accepts `ams_slot` in upload body; stored in `gcodes` table

**`server/scheduler.js`**
- `ams_slot` added to candidate query; passed as `options.amsSlot` to `uploadAndPrint`

**`client/src/pages/Projects.jsx`**
- File picker now accepts `.3mf` in addition to `.gcode`/`.bgcode`
- When a Bambu model is selected, fetches `/api/printers/ams?model=...` and shows a live AMS slot dropdown (populated with filament type per slot + external spool option)
- `ams_slot` is required before upload when AMS slots are available; included in FormData

---

## 2026-04-09 — Printer event log + Printers browser

Persistent audit trail for each printer. Every significant machine event — job completions, failures, decommissions, recommissions, and freeform operator notes — is now recorded to a `printer_events` table and never deleted. A new **Printers** page lets you browse the full fleet and click into any machine's timeline.

### New files
- `server/events.js` — singleton helper (`insert(printerId, eventType, note)`) used at all call sites
- `server/routes/events.js` — `GET /api/printers/:id/events`, `POST /api/printers/:id/events`; mounted as sub-router on `/api/printers`
- `client/src/pages/Printers.jsx` — searchable list of all printers (active + decommissioned); click any row to open the detail view
- `client/src/pages/PrinterDetail.jsx` — printer header (name, model, IP, status), inline "Add note" form, full event timeline with type badge + timestamp

### Modified files
- `server/db.js` — `printer_events` table added to `CREATE TABLE IF NOT EXISTS` block; no migration needed (new table)
- `server/routes/printers.js` — mounts events sub-router; inserts events on decommission and both mark-job-failure paths
- `server/index.js` — inserts `recommission` event when printer is returned to active fleet
- `server/scheduler.js` — inserts `job_finished` event in `_handleFinished` (part name + qty in note)
- `server/routes/backup.js` — `printer_events` included in export and restore; backwards-compatible (`|| []` fallback for old backup files)
- `client/src/App.jsx` — "Printers" nav item added between Fleet and Projects; routes for `/printers` and `/printers/:id`; `end` prop support on NavLink items
- `client/src/pages/Decommissioned.jsx` — note save now also writes a `note` event to `printer_events`; "View History" button links to PrinterDetail

### Event types recorded automatically
| Event | Trigger |
|---|---|
| `job_finished` | Scheduler `_handleFinished` — includes part name and plate qty |
| `job_failed` | `mark-job-failure` — both the tracked-job and no-job paths |
| `decommission` | `POST /api/printers/:id/decommission` |
| `recommission` | `POST /api/printers/:id/recommission` |
| `note` | Operator via PrinterDetail or Decommissioned page |

### Schema
```sql
CREATE TABLE IF NOT EXISTS printer_events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  printer_id  INTEGER NOT NULL,  -- no FK — history survives printer deletion
  event_type  TEXT NOT NULL,
  note        TEXT,
  created_at  INTEGER NOT NULL
);
```

---

## 2026-04-09 — Elegoo status 9 fix + decommission bug fix

### Bug fixes

**Elegoo status code 9 mapped to FINISHED** (`server/drivers/elegoo-centauri.js`)
- Status code 9 was observed on Centauri Carbon overnight after a print completed: `CurrentLayer === TotalLayer`, `Filename` cleared, `Progress = 0`. This is a post-completion state that the firmware enters after the print ends.
- Previously mapped to `UNKNOWN`, which prevented `_handleFinished` from firing, left the job stuck in `'printing'` state, and flooded the console with repeated UNKNOWN log lines.
- Now correctly mapped to `FINISHED`. Operator confirmation will fire as expected.

**`mark-job-failure` now decommissions even when no tracked job exists** (`server/routes/printers.js`)
- Previously returned `404` if no `finished`/`printing` job was found for the printer. This silently blocked the decommission because the UI wasn't checking the response.
- Root cause: prints that finished while the printer was in `UNKNOWN` status (e.g. status code 9 before today's fix) never had their job transitioned, so `mark-job-failure` found nothing.
- Now: if no job is found, the printer is still decommissioned. The response returns `{ success: true, job_id: null }`.

**`badPrint()` in Fleet.jsx now surfaces errors** (`client/src/pages/Fleet.jsx`)
- The fetch call was fire-and-forget — if the API returned an error, the UI silently refreshed with no change.
- Now checks `res.ok` and shows an `alert()` with the error detail if the call fails.
- Also fixed the plain `decommission()` function the same way.

### Tests added
- `server/tests/printers-decommission.test.js` — 10 tests covering `mark-job-failure` (finished job, printing job, no-job fallback, qty undo, part reopen) and `decommission` (sets is_active=0, appears in decommissioned list, absent from active list)
- `server/tests/elegoo-driver.test.js` — added status code 9 → FINISHED test case

---

## 2026-04-08 — Printer Models refactor: DB-backed model registry

Replaces all hardcoded printer model lists (previously duplicated in `printers.js`, `gcodes.js`, `Projects.jsx`, `Settings.jsx`, `Fleet.jsx`, `Dashboard.jsx`) with a single source of truth: a `printer_models` DB table managed by operators in **Settings → Printer Models**.

### New files
- `server/routes/models.js` — `GET /api/models`, `POST /api/models`, `DELETE /api/models/:model_id`. Delete is blocked if any printers are using that model.

### Modified files
- `server/db.js` — creates `printer_models` table on startup; auto-seeds from models already in use by `printers` and `gcodes` tables via `INSERT OR IGNORE` (idempotent, runs once)
- `server/index.js` — mounts the models router at `/api/models`
- `server/routes/printers.js` — removed `VALID_MODELS` hardcode; model validation is now a DB query; `serial_number` field added for Bambu printers
- `server/routes/gcodes.js` — removed inline `VALID_MODELS`; validates via DB query
- `client/src/pages/Settings.jsx` — new **Printer Models** management section (table, add form, per-row delete); Add Printer model dropdown is dynamically filtered by connector; removed all hardcoded model constants
- `client/src/pages/Projects.jsx` — G-code upload model picker fetches from `/api/models` instead of a hardcoded list
- `client/src/pages/Fleet.jsx` — grouping and labels derived from `/api/models`
- `client/src/pages/Dashboard.jsx` — grouping and labels derived from `/api/models`

### Migration behaviour
- **New installs:** `printer_models` starts empty; operator adds models in Settings before adding printers
- **Existing installs:** auto-seed populates the table from models already referenced in `printers` + `gcodes` tables — no manual action required after `update.bat`
- Connectors remain hardcoded (`prusa`, `elegoo-centauri`, `bambu`) — they require driver implementations

---

## 2026-04-08 — Phase 6B milestone: Elegoo SDCP connector finalized

### Connector naming
The driver family is now named **Elegoo SDCP** (parallel to **Prusa Link**). Both Centauri Carbon and Centauri Carbon 2 live under this family — they share the same protocol, firmware, and interface. The connector name reflects the brand + protocol, not the specific model.

### `getStatus()` now returns `currentFile`
Both drivers (`prusa.js`, `elegoo-centauri.js`) now include `currentFile` in the `getStatus()` return shape:
- **Elegoo SDCP:** populated from `PrintInfo.Filename` when PRINTING or PAUSED. The multer-prepended timestamp (`^\d+-`) is stripped before returning, so the display name is clean.
- **Prusa Link:** returns `null` — PrusaLink does not expose the filename in its status endpoint.

The poller was updated to prefer `result.currentFile` when populated, falling back to the existing jobs → gcodes DB join (used by Prusa). Elegoo printers no longer require a job record to display what's printing.

### Driver interface (final shape for 6B)

```
getStatus(printer)
  → { status, progress, timeRemaining, currentFile }

uploadAndPrint(printer, filePath, filename)
  → resolves when print confirmed started

cancelJob(printer)
  → resolves when cancellation confirmed

checkIfPrinting(printer)
  → boolean
```

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

Codes were refined through real hardware testing on a Centauri Carbon. Several firmware states fire during normal FDM startup that have no SDCP spec documentation.

| SDCP code | Canonical | Notes |
|---|---|---|
| 0 | IDLE | |
| 1 | PRINTING | |
| 2 | PAUSED | |
| 3 | FINISHED | Stopped — triggers operator confirmation |
| 4 | FINISHED | Normal completion |
| 13 | PRINTING | Active print (layer incrementing) — observed on Centauri Carbon firmware |
| 16 | PRINTING | Preparing/preheating/homing before print starts |
| 21 | PRINTING | Startup/init state, file loaded but CurrentLayer=0 |
| any other | UNKNOWN | Logged for future mapping; does not hold the printer |

Unknown codes return `UNKNOWN` (not `ERROR`) so undocumented transient firmware states don't incorrectly hold printers. Any new codes observed will surface in the server log with full PrintInfo for classification.

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
