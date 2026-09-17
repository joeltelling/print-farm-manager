# Web App (Client)

## Purpose

The React single-page application served by Vite. In development, Vite runs on port 5173 and proxies all `/api/*` requests to the Express server on port 3000. The production build is installable as a PWA (manifest + service worker). The app provides:

- **ERP Dashboard:** CoMa ERP command center at `/erp` (KPIs, shopfloor sync, needs-data queue, pending postings). Modules: Products & components (product=project, component=part; manufactured/outsource), Locations, Inventory (charts), Manufacturing dashboard, Machines, Mfg Components, BOM, Work Orders, QR complete, Postings queue, Sales dashboard. Full `/api/erp` on the same Express process and SQLite file. Legacy Acres HTML is not served.
- **Dashboard:** CoMa command center: KPI cards, utilization donut, parts-per-hour bars, clickable fleet grid, active projects, and a Needs Attention queue
- **Fleet page** — live grid of all active printers with status, filterable and searchable
- **Printers page** — searchable directory of all printers (active and decommissioned); click any row to open the detail view
- **Printer detail / incident view:** camera (Klipper), event log, stats, notes, job history
- **Settings page:** tabbed site, hardware, materials, alerts, backup, account, and about
- **Projects page** — project/part/G-code management and production tracking
- **Jobs page** — live job queue with filters and cancel action
- **Calendar page** - planned stock arrivals, shipments, deadlines, and production closures (closures block new job dispatch)
- **Workspace Tablero** - single shared CoMa-styled kanban for operator tasks (`/workspace`)
- **Workspace Bloc** - technical notepad with dark graph paper, trash, and autosave (`/workspace/bloc`)

Nav is a three-level tree: **module** (ERP, Shopfloor, Workspace), **group** (only under ERP: Resumen, Inventario, Fabricacion, Ventas), and **screen**. Modules and ERP groups are accordion toggles (one open at a time); open state is stored in `localStorage` as `coma.nav.accordion` and re-opened from the active route. Shopfloor and Workspace are flat lists under their modules. Settings sits below. On mobile the top bar shows every link flat with module and group labels.

**Boot splash:** on the first entry of a browser tab session, a full-screen CoMa boot animation covers the shell (`BootSplash`, keyed by `sessionStorage` `coma.boot.done`). React Router moves do not remount App, so in-app navigation never re-shows it. A reload in the same tab skips it; a new tab shows it again.

**Login gate:** `client/src/components/AuthGate.jsx` wraps `<App />` in `main.jsx`, outside `<BrowserRouter>`. It fetches `GET /api/auth/status` and renders, in order: a blank shell while loading, an account-creation screen if no account exists yet, a login screen if not authenticated, a one-time setup guide (site name, dispatch concurrency) if the account has never completed onboarding, or `<App />` itself. `App` does not mount until all three gates pass, so its own effects (fetching `/api/settings` for the sidebar name) never run against a 401. Settings > Account dispatches the `authLoggedOut` and `authAccountDeleted` window events (the same cross-page pattern as `farmNameChanged`) to make `AuthGate` re-check status after logout or account deletion. See [docs/api.md](api.md#authentication).

**Shared ERP DB:** Express embeds `/api/erp/*` and `/api/shared/*` on the same dataset SQLite file. React ERP pages use the CoMa theme.

## Key Files

| File | Responsibility |
|---|---|
| `client/src/main.jsx` | React root — mounts `<App />` into `#root` |
| `client/src/App.jsx` | Layout shell, sidebar/topbar, `<Routes>` |
| `client/src/components/NavTree.jsx` | Module / group / screen nav tree, accordion state, route sync |
| `client/src/pages/Erp.jsx` | ERP route exports; `/erp` renders the live ERP Dashboard |
| `client/src/pages/erp/modules.jsx` | Dashboard, postings (std/actual cost), analytics, manufacturing dashboard, products/components, locations, inventory charts, machines, MFG components, BOM, WO, QR |
| `client/src/pages/erp/sales.jsx` | Sales dashboard, defaults, pricing (Enter/Escape), order entry with live totals, matrix badges/sort, history exports |
| `client/src/pages/erp/ebay.jsx` | eBay Sell: credentials, SKU maps, pending order queue, inventory push, analytics |
| `client/src/pages/erp/format.js` | Acres-compatible numeric display helpers |
| `client/src/pages/erp/qr.js` | Dependency-free local QR SVG generator for printable WO pick lists |
| `client/src/pages/Timelapses.jsx` | Timelapse gallery, manual start, video/frame preview |
| `client/src/pages/Calendar.jsx` | Month grid of planned events + ERP/job history overlay; production-closure banner |
| `client/src/pages/WorkspaceBoard.jsx` | Workspace kanban: columns, cards, HTML5 drag reorder |
| `client/src/pages/Notebook.jsx` | Technical notebook: list + graph-paper editor, trash, autosave |
| `client/src/pages/Settings.jsx` | Tabbed settings (site name, camera mode, timelapse interval/FPS/retention, models, CSV, backup, account) |
| `client/src/components/BootSplash.jsx` | Session boot splash (once per tab session; not on in-app navigation) |
| `client/src/components/AuthGate.jsx` | Wraps `<App />`; gates on account creation, login, and the one-time setup guide |
| `client/src/pages/Fleet.jsx` | Live printer grid |
| `client/src/pages/Printers.jsx` | Searchable all-printers directory |
| `client/src/theme.js` | Design tokens: surfaces, borders, text ramp, accents, radii, shadows, and the shared card/input/button style objects |
| `client/src/pages/PrinterDetail.jsx` | Incident view: camera, event timeline, notes |
| `client/src/pages/Settings.jsx` | Tabbed settings (site name, camera mode, models, CSV, backup, account) |
| `client/src/pages/Dashboard.jsx` | Command center dashboard |
| `client/src/components/CameraFeed.jsx` | Snapshot (5s) or MJPEG stream for Klipper cameras |
| `client/src/components/AlertBell.jsx` | Shell bell for in-memory server alerts |
| `client/src/components/DonutChart.jsx` | Handmade SVG donut |
| `client/src/components/BarChart.jsx` | Handmade SVG bars |
| `client/src/pages/Projects.jsx` | Project/Part/G-code management |
| `client/src/pages/Jobs.jsx` | Job queue table with filters |
| `client/src/pages/Decommissioned.jsx` | Decommissioned printer list with notes and recommission |
| `client/src/components/PollTimer.jsx` | Shared circular refresh-countdown ring used by Fleet and Dashboard |
| `client/index.html` | HTML shell with dark background baseline CSS, PWA meta tags |
| `client/vite.config.js` | Vite config — port 5173, `/api` proxy to 3000 |
| `client/public/manifest.webmanifest` | PWA install manifest (name, icons, standalone display) |
| `client/public/sw.js` | Service worker: caches app shell; never caches `/api/*` |
| `client/public/icons/` | PWA icons (192 / 512) |

## PWA

Production builds are installable:

- `client/public/manifest.webmanifest` declares name, standalone display, theme colors, and icons
- `client/public/sw.js` precaches the app shell and never caches `/api/*`
- `client/src/main.jsx` registers the service worker only when `import.meta.env.PROD` is true (Vite/dev does not register it)
- Express serves `.webmanifest` as `application/manifest+json`

Use the built client on port 3000 (or HTTPS) to install. Vite hot-reload on 5173 is for development only.

## Layout

`App.jsx` renders a two-column shell:

```
┌──────────────────────────────────────────┐
│ SIDEBAR (256px)   │  MAIN CONTENT         │
│  CoMa / site name │                       │
│  CoreManufacturing│  <Routes />           │
│                   │                       │
│  ERP (accordion)  │                       │
│    Resumen / ...  │                       │
│  Shopfloor        │                       │
│    Dashboard ...  │                       │
│  Workspace        │                       │
│    Tablero / Bloc │                       │
│  Settings         │                       │
│  [alert bell]     │                       │
└───────────────────┴───────────────────────┘
```

**Responsive breakpoint at 600px:** the sidebar is hidden and replaced by a horizontal top nav bar (flat links, no accordion). All page content is still fully accessible on mobile. Decommissioned printers stay reachable at `/decommissioned` and via the Printers page toggle.

The sidebar shows the operator-configured site name (`farm_name`, default CoMa) with a CoreManufacturing subtitle and a live lime dot. Modules and groups are chevron rows rather than boxed cards, active links use a rounded lime pill with a trailing dot, and the pinned footer is the System Logs row (the alert bell, with the pending count spelled out). Main content scrolls inside a dotted-grid backdrop and is capped at 1720 px, centered.

### Design system

One place defines the look: `client/src/theme.js`. Pages import tokens from it instead of pasting hex values.

| Group | Tokens |
|---|---|
| Surfaces | `shell` `#0a0b0f`, `page` `#0d0e14`, `sidebar` `#0f1017`, `panel` `#12131c`, `card` `#141620`, `cardAlt` `#181a27`, `cardSoft` `#171825`, `hover` `#1d1f2c` |
| Borders | `borderSoft` `#1e202e`, `border` `#232639`, `borderStrong` `#2d3146` |
| Text | `textBright`, `text`, `textStrong`, `textMuted`, `textDim`, `textFaint` (zinc ramp) |
| Accents | `lime` (primary metric), `accent` / `violet` (actions and in-progress), `indigo`, `cyan`, `teal` (value), `amber` / `orange` (needs a human), `emerald` (healthy), `red` (failure) |
| Style objects | `CARD_STYLE`, `PANEL_STYLE`, `INPUT_STYLE`, `BTN_PRIMARY`, `BTN_SECONDARY`, `CAPTION_STYLE`, `CHIP_STYLE`, plus the `tintStyle()` / `hexAlpha()` helpers that derive a tinted fill and border from any accent |

Typography is Plus Jakarta Sans for prose and JetBrains Mono (`theme.mono`) for identifiers, counts, and machine-readable metadata. Shared chrome lives in `client/src/components/`: `Card` (caption header with optional live dot, badge, and footer), `KpiCard` (compact metric tile, optional accent frame and router link), `PageHeader` (title, status badge, actions), `StatusPill`, and `EmptyState`.

## Dashboard Page

`client/src/pages/Dashboard.jsx`

TV-optimized command center. Polls `GET /api/dashboard` every 15 seconds. A live clock ticks every second client-side. Failed polls keep the last successful payload (same pattern as Fleet). The site name stays in the sidebar only; the dashboard header is utilization + clock to avoid repeating the brand. On desktop the page is a viewport-height CSS grid so charts, fleet, and projects share remaining space instead of stacking into a long scroll; below ~1100px it stacks normally.

**TV Mode button:** calls `element.requestFullscreen()` on the dashboard container.

**Sections:**

| Section | Description |
|---|---|
| Header | Utilization %, printing count, live clock (site name is in the sidebar) |
| KPI cards | Printing, Idle, Awaiting sign-off, Parts Today (rolling 24h) |
| Parts last 24h | Handmade SVG bar chart from `parts_by_hour`; fills its grid cell |
| Fleet mix | Handmade SVG donut of live status counts; center shows printer count |
| Needs Attention | Printers requiring a human, sorted AWAITING, ERROR, STOPPED, PAUSED, OFFLINE, then longest-waiting first. Click opens `/printers/:id`. Empty state: All clear. |
| Fleet status | Equal-size responsive cells in one auto-fill grid that stretches to fill the card; model label on each cell |
| Active Projects | All active projects with per-part 3-segment progress bars |

`recent_activity` remains in the API payload for compatibility and is not rendered.

**Fleet cell colors:**

| Color | Status |
|---|---|
| Violet | PRINTING |
| Green | FINISHED / awaiting operator sign-off |
| Dark gray | IDLE |
| Orange | STOPPED |
| Red | ERROR |
| Near-black | OFFLINE |

---

## Fleet Page

`client/src/pages/Fleet.jsx`

Live printer grid that polls `GET /api/printers` every 15 seconds (matching the server-side poll interval). Model bands are split across two columns with a similar group count in each (first half left, second half right); below ~1100px they stack to one column. Within each band, cards sit in a fixed track (`200px` to `240px` via `auto-fill`) with a `200px` minimum height so they stay near-square mild rectangles. Klipper camera thumbnails are fixed at 88px tall.

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
| PRINTING | dark indigo | indigo |
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

**Needs attention:** instead of full-width banners, Fleet shows a compact header chip with the count (`N Needs attention`). Clicking it opens a modal listing failed uploads, offline-with-job printers, and awaiting-confirmation printers. Batch Select all / Set Ready live in that modal. Clicking a printer name opens its detail view.

**OFFLINE-with-job handling:** when `is_held === 1` AND `status` is `OFFLINE` AND `has_active_job === 1`, an amber card appears (and the printer is listed in the Needs attention modal) instead of the green confirmation UI. Two buttons are shown:
- **✓ Job OK** — releases the hold via `POST /api/printers/:id/set-ready`. The job stays as `printing` and resolves naturally when the printer finishes. No qty is credited.
- **✗ Job Failed** — calls `POST /api/printers/:id/mark-job-failure`, marking the job failed and decommissioning the printer for investigation.

If the printer recovers and transitions back to `PRINTING` on its own, the scheduler auto-releases the hold with no operator action required. The Needs attention modal notes this.

**Partial plate confirmation:** when a job's `last_parts_per_plate` is known, a `Good: [N] / M` number input appears between the Include checkbox and the Set Ready button. It pre-fills with the full plate count. If the operator reduces it (e.g. 24 of 25 parts came out good), clicking Set Ready applies the delta to `completed_qty` and the Include checkbox is hidden — the printer cannot be batch-confirmed and must be set ready individually. Bad Print remains for full/catastrophic failures that also decommission the printer.

**Decommission resolves a pending sign-off:** the Decommission action checks whether a print outcome is still unresolved — `has_active_job` (an uploading/printing job) **or** `is_held` (the green/red sign-off is showing). If either is true, it opens the "Was the last print successful?" dialog: *succeeded* → `POST /api/printers/:id/complete-and-decommission` (keeps the parts already credited at finish, clears the hold, takes the machine offline); *failed* → `POST /api/printers/:id/mark-job-failure` (undoes the credit, decommissions). Only a printer with no pending outcome takes the direct path (`POST /api/printers/:id/decommission` with just a reason). This prevents decommissioning a FINISHED-and-held printer without resolving its waiting confirmation — e.g. taking a machine offline to swap filament after a good print.

When a held printer shows the partial-plate `Good: N / M` input, the count is carried into the *succeeded* path as `confirmed_qty`: `complete-and-decommission` applies it exactly like Set Ready (a delta against the full plate `_handleFinished` already booked, or the credited amount on a missed-finish), the only difference being the machine is decommissioned instead of re-queued. If the reduced count drops the part below its target, the part — and its project if it had just completed — reopens and re-enters the queue for the next available printer.

## Printers Page

`client/src/pages/Printers.jsx`

Searchable directory of every active printer on the shopfloor, grouped by model. Each model is a collapsible section with a header showing the count and compact status-summary pills (e.g. `5 printing · 2 idle · 1 offline`). Designed to scale to hundreds of printers.

**Toolbar:**
- Search box — filters by name, model, group, or IP (case-insensitive)
- **Expand all / Collapse all** buttons
- **Show decommissioned** checkbox — hidden by default; when enabled, decommissioned printers appear in a dimmed "Decommissioned" group at the bottom

**Collapse state** is persisted to `localStorage` (`printers.collapsedGroups`, `printers.showDecommissioned`) so the operator's view sticks across reloads.

**Search behavior:** when a query is active, collapse state is overridden — groups with matches expand, groups with zero matches are hidden, and a "N of M match" hint appears above the list.

**Columns within a group:** Name, Group, IP, Status badge. (Model is implied by the group header.)

**Bulk edit:** selecting one or more printers (row checkboxes / select-all) reveals a bulk-edit bar. It can set **Material** and **Color** (dropdowns from the filament library) and **Group** (free-text input with a `<datalist>` autocomplete, now sourced from the persisted group registry, `GET /api/groups`, rather than derived from currently-loaded printers, so a registered group still autocompletes even if no printer currently carries it; typing a new name still works and registers it). "Apply to selected" loops `PUT /api/printers/:id` for each selected printer; only non-empty fields are sent, so empty fields are left unchanged. Each changed field is recorded as an `info_changed` event on the printer. Common use: funnel small prints to low-spool machines by bulk-assigning them a group, then targeting that group from the G-code's `allowed_groups` (or the project's, see the Projects page).

Click any row to navigate to `/printers/:id` (the Printer Detail view).

## Printer Detail View

`client/src/pages/PrinterDetail.jsx`

Incident and history screen. Reached from Dashboard Needs Attention, Fleet cards, Printers rows, or Decommissioned "View History". Polls printer + events every 15 seconds.

**Layout:** two columns on desktop (camera left, notes and event log right). Single column below 900px.

**Camera:** `CameraFeed` calls `GET /api/printers/:id/camera`. Klipper printers proxy snapshot (refresh every 5 seconds) or MJPEG stream through CoMa. Other connectors show "Camera not available" plus a link to `http://{ip}`. Bambu streaming is not implemented. Default mode comes from the `camera_mode` setting; the operator can toggle Low/Stream on the page.

**Header card:** printer name, live status badge, model, IP, connector, decommissioned timestamp if applicable. Operator Set Ready / Bad Print stay on the Fleet page; a text link points there.

**Event timeline:** all `printer_events` rows, newest first, including `error`, `job_cancelled`, `offline_with_job`, and `recovered`.

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

Tabbed layout (`?tab=`): General, Hardware, Materials, Alerts, Backup, Account, About. Multi-section tabs (General, Hardware, Materials) use a two-column layout above ~1100px. List rows (models, groups, filament types/colors) sit in a shared bordered list instead of sparse table cells.

**General:** site name (`farm_name`, label "Site name", fallback CoMa), camera mode (`snapshot` or `stream`), timelapse (enabled, interval seconds, FPS, retention days), dispatch batch size, polling explanation.

**Hardware:** printer models and groups on the left; add printer and CSV import on the right.

**Materials:** Filament Library types and colors side by side.

**Alerts:** in-memory scheduler notifications (`GET /api/notifications`). Also mirrored by the shell alert bell.

**Backup:** one JSON export/restore covers shopfloor, G-code files, settings, and every embedded ERP table in the shared SQLite dataset. Legacy shopfloor-only backups remain accepted and preserve current ERP records. See [api.md](api.md).

**Account:** shows the signed-in username with a Log out button, and a password-gated Delete account action. Deleting the account signs everyone out and makes `AuthGate` show account creation and the setup guide again on the next load; it does not touch printers, projects, parts, or ERP data. See [api.md](api.md#authentication).

## ERP Pages

All ERP pages use the CoMa shell, `theme.js`, inline styles, `useToast`, and `useConfirm`. Tables scroll horizontally on narrow screens and forms use auto-fit grids, so every action remains available at 600 px. `ErpShell` forwards `badge` and `actions` to `PageHeader`, so a module can put its status word next to the title and its primary action on the same row.

| Route | Operator workflow |
|---|---|
| `/erp` | KPIs, shopfloor sync, linked master counts, pending postings, and Needs ERP data reminders. Layout is an eight-tile metric grid, a stock-value strip, then a split of Shopfloor link (project/part/printer counts plus what the last sync created) and Needs ERP data (scrollable queue; each row links to the module that resolves it) |
| `/erp/postings` | Confirm or dismiss shopfloor postings (stock moves); shows std vs actual unit cost; acknowledge shortage when plastic already used |
| `/erp/analytics` | Profitability, machine OEE, and cost variance from shopfloor telemetry |
| `/erp/items` | Create/filter products, components, and raw materials; warehouse and UOM columns; set sourcing |
| `/erp/locations` | Create warehouses and validated `##A##` locations |
| `/erp/inventory` | Receive by SKU; value-by-warehouse charts; per-warehouse qty/value charts; on-hand total footer |
| `/erp/manufacturing` | Utilization vs machine rates, open WOs, machines missing rates |
| `/erp/machines` | Sync printers; set electricity USD/kWh; per-machine manual USD/h or calculated (maintenance + kW); clear missing-rate reminders |
| `/erp/components` | Upsert/edit manufacturing components; Mat $/unit and Time $/unit columns |
| `/erp/bom` | Product+BOM, inline qty edit, three-line cost footer, estimate* marker, deletes |
| `/erp/wo` | Create from BOM products, warehouse/name columns, complete qty, pick list with local QR |
| `/erp/qr` | Mobile completion target used by pick-list QR codes |
| `/erp/sales` | Sales dashboard (revenue, margin, FG stock) plus links to config/pricing/order/reports |
| `/erp/sales/*` | Defaults, Enter/Escape pricing edits, live order totals, margin badges, header sort, CSV/PDF |
| `/timelapses` | Gallery of job/manual captures; start on a machine; video or last-frame preview |

WO completion, sales orders, pricing resets, BOM deletion, BOM-line deletion, and posting confirm/dismiss use the CoMa confirmation modal. User-triggered mutations surface success/error toasts. The QR SVG is generated inside the browser and never sends an internal URL or WO identifier to an external service.

**About:** CoMa / mdwcoder fork credit with GitHub Sponsors CTA; upstream print-farm-manager (Joel) credit and donation links sit behind a collapsed "Original project" disclosure.

## Projects Page

`client/src/pages/Projects.jsx`

Primary operator screen for setting up and launching print runs.

**List view (default):**
- Only `active` projects show by default, ordered by dispatch priority (drag the ⠿ handle to reorder → `PUT /api/projects/reorder`). `draft`, `paused`, and `completed` projects are each hidden behind their own "Show X (count)" checkbox above the list, so a site with a long project history doesn't bury the in-flight work; a checkbox only appears when at least one project has that status. State persists per browser (`localStorage`), same pattern as the Printers page's "Show decommissioned". If every project is filtered out, an empty-state prompts to check a box rather than showing the first-run "create your first project" message.
- Each row shows name and status badge, click to open detail
- "New Project" inline form: name + optional description → `POST /api/projects`

**Detail view:**
- Header with project name (click ✎ to rename inline → `PUT /api/projects/:id { name }`), status badge, and a status dropdown with context-sensitive options:
  - `draft` → "Activate" (`PUT /api/projects/:id { status: 'active' }` + `POST /api/scheduler/dispatch`) or "Delete project" (`DELETE /api/projects/:id`)
  - `active` → "Pause project" (`PUT /api/projects/:id { status: 'paused' }`) or "Mark complete" (`POST /api/projects/:id/complete`)
  - `paused` → "Resume project" (same as Activate) or "Mark complete"
  - `completed` → "Re-activate" (`POST /api/projects/:id/reactivate`): reopens any closed parts that still have remaining qty and sweeps for idle printers immediately. Shows a warning toast instead of transitioning if every part is already at target qty (`nothing_to_reopen` in the response).
- **Project-level targeting defaults:** two rows shown when a filament library or a group registry exists. *Filament*: Material/Color dropdowns → `PUT /api/projects/:id/filament`. *Groups*: checkboxes sourced from `GET /api/groups` → `PUT /api/projects/:id/groups`. Both apply to every G-code in the project that doesn't set its own override, and both are visible again in the per-gcode Targeting row below (Upload G-code and each G-code file's estimate row): a per-gcode value always wins over the project default, and the per-gcode picker's empty state reads "inherits project: X" instead of "all groups"/"any material" when a project default is set. See the "Targeting cascade" note in [database.md](database.md).
- **Parts list:** each row shows name (with ▲/▼ priority buttons), a 3-segment progress bar, a fixed-width status badge (Open/Closed), and a Details toggle. A red `×` delete button appears at the far right — clicking it confirms then calls `DELETE /api/parts/:id`, which cascades to all jobs and G-code files for that part. Deletion is blocked (with an alert) if the part has an active uploading or printing job. All other editing is behind the Details button.

  **Progress bar segments:** green = `completed_qty` (confirmed done); blue = `active_qty` (parts currently printing across all active jobs); dark background = not yet started. When active jobs push the total past `target_qty`, the bar rescales against `max(target, completed + active)` and an amber tick marks the target. The count label shows `976 +24 printing / 1000` when jobs are active.
- **▲/▼ ordering buttons:** move a part up or down in dispatch priority. Updates `sort_order` via `PUT /api/parts/reorder`. Optimistic — local state reorders immediately.
- **Details panel** (per part, toggle with "Details" button): four sections:
  - *Part Name* — current name displayed with a ✎ pencil button. Click to edit inline; Enter or blur saves, Escape cancels → `PUT /api/parts/:id { name }`
  - *Quantities* — editable Have (completed_qty) and Need (target_qty) fields, single Save button. Confirm dialogs guard open↔closed transitions. Server auto-calculates status. If raising Need above Have reopens a part that was `closed` and the parent project had already `completed`, the project is reactivated to `active` server-side and swept for idle printers immediately, the same behavior as the Add Part form below and the header's Re-activate action. Since this part necessarily already has G-code from before it was closed, the sweep can genuinely dispatch it right away.
  - *G-code Files* — lists each uploaded file with filename, printer model badge, and × delete button (with confirm) → `DELETE /api/gcodes/:id`
  - *Upload G-code* — file picker → `POST /api/gcodes/parse-filename` pre-fills `parts_per_plate` and model. `409` duplicate error shown inline. A successful upload also triggers a scheduler sweep: this is what actually makes a brand-new part (added via the form below) dispatchable, since the scheduler requires a matching G-code.
- **Add Part form:** name + target quantity → `POST /api/parts`. If the parent project had `completed`, it's reactivated to `active` immediately, no separate manual reactivate step needed. The new part itself isn't dispatchable yet, though: it has no G-code, so uploading one (above) is what actually triggers dispatch.

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

## Calendar Page

`client/src/pages/Calendar.jsx`

Monday-based month grid of planned events (`calendar_events`) plus a read-only history overlay from jobs, sales, stock receipts, and work orders (`GET /api/calendar/overview`). Day click opens a detail panel; double-click (or New event) opens the create form. Production closures show a red banner on this page and on the Dashboard when active.

Mutations use `useToast` / `useConfirm` (toast and confirm modal must be rendered in the page JSX). Layout uses a scoped `@media (max-width: 600px)` block so the grid and side panel stack on small screens. See [docs/calendar.md](calendar.md).

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
| `vite` | ^5.3.1 | Dev server and bundler |
| `@vitejs/plugin-react` | ^4.3.1 | JSX transform + Fast Refresh |

## Quick Start (client only)

```bash
cd client
npm install
npm run dev     # starts Vite on port 5173
```

The server must also be running for API calls to succeed.
