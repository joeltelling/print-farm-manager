# API Reference

In **production** (after `npm run build && npm start`) the Express server at port 3000 serves both the API and the React client. Access from any browser on the LAN via `http://[server-ip]:3000`.

In **development** (`npm run dev`) the Vite dev server at port 5173 proxies all `/api/*` requests to port 3000.

All request bodies are JSON (`Content-Type: application/json`) unless noted otherwise. All responses are JSON. Timestamps are Unix epoch milliseconds.

---

## Health

### `GET /api/health`

```json
{ "status": "ok", "timestamp": 1774903214349 }
```

---

## Printers

### `GET /api/printers`

Returns all active printers (`is_active = 1`) ordered by name.

```json
[
  {
    "id": 1,
    "name": "MK4S_01",
    "ip": "192.168.1.100",
    "api_key": "aK3jR7xQ2pLm9vN",
    "group_name": "MK4S Farm",
    "type": "prusa",
    "model": "mk4s",
    "status": "PRINTING",
    "is_held": 1,
    "is_active": 1,
    "job_name": "4x Left Bracket_0.20n_MK4S_5h11m.bgcode",
    "job_progress": 45.2,
    "job_time_remaining": 10140,
    "created_at": 1774903214387
  }
]
```

`job_name`, `job_progress`, and `job_time_remaining` are non-null only while `status = "PRINTING"`, and are cleared to `null` when the printer leaves that state.

`last_parts_per_plate` is the `parts_per_plate` from the most recent finished (or currently printing) job, the Fleet UI's fallback for the confirmed-qty input.

`confirm_job_id`, `confirm_parts_per_plate`, and `confirm_credited` are set only on held printers whose next "N good" confirmation corrects an already-finished job (`null` otherwise, including while an uploading or printing job is pending). They name that job, its plate size, and what it currently contributes to its part (its net in `part_qty_ledger`: the full plate unless an operator already corrected it). The Fleet UI pre-fills the count with `confirm_credited` and sends `confirm_job_id` back as `job_id` on `set-ready` and `complete-and-decommission`. The job is chosen by `finishedConfirmTarget()` in `server/confirmCount.js`, the same rule those endpoints use.

`has_active_job` is `1` if the printer currently has a job in `uploading` or `printing` status, `0` otherwise — used by the Fleet UI to show the OFFLINE-with-job confirmation buttons.

`uploading_job_name` is the filename of the printer's active `uploading` job (`null` when none). The Fleet UI uses it with `has_uploading_job` to display an "Uploading" status overlay while a file transfers — the hardware still reports IDLE during transfer, so this is presentation-only and never written back to `status`.

### `GET /api/printers/ams?model=<model_id>`

Returns the live AMS slot list from any connected Bambu printer of the given model. Used by the upload form to populate the slot picker.

Returns `[]` if no active Bambu printer of that model is connected or the model is not a Bambu type.

**Response** (example with one AMS and external spool):
```json
[
  { "slot": 0, "type": "PLA", "color": "FFFFFFFF" },
  { "slot": 1, "type": "PETG", "color": "000000FF" },
  { "slot": -1, "type": "PLA", "color": "FF6600FF" }
]
```

`slot` values: `0–N` = AMS tray (compound id: `ams_unit * 4 + tray_id`), `-1` = external spool.

---

### `GET /api/printers/:id`

Returns a single printer by ID. `404` if not found.

### `POST /api/printers`

Create a single printer.

**Body:**
```json
{
  "name": "MK4S_01",
  "ip": "192.168.1.100",
  "api_key": "aK3jR7xQ2pLm9vN",
  "model": "mk4s",
  "group_name": "MK4S Farm",
  "type": "prusa"
}
```

Required: `name`, `ip`, `api_key`, `model`. Optional: `group_name`, `type` (defaults to `"prusa"`).

`model` must be one of: `mk4`, `mk4s`, `c1`, `c1l`, `xl`.

Returns `201` with the created printer object. Returns `409` if `name` already exists.

### `PUT /api/printers/:id`

Partial update — only fields provided are changed (uses `COALESCE`). All fields from POST are accepted, plus `is_held` (`0` or `1`).

Changing `ip`, `api_key`, `serial_number`, or `type` drops the driver's cached connection for this printer, so the new settings take effect on the next poll (about 15 seconds) with no server restart.

Changing `loaded_material`, `loaded_color`, `group_name`, or `model` triggers a scheduler sweep of idle printers, so an already-idle printer that now matches a waiting part is dispatched immediately (idle printers otherwise only ask for work when they transition into IDLE). `loaded_material` and `loaded_color` are trimmed; an empty or whitespace-only value clears the field.

Returns `404` if not found, `409` on name conflict.

### `DELETE /api/printers/:id`

```json
{ "success": true }
```

Also drops the driver's cached connection for this printer. Decommissioning (all three variants: `decommission`, `complete-and-decommission`, `mark-job-failure`) does the same, so an inactive row can never hold a live client that competes with a replacement entry for the same physical printer.

Returns `404` if not found.

### `POST /api/printers/:id/set-ready`

Releases the printer's hold (`is_held = 0`) and immediately dispatches the next eligible job to it. Called by the Fleet UI when an operator confirms a print is good.

Accepts an optional body:
```json
{ "confirmed_qty": 24, "job_id": 1381 }
```

When the printer's last print is a finished job that was already credited, `confirmed_qty` corrects it:

- **With `job_id`** (what the Fleet UI sends, from `confirm_job_id`): `confirmed_qty` is the plate's **total** good count. The part is adjusted by `confirmed_qty` minus what the job currently contributes, so 24 of 25 subtracts 1 and confirming 24 again changes nothing. If `job_id` is not the job this confirmation would correct (a new print finished, a print started, or the job was stopped on the printer since the page loaded), the request is refused with `409` and nothing changes.
- **Without `job_id`** (older clients, scripts): `confirmed_qty` is compared to the job's `parts_per_plate`, as before. Sending the same correction twice applies it twice.

If the correction closes or reopens the part, its status follows. Omitting `confirmed_qty` leaves `completed_qty` unchanged.

**Errors:** `404` printer not found; `409` `{ "error": "This printer's last print changed since the page loaded. Refresh and confirm the count again." }` when `job_id` no longer matches.

**OFFLINE-with-job exception:** if the printer's current status is `OFFLINE` and it has a `printing` job (no finished job), qty is not credited and the job is not marked finished. The printer is simply unheld and the job continues to its natural finish. This is the "Job OK" path from the Fleet UI — the operator is confirming the job is still running, not that it completed.

Returns the updated printer object.

### `POST /api/printers/:id/decommission`

Removes the printer from active duty (`is_active = 0`). It will no longer be polled or receive jobs. Returns the updated printer object.

### `POST /api/printers/:id/complete-and-decommission`

Operator confirms the last print was successful, then takes the machine offline for maintenance instead of releasing it to the job queue.

- **Normal case** (job already in `finished` status): `_handleFinished` already credited `completed_qty`; nothing is re-credited. `confirmed_qty` corrects it exactly as in `set-ready`: with `job_id` it is the plate's total good count against the job's current contribution (and a stale `job_id` is a `409` with nothing changed, the printer staying active); without `job_id` it is compared to `parts_per_plate` against the latest finished job, as before. The printer is then decommissioned.
- **Missed-finish case** (job still in `printing` status): credits `completed_qty` by `parts_per_plate`, marks the job `finished`, and closes the Part / Project if targets are met — same logic as `set-ready`, but ending in decommission rather than dispatch.

Returns the updated printer object.

### `POST /api/printers/:id/recommission`

Returns a decommissioned printer to active duty (`is_active = 1`, `is_held = 0`, clears `decommissioned_at`/`decommission_note`), logs a `recommission` event, and immediately dispatches the next eligible job via `scheduler.scheduleForPrinter`. Returns the updated printer object.

The dispatched job is marked `printing` before the next poll has updated the printer's stored status, so it briefly looks like an orphaned job on an `IDLE`/`FINISHED` printer. The scheduler's stale-job auto-fail only fires on jobs older than `STALE_JOB_GRACE_MS` (90s), so a freshly recommissioned-and-dispatched printer is not wrongly re-held if another dispatch (e.g. "Scan for Jobs") runs before the printer is re-polled as `PRINTING`.

### `POST /api/printers/:id/mark-job-failure`

Marks the printer's most relevant active or recently-completed job as `failed`, undoes the `completed_qty` increment if needed, reopens the Part and Project if needed, and decommissions the printer (`is_active = 0`).

**Job selection — two-query priority:**

1. **Active first:** finds the most recent `printing` or `uploading` job (`ORDER BY started_at DESC`). These jobs were never credited to `completed_qty`, so no undo is needed.
2. **Finished fallback:** if no active job exists, finds the most recent `finished` job — but only if no subsequent job was created for this printer after it finished. This scope guard prevents the endpoint from reaching back and decrementing `completed_qty` on an old job from a previous cycle when the printer is held for an unrelated reason.

**Per-status behaviour:**
- `finished`: `completed_qty` decremented by what the job currently contributes, its net in `part_qty_ledger`. That is `parts_per_plate` unless an operator already corrected the plate's count (a plate confirmed as 3 of 4 good deducts 3); nothing is deducted if it already contributes 0. Part reopened if it was closed by this job; Project reopened if it was completed.
- `printing` — no qty change (was never credited).
- `uploading` — no qty change (print never started).

If no tracked job matches any of the above, the printer is still decommissioned — operator intent is always to take the machine offline.

Returns `{ "success": true, "job_id": N }` (or `job_id: null` when no job was found). Returns `404` only if the printer itself does not exist.

### `GET /api/printers/:id/linkable-jobs`

Returns jobs in `failed` or `uploading` status whose G-code was sliced for this printer's model. Used by the Fleet UI job-link picker. Returns up to 20 results, newest first.

Each job includes `part_name`, `gcode_filename`, `original_printer_name` (the printer it was originally dispatched to), and `original_printer_id`.

### `POST /api/printers/:id/link-job`

Manually associates a failed or stalled job with this printer — for record keeping when a job was dispatched but the upload appeared to fail while the printer actually started printing.

**Body:** `{ "job_id": N }`

Sets `jobs.status` to `'printing'`, updates `jobs.printer_id` to this printer, sets `jobs.started_at` if not already set, and releases the printer's hold (`is_held = 0`).

Returns `409` if the job is not in `failed` or `uploading` status. Returns `404` if the printer or job does not exist.

### `GET /api/printers/:id/events`

Returns all events for a printer, newest first.

```json
[
  {
    "id": 12,
    "printer_id": 57,
    "event_type": "job_failed",
    "note": "Job 304 — part: Left Bracket",
    "created_at": 1775001234567
  }
]
```

Event types: `decommission`, `recommission`, `job_finished`, `job_failed`, `note`.

Returns `404` if the printer does not exist.

### `POST /api/printers/:id/events`

Adds a freeform operator note to the printer's event log.

**Body:**
```json
{ "note": "Nozzle replaced, tension checked — cleared to run." }
```

Returns `201` with the created event object. Returns `400` if `note` is missing or blank. Returns `404` if the printer does not exist.

### `GET /api/printers/:id/raw-status`

Proxies a live `GET /api/v1/status` call to the printer's PrusaLink API and returns the raw response. Used for debugging printer state from the Fleet UI (click any printer card to trigger this in the browser console).

```json
{
  "printer": { "id": 1, "name": "MK4S_35", "ip": "192.168.1.100" },
  "raw": { "printer": { "state": "IDLE", ... }, "storage": { ... } }
}
```

### `POST /api/printers/import`

Bulk import from CSV. `Content-Type: multipart/form-data`, field name `file`.

**CSV format** (header row required, column order flexible):

```
name,ip,api_key,group,type,model
MK4S_01,192.168.1.100,aK3jR7xQ2pLm9vN,MK4S Farm,prusa,MK4S
C1 Rarity,192.168.1.101,bR5mQ8nZ4vKs2Pw,CORE One Farm,prusa,C1
```

The `model` column is optional but strongly recommended. Valid values (case-insensitive): `MK4`, `MK4S`, `C1`, `C1L`, `XL`. When present it takes priority over name inference — any printer name is valid.

**Import rules:**
- If `model` column is present and valid, it is used directly (normalized to lowercase)
- If `model` column is absent or blank, model is inferred from `name` — see [database.md](database.md)
- If both fail, the row is **flagged** — not saved until operator resolves via the Settings UI or `POST /api/printers`
- Rows whose `name` already exists in the DB are **skipped** (not overwritten)
- Rows missing `name`, `ip`, or `api_key` are flagged

**Response:**
```json
{
  "imported": 2,
  "skipped": 1,
  "flagged": [
    {
      "row": { "name": "Twilight", "ip": "192.168.1.102", "api_key": "...", "group": "Core One Farm", "type": "prusa" },
      "reason": "Cannot infer model from name \"Twilight\". Please specify model manually."
    }
  ]
}
```

---

## Groups

Persisted registry of printer group names (see `printer_groups` in [database.md](database.md)). Independent of `printers.group_name`: a group stays registered even when no printer currently carries it, which is what lets a G-code's or project's `allowed_groups` restriction stay meaningful (and editable) after every printer in that group is reassigned elsewhere.

### `GET /api/groups`

Returns all registered groups, ordered by name.

```json
[{ "name": "Rack A", "created_at": 1783800000000 }]
```

### `POST /api/groups`

**Body:** `{ "name": "Rack A" }`. Required, trimmed. Returns `201` with the created row, or `409` if the name already exists.

Groups are also registered automatically: creating or updating a printer with a non-empty `group_name` not already in the registry adds it silently (see `POST /api/printers`, `PUT /api/printers/:id`, `POST /api/printers/import`).

### `DELETE /api/groups/:name`

Returns `404` if the group doesn't exist. Returns `409` if it's still referenced anywhere (an active printer's `group_name`, a G-code's `allowed_groups`, or a project's `allowed_groups`), with a message naming which:

```json
{ "error": "Cannot delete: group \"Rack A\" is used by 2 active printer(s), 1 G-code restriction(s)" }
```

---

## Projects

### `GET /api/projects`

Returns all projects ordered by `created_at DESC`.

### `GET /api/projects/:id`

Returns a single project. `404` if not found.

### `POST /api/projects`

Required: `name`. Optional: `description`.

Returns `201` with created project (`status` defaults to `"draft"`).

### `PUT /api/projects/:id`

Partial update. Accepts: `name`, `description`, `status` (`draft` | `active` | `paused` | `completed`).

When setting `status` to `active`, the UI also calls `POST /api/scheduler/dispatch` to trigger an immediate sweep of idle printers.

### `PUT /api/projects/:id/filament`

Sets project-wide default `required_material` / `required_color`, applied to every G-code in the project that doesn't set its own override.

**Body:** `{ "required_material": "PETG", "required_color": "Red" }`. Either field, empty string, or omitted resolves to `NULL` (no default).

Triggers a scheduler sweep of idle printers, since a new default can make an already-idle printer a match. Returns the updated project, or `404` if not found.

### `PUT /api/projects/:id/groups`

Sets a project-wide default `allowed_groups`, applied to every G-code in the project that doesn't set its own `allowed_groups` override. Mirrors `PUT /api/gcodes/:id`'s `allowed_groups` field, and follows the same gcode-overrides-project precedence as `/filament` above; see the "Targeting cascade" note in [database.md](database.md).

**Body:** `{ "allowed_groups": ["Rack A", "Rack B"] }`. An empty array (or omitted) clears the project default back to unrestricted.

Triggers a scheduler sweep of idle printers, same reason as `/filament`. Returns the updated project, or `404` if not found.

### `DELETE /api/projects/:id`

---

## Parts

### `GET /api/parts`

Optional query param `?project_id=N` to filter by project. Results ordered by `sort_order ASC, created_at ASC`.

Each part includes `active_qty` — the sum of `parts_per_plate` across all `uploading` or `printing` jobs for that part. Used by the progress bars in the Projects and Dashboard pages to show in-flight work.

### `GET /api/parts/queue`

Data for the Print Queue page (Fleet > Print Queue). Every `open` part of every `active` project, in the order the scheduler considers them (project `priority`, project age, part `sort_order`, part age: the same `ORDER BY` as `server/candidate-query.js`), each with the printers that match it or, when none do, the reasons why. Read-only. No parameters, so no `400`/`404` cases.

```json
{
  "version": "3f9c1a0b7d2e4c55",
  "parts": [
    {
      "position": 1,
      "part_id": 7, "part_name": "Hinge",
      "project_id": 2, "project_name": "Rush order", "project_priority": 0,
      "target_qty": 20, "completed_qty": 6, "active_qty": 2, "remaining_qty": 14,
      "dispatchable": true,
      "blockers": [],
      "matches": [
        {
          "id": 3, "name": "MK4S_03", "model": "mk4s", "status": "IDLE", "is_held": 0,
          "group_name": "Rack A", "loaded_material": "PETG", "loaded_color": "Black",
          "state": "ready",
          "next_up": { "part_id": 7, "part_name": "Hinge", "project_name": "Rush order", "is_this_part": true },
          "gcode_id": 12, "filename": "hinge_mk4s.bgcode"
        }
      ],
      "no_match_reasons": []
    },
    {
      "position": 2,
      "part_id": 9, "part_name": "Lid",
      "project_id": 2, "project_name": "Rush order", "project_priority": 0,
      "target_qty": 5, "completed_qty": 0, "active_qty": 0, "remaining_qty": 5,
      "dispatchable": false,
      "blockers": [],
      "matches": [],
      "no_match_reasons": ["lid_xl.bgcode: no printer has ASA / Black loaded (set it on the printer's detail page)"]
    }
  ]
}
```

- `version`: the schedule freshness fingerprint, identical to `GET /api/schedule/version`. The page polls that endpoint and refetches the queue when it moves. It does not hash display names, so a rename alone does not change it.
- `matches[]`: printers whose model, group, and loaded filament match one of the part's G-codes, with `state` `ready`, `busy`, or `held`. These are the same printer objects as `gcodes[].printers[]` on `GET /api/parts/:id/dispatch-status` (plus the G-code's `gcode_id` and `filename`); `wrong_group` and `wrong_filament` printers are left out. A printer holding an `uploading` or `printing` job row is `busy` even while its last polled status still reads IDLE or FINISHED, because the scheduler will not dispatch to it.
- `no_match_reasons[]`: populated only when `matches` is empty. Either the no-G-code reason, or one line per G-code saying whether no active printer of that model exists, none is in the allowed groups, or none has the required filament loaded.
- `blockers[]`: part-level reasons the part cannot dispatch even with matching printers, currently only "jobs already printing cover the remaining quantity".
- `dispatchable`: same meaning as on `dispatch-status`.

### `GET /api/parts/:id`

Also includes `active_qty` (same calculation as the list endpoint).

### `GET /api/parts/:id/dispatch-status`

Diagnostic for the "Why isn't this printing?" button on the Projects page. Mirrors the scheduler's eligibility rules and returns why the part is or isn't dispatching right now, plus every candidate printer and where it stands.

```json
{
  "dispatchable": true,
  "reasons": [],
  "notes": ["Every ready matching printer has higher-priority work queued first; this part prints after that work"],
  "gcodes": [
    {
      "gcode_id": 12,
      "filename": "bracket_mk4s.bgcode",
      "printer_model": "mk4s",
      "required_material": "PETG",
      "required_color": null,
      "allowed_groups": null,
      "printers": [
        {
          "id": 3, "name": "MK4S_03", "model": "mk4s", "status": "IDLE", "is_held": 0,
          "group_name": "Rack A", "loaded_material": "PETG", "loaded_color": "Black",
          "state": "ready",
          "next_up": { "part_id": 7, "part_name": "Hinge", "project_name": "Rush order", "is_this_part": false }
        },
        {
          "id": 4, "name": "MK4S_04", "model": "mk4s", "status": "IDLE", "is_held": 0,
          "group_name": "Rack A", "loaded_material": "PLA", "loaded_color": "Black",
          "state": "wrong_filament", "next_up": null
        }
      ],
      "mismatch": null
    }
  ]
}
```

- `reasons`: populated when `dispatchable` is `false`: global blockers (project not active, part complete, no G-code, remaining qty already covered by in-progress jobs) followed by per-G-code availability problems (no printers of that model, group/material/color mismatch, all matching printers busy or held).
- `notes`: populated when `dispatchable` is `true`: advisory per-G-code items (e.g. one G-code can dispatch but another has no ready printers), and a note when every ready matching printer would print a higher-priority part first.
- `gcodes[]`: one entry per G-code, with the effective targeting after the gcode-overrides-project cascade (`allowed_groups` is a parsed array or `null`).
- `gcodes[].printers[]`: every active printer of that model, ordered by name, including its `model`. `state` is checked in this order: `wrong_group`, `wrong_filament`, `held` (awaiting operator sign-off), `busy` (not IDLE, FINISHED, or STOPPED, or holding an `uploading`/`printing` job row), `ready`.
- `gcodes[].mismatch`: when no printer matches this G-code's targeting at all, the same sentence that appears in `reasons`/`notes` for it; `null` otherwise. `GET /api/parts/queue` uses it as the no-match reason.
- `gcodes[].printers[].next_up`: for `ready` printers only, the part the scheduler would dispatch to that printer right now, computed with the scheduler's own candidate query (`server/candidate-query.js`) and ceiling skip; `null` otherwise. Read-only: no job row is written.

Returns `404` if the part does not exist.

### `GET /api/parts/:id/audit`

The part's quantity audit trail: every change to `completed_qty`, which printer and job it came from, and the failures that took parts away. Read-only; backs the part audit page. Data comes from `part_qty_ledger` (see [database.md](database.md#part_qty_ledger)).

```json
{
  "part": { "id": 3, "project_id": 2, "name": "2x4 Gridfinity Bin", "target_qty": 200, "completed_qty": 134, "status": "open", "created_at": 1789083501777, "updated_at": 1790289501777 },
  "project": { "id": 2, "name": "Gridfinity Organizer Set", "status": "active" },
  "entries": [
    {
      "id": 41, "created_at": 1790203101777, "source": "print_finished", "delta": 6, "balance_after": 32,
      "note": null, "job_id": 88, "printer_id": 1, "printer_name": "MK4S_01", "printer_exists": true,
      "printer_current_name": "MK4S_01", "gcode_id": 7, "gcode_filename": "gridfinity_2x4_mk4s.bgcode",
      "parts_per_plate": 6, "job_status": "finished", "job_started_at": 1790195901777, "job_finished_at": 1790203101777
    },
    {
      "id": 42, "created_at": 1790203401777, "source": "operator_adjust", "delta": -1, "balance_after": 31,
      "note": "Operator confirmed 5 of 6 good (Set Ready)", "job_id": 88, "printer_id": 1, "printer_name": "MK4S_01",
      "printer_exists": true, "printer_current_name": "MK4S_01", "gcode_id": 7, "gcode_filename": "gridfinity_2x4_mk4s.bgcode",
      "parts_per_plate": 6, "job_status": "finished", "job_started_at": 1790195901777, "job_finished_at": 1790203101777
    }
  ],
  "uncredited_failures": [
    {
      "job_id": 90, "status": "failed", "parts_per_plate": 6, "started_at": 1790210000000, "finished_at": null,
      "created_at": 1790210000000, "printer_id": 2, "printer_name": "MK4S_02", "printer_exists": true,
      "gcode_id": 7, "gcode_filename": "gridfinity_2x4_mk4s.bgcode"
    }
  ],
  "printers": [
    { "printer_id": 1, "printer_name": "MK4S_01", "printer_exists": true, "plates": 5, "added": 30, "removed": 1, "net": 29, "failed_plates": 0 },
    { "printer_id": 2, "printer_name": "MK4S_02", "printer_exists": true, "plates": 0, "added": 0, "removed": 0, "net": 0, "failed_plates": 1 },
    { "printer_id": null, "printer_name": null, "printer_exists": false, "plates": 0, "added": 105, "removed": 0, "net": 105, "failed_plates": 0 }
  ],
  "reconciliation": { "ledger_sum": 134, "completed_qty": 134, "matches": true }
}
```

- `entries`: ledger rows, oldest first. `source` is one of `print_finished`, `operator_confirm`, `operator_adjust`, `marked_failed`, `manual_edit`, `rebuilt_job`, `baseline`, `recovered_job` (meanings in [database.md](database.md#part_qty_ledger)). `delta` is the change actually applied; `balance_after` is `completed_qty` right after it. `printer_name` is the name when the row was written; `printer_current_name` is the printer's name now, or `null` (with `printer_exists: false`) if the printer was deleted. `gcode_filename` and the `job_*` fields are `null` when the G-code or job no longer exists, and for manual edits and baseline rows.
- `uncredited_failures`: jobs for this part that started printing and ended `failed` or `cancelled` without ever changing the count. They had no effect on `completed_qty` and are listed for context. Excludes queued jobs cancelled before they started, and jobs that have ledger rows (a credited plate later marked failed appears in `entries` as a `marked_failed` deduction instead). Jobs from before the ledger existed that were credited then marked failed also appear here, because the old schema cannot tell them apart; their net effect is zero either way.
- `printers`: one row per printer that appears in `entries` or `uncredited_failures`, largest `net` first. `plates` counts credited plates (`print_finished`, `operator_confirm`, `rebuilt_job`); `added`/`removed` sum positive/negative deltas; `failed_plates` counts `marked_failed` deductions plus uncredited failures. Manual edits and baseline rows are grouped last under `printer_id: null`.
- `reconciliation.matches` is `false` when the ledger does not add up to `completed_qty`, which means some write bypassed the ledger.

**Errors:** `404` `{ "error": "Part not found" }`.

### `POST /api/parts`

Required: `project_id`, `name`, `target_qty`. Optional: `print_time`.

`print_time` is the operator's estimate of how long one plate of this part takes, stored as `parts.print_time_seconds`. It exists so the Schedule page can size this part's blocks before any sliced G-code has been uploaded. Accepts `"2h15m"`, `"90m"`, `"1:30:00"`, or a bare integer (seconds); returns `400` if non-empty and unparseable, or if it resolves to zero or less. Omitted or `""` stores `null`, which the schedule draws as a two-hour block marked "time unknown". A G-code's own `est_print_secs` always takes precedence over this value.

A new part always starts `open` with `completed_qty: 0`. If the parent project's status is `completed`, it's reactivated to `active` immediately (same as `POST /api/projects/:id/reactivate`) without a separate manual reactivate step. A scheduler sweep also runs at this point, but it can't dispatch the new part itself yet: the scheduler's candidate query requires a matching G-code, and a brand-new part has none. The part becomes an actual dispatch candidate once G-code is uploaded for it (see `POST /api/gcodes/upload`, which triggers its own sweep).

### `PUT /api/parts/:id`

Partial update. Accepts: `name`, `target_qty`, `completed_qty`, `status`, `print_time`.

**`print_time`:** same formats and validation as `POST /api/parts`. Present in the body wins, and `""` clears the estimate back to `null`; omitting the key leaves the stored value untouched. A `400` changes nothing at all, including the other fields in the same request.

**`completed_qty` auto-status:** when `completed_qty` is included in the request body, `status` is recalculated server-side — `closed` if `completed_qty >= target_qty`, `open` otherwise. An explicit `status` field in the body is ignored when `completed_qty` is also present.

**Audit trail:** a `completed_qty` that differs from the stored value writes one `manual_edit` row to `part_qty_ledger` (visible in `GET /api/parts/:id/audit`). Sending the unchanged value, as the Projects page does on every quantity save, writes nothing.

**Reactivation:** if this update flips the part from `closed` back to `open` (e.g. raising `target_qty` above `completed_qty`) and the parent project's status is `completed`, the project is reactivated to `active` and the scheduler sweeps for idle printers immediately, same behavior as `POST /api/parts` and `POST /api/projects/:id/reactivate`.

### `PUT /api/parts/reorder`

Sets `sort_order` for a list of parts in one transaction. Send the full ordered array of IDs — index position becomes the new `sort_order`.

**Body:**
```json
{ "ids": [3, 1, 2] }
```

**Response:** `{ "success": true }`

Returns `400` if `ids` is missing or empty.

### `DELETE /api/parts/:id`

Safe cascade delete. Runs entirely in a single transaction.

Returns `409` if any job for this part is currently `uploading` or `printing` — deletion is blocked while dispatch is active. Wait for the job to finish or cancel it first.

On success:
- All jobs for the part are deleted (history has no meaning without the part).
- All G-code records for the part are deleted and their physical files removed from `server/gcode/`.
- The part itself is deleted.

```json
{ "success": true }
```

Returns `404` if not found.

---

## G-codes

### `GET /api/gcodes`

Optional query param `?part_id=N` to filter by part.

Returns all G-code records. Each record includes `part_id`, `printer_model`, `filename`, `filepath`, `parts_per_plate`, `est_print_secs`, `material_grams`, `ams_slot`, `allowed_groups`, `required_material`, `required_color`, `created_at`.

`filepath` stores only the filename (not an absolute path) — the server resolves the full path at runtime using its own `server/gcode/` directory. This makes the DB portable across machines.

### `POST /api/gcodes/parse-filename`

Parses a G-code filename and returns structured fields without saving anything. Used to pre-fill the upload form and per-gcode estimate inputs.

**Body:** `{ "filename": "4x Left Bracket_0.20n_0.40mm_MK4S_MK4S_5h11m.bgcode" }`

**Response (success):**
```json
{
  "parse_failed": false,
  "parts_per_plate": 4,
  "printer_model": "mk4s",
  "est_print_secs": 18660,
  "material_grams": null,
  "part_name_hint": "Left Bracket"
}
```

**Response (no match):** `{ "parse_failed": true, "material_grams": null }`

`material_grams` is extracted from flexible patterns anywhere in the filename (e.g. `45g`, `1.2kg`) and is returned regardless of whether the strict Bambu-format parse succeeded. Either field may be `null` if not found.

### `POST /api/gcodes/upload`

Upload a G-code file and create a DB record. `Content-Type: multipart/form-data`, file field name `file`.

**Form fields:**
- `part_id` (required)
- `parts_per_plate` (required)
- `printer_model` (required) — must be a registered model ID
- `est_print_secs` (optional): per-plate print time in seconds; used only as a fallback, see "Estimates read from the file" below
- `material_grams` (optional): per-plate material weight in grams; same fallback rule
- `ams_slot` (optional) — Bambu only
- `allowed_groups` (optional): JSON array string e.g. `'["Rack A","Rack B"]'`; restricts dispatch to printers in one of these groups. Omitted or empty means unrestricted at the G-code level (falls back to the project's `allowed_groups`, if any; see `PUT /api/projects/:id/groups`)
- `required_material` / `required_color` (optional): overrides the project's defaults for this G-code specifically

Returns `201` with created G-code record. Returns `409` if a G-code for this `(part_id, printer_model)` combination already exists.

**Estimates read from the file:** the upload is parsed for the slicer's own print time and material weight, which override the `est_print_secs` / `material_grams` form fields. The client derives those fields from the filename, and a filename convention is a weaker source than the slicer's own numbers. Sources, in order:

- `.3mf`: `Metadata/slice_info.config`, written by Bambu Studio and Orca Slicer. `prediction` (whole seconds) and `weight` (grams) are read from the plate with `index` 1, the plate the Bambu driver prints.
- `.gcode`: the footer/header comments both slicer families write: `; estimated printing time (normal mode) = 1h 13m 3s` (PrusaSlicer), `; total estimated time: 1h 13m 3s` (Orca/Bambu), and `; total filament used [g] = 45.67`.
- `.bgcode`: not parsed. Prusa's binary container is left alone rather than guessed at, so the posted filename-derived values stand.

Each field falls back independently: a file with a time but no weight keeps the posted weight. When nothing supplies a value the column stays `null`, and the Schedule page draws that part's blocks at its two-hour default. Field names and units are taken from slicer source, cited in `server/slicer-metadata.js`.

**Sliced-.3mf validation:** a `.3mf` upload is inspected (ZIP central directory, no extraction) and rejected with `400` unless it contains `Metadata/plate_1.gcode`, the exact entry the Bambu driver prints. This catches two silent-failure cases at upload time: a project file saved without slicing (no G-code inside at all), and an export whose sliced plate is not plate 1. The error message tells the operator how to re-export ("Slice Plate, then File > Export > Export plate sliced file"). Non-`.3mf` uploads are not inspected.

A part only becomes a real dispatch candidate once it has at least one matching G-code (the scheduler's candidate query joins on `gcodes`). A successful upload triggers a scheduler sweep immediately, so an idle printer can pick up the part right away instead of waiting for a manual dispatch or the next printer status transition.

### `PUT /api/gcodes/:id`

Update `est_print_secs`, `material_grams`, `allowed_groups`, `required_material`, and/or `required_color` for a G-code. Omitting a field leaves it unchanged; sending `null` (or, for the time/material fields, `""`) clears it back to "inherit from project / unrestricted".

**Body:**
```json
{ "print_time": "2h15m", "material_grams": "45g", "allowed_groups": "[\"Rack A\"]", "required_material": "PETG", "required_color": "Red" }
```

`print_time` accepts the same human-readable formats as `PUT /api/parts/:id`: `"2h15m"`, `"90m"`, `"1:30:00"`, bare integer (seconds). Returns `400` if non-empty and unparseable. Both routes share one parser (`server/estimate-input.js`), so the same string means the same number on a part and on its G-code.

`material_grams` accepts `"45g"`, `"45.5g"`, `"1.2kg"`, bare number. Returns `400` if non-empty and unparseable.

`allowed_groups` is a JSON-encoded array string, matching the shape `POST /api/gcodes/upload` accepts (see above). This G-code's `allowed_groups`, `required_material`, and `required_color` always take precedence over the project's defaults when set; see `PUT /api/projects/:id/groups` and `PUT /api/projects/:id/filament`.

When `allowed_groups`, `required_material`, or `required_color` actually changes, the scheduler sweeps idle printers. An estimate-only edit does not sweep.

Returns the updated G-code record.

### `DELETE /api/gcodes/:id`

Deletes the DB record and removes the file from disk. Returns `{ "success": true }`.

Returns `409` if the gcode is referenced by an active job (`queued`, `uploading`, or `printing`). Wait for the job to finish or cancel it before deleting.

Historical jobs (`finished`, `failed`, `cancelled`) are retained with their `gcode_id` nulled out so job history is preserved.

---

## Jobs

### `GET /api/jobs`

Returns jobs with part/project/printer names joined. Supports query params: `?printer_id=N`, `?part_id=N`, `?project_id=N`, `?status=printing`.

Each job includes: `part_name`, `project_id`, `project_name`, `printer_name`, `printer_model`, `printer_is_held`, `printer_status`.

Job statuses: `uploading` | `printing` | `queued` | `finished` | `failed` | `cancelled`.

`printer_is_held` and `printer_status` are the current state of the job's printer, not a property of the job row itself. A job can sit at `status: "printing"` after its printer has already been held for operator sign-off (for example a printer that goes `PRINTING` -> `IDLE` directly, with no observable `FINISHED`/`STOPPED` in between polls): the job stays `printing` until Set Ready or Bad Print resolves it. Clients should treat `status === 'printing' && printer_is_held === 1 && printer_status !== 'PRINTING'` as "awaiting operator confirmation," not as an active print.

### `GET /api/jobs/:id`

Single job with same joins, including `printer_is_held` and `printer_status`. `404` if not found.

### `DELETE /api/jobs/:id`

Cancels a job. Returns `409` if status is not `queued` (only queued jobs can be cancelled).

With `?force=true` (or `?force=1`), also cancels an `uploading` or `printing` job. This is the escape hatch for a stuck row, e.g. a printer that silently ignored the print-start command, leaving its job `printing` forever and blocking part deletion. Force-cancel updates only the job row (status `cancelled`, `finished_at` stamped): it never credits `completed_qty`, never clears a printer hold, and never contacts the printer. `finished` and `failed` jobs return `409` even with force.

```json
{ "success": true }
```

---

## Schedule

Forward-looking projection of what each printer is expected to run next. Read-only: these
endpoints create no job rows, dispatch nothing, and never touch `completed_qty`. Design notes
and the operator model live in [docs/schedule.md](schedule.md).

### `GET /api/schedule`

Optional query param `?horizon_hours=N` (default `24`, range `1` to `168`). Returns `400` if
`N` is non-numeric or out of range.

```json
{
  "version": "ebbf25c3e5fc5315",
  "computed_at": 1769871783000,
  "now": 1769871783000,
  "horizon_hours": 24,
  "horizon_end": 1769958183000,
  "truncated": false,
  "assumptions": {
    "default_print_secs": 7200,
    "changeover_secs": 900,
    "staffed_start_hour": 6,
    "staffed_end_hour": 22,
    "tie_window_secs": 60
  },
  "printers": [
    {
      "id": 4,
      "name": "MK4S_04",
      "model": "mk4s",
      "group_name": "Rack A",
      "status": "FINISHED",
      "is_held": 1,
      "available_at": 1769872683000,
      "blocked_reason": "Awaiting operator sign-off"
    }
  ],
  "projects": [
    { "id": 2, "name": "Benchy Fleet", "priority": 0, "color_index": 0 }
  ],
  "blocks": [
    {
      "id": "job-31",
      "kind": "active",
      "printer_id": 4,
      "job_id": 31,
      "job_status": "printing",
      "part_id": 7,
      "part_name": "Standard Benchy",
      "project_id": 2,
      "project_name": "Benchy Fleet",
      "gcode_id": 12,
      "filename": "benchy_mk4s.bgcode",
      "parts_per_plate": 4,
      "start": 1769864400000,
      "end": 1769871783000,
      "est_secs": 7383,
      "time_source": "gcode",
      "time_unknown": false
    }
  ],
  "unscheduled": [
    {
      "part_id": 9,
      "part_name": "Mini Benchy (60%)",
      "project_name": "Benchy Fleet",
      "remaining_qty": 12,
      "reason": "beyond_horizon"
    }
  ]
}
```

- `version`: fingerprint of the projection's inputs, the same value `GET /api/schedule/version` returns. Also seeds the tie-break shuffle, so an unchanged farm returns an identical schedule.
- `printers[].available_at`: when this printer can start its next print, or `null` when it is not projectable at all (`OFFLINE`, `ERROR`, `PAUSED`, `UNKNOWN` with no active job).
- `printers[].blocked_reason`: `"Awaiting operator sign-off"` for a held printer, `"Printer is X"` for an unprojectable one, otherwise absent/`null`.
- `blocks[].kind`: `active` for a job already `uploading`/`printing` (`job_id` set), `projected` for predicted work (`job_id` null). A projected block is not a queued job and has no row in the `jobs` table.
- `blocks[].time_source`: `gcode` (from `gcodes.est_print_secs`), `part` (from `parts.print_time_seconds`), or `default`. `time_unknown` is `true` only for `default`, which means the block is drawn at `assumptions.default_print_secs`.
- `truncated`: `true` when open demand ran past `horizon_end` or a safety cap was hit; the leftovers appear in `unscheduled`.
- `unscheduled[].reason`: `beyond_horizon` (extend the range to see it) or `no_eligible_printer` (use `GET /api/parts/:id/dispatch-status` for the per-part explanation).

### `GET /api/schedule/version`

Fingerprint of the schedule's inputs, for clients deciding whether their rendered schedule is stale.

```json
{ "version": "ebbf25c3e5fc5315" }
```

Deliberately cheap, so it can be polled far more often than the full projection. It changes when anything structural changes (printer status or hold, a job dispatched or resolved, a G-code or part estimate edited, quantities, priorities, reordering, project status, loaded filament). It does **not** change on `printers.job_progress` / `job_time_remaining`, which every poll rewrites for every printing printer: those move the leading edge of an in-progress block, which a normal refresh picks up, and treating them as staleness would leave a client permanently "recalculating".

---

## Scheduler

### `POST /api/scheduler/dispatch`

Triggers an immediate dispatch sweep — queries all currently idle, non-held printers and attempts to dispatch the next eligible job to each. No request body required.

```json
{ "ok": true }
```

Called by the Projects UI when a project is activated or resumed.

---

## Notifications

In-memory store of server-side alerts that require operator attention. Lost on server restart (errors will recur naturally on the next dispatch attempt if unresolved).

### `GET /api/notifications`

Returns all current notifications, newest first.

```json
[
  {
    "id": 1,
    "message": "G-code file missing for \"4x Left Bracket_MK4S_5h11m.bgcode\" — re-upload the file for part \"Left Bracket\" in project \"Batch 7\". Printer MK4S_03 has been held.",
    "timestamp": 1774903214349
  }
]
```

### `DELETE /api/notifications/:id`

Dismisses a notification. Returns `{ "ok": true }`. Returns `404` if not found.

---

## Settings

### `GET /api/settings`

Returns all operator settings as a flat object, e.g. `{ "dispatch_batch_size": "10", "farm_name": "My Farm" }`.

### `PUT /api/settings/:key`

Body: `{ "value": "..." }`. Allowed keys:

| Key | Validation | Used by |
|---|---|---|
| `dispatch_batch_size` | integer 1-100 | How many printers the scheduler keeps uploading or printing at once (a concurrency target, not a fixed group size; it draws deeper into the ready queue to fill the target if some printers have no dispatchable candidate) |
| `farm_name` | ≤ 40 chars | Sidebar branding (falls back to "Print Farm") |

Returns `400` for unknown keys or failed validation.

---

## Dashboard

### `GET /api/dashboard`

Single endpoint that returns all data required by the TV dashboard in one call. Polled every 15 seconds by the Dashboard page.

```json
{
  "stats": {
    "printing": 38,
    "idle": 8,
    "awaiting": 6,
    "parts_today": 847
  },
  "printers": [ ... ],
  "active_projects": [
    {
      "id": 1,
      "name": "Spring Product Line",
      "status": "active",
      "parts": [
        { "id": 3, "name": "Left Bracket", "completed_qty": 671, "target_qty": 1000, "status": "open", ... }
      ]
    }
  ],
  "recent_activity": [
    {
      "id": 512,
      "status": "finished",
      "parts_per_plate": 25,
      "finished_at": 1774903214349,
      "part_name": "Left Bracket",
      "printer_name": "MK4_07"
    }
  ]
}
```

**`stats` fields:**
- `printing` — printers currently in `PRINTING` status
- `idle` — printers in `IDLE` status with no hold
- `awaiting` — printers held (`is_held = 1`) in `FINISHED` or `IDLE` state, waiting for operator sign-off
- `parts_today` — sum of `parts_per_plate` on `finished` jobs in the rolling 24-hour window (`finished_at >= now - 86400000`)

`printers` is the same shape as `GET /api/printers` (includes `last_parts_per_plate`) plus `last_event_at` — the timestamp of the most recent `printer_events` row for that printer.

`active_projects` includes only `status = 'active'` projects, ordered by `priority ASC, created_at ASC` (same order as `GET /api/projects` and the scheduler's dispatch query, so the dashboard's project order matches what actually dispatches next), each with a nested `parts` array ordered by `sort_order`, plus three computed stats fields:

- `elapsed_secs` — total wall-clock print time in seconds: sum of `finished_at − started_at` for all `finished` jobs in the project, plus `now − started_at` for any currently `printing` job.
- `material_used_grams` — total material consumed in grams: sum of `gcode.material_grams / gcode.parts_per_plate * job.parts_per_plate` across all `finished` jobs that have a linked gcode with `material_grams` set. `null` if no jobs have gcode material data.
- `model_breakdown` — array of per-printer-model summaries for all finished jobs: `{ printer_model, jobs_count, parts_printed, material_grams, elapsed_secs }`, ordered by `parts_printed DESC`.

`recent_activity` is the 12 most recent `finished` or `failed` jobs, each with `part_name` and `printer_name` joined in. (Retained in the payload for compatibility; the dashboard UI no longer renders this list — see [web-app.md](web-app.md).)

---

## Error Responses

All error responses use this shape:

```json
{ "error": "Human-readable message" }
```

| Status | Meaning |
|---|---|
| `400` | Missing required field or invalid value |
| `404` | Resource not found |
| `409` | Conflict (e.g. duplicate printer name) |

---

## Backup

### `GET /api/backup`

Downloads a full farm snapshot as `farm-backup-YYYY-MM-DD.json`. Includes `printers`, `projects`, `parts`, `gcodes`, `jobs`, `printer_events`, `printer_models`, `printer_groups`, `filament_types`, `filament_colors`, `settings`, `part_qty_ledger` (the part audit trail), and gcode file contents (base64 encoded, keyed by on-disk filename). No request body.

**Response:** `Content-Disposition: attachment` JSON file.

### `POST /api/backup/restore`

Replaces all farm data from a previously exported backup file. Clears the DB and rewrites all tables; gcode files are written to `server/gcode/`. Since `filepath` stores only the filename, no path rewriting is needed — the restored DB works correctly on any machine. Each `gcode_files` key must be a bare filename — any key that isn't (e.g. containing `/`, `\`, or equal to `.`/`..`) is rejected with `400` before anything is written to disk, since it would otherwise be able to resolve outside `server/gcode/`.

Each table's restore INSERT covers the columns the *live* schema currently has (derived from `PRAGMA table_info`) that are also present in the backup's data, rather than a hardcoded list: so printer `serial_number`/`loaded_material`/`loaded_color`, project `required_material`/`required_color`/`allowed_groups`, part `print_time_seconds`/`material_grams`, and gcode `ams_slot`/`material_grams`/`allowed_groups`/`required_material`/`required_color` all round-trip correctly, along with any future column a migration adds. A column present in the live schema but missing from every row of a given backup (e.g. an older backup that predates it) is omitted from the INSERT entirely so the column's own schema default applies, instead of failing on `NOT NULL` columns like `parts.sort_order`.

`printer_models`, `printer_groups`, `filament_types`, `filament_colors`, and `settings` are restored the same way, but each is only cleared and rewritten if that key is present in the uploaded file: restoring a backup taken before these were added to the export leaves the farm's current printer models, groups, filament library, and settings untouched rather than wiping them with nothing to restore.

`part_qty_ledger` is always cleared on restore, because its rows describe the parts being replaced. Ledger rows in the backup are restored as-is; parts from an older backup without a `part_qty_ledger` key get the same one-time history rebuild as an upgraded install (see [database.md](database.md#part_qty_ledger)).

**Request:** `multipart/form-data` with field `file` — the `.json` backup file. Max 500 MB.

```json
{
  "ok": true,
  "printers": 52,
  "projects": 3,
  "parts": 12,
  "gcodes": 18,
  "jobs": 340,
  "printer_events": 210,
  "printer_models": 6,
  "printer_groups": 4,
  "filament_types": 3,
  "filament_colors": 9,
  "part_qty_ledger": 410
}
```
| `500` | Unhandled server error |
