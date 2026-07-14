# Web App (Client)

## Purpose

The React single-page application served by Vite. In development, Vite runs on port 5173 and proxies all `/api/*` requests to the Express server on port 3000. The app provides:

- **Dashboard** — TV-optimized command center: fleet utilization, stat cards, printer grid, active project progress, and a needs-attention panel
- **Fleet page** — live grid of all active printers with status, filterable and searchable
- **Printers page** — searchable directory of all printers (active and decommissioned); click any row to open the detail view
- **Printer detail view** — per-machine event timeline, inline note form, printer header
- **Settings page** — CSV import UI for the printer registry, with flagged-row resolution
- **Projects page** — project/part/G-code management and production tracking
- **Jobs page** — live job queue with filters and cancel action

## Key Files

| File | Responsibility |
|---|---|
| `client/src/main.jsx` | React root — mounts `<App />` into `#root` |
| `client/src/App.jsx` | Layout shell, sidebar/topbar nav, `<Routes>` |
| `client/src/pages/Fleet.jsx` | Live printer grid |
| `client/src/pages/Printers.jsx` | Searchable all-printers directory |
| `client/src/pages/PrinterDetail.jsx` | Per-printer event timeline and note form |
| `client/src/pages/Decommissioned.jsx` | Decommissioned printer list with notes and recommission |
| `client/src/pages/Settings.jsx` | CSV import, flagged-row resolution, printer models |
| `client/src/pages/Dashboard.jsx` | TV command center dashboard |
| `client/src/pages/Projects.jsx` | Project/Part/G-code management |
| `client/src/pages/Jobs.jsx` | Job queue table with filters |
| `client/src/components/PollTimer.jsx` | Shared circular refresh-countdown ring used by Fleet and Dashboard |
| `client/index.html` | HTML shell with dark background baseline CSS |
| `client/vite.config.js` | Vite config — port 5173, `/api` proxy to 3000 |

## Layout

`App.jsx` renders a two-column shell:

```
┌──────────────────────────────────────────┐
│ SIDEBAR (180px)   │  MAIN CONTENT         │
│  Print Farm       │                       │
│  Manager          │  <Routes />           │
│                   │                       │
│  Dashboard        │                       │
│  Fleet            │                       │
│  Printers         │                       │
│  Projects         │                       │
│  Jobs             │                       │
│  Decommissioned   │                       │
│  Settings         │                       │
└───────────────────┴───────────────────────┘
```

**Responsive breakpoint at 600px:** the sidebar is hidden and replaced by a horizontal top nav bar. All page content is still fully accessible on mobile.

Navigation uses `react-router-dom` `<NavLink>` — active links are highlighted in blue (`#1e40af`).

## Dashboard Page

`client/src/pages/Dashboard.jsx`

TV-optimized command center intended to be shown full-screen on a large monitor or TV in the print farm. Polls `GET /api/dashboard` every 15 seconds (matching the Fleet page). A live clock ticks every second client-side.

**⛶ TV Mode button:** calls `element.requestFullscreen()` on the dashboard container — the sidebar disappears and the dashboard fills the screen. Use the browser's Escape key or fullscreen API to exit.

**Sections:**

| Section | Description |
|---|---|
| Header | Branding, fleet utilization % (printing / total), live HH:MM:SS clock and date |
| Hero stat cards | Printing, Idle, Awaiting sign-off, Parts Today (rolling 24h) — large tabular numerals |
| Fleet grid | All active printers as color-coded 54×44px cells, grouped by model row with per-row status summary badges and a color legend. Badge text and the per-cell hover tooltip are translated via `common.status*` keys (`STATUS_LABEL_KEYS`/`statusLabel()` in `Dashboard.jsx`, mirroring Fleet.jsx's `STATUS_COLORS.labelKey` convention) rather than the raw internal status code. |
| Active Projects | All active projects with **all parts** listed — per-part 3-segment progress bars (green = completed, blue = printing, dark = remaining), completion counts with `+N printing` annotation, and DONE badges on closed parts. No truncation. |
| Needs Attention | Every printer requiring a human, sorted by priority: AWAITING → ERROR → STOPPED → PAUSED → OFFLINE, then longest-waiting first. Each row shows a reason badge, printer name, and wait time derived from `last_event_at`. Empty state renders a green "✓ All clear" badge. |

The bottom row is a 2-column grid (`2fr 1fr`): Active Projects takes two-thirds, Needs Attention takes one-third on the right. Recent Activity is no longer rendered on the dashboard — finished/failed jobs are listed in detail on the Jobs page.

**Fleet cell colors:**

| Color | Status |
|---|---|
| Blue | PRINTING |
| Green | FINISHED / awaiting operator sign-off |
| Dark gray | IDLE |
| Orange | STOPPED |
| Red | ERROR |
| Near-black | OFFLINE |

---

## Fleet Page

`client/src/pages/Fleet.jsx`

Live printer grid that polls `GET /api/printers` every 15 seconds (matching the server-side poll interval).

**Features:**
- Status filter chips: All, Printing, Idle, Error, Attention, Offline — each shows live count
- Search box filters by printer name, IP, or group name (case-insensitive)
- Printers grouped by model: MK4S → Core One → Core 1L → XL → Other (in that order)
- Each printer card shows: name, status badge (color-coded), model tag, group name
- **While PRINTING:** job filename (monospace, truncated), left-to-right blue progress bar, percentage, time remaining, and wall-clock ETA (e.g. "45m left · done 4:35 PM")
- **While UPLOADING (display-only overlay):** the hardware still reports IDLE while the scheduler transfers a file, so cards with a healthy in-flight upload (`has_uploading_job` and not held) show a violet "Uploading" badge, the filename, and "Sending file to printer…". Held + uploading is a *failed* upload and renders the existing orange confirmation UI instead. The overlay is computed client-side (`displayStatus()` in Fleet.jsx) and never written to `printers.status`; the Uploading chip/count appears in the filter row and uploading printers are excluded from the Idle count.
- IP address is not shown on cards
- Empty state message when no printers are registered

**Status color scheme (aligned to Prusa UI):**

| Status | Background | Text |
|---|---|---|
| PRINTING | dark blue | blue |
| IDLE | dark gray | gray |
| READY/Prepared | dark gray | muted gray |
| FINISHED | dark green | light green |
| PAUSED | dark amber | yellow |
| ATTENTION | dark amber | yellow |
| ERROR | dark red | red |
| OFFLINE | dark gray | gray |
| UNKNOWN | dark gray | light gray |

Filter chips in the Fleet header derive their text color from the same `STATUS_COLORS` constant so badges and chips are always in sync.

**Card click behavior:** clicking a printer card navigates to its detail view (`/printers/:id`). The exception is a card awaiting sign-off (held + `FINISHED`/`IDLE`/`STOPPED`): there, clicking toggles the card's selection for the batch "Set Ready (N)" action instead. Action buttons inside a card (Set Ready, Bad Print, etc.) `stopPropagation`, so they never trigger navigation.

**Confirmation button visibility:** "Set Ready" and "Bad Print" buttons (and the green card highlight) appear when `is_held === 1` AND `status` is `FINISHED`, `IDLE`, or `STOPPED`.

**Stopped printers:** `STOPPED` is included because some printers (Bambu) latch the stopped state until the next print starts, with nothing to acknowledge on the printer screen — confirming here is the only way to resume dispatch without power-cycling the machine. For stopped printers the `Good: N / M` input defaults to **0** (the operator deliberately stopped the print, so crediting parts must be an explicit choice); this also excludes them from batch Set Ready via the partial-count rule, forcing individual confirmation. Server-side, set-ready resolves the stopped (`cancelled`) job when it is newer than the last finished job, crediting `confirmed_qty` — it is never applied as a delta against the older finished job.

A STOPPED printer that is **not** held (its outcome was already resolved, or the stopped print was never a farm job) shows no buttons — instead it is dispatch-eligible: `sweepIdlePrinters` includes unheld STOPPED printers, so it returns to service on the next sweep (server start, project activation, or Sweep for Jobs). The card notes this.

**OFFLINE-with-job handling:** when `is_held === 1` AND `status` is `OFFLINE` AND `has_active_job === 1`, an amber card and separate amber banner appear instead of the green confirmation UI. Two buttons are shown:
- **✓ Job OK** — releases the hold via `POST /api/printers/:id/set-ready`. The job stays as `printing` and resolves naturally when the printer finishes. No qty is credited.
- **✗ Job Failed** — calls `POST /api/printers/:id/mark-job-failure`, marking the job failed and decommissioning the printer for investigation.

If the printer recovers and transitions back to `PRINTING` on its own, the scheduler auto-releases the hold with no operator action required. The amber banner includes a note explaining this.

**Partial plate confirmation:** when a job's `last_parts_per_plate` is known, a `Good: [N] / M` number input appears between the Include checkbox and the Set Ready button. It pre-fills with the full plate count. If the operator reduces it (e.g. 24 of 25 parts came out good), clicking Set Ready applies the delta to `completed_qty` and the Include checkbox is hidden — the printer cannot be batch-confirmed and must be set ready individually. Bad Print remains for full/catastrophic failures that also decommission the printer.

**Decommission resolves a pending sign-off:** the Decommission action checks whether a print outcome is still unresolved — `has_active_job` (an uploading/printing job) **or** `is_held` (the green/red sign-off is showing). If either is true, it opens the "Was the last print successful?" dialog: *succeeded* → `POST /api/printers/:id/complete-and-decommission` (keeps the parts already credited at finish, clears the hold, takes the machine offline); *failed* → `POST /api/printers/:id/mark-job-failure` (undoes the credit, decommissions). Only a printer with no pending outcome takes the direct path (`POST /api/printers/:id/decommission` with just a reason). This prevents decommissioning a FINISHED-and-held printer without resolving its waiting confirmation — e.g. taking a machine offline to swap filament after a good print.

When a held printer shows the partial-plate `Good: N / M` input, the count is carried into the *succeeded* path as `confirmed_qty`: `complete-and-decommission` applies it exactly like Set Ready (a delta against the full plate `_handleFinished` already booked, or the credited amount on a missed-finish), the only difference being the machine is decommissioned instead of re-queued. If the reduced count drops the part below its target, the part — and its project if it had just completed — reopens and re-enters the queue for the next available printer.

## Printers Page

`client/src/pages/Printers.jsx`

Searchable directory of every active printer registered in the farm, grouped by model. Each model is a collapsible section with a header showing the count and compact status-summary pills (e.g. `5 printing · 2 idle · 1 offline`). Designed to scale to hundreds of printers.

**Toolbar:**
- Search box — filters by name, model, group, or IP (case-insensitive)
- **Expand all / Collapse all** buttons
- **Show decommissioned** checkbox — hidden by default; when enabled, decommissioned printers appear in a dimmed "Decommissioned" group at the bottom

**Collapse state** is persisted to `localStorage` (`printers.collapsedGroups`, `printers.showDecommissioned`) so the operator's view sticks across reloads.

**Search behavior:** when a query is active, collapse state is overridden — groups with matches expand, groups with zero matches are hidden, and a "N of M match" hint appears above the list.

**Columns within a group:** Name, Group, IP, Status badge. (Model is implied by the group header.) Badge text is translated via `common.status*` keys, mirroring Fleet.jsx/Dashboard.jsx's `labelKey` convention.

**Bulk edit:** selecting one or more printers (row checkboxes / select-all) reveals a bulk-edit bar. It can set **Material** and **Color** (dropdowns from the filament library) and **Group** (free-text input with a `<datalist>` autocomplete, now sourced from the persisted group registry, `GET /api/groups`, rather than derived from currently-loaded printers, so a registered group still autocompletes even if no printer currently carries it; typing a new name still works and registers it). "Apply to selected" loops `PUT /api/printers/:id` for each selected printer; only non-empty fields are sent, so empty fields are left unchanged. Each changed field is recorded as an `info_changed` event on the printer. Common use: funnel small prints to low-spool machines by bulk-assigning them a group, then targeting that group from the G-code's `allowed_groups` (or the project's, see the Projects page).

Click any row to navigate to `/printers/:id` (the Printer Detail view).

## Printer Detail View

`client/src/pages/PrinterDetail.jsx`

Per-machine history and annotation screen. Reached by clicking a printer card in the Fleet page, clicking a row in the Printers page, or via the "View History" button in the Decommissioned page.

**Header card:** printer name, live status badge (or DECOMMISSIONED), model, IP, connector type, decommissioned timestamp if applicable. Status badge and the job-history status column are translated via `common.status*`/`jobs.status*` keys (the job-history column also maps the legacy `done` job status alias to `common.statusFinished`); dates and durations are formatted using `i18n.resolvedLanguage` (falling back to `i18n.language`, then `en`) and translated `h`/`m` duration units, so a future non-English language doesn't mix translated labels with English-only formatting.

**Rename:** a **Rename** button next to the printer name swaps the header into an inline edit form. Save sends `PUT /api/printers/:id` with the new `name`; the server's UNIQUE-name 409 is surfaced inline. Escape or the Cancel button closes the form without saving.

**Edit Details form:** includes a Group field with a `<datalist>` autocomplete sourced from `GET /api/groups`, same free-text-plus-suggestions behavior as the Printers page bulk-edit and the Settings Add Printer form.

**Add note form:** freeform textarea → `POST /api/printers/:id/events`. Submitted note appears immediately at the top of the timeline.

**Event timeline:** all `printer_events` rows for this printer, newest first. Each entry shows:
- Color-coded type badge (`Job Finished` / `Job Failed` / `Decommissioned` / `Recommissioned` / `Note`)
- Note text (if any)
- Formatted timestamp

**← All Printers** back button returns to the Printers list.

## Decommissioned Page

`client/src/pages/Decommissioned.jsx`

Responsive grid of decommissioned printers — printers that have been pulled from the active fleet for inspection. Cards auto-fill into 2 or 3 columns depending on viewport width (`repeat(auto-fill, minmax(360px, 1fr))`).

**Each card shows:** printer name, model + IP + group metadata, removal timestamp, an investigation note area, and compact icon-style action buttons (↩ Recommission, ⋯ View History) in the top-right.

**Note editing:**
- Click the note area to enter edit mode (the dashed-border placeholder becomes a focused textarea)
- **Enter saves** · Shift+Enter inserts a newline · Esc cancels
- Blur auto-saves as a backstop
- Save no-ops if the draft is unchanged, to avoid spurious `printer_events` entries
- Saving the note also appends a note event to the printer's timeline (`POST /api/printers/:id/events`)

**Recommission** uses the styled `useConfirm` modal — the worker must confirm that the machine has been fully inspected and is safe to run before it returns to the active fleet. On confirm: `POST /api/printers/:id/recommission` and a success toast.

## Settings Page

`client/src/pages/Settings.jsx`

**Server Alerts section:** shown only when unresolved notifications exist. Polls `GET /api/notifications` every 15 seconds. Each alert shows the message, timestamp, and an × dismiss button (`DELETE /api/notifications/:id`). Alerts are generated by the scheduler when it encounters a recoverable error (e.g. a missing G-code file) — the affected printer is held and the alert tells the operator exactly which file to re-upload and for which part/project.

**CSV Import flow:**
1. Operator picks a `.csv` file and clicks "Import CSV"
2. `POST /api/printers/import` (multipart)
3. Result summary shown: imported count, skipped count, flagged count
4. Flagged rows with "Cannot infer model" show a model dropdown + Save button
5. Clicking Save calls `POST /api/printers` with the operator-selected model
6. Saved rows are removed from the flagged list and the imported count increments

**Section order** (tuned for first-run flow): Server Alerts → Printer Models → Groups → Filament Library → Add Printer → CSV Import → Farm Name → Language → Dispatch Settings → Farm Backup → Polling info. Models, Groups, and Filaments come first because the Add Printer form depends on them.

**Groups section:** lists every registered group (`GET /api/groups`) with a Delete button per row and a name-only add form (`POST /api/groups`). Modeled on the Printer Models section, minus the type/color hierarchy Filament Library has. Deleting a group is blocked with an inline error naming the printer/G-code/project count still referencing it (`DELETE /api/groups/:name`, `409`). A group doesn't have to be created here first: typing a new name on a printer (Add Printer form, Printers bulk-edit, PrinterDetail, or CSV import) registers it automatically; this section exists for pre-creating a group before any printer uses it, and for cleanup.

**Add Printer form:** shows a per-brand help box (`CREDENTIAL_HELP`) explaining where to find each brand's credentials (PrusaLink API key, Bambu LAN access code + serial, Elegoo/Klipper no key). If no models exist for the selected brand, an inline hint points at the Printer Models section. The Group field is a `<datalist>` autocomplete, same as Printers bulk-edit and PrinterDetail.

**Farm Name section:** saves the `farm_name` setting (`PUT /api/settings/farm_name`); `App.jsx` fetches it on load and shows it in the sidebar/topbar, falling back to "Print Farm".

**Farm Backup section:** Export and Restore buttons — see [api.md](api.md) for the backup endpoints.

**Polling info section:** displays the 15-second interval and explains concurrent polling behavior.

## Projects Page

`client/src/pages/Projects.jsx`

Primary operator screen for setting up and launching print runs.

**List view (default):**
- All projects with name and status badge, click to open detail
- "New Project" inline form: name + optional description → `POST /api/projects`

**Detail view:**
- Header with project name (click ✎ to rename inline → `PUT /api/projects/:id { name }`), status badge, and context-sensitive action button:
  - `draft` → "Activate" → `PUT /api/projects/:id { status: 'active' }` + `POST /api/scheduler/dispatch`
  - `active` → "Pause" → `PUT /api/projects/:id { status: 'paused' }`
  - `paused` → "Resume" → same as Activate
  - `completed` → no button
- **Project-level targeting defaults:** two rows shown when a filament library or a group registry exists. *Filament*: Material/Color dropdowns → `PUT /api/projects/:id/filament`. *Groups*: checkboxes sourced from `GET /api/groups` → `PUT /api/projects/:id/groups`. Both apply to every G-code in the project that doesn't set its own override, and both are visible again in the per-gcode Targeting row below (Upload G-code and each G-code file's estimate row): a per-gcode value always wins over the project default, and the per-gcode picker's empty state reads "inherits project: X" instead of "all groups"/"any material" when a project default is set. See the "Targeting cascade" note in [database.md](database.md).
- **Parts list:** each row shows name (with ▲/▼ priority buttons), a 3-segment progress bar, a fixed-width status badge (Open/Closed), and a Details toggle. A red `×` delete button appears at the far right — clicking it confirms then calls `DELETE /api/parts/:id`, which cascades to all jobs and G-code files for that part. Deletion is blocked (with an alert) if the part has an active uploading or printing job. All other editing is behind the Details button.

  **Progress bar segments:** green = `completed_qty` (confirmed done); blue = `active_qty` (parts currently printing across all active jobs); dark background = not yet started. When active jobs push the total past `target_qty`, the bar rescales against `max(target, completed + active)` and an amber tick marks the target. The count label shows `976 +24 printing / 1000` when jobs are active.
- **▲/▼ ordering buttons:** move a part up or down in dispatch priority. Updates `sort_order` via `PUT /api/parts/reorder`. Optimistic — local state reorders immediately.
- **Details panel** (per part, toggle with "Details" button): four sections:
  - *Part Name* — current name displayed with a ✎ pencil button. Click to edit inline; Enter or blur saves, Escape cancels → `PUT /api/parts/:id { name }`
  - *Quantities* — editable Have (completed_qty) and Need (target_qty) fields, single Save button. Confirm dialogs guard open↔closed transitions. Server auto-calculates status.
  - *G-code Files* — lists each uploaded file with filename, printer model badge, and × delete button (with confirm) → `DELETE /api/gcodes/:id`
  - *Upload G-code* — file picker → `POST /api/gcodes/parse-filename` pre-fills `parts_per_plate` and model. `409` duplicate error shown inline.
- **Add Part form:** name + target quantity → `POST /api/parts`

## Jobs Page

`client/src/pages/Jobs.jsx`

Live job queue that polls `GET /api/jobs` every 15 seconds.

**Columns:** ID, Part, Project, Printer, Model, Status, Started, Duration, Actions

**Filters:** status dropdown (all / queued / uploading / printing / finished / failed / cancelled), project dropdown, printer dropdown, all passed as query params on each fetch. The dropdown filters on the real `jobs.status` column; "Awaiting Sign-off" below is a display-only badge, not a filterable value.

**Actions:** "Cancel" button on `queued` rows → `DELETE /api/jobs/:id` with confirm dialog.

**Status color coding:**

| Status | Background | Text |
|---|---|---|
| queued | dark gray | gray |
| uploading | dark blue | blue |
| printing | dark green | bright green |
| finished | muted dark green | light green |
| failed | dark red | red |
| cancelled | near-black | muted gray |

**"Awaiting Sign-off" badge (display-only):** a row whose `jobs.status` is still `printing` can belong to a printer that is already held for operator confirmation (for example a printer that transitions `PRINTING` -> `IDLE` directly, with no observable `FINISHED`/`STOPPED` in between two polls). `GET /api/jobs` joins `printer_is_held` and `printer_status` for exactly this case; `displayJobStatus()` in Jobs.jsx renders such a row as "Awaiting Sign-off" (green) instead of "Printing" (blue) so the Jobs page agrees with Fleet/Dashboard, which already reflect the hold via `is_held`. The underlying job row is untouched: it still says `printing` until the operator resolves it via Set Ready or Bad Print, at which point it becomes `finished`/`failed` normally.

## Live Update Pattern

The Fleet, Dashboard, and Jobs pages use the same pattern — no WebSocket, no SSE. Pure polling:

```js
useEffect(() => {
  fetchPrinters();                             // immediate on mount
  const interval = setInterval(fetchPrinters, 15000);
  return () => clearInterval(interval);        // cleanup on unmount
}, [fetchPrinters]);
```

This matches the server's 15-second poll interval. In practice, the UI is never more than ~30 seconds behind reality (server poll + client poll worst case).

## Configuration

| Setting | Value | Location |
|---|---|---|
| Dev server port | 5173 | `client/vite.config.js` |
| API proxy target | `http://localhost:3000` | `client/vite.config.js` |

## Dependencies

| Package | Version | Purpose |
|---|---|---|
| `react` | ^18.3.1 | UI framework |
| `react-dom` | ^18.3.1 | DOM renderer |
| `react-router-dom` | ^6.24.0 | Client-side routing |
| `i18next` | ^26.0.0 | i18n core (resources, interpolation, pluralization) |
| `i18next-browser-languagedetector` | ^8.0.0 | Detects/caches the visitor's language (localStorage, then browser) |
| `react-i18next` | ^17.0.0 | React bindings (`useTranslation`, `Trans`) for i18next |
| `vite` | ^8.0.16 | Dev server and bundler |
| `@vitejs/plugin-react` | ^5.2.0 | JSX transform + Fast Refresh |

## Quick Start (client only)

```bash
cd client
npm install
npm run dev     # starts Vite on port 5173
```

The server must also be running for API calls to succeed.
