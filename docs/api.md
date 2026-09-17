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

## Authentication

CoMa gates every `/api/*` route except `/api/auth/*` and `/api/health` behind a single local operator account (`server/auth.js`, `server/routes/auth.js`). This is intentionally basic: one shared account, no roles, no password reset flow, no CSRF token, no rate limiting. It stops a stranger on the LAN from opening the app without logging in; it is not a hardened multi-user auth system. Still run CoMa only on a trusted LAN or VPN (see the security note in [README.md](../README.md)).

Sessions are an HttpOnly `coma_session` cookie (`SameSite=Lax`, 30 day expiry, no `Secure` attribute since installs are typically plain HTTP on a LAN). The client (`client/src/components/AuthGate.jsx`) reads `GET /api/auth/status` to decide which screen to show: create an account, log in, run the one-time setup guide, or render the app.

### `GET /api/auth/status`

Not gated by auth (this is what decides whether to ask for one). Returns:

```json
{ "hasAccount": true, "authenticated": true, "onboardingCompleted": false, "username": "operator" }
```

`username` is only present when `authenticated` is `true`.

### `POST /api/auth/register`

Creates the single operator account. Body: `{ "username": "...", "password": "..." }` (password minimum 8 characters). Sets the session cookie and returns `201` with `{ "ok": true, "onboardingCompleted": false }`. Returns `409` if an account already exists (delete it first via `/api/auth/delete-account`), `400` for a missing username or a short password.

### `POST /api/auth/login`

Body: `{ "username": "...", "password": "..." }`. Sets the session cookie and returns `{ "ok": true, "onboardingCompleted": <bool> }`. Returns `401` for a wrong username or password.

### `POST /api/auth/logout`

Clears the caller's session. Returns `{ "ok": true }`. The account itself is untouched.

### `POST /api/auth/complete-onboarding`

Marks the one-time setup guide as done for the account, so `AuthGate` stops showing it. Requires a valid session (`401` otherwise). Returns `{ "ok": true }`.

### `POST /api/auth/delete-account`

The only way the setup guide reappears. Body: `{ "password": "..." }`; the current password is required even though the caller already holds a session, because this is destructive. Deletes the account, invalidates every open session (not just the caller's), and clears the session cookie. Returns `{ "ok": true }`, `401` for a missing session or a wrong password, `404` if there is no account.

`auth_account` and `auth_sessions` are intentionally excluded from `GET /api/backup` and restore: a restored backup must never change who can log into the machine it lands on, or leak a password hash inside the backup JSON (see `server/routes/backup.js`).

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

`last_parts_per_plate` is the `parts_per_plate` from the most recent finished (or currently printing) job — used by the Fleet UI to pre-fill the confirmed-qty input.

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

### `GET /api/printers/:id/camera`

Camera metadata for the incident view. Does not return raw printer URLs; the browser loads frames through the proxy endpoints below.

```json
{
  "available": true,
  "name": "webcam",
  "mode": "snapshot",
  "rotation": 0,
  "flipHorizontal": false,
  "flipVertical": false
}
```

`mode` is the site-wide `camera_mode` setting (`snapshot` or `stream`). `available` is `false` when the connector has no `getCameraInfo` (or Moonraker is unreachable). `404` if the printer does not exist.

Klipper uses Moonraker `GET /server/webcams/list` and `POST /server/webcams/test` (see [Moonraker webcam API](https://moonraker.readthedocs.io/en/stable/external_api/webcams/)). If the list is empty, CoMa falls back to `http://{ip}:8110/?action=snapshot` (Virtual Klipper Printer dummy webcam). Implemented from protocol docs; not yet validated on physical hardware.

### `GET /api/printers/:id/camera/snapshot`

Proxies one JPEG from the printer webcam. `404` if no camera. `502` if the upstream snapshot fails.

### `GET /api/printers/:id/camera/stream`

Pipes the upstream MJPEG stream. `404` if no camera. `502` if the upstream stream fails to connect.

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

Returns a decommissioned printer to active duty (`is_active = 1`, `is_held = 0`, clears `decommissioned_at`/`decommission_note`), logs a `recommission` event, and immediately dispatches the next eligible job via `scheduler.scheduleForPrinter`. Returns the updated printer object.

The dispatched job is marked `printing` before the next poll has updated the printer's stored status, so it briefly looks like an orphaned job on an `IDLE`/`FINISHED` printer. The scheduler's stale-job auto-fail only fires on jobs older than `STALE_JOB_GRACE_MS` (90s), so a freshly recommissioned-and-dispatched printer is not wrongly re-held if another dispatch (e.g. "Scan for Jobs") runs before the printer is re-polled as `PRINTING`.

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

### `PUT /api/projects/:id/groups`

Sets a project-wide default `allowed_groups`, applied to every G-code in the project that doesn't set its own `allowed_groups` override. Mirrors `PUT /api/gcodes/:id`'s `allowed_groups` field, and follows the same gcode-overrides-project precedence as `/filament` above; see the "Targeting cascade" note in [database.md](database.md).

**Body:** `{ "allowed_groups": ["Rack A", "Rack B"] }`. An empty array (or omitted) clears the project default back to unrestricted.

### `DELETE /api/projects/:id`

---

## Parts

### `GET /api/parts`

Optional query param `?project_id=N` to filter by project. Results ordered by `sort_order ASC, created_at ASC`.

Each part includes `active_qty` — the sum of `parts_per_plate` across all `uploading` or `printing` jobs for that part. Used by the progress bars in the Projects and Dashboard pages to show in-flight work.

### `GET /api/parts/:id`

Also includes `active_qty` (same calculation as the list endpoint).

### `GET /api/parts/:id/dispatch-status`

Diagnostic for the "Why isn't this printing?" button on the Projects page. Mirrors the scheduler's eligibility rules and returns why the part is or isn't dispatching right now.

```json
{
  "dispatchable": false,
  "reasons": ["gridfinity_2x4_x1c.3mf: all 1 matching printer(s) are busy"],
  "notes": []
}
```

- `reasons` — populated when `dispatchable` is `false`: global blockers (project not active, part complete, no G-code, remaining qty already covered by in-progress jobs) followed by per-G-code availability problems (no printers of that model, group/material/color mismatch, all matching printers busy or held).
- `notes` — populated when `dispatchable` is `true`: advisory per-G-code items (e.g. one G-code can dispatch but another has no ready printers).

### `POST /api/parts`

Required: `project_id`, `name`, `target_qty`.

A new part always starts `open` with `completed_qty: 0`. If the parent project's status is `completed`, it's reactivated to `active` immediately (same as `POST /api/projects/:id/reactivate`) without a separate manual reactivate step. A scheduler sweep also runs at this point, but it can't dispatch the new part itself yet: the scheduler's candidate query requires a matching G-code, and a brand-new part has none. The part becomes an actual dispatch candidate once G-code is uploaded for it (see `POST /api/gcodes/upload`, which triggers its own sweep).

### `PUT /api/parts/:id`

Partial update. Accepts: `name`, `target_qty`, `completed_qty`, `status`.

**`completed_qty` auto-status:** when `completed_qty` is included in the request body, `status` is recalculated server-side — `closed` if `completed_qty >= target_qty`, `open` otherwise. An explicit `status` field in the body is ignored when `completed_qty` is also present.

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
- `est_print_secs` (optional) — per-plate print time in seconds
- `material_grams` (optional) — per-plate material weight in grams
- `ams_slot` (optional) — Bambu only
- `allowed_groups` (optional): JSON array string e.g. `'["Rack A","Rack B"]'`; restricts dispatch to printers in one of these groups. Omitted or empty means unrestricted at the G-code level (falls back to the project's `allowed_groups`, if any; see `PUT /api/projects/:id/groups`)
- `required_material` / `required_color` (optional): overrides the project's defaults for this G-code specifically

Returns `201` with created G-code record. Returns `409` if a G-code for this `(part_id, printer_model)` combination already exists.

A part only becomes a real dispatch candidate once it has at least one matching G-code (the scheduler's candidate query joins on `gcodes`). A successful upload triggers a scheduler sweep immediately, so an idle printer can pick up the part right away instead of waiting for a manual dispatch or the next printer status transition.

### `PUT /api/gcodes/:id`

Update `est_print_secs`, `material_grams`, `allowed_groups`, `required_material`, and/or `required_color` for a G-code. Omitting a field leaves it unchanged; sending `null` (or, for the time/material fields, `""`) clears it back to "inherit from project / unrestricted".

**Body:**
```json
{ "print_time": "2h15m", "material_grams": "45g", "allowed_groups": "[\"Rack A\"]", "required_material": "PETG", "required_color": "Red" }
```

`print_time` accepts the same human-readable formats as `PUT /api/parts/:id` did for `print_time`: `"2h15m"`, `"90m"`, `"1:30:00"`, bare integer (seconds). Returns `400` if non-empty and unparseable.

`material_grams` accepts `"45g"`, `"45.5g"`, `"1.2kg"`, bare number. Returns `400` if non-empty and unparseable.

`allowed_groups` is a JSON-encoded array string, matching the shape `POST /api/gcodes/upload` accepts (see above). This G-code's `allowed_groups`, `required_material`, and `required_color` always take precedence over the project's defaults when set; see `PUT /api/projects/:id/groups` and `PUT /api/projects/:id/filament`.

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

### `GET /api/jobs/:id/telemetry`

Real machine time / energy / material for a job, plus related `printer_status_history` rows.

```json
{
  "job_id": 12,
  "printing_seconds": 3540.2,
  "paused_seconds": 0,
  "sample_count": 236,
  "material_grams_actual": 42.5,
  "energy_kwh": 0.344,
  "telemetry_quality": "measured",
  "history": [{ "status": "PRINTING", "started_at": 1710000000000, "ended_at": 1710003540000, "duration_ms": 3540000 }]
}
```

`404` if the job is missing.

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

## Settings

### `GET /api/settings`

Returns all operator settings as a flat object, e.g. `{ "dispatch_batch_size": "10", "farm_name": "CoMa Lab" }`.

### `PUT /api/settings/:key`

Body: `{ "value": "..." }`. Allowed keys:

| Key | Validation | Used by |
|---|---|---|
| `dispatch_batch_size` | integer 1-100 | How many printers the scheduler keeps uploading or printing at once (a concurrency target, not a fixed group size; it draws deeper into the ready queue to fill the target if some printers have no dispatchable candidate) |
| `farm_name` | ≤ 40 chars | Sidebar branding (falls back to "CoMa") |
| `camera_mode` | `snapshot` or `stream` | Default camera feed on printer detail (Klipper or configured URL). Snapshot refreshes every 5 seconds. |
| `timelapse_enabled` | `true` / `false` | Auto-capture while jobs are PRINTING |
| `timelapse_interval_seconds` | positive integer | Frame interval (independent of the 15 s poll) |
| `timelapse_fps` | positive integer | ffmpeg output framerate |
| `timelapse_retention_days` | positive integer | Auto-delete ready/failed captures older than this |

Returns `400` for unknown keys or failed validation.

---

## Calendar

Planned shopfloor events (stock arrivals, shipments, deadlines, production closures) plus a read-only overlay of recent ERP/job history. See [docs/calendar.md](calendar.md). Closures with `blocks_dispatch = 1` stop **new** job reservations in the scheduler; in-flight uploads and running prints are not cancelled.

### `GET /api/calendar/dispatch-block`

Returns whether a production closure is currently blocking dispatch.

```json
{
  "active": true,
  "block": {
    "id": 3,
    "title": "Holiday shutdown",
    "start_at": 1789200000000,
    "end_at": 1789460000000
  }
}
```

When nothing blocks: `{ "active": false, "block": null }`.

### `GET /api/calendar/events?from=&to=&type=`

**Required query:** `from` and `to` as epoch milliseconds. Optional `type` filter (`stock_arrival`, `shipment`, `deadline`, `production_closure`, `note`).

Returns events whose range overlaps `[from, to)`. Ordered by `start_at`.

### `GET /api/calendar/overview?from=&to=`

Same range params. Read-only derived items (jobs, sales, positive stock moves, work-order open/close markers), each with `source`, `title`, `start_at`, and optional `end_at`, normalized to epoch ms.

### `POST /api/calendar/events`

**Body (required):** `event_type`, `title`, `start_at` (epoch ms).

**Optional:** `end_at`, `notes`, `all_day` (default 1), `status` (default `planned`), `blocks_dispatch` (default 0; production_closure defaults to 1 if omitted), `project_id`, `item_sku`.

Returns `201` with the created row. Returns `400` when validation fails (unknown type, empty title, missing `start_at`, `end_at` before `start_at`, or `blocks_dispatch` without `end_at`).

### `PUT /api/calendar/events/:id`

Partial update via `COALESCE` for omitted fields. Same validation rules as create when the resulting row would block dispatch. Returns `404` if the event does not exist.

### `DELETE /api/calendar/events/:id`

Returns `{ "ok": true }` or `404`.

---

## Workspace

Single shared kanban board for operator tasks and short notes. See [docs/workspace.md](workspace.md). Does not touch printers or `completed_qty`.

### `GET /api/workspace`

Returns `{ "columns": [ { id, title, accent, sort_order, cards: [...] }, ... ] }`. Seeds four default columns when the table is empty.

### `POST /api/workspace/columns`

Required: `title`. Optional: `accent` (`lime|violet|cyan|amber|red|indigo`, default `violet`). Returns `201` with the column row. `400` on validation failure.

### `PUT /api/workspace/columns/reorder`

Body: `{ "order": [id, ...] }` listing every column id exactly once. Returns the full board. `400` if the list is incomplete or unknown.

### `PUT /api/workspace/columns/:id`

Partial update of `title` and/or `accent`. `404` if missing.

### `DELETE /api/workspace/columns/:id`

Deletes the column and cascades its cards. Returns `{ "ok": true }` or `404`.

### `POST /api/workspace/cards`

Required: `column_id`, `title`. Optional: `body` (default `""`). Returns `201`. `404` if the column does not exist.

### `PUT /api/workspace/cards/reorder`

Body: `{ "cards": [ { "id", "column_id", "sort_order" }, ... ] }` in one transaction (move across columns and reorder). Returns the full board. `404` if a card or column is missing.

### `PUT /api/workspace/cards/:id`

Partial update of `title`, `body`, and/or `column_id`. `404` if missing.

### `DELETE /api/workspace/cards/:id`

Returns `{ "ok": true }` or `404`.

---

## Notebook

Technical notepad pages (plain text). Soft-delete via `trashed_at`. See [docs/workspace.md](workspace.md).

### `GET /api/notebook/pages?trashed=0|1&q=`

Returns `{ "pages": [...] }`. `trashed=1` lists trash only. Optional `q` matches title or body (case-insensitive LIKE).

### `POST /api/notebook/pages`

Required: `title`. Optional: `body` (default `""`), `accent` (default `lime`). Returns `201`.

```json
{
  "id": 1,
  "title": "Ops checklist",
  "body": "1. Sweep",
  "accent": "lime",
  "trashed_at": null,
  "created_at": 1710000000000,
  "updated_at": 1710000000000
}
```

### `PUT /api/notebook/pages/:id`

Partial update of `title`, `body`, `accent`. Empty `body` is allowed. `404` if missing.

### `POST /api/notebook/pages/:id/trash`

Sets `trashed_at`. `409` if already trashed. `404` if missing.

### `POST /api/notebook/pages/:id/restore`

Clears `trashed_at`. `409` if not in trash. `404` if missing.

### `DELETE /api/notebook/pages/:id`

Permanent delete. `409` if the page is still live (must trash first). `404` if missing.

---

## Timelapses

### `GET /api/timelapses`

Query: `?printer_id=`, `?job_id=`, `?part_id=`, `?status=`, `?limit=`.

### `GET /api/timelapses/:id`

### `GET /api/timelapses/:id/video`

MP4 stream when `status` is `ready`.

### `GET /api/timelapses/:id/frames/:n`

JPEG frame `n` (1-based).

### `POST /api/timelapses/:id/stop` / `POST /api/timelapses/:id/render` / `DELETE /api/timelapses/:id`

### `POST /api/printers/:id/timelapse/start` / `POST /api/printers/:id/timelapse/stop`

Manual capture for a machine (no job required).

### `GET /api/printers/:id/utilization?days=30`

Aggregated `printer_status_history` plus job counts for OEE-style utilization.

---

## Shared masters (ERP + shopfloor)

Same SQLite file. Read-only aggregates for CoMa UI.

### `GET /api/shared/machines`

```json
{
  "machines": [{
    "id": 1,
    "name": "LABOR",
    "hourly_rate": 20,
    "is_active": 1,
    "printer_id": null,
    "printer_name": null,
    "printer_model": null,
    "printer_status": null,
    "kind": "rate"
  }],
  "printers": [{ "id": 3, "name": "MK4_01", "model": "MK4", "status": "IDLE", "is_active": 1, "kind": "printer" }],
  "linked_printer_machines": 0,
  "source": "shared-sqlite"
}
```

`machines` are ERP rate centers (`machine` table). Acres only stored `name` + `hourly_rate` (USD/h). CoMa also links `printer_id` and, when joined, returns `printer_name` / `printer_model` / `printer_status` from the shopfloor fleet.

### `GET /api/shared/materials`

```json
{
  "items": [{ "id": 1, "sku": "PLA-BLK", "name": "PLA Black", "dimension": "mass", "kind": "item" }],
  "filament_types": [],
  "filament_colors": [{ "id": 1, "name": "Black", "hex": "#111111", "hex_color": "#111111", "type_id": 1 }],
  "source": "shared-sqlite"
}
```

Color responses expose both `hex` and `hex_color` aliases and accept either historical database column, so older local datasets remain readable.

---

## Bridge (shopfloor → ERP)

### `POST /api/bridge/units-completed`

Creates a pending `erp_posting` for operator confirmation. Does **not** change `parts.completed_qty`. Stock moves happen only after `POST /api/erp/postings/:id/confirm`.

Body (required: `qty`):

```json
{ "sku": "BRACKET-L", "qty": 4, "machine_type": "3d_printer", "shopfloor_job_ref": 42 }
```

`201` (new) / `200` (idempotent same job):

```json
{
  "ok": true,
  "posting": { "id": 1, "job_id": 42, "erp_sku": "BRACKET-L", "qty": 4, "status": "pending" },
  "created": true,
  "linked_part": { "id": 3, "erp_sku": "BRACKET-L" },
  "note": "Pending ERP posting created; confirm in /erp/postings to move stock"
}
```

---

## ERP (embedded)

Mounted at `/api/erp` on the same Express process. Full module map: [docs/erp/README.md](erp/README.md).

| Method | Path | Notes |
|---|---|---|
| `GET` | `/api/erp/health` | `{ "status": "ok", "erp": "embedded" }` |
| `GET` | `/api/erp/dashboard` | KPIs including `pending_postings`, shopfloor link, sync summary, needs_attention |
| `POST` | `/api/erp/sync` | Soft-sync printers/projects/parts/filaments into ERP |
| `GET` | `/api/erp/postings` | Posting queue; optional `?status=pending\|posted\|dismissed` |
| `GET` | `/api/erp/postings/:id` | Preview shortage / std+actual unit cost / cost_basis for one posting |
| `POST` | `/api/erp/postings/:id/confirm` | Apply stock moves (actual cost when telemetry measured); body `{ "acknowledge_shortage": true }` when 409 shortage |
| `POST` | `/api/erp/postings/:id/dismiss` | Discard pending posting without stock moves |
| `GET` | `/api/erp/reports/cost-variance` | Std vs actual minutes/cost by component SKU; `?days=` |
| `GET` | `/api/erp/reports/profitability` | Project revenue / margin from telemetry + pricing; `?days=` |
| `GET` | `/api/erp/reports/machine-oee` | Availability / performance / quality / OEE per printer; `?days=` |
| `GET`/`POST` | `/api/erp/items`, `PUT /api/erp/items/:id` | SKU master (`item_role`: product/component/raw, `sourcing`: manufactured/outsource) |
| `GET`/`POST` | `/api/erp/warehouses`, `/api/erp/locations` | WH + bins |
| `GET`/`POST` | `/api/erp/mfg/machines` | Rate centers. Per machine: `rate_mode` `manual` (set `hourly_rate` USD/h) or `calculated` (`maintenance_rate` USD/h + `power_kw` × site electricity). GET joins linked printer name/model/status. Seeded `LABOR` is the BOM labor rate. |
| `GET`/`PUT` | `/api/erp/mfg/energy` | Site electricity price (`electricity_price_per_kwh`, stored as `pricing_config.ELEC_KWH`). PUT recalculates all calculated-mode machines. |
| `GET`/`POST` | `/api/erp/mfg/components` | Manufacturing components |
| `POST` | `/api/erp/mfg/calculate-component-cost` | Material + time estimate (includes scrap %) |
| `GET` | `/api/erp/inventory/stock`, `/api/erp/inventory/dashboard` | On-hand + KPIs |
| `POST` | `/api/erp/inventory/receive_by_sku` | Receive (WAC) |
| `GET`/`POST`/`DELETE` | `/api/erp/bom`, lines, `calculate-cost` | BOM + UOM/MFG cost (`is_estimate` on lines) |
| `GET`/`POST` | `/api/erp/wo`, `POST /api/erp/wo/:id/complete` | Work orders (`q` filtered in SQL) |
| `GET`/`POST` | `/api/erp/sales/config` | Pricing defaults |
| `GET`/`PATCH` | `/api/erp/sales/pricing`, `POST .../reset` | Per-item overrides |
| `GET` | `/api/erp/sales/reports` | Price matrix |
| `GET` | `/api/erp/sales/order/items` | Sellable FG + stock |
| `POST` | `/api/erp/sales/orders` | Sale (depletes FIN_GOOD) |
| `GET` | `/api/erp/sales/orders/report` | History; `format=csv\|pdf` |

### eBay Sell (`/api/erp/ebay`)

Mounted **before** `/api/erp` so these paths are not shadowed. Full operator guide: [docs/erp/ebay.md](erp/ebay.md). Credentials are never returned in full (masked). `ebay_credential` is excluded from backup export.

| Method | Path | Notes |
|---|---|---|
| `GET` | `/api/erp/ebay/status` | Configured flag, pending count, last sync errors |
| `GET`/`PUT` | `/api/erp/ebay/credentials` | Masked GET; PUT accepts partial secrets (blank keeps stored) |
| `POST` | `/api/erp/ebay/test-connection` | OAuth refresh + Account privilege probe |
| `GET`/`POST` | `/api/erp/ebay/listings` | Map ERP item to eBay SKU / offer_id |
| `PUT`/`DELETE` | `/api/erp/ebay/listings/:id` | Update or remove mapping |
| `POST` | `/api/erp/ebay/inventory/push` | Optional `{ "listing_id": N }`; else all active |
| `POST` | `/api/erp/ebay/orders/sync` | Pull Fulfillment orders; hybrid auto-post / queue |
| `GET` | `/api/erp/ebay/orders` | Local order history; `limit`/`offset` |
| `GET` | `/api/erp/ebay/orders/:orderId` | Order + lines |
| `GET` | `/api/erp/ebay/pending` | Pending lines for operator confirm |
| `POST` | `/api/erp/ebay/pending/:lineId/confirm` | Body `{ "acknowledge_shortage": true }` on 409 shortage |
| `POST` | `/api/erp/ebay/pending/:lineId/dismiss` | Abandon pending line |
| `GET` | `/api/erp/ebay/analytics/traffic` | Seller traffic report (cached) |
| `GET` | `/api/erp/ebay/analytics/seller-standards` | Seller standards profiles |
| `GET` | `/api/erp/ebay/analytics/privilege` | Account privilege |

#### `PUT /api/erp/ebay/credentials`

```json
{
  "environment": "sandbox",
  "marketplace_id": "EBAY_US",
  "client_id": "AppId...",
  "client_secret": "CertId...",
  "refresh_token": "v^1.1#i^1...",
  "auto_post": 1
}
```

Response (secrets masked):

```json
{
  "configured": true,
  "environment": "sandbox",
  "marketplace_id": "EBAY_US",
  "auto_post": 1,
  "client_id": "AppI********...",
  "client_secret": "Cert********...",
  "refresh_token": "v^1.********..."
}
```

#### `POST /api/erp/ebay/pending/:lineId/confirm`

Success: `{ "ok": true, "status": "posted", "sales_order_id": 12, "stock_move_id": 34 }`.

Shortage without acknowledge: `409` with `{ "error": "Insufficient stock", "acknowledge_required": true, "missing": [...] }`.

Parts may carry optional `erp_sku` (nullable) via `PUT /api/parts/:id`.
Set Ready and set-ready-batch enqueue `erp_posting` rows; they never alter completed_qty beyond the existing shopfloor credit paths.

### `POST /api/erp/sync`

Creates only missing links. Existing rates, SKUs, sourcing choices, and stock are preserved.

```json
{
  "ok": true,
  "created": { "machines": 0, "products": 1, "components": 2, "raw_materials": 3 },
  "needs_attention": [
    { "kind": "machine", "id": 7, "name": "MK4_01", "fields": ["hourly_rate"] }
  ]
}
```

Returns `200`; unexpected schema/database errors return `500`.

### `POST /api/erp/items`

```json
{
  "sku": "FG-BRACKET",
  "name": "Bracket",
  "warehouse_id": 2,
  "dimension": "COUNT",
  "display_uom_code": "EA",
  "purchase_uom_code": "EA",
  "item_role": "product",
  "sourcing": "manufactured"
}
```

Required: `sku`, `name`, `dimension`, `display_uom_code`, `purchase_uom_code`. `item_role` is `product`, `component`, or `raw`; `sourcing` is `manufactured` or `outsource`. Returns `201`, `400` for validation, `409` for duplicate SKU. `PUT /api/erp/items/:id` is partial and returns `404` if absent.

### `POST /api/erp/locations`

```json
{ "warehouse_id": 1, "code": "01A01" }
```

Codes use `##A##`. Returns `201`, `400` for format, `404` for warehouse, `409` for duplicate location in that warehouse.

### `POST /api/erp/inventory/receive_by_sku`

```json
{
  "sku": "RAW-PLA",
  "warehouse_id": 3,
  "location_id": 8,
  "qty": 5,
  "unit_cost": 20,
  "note": "PO 1042",
  "trans_date": "2026-09-17",
  "idem_key": "receive-po-1042-line-1"
}
```

`qty` and `unit_cost` use the purchasing UOM. Quantity must be positive and unit cost cannot be negative. A repeated `idem_key` returns the original `move_id` without receiving twice. The location must belong to the warehouse. Receiving a synced raw material clears its `Needs ERP data` reminder. Returns `200`, `400` for quantity, cost, or location mismatch, `404` for SKU/warehouse/location.

### `POST /api/erp/mfg/components`

Upserts by SKU and makes sure the matching component item exists.

```json
{
  "sku": "COMP-BRACKET",
  "name": "Printed bracket",
  "machine": "MK4_01",
  "std_minutes": 30,
  "raw_item_id": 4,
  "raw_qty_per_unit": 100,
  "scrap_pct": 5,
  "is_active": true
}
```

Returns `201` for create, `200` for update, `400` for missing fields, `404` for raw item.

### `POST /api/erp/mfg/calculate-component-cost`

```json
{ "raw_sku": "RAW-PLA", "raw_qty_per_unit": 100, "std_minutes": 30, "machine": "MK4_01" }
```

Returns source/display WAC, material cost, and time cost. Returns `400` for missing SKU and `404` for unknown SKU.

### BOM routes

Create/update a header with `POST /api/erp/bom`:

```json
{ "item_id": 10, "name": "Bracket BOM", "labor_hours_per_unit": 0.1 }
```

Upsert a line with `POST /api/erp/bom/:id/line`:

```json
{ "component_item_id": 9, "qty": 2 }
```

`GET /api/erp/bom/:id/calculate-cost` returns material, labor, and total. Delete a line with `DELETE /api/erp/bom/:id/line/:lineId`; delete the full BOM with `DELETE /api/erp/bom/:id`. Missing rows return `404`; missing IDs return `400`.

### Work order routes

```json
{
  "item_id": 10,
  "qty_planned": 5,
  "warehouse_code": "fin_good",
  "location_code": "01A01"
}
```

`POST /api/erp/wo` returns `201`. It requires a positive quantity, existing destination, a location belonging to that destination warehouse, and a BOM. Complete with:

```json
{ "qty_completed": 5 }
```

`POST /api/erp/wo/:id/complete` validates all material before a transaction issues raw/components, records labor, receives finished goods into the warehouse and location selected on the WO, and closes it. A closed WO returns unchanged, so a retry cannot double-consume stock. Returns `409` with `missing[]` for insufficient stock, `404` for missing WO/BOM/item, `422` for invalid quantity.

### `POST /api/erp/sales/orders`

```json
{ "sku": "FG-BRACKET", "qty": 1 }
```

Atomically depletes `fin_good`, updates cached on-hand quantity, and records history. Returns `201`, `400` for invalid quantity/config, `404` for unknown finished SKU, `409` for insufficient stock.

### `GET /api/erp/sales/orders/report`

Query: `start_date=YYYY-MM-DD`, `end_date=YYYY-MM-DD`, `page`, `limit`, and optional `format=csv|pdf`. JSON is paginated but summary totals cover the full filtered range. CSV and PDF always export the full range; PDF adds pages as needed instead of truncating rows. Invalid dates or a reversed range return `400`.

### Shopfloor create sourcing

`POST /api/projects` and `POST /api/parts` accept optional `sourcing` (`manufactured` or `outsource`). Invalid sourcing returns `400` before creating the shopfloor row. The response retains all original shopfloor fields and adds `erp_product` or `erp_component` when the embedded ERP schema is available. Standalone route usage without ERP remains compatible and returns the shopfloor row with a null ERP link.

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
  ],
  "parts_by_hour": [
    { "hour_start": 1774892400000, "parts": 12 }
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

`recent_activity` is the 12 most recent `finished` or `failed` jobs, each with `part_name` and `printer_name` joined in. (Retained in the payload for compatibility; the dashboard UI no longer renders this list.)

`parts_by_hour` is an array of 24 objects `{ hour_start, parts }` covering the rolling 24-hour window, one bucket per hour (epoch ms floored to the hour). Hours with no finished jobs have `parts: 0`. Used by the dashboard bar chart.

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

Downloads a complete CoMa snapshot as `shopfloor-backup-YYYY-MM-DD.json`. The stable filename is retained for compatibility. It includes `printers`, `projects`, `parts`, `gcodes`, `jobs`, `printer_events`, `printer_models`, `printer_groups`, `filament_types`, `filament_colors`, `settings`, gcode file contents, and an `erp` object containing every embedded ERP table. Older `farm-backup-*.json` files still restore. No request body.

**Response:** `Content-Disposition: attachment` JSON file.

### `POST /api/backup/restore`

Replaces all CoMa data represented by a previously exported backup file. Shopfloor tables, ERP inventory, costing, BOMs, work orders, pricing, and sales are restored in foreign-key-safe order. G-code files are written to `server/gcode/`. Since `filepath` stores only the filename, no path rewriting is needed. Each `gcode_files` key must be a bare filename; any unsafe key is rejected with `400` before anything is written.

Each table's restore INSERT covers the columns the *live* schema currently has (derived from `PRAGMA table_info`) that are also present in the backup's data, rather than a hardcoded list: so printer `serial_number`/`loaded_material`/`loaded_color`, project `required_material`/`required_color`/`allowed_groups`, part `print_time_seconds`/`material_grams`, and gcode `ams_slot`/`material_grams`/`allowed_groups`/`required_material`/`required_color` all round-trip correctly, along with any future column a migration adds. A column present in the live schema but missing from every row of a given backup (e.g. an older backup that predates it) is omitted from the INSERT entirely so the column's own schema default applies, instead of failing on `NOT NULL` columns like `parts.sort_order`.

`printer_models`, `printer_groups`, `filament_types`, `filament_colors`, and `settings` are restored the same way, but each is only cleared and rewritten if that key is present in the uploaded file: restoring a backup taken before these were added to the export leaves the farm's current printer models, groups, filament library, and settings untouched rather than wiping them with nothing to restore.

The ERP section is atomic: a current backup must contain arrays for all ERP tables or restore returns `400` before changing the database. A legacy backup with no `erp` key restores its shopfloor data and preserves the current embedded ERP domain.

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
  "erp": {
    "item": 42,
    "stock_move": 180,
    "bom": 12,
    "work_order": 28,
    "sales_order": 64
  }
}
```
The real response contains a count for all 15 ERP tables inside `erp`. For a legacy backup without an ERP section, `erp` is `null` to show that existing ERP data was preserved.

Returns `400` for an invalid JSON bundle, unsafe G-code filename, or incomplete ERP section, and `500` for an unexpected restore failure.
