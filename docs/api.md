# API Reference

All endpoints are served by the Express server at `http://localhost:3000`. The Vite dev server at port 5173 proxies all `/api/*` requests to port 3000.

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

Returns the updated printer object.

### `POST /api/printers/:id/decommission`

Removes the printer from active duty (`is_active = 0`). It will no longer be polled or receive jobs. Returns the updated printer object.

### `POST /api/printers/:id/recommission`

Returns a decommissioned printer to active duty (`is_active = 1`). Returns the updated printer object.

### `POST /api/printers/:id/mark-job-failure`

Marks the printer's most recent `finished` job as `failed`, undoes the `completed_qty` increment on the associated Part, and reopens the Part (and Project if needed). Also releases the hold so the printer can receive a new job.

Returns `{ "success": true, "job_id": N }`. Returns `404` if no finished job exists for this printer.

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

### `GET /api/parts/:id`

### `POST /api/parts`

Required: `project_id`, `name`, `target_qty`.

### `PUT /api/parts/:id`

Partial update. Accepts: `name`, `target_qty`, `completed_qty`, `status`.

**`completed_qty` auto-status:** when `completed_qty` is included in the request body, `status` is recalculated server-side — `closed` if `completed_qty >= target_qty`, `open` otherwise. An explicit `status` field in the body is ignored when `completed_qty` is also present.

### `PUT /api/parts/reorder`

Sets `sort_order` for a list of parts in one transaction. Send the full ordered array of IDs — index position becomes the new `sort_order`.

**Body:**
```json
{ "ids": [3, 1, 2] }
```

**Response:** `{ "success": true }`

Returns `400` if `ids` is missing or empty.

### `DELETE /api/parts/:id`

---

## G-codes

### `GET /api/gcodes`

Optional query param `?part_id=N` to filter by part.

Returns all G-code records. Each record includes `part_id`, `printer_model`, `filename`, `filepath`, `parts_per_plate`, `est_print_secs`, `created_at`.

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
| `500` | Unhandled server error |
