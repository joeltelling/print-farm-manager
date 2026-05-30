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
    "ip": "192.168.15.194",
    "api_key": "aauukLtMLUTqq6e",
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

`last_parts_per_plate` is the `parts_per_plate` from the most recent finished (or currently printing) job — used by the Fleet UI to pre-fill the confirmed-qty input.

`has_active_job` is `1` if the printer currently has a job in `uploading` or `printing` status, `0` otherwise — used by the Fleet UI to show the OFFLINE-with-job confirmation buttons.

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
  "ip": "192.168.15.194",
  "api_key": "aauukLtMLUTqq6e",
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

Returns `404` if not found, `409` on name conflict.

### `DELETE /api/printers/:id`

```json
{ "success": true }
```

Returns `404` if not found.

### `POST /api/printers/:id/set-ready`

Releases the printer's hold (`is_held = 0`) and immediately dispatches the next eligible job to it. Called by the Fleet UI when an operator confirms a print is good.

Accepts an optional body:
```json
{ "confirmed_qty": 24 }
```

If `confirmed_qty` is provided and differs from the `parts_per_plate` of the printer's most recent finished job, the delta is applied to the part's `completed_qty` (e.g. operator confirms 24 of 25 good → `completed_qty` decremented by 1). If the auto-credit had closed the part, it is reopened. Omitting the body leaves `completed_qty` unchanged.

**OFFLINE-with-job exception:** if the printer's current status is `OFFLINE` and it has a `printing` job (no finished job), qty is not credited and the job is not marked finished. The printer is simply unheld and the job continues to its natural finish. This is the "Job OK" path from the Fleet UI — the operator is confirming the job is still running, not that it completed.

Returns the updated printer object.

### `POST /api/printers/:id/decommission`

Removes the printer from active duty (`is_active = 0`). It will no longer be polled or receive jobs. Returns the updated printer object.

### `POST /api/printers/:id/complete-and-decommission`

Operator confirms the last print was successful, then takes the machine offline for maintenance instead of releasing it to the job queue.

- **Normal case** (job already in `finished` status): `_handleFinished` already credited `completed_qty`; nothing is re-credited. The printer is simply decommissioned.
- **Missed-finish case** (job still in `printing` status): credits `completed_qty` by `parts_per_plate`, marks the job `finished`, and closes the Part / Project if targets are met — same logic as `set-ready`, but ending in decommission rather than dispatch.

Returns the updated printer object.

### `POST /api/printers/:id/recommission`

Returns a decommissioned printer to active duty (`is_active = 1`). Returns the updated printer object.

### `POST /api/printers/:id/mark-job-failure`

Marks the printer's most relevant active or recently-completed job as `failed`, undoes the `completed_qty` increment if needed, reopens the Part and Project if needed, and decommissions the printer (`is_active = 0`).

**Job selection — two-query priority:**

1. **Active first:** finds the most recent `printing` or `uploading` job (`ORDER BY started_at DESC`). These jobs were never credited to `completed_qty`, so no undo is needed.
2. **Finished fallback:** if no active job exists, finds the most recent `finished` job — but only if no subsequent job was created for this printer after it finished. This scope guard prevents the endpoint from reaching back and decrementing `completed_qty` on an old job from a previous cycle when the printer is held for an unrelated reason.

**Per-status behaviour:**
- `finished` — `completed_qty` decremented by `parts_per_plate`. Part reopened if it was closed by this job; Project reopened if it was completed.
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
  "printer": { "id": 1, "name": "MK4S_35", "ip": "192.168.15.88" },
  "raw": { "printer": { "state": "IDLE", ... }, "storage": { ... } }
}
```

### `POST /api/printers/import`

Bulk import from CSV. `Content-Type: multipart/form-data`, field name `file`.

**CSV format** (header row required, column order flexible):

```
name,ip,api_key,group,type,model
MK4S_01,192.168.15.194,aauukLtMLUTqq6e,MK4S Farm,prusa,MK4S
C1 Apple Jack,192.168.15.72,pu6whBHx8B2ivgK,CORE One Farm,prusa,C1
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
      "row": { "name": "Twilight", "ip": "192.168.15.110", "api_key": "...", "group": "Core One Farm", "type": "prusa" },
      "reason": "Cannot infer model from name \"Twilight\". Please specify model manually."
    }
  ]
}
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

### `DELETE /api/projects/:id`

---

## Parts

### `GET /api/parts`

Optional query param `?project_id=N` to filter by project. Results ordered by `sort_order ASC, created_at ASC`.

Each part includes `active_qty` — the sum of `parts_per_plate` across all `uploading` or `printing` jobs for that part. Used by the progress bars in the Projects and Dashboard pages to show in-flight work.

### `GET /api/parts/:id`

Also includes `active_qty` (same calculation as the list endpoint).

### `POST /api/parts`

Required: `project_id`, `name`, `target_qty`.

### `PUT /api/parts/:id`

Partial update. Accepts: `name`, `target_qty`, `completed_qty`, `status`, `print_time`, `material`.

**`completed_qty` auto-status:** when `completed_qty` is included in the request body, `status` is recalculated server-side — `closed` if `completed_qty >= target_qty`, `open` otherwise. An explicit `status` field in the body is ignored when `completed_qty` is also present.

**`print_time`** — optional, sets `print_time_seconds`. Server normalizes human-readable input: `"2h15m"`, `"90m"`, `"5400s"`, `"1:30:00"`, `"2:15"`, bare integer (seconds). Send `null` or `""` to clear. Returns `400` if the string is non-empty but unparseable.

**`material`** — optional, sets `material_grams`. Accepts: `"45g"`, `"45.5g"`, `"1.2kg"`, bare number (grams). Send `null` or `""` to clear. Returns `400` if the string is non-empty but unparseable.

### `POST /api/parts/:id/parse-gcode`

Extracts `print_time_seconds` and `material_grams` (per part) from the filename of a gcode attached to this part, without modifying any records. Useful for populating the estimate fields before confirming.

**Body:** `{ "gcode_id": 12 }` — optional. If omitted, the part's earliest gcode is used.

**Response:**
```json
{
  "print_time_seconds": 8100,
  "material_grams": 42.5,
  "source": "1x XRP_Chassis_2h15m_42.5g_PLA_MK4S_4.bgcode",
  "nothing_found": false
}
```

Either `print_time_seconds` or `material_grams` may be `null` if not found in the filename. `nothing_found: true` when both are null.

Returns `404` if no gcode exists for this part (or the specified `gcode_id` doesn't belong to it).

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

Returns all G-code records. Each record includes `part_id`, `printer_model`, `filename`, `filepath`, `parts_per_plate`, `est_print_secs`, `created_at`.

`filepath` stores only the filename (not an absolute path) — the server resolves the full path at runtime using its own `server/gcode/` directory. This makes the DB portable across machines.

### `POST /api/gcodes/parse-filename`

Parses a G-code filename and returns structured fields without saving anything. Used to pre-fill the upload form.

**Body:** `{ "filename": "4x Left Bracket_0.20n_0.40mm_MK4S_MK4S_5h11m.bgcode" }`

**Response (success):**
```json
{
  "parse_failed": false,
  "parts_per_plate": 4,
  "printer_model": "mk4s",
  "est_print_secs": 18660,
  "part_name_hint": "Left Bracket"
}
```

**Response (no match):** `{ "parse_failed": true }`

Filename format: `{qty}x {part name}_{layer}_{nozzle}_{material}_{model}_{time}.{bgcode|gcode}`

### `POST /api/gcodes/upload`

Upload a G-code file and create a DB record. `Content-Type: multipart/form-data`, file field name `file`.

**Form fields:**
- `part_id` (required)
- `parts_per_plate` (required)
- `printer_model` (required) — must be one of `mk4`, `mk4s`, `c1`, `c1l`, `xl`
- `est_print_secs` (optional)

Returns `201` with created G-code record. Returns `409` if a G-code for this `(part_id, printer_model)` combination already exists.

### `DELETE /api/gcodes/:id`

Deletes the DB record and removes the file from disk. Returns `{ "success": true }`.

Returns `409` if the gcode is referenced by an active job (`queued`, `uploading`, or `printing`). Wait for the job to finish or cancel it before deleting.

Historical jobs (`finished`, `failed`, `cancelled`) are retained with their `gcode_id` nulled out so job history is preserved.

---

## Jobs

### `GET /api/jobs`

Returns jobs with part/project/printer names joined. Supports query params: `?printer_id=N`, `?part_id=N`, `?project_id=N`, `?status=printing`.

Each job includes: `part_name`, `project_id`, `project_name`, `printer_name`, `printer_model`.

Job statuses: `uploading` | `printing` | `queued` | `finished` | `failed` | `cancelled`.

### `GET /api/jobs/:id`

Single job with same joins. `404` if not found.

### `DELETE /api/jobs/:id`

Cancels a job. Returns `409` if status is not `queued` (only queued jobs can be cancelled).

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

`active_projects` parts include `print_time_seconds` and `material_grams` when set — the dashboard uses these to project remaining print time and material per part and per project.

`active_projects` includes only `status = 'active'` projects, each with a nested `parts` array ordered by `sort_order`.

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

Downloads a full farm snapshot as `farm-backup-YYYY-MM-DD.json`. Includes all 5 tables and gcode file contents (base64 encoded). No request body.

**Response:** `Content-Disposition: attachment` JSON file.

### `POST /api/backup/restore`

Replaces all farm data from a previously exported backup file. Clears the DB and rewrites all tables; gcode files are written to `server/gcode/`. Since `filepath` stores only the filename, no path rewriting is needed — the restored DB works correctly on any machine.

**Request:** `multipart/form-data` with field `file` — the `.json` backup file. Max 500 MB.

```json
{
  "ok": true,
  "printers": 52,
  "projects": 3,
  "parts": 12,
  "gcodes": 18,
  "jobs": 340
}
```
| `500` | Unhandled server error |
