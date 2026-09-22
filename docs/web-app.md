# Web App (Client)

## Purpose

The React single-page application served by Vite. In development, Vite runs on port 5173 and proxies all `/api/*` requests to the Express server on port 3000. The whole app is gated behind `AuthContext` (see [docs/auth.md](auth.md)): a logged-out visitor sees only the Login page, regardless of which URL they land on. The app provides:

- **Login page**: email/password sign-in, a "Sign in with SSO" button when OIDC is configured, and a one-time "create the admin account" form on a fresh install
- **Dashboard**: TV-optimized command center: fleet utilization, stat cards, printer grid (hover a printer for a camera preview), active project progress, and a needs-attention panel
- **Fleet page**: live grid of all active printers with status, filterable and searchable
- **Webcams page**: a plain snapshot gallery, one still image per printer refreshed every 30 seconds, deliberately without the fleet status grid's color-coded highlighting
- **Printers page**: searchable directory of all printers (active and decommissioned); click any row to open the detail view
- **Printer detail view**: per-machine event timeline, inline note form, printer header, a camera card (OctoPrint/Klipper) that opens on a snapshot and streams live only once "Watch Live" is clicked, and a popup for cataloging any print sent straight to the printer outside the farm
- **Settings page** — CSV import UI for the printer registry, with flagged-row resolution
- **Projects page** — project/part/G-code management and production tracking
- **Jobs page** — live job queue with filters and cancel action
- **Account page**: the signed-in user's own API keys: create one (shown once), revoke one
- **Users page**: admin only: add accounts, change roles, remove access

## Key Files

| File | Responsibility |
|---|---|
| `client/src/main.jsx` | React root, wraps `<App />` in `<AuthProvider>`, mounts into `#root` |
| `client/src/App.jsx` | Layout shell, sidebar/topbar nav, `<Routes>`, renders `<Login>` when logged out |
| `client/src/AuthContext.jsx` | Current-user state, checked once via `GET /api/auth/me` |
| `client/src/pages/Login.jsx` | Sign-in form, SSO button, first-run bootstrap form, automatic SSO redirect, `/backup-login` fallback |
| `client/src/pages/Account.jsx` | Self-service API key management |
| `client/src/pages/Users.jsx` | Admin-only account management |
| `client/src/pages/Fleet.jsx` | Live printer grid, pinned-printers section |
| `client/src/pages/Webcams.jsx` | Plain snapshot gallery, one still image per printer, no status highlighting |
| `client/src/pages/Printers.jsx` | Searchable all-printers directory |
| `client/src/pages/PrinterDetail.jsx` | Per-printer event timeline, note form, camera card, catalog-print popup |
| `client/src/pages/Decommissioned.jsx` | Decommissioned printer list with notes and recommission |
| `client/src/pages/Settings.jsx` | CSV import, flagged-row resolution, printer models, farm name, admin-only single sign-on redirect toggle |
| `client/src/pages/Dashboard.jsx` | TV command center dashboard |
| `client/src/pages/Projects.jsx` | Project/Part/G-code management |
| `client/src/pages/Jobs.jsx` | Job queue table with filters |
| `client/src/components/FleetStatusGrid.jsx` | Grouped-by-model printer grid used by the Dashboard's fleet grid |
| `client/src/useCameraHover.jsx` | Hover-to-preview camera hook used by `FleetStatusGrid`: lazy-fetches `GET /api/printers/:id/camera` on first hover, shows a snapshot only (never the live stream) |
| `client/src/cameraTransform.js` | Builds the CSS `transform` for a camera image from `camera_rotation`/`camera_flip_h`/`camera_flip_v`, plus `rotationFitTransform`/`useNaturalSize` to keep a 90/270-rotated image's box correctly sized instead of overflowing it; shared by PrinterDetail's camera card, `useCameraHover.jsx`, and Webcams.jsx |
| `client/src/webUiLink.js` | Picks the "open web interface" URL/label for a printer: its `octoeverywhere_url` if set, otherwise the connector-appropriate local-IP link; shared by Fleet.jsx and FleetStatusGrid.jsx |
| `client/src/components/GcodeUploadWizard.jsx` | Drag-and-drop-triggered 3-step upload wizard used by the Projects page: an alternative to its per-part upload panel |
| `client/src/filamentColorHex.js` | Builds a color-name-to-hex-code lookup from `GET /api/filaments/colors`, for showing a printer's loaded color as a swatch outside the Filament Library table |
| `client/src/components/ColorSwatch.jsx` | Small colored square for a filament color's hex code; renders nothing if no hex is set |
| `client/src/usePinnedPrinters.js` | Per-browser (`localStorage`) pinned-printer set for Fleet's Pinned section |
| `client/src/components/CommandPalette.jsx` | Global Cmd/Ctrl+K jump-to-anything search, mounted once in `App.jsx` |
| `client/src/components/PollTimer.jsx` | Shared circular refresh-countdown ring used by Fleet and Dashboard |
| `client/index.html` | HTML shell with dark background baseline CSS |
| `client/vite.config.js` | Vite config — port 5173, `/api` proxy to 3000 |

## Layout

`App.jsx` renders a two-column shell once a user is signed in (a logged-out visitor gets the Login page instead, full-screen, with no sidebar):

```
┌──────────────────────────────────────────┐
│ SIDEBAR (180px)   │  MAIN CONTENT         │
│  Print Farm       │                       │
│  Manager          │  <Routes />           │
│                   │                       │
│  Dashboard        │                       │
│  Fleet            │                       │
│  Webcams          │                       │
│  Printers         │                       │
│  Projects         │                       │
│  Jobs             │                       │
│  Decommissioned   │                       │
│  Settings         │                       │
│  Users (admin)    │                       │
│  Account          │                       │
│  ─────────────    │                       │
│  Sign out         │                       │
└───────────────────┴───────────────────────┘
```

`Users` only appears in the nav for `admin` accounts; the route itself is conditionally registered on `user.role`, so an `operator` navigating to `/users` directly gets no match rather than the Users UI.

**Responsive breakpoint at 600px:** the sidebar is hidden and replaced by a horizontal top nav bar (with the same Sign out button). All page content is still fully accessible on mobile.

Navigation uses `react-router-dom` `<NavLink>` — active links are highlighted in blue (`#1e40af`).

## Login Page

`client/src/pages/Login.jsx`

Rendered by `App.jsx` in place of the whole layout shell whenever `AuthContext`'s `user` is `null`: no sidebar, no nav, a single centered card. `GET /api/auth/status` on mount decides which form to show:

- **`needsBootstrap: true`** (a fresh install, zero users exist): name, email, and password fields, submitting to `POST /api/auth/bootstrap`. This form only ever appears once per install.
- **`autoSsoRedirect: true`** (an admin turned it on in Settings, and OIDC is actually configured; see `docs/auth.md`): the form doesn't render at all. A `useEffect` sends the browser straight to `/api/auth/oidc/login` instead, with a "Redirecting to single sign-on..." message and a manual link to `/backup-login` shown in case the redirect is slow. `App.jsx` passes `forceLocal={true}` when the path is `/backup-login`, which always shows the normal form below instead, ignoring the redirect.
- **Otherwise:** email and password fields, submitting to `POST /api/auth/login`. If `oidcEnabled` is also true, a "Sign in with SSO" link to `/api/auth/oidc/login` appears below a divider.

A successful bootstrap or login calls `setUser` from `AuthContext`, which re-renders `App.jsx` into the normal layout immediately, no page reload. If the path was `/backup-login`, it is reset to `/` first (via `history.replaceState`) since that path has no matching route once the normal app mounts.

## Command Palette

`client/src/components/CommandPalette.jsx`, mounted once in `App.jsx` inside `<BrowserRouter>` (so `useNavigate` works), available from every page once signed in.

Opens on **Cmd+K** (Mac) / **Ctrl+K** (elsewhere), Escape closes it, or the sidebar's **Search** button, which dispatches an `openCommandPalette` window `CustomEvent` (the same cross-component-tree signal pattern `App.jsx` already uses for `farmNameChanged`). `GET /api/printers`, `/api/projects`, and `/api/parts` are fetched once, lazily, the first time the palette is actually opened, not on every page load.

Typing filters printers, projects, and parts by a case-insensitive substring match on name (nothing shown until at least one character is typed: this is a jump-to tool, not a fleet report), capped at 30 results. Arrow keys move the highlighted result, Enter or a click chooses it:

- A **printer** result navigates to `/printers/:id` (an existing route).
- A **project** result navigates to `/projects?open=<id>`. A **part** result navigates to `/projects?open=<projectId>&part=<id>`, also expanding that part's Details panel. Projects.jsx has never had its own `:id` route (which project's detail view is open is plain `selectedId` component state), so these are read once on mount by a `useSearchParams` effect in `Projects.jsx` rather than being two-way-synced URL state: a one-time "arrive here already open" jump, not a bookmarkable/shareable view.

## Dashboard Page

`client/src/pages/Dashboard.jsx`

TV-optimized command center intended to be shown full-screen on a large monitor or TV in the print farm. Polls `GET /api/dashboard` every 15 seconds (matching the Fleet page). A live clock ticks every second client-side.

**⛶ TV Mode button:** calls `element.requestFullscreen()` on the dashboard container — the sidebar disappears and the dashboard fills the screen. Use the browser's Escape key or fullscreen API to exit.

**Sections:**

| Section | Description |
|---|---|
| Header | Branding, fleet utilization % (printing / total), live HH:MM:SS clock and date |
| Hero stat cards | Printing, Idle, Awaiting sign-off, Parts Today (rolling 24h) — large tabular numerals |
| Fleet grid | All active printers as color-coded 54×44px cells. Grouped by model into a self-contained chip per model (label above its own cell row, not a fixed-width side column), and the chips flow via `flexWrap` instead of stacking one full-width row per model: a fleet with many single-printer models packs several chips per line instead of showing mostly-empty rows, and a long model name wraps on its own line instead of colliding with the cells next to it. Per-model status summary badges sit below each chip's cells; the color legend stays below all chips. Hovering a cell shows a floating camera snapshot (rotation/flip-corrected) plus its loaded filament, if the printer has one configured (`useCameraHover.jsx`); it never opens the live stream, since a hover fires far too often for that to be a lightweight preview. A `klipper` or `octoprint` printer's cell is also clickable, opening its web interface in a new tab (`client/src/webUiLink.js`: the printer's `octoeverywhere_url` if set, otherwise `http://<printer.ip>`); other printers' cells are not clickable. |
| Active Projects | All active projects, ordered by dispatch priority (same order as the Projects page), with **all parts** listed: per-part 3-segment progress bars (green = completed, blue = printing, dark = remaining), completion counts with `+N printing` annotation, and DONE badges on closed parts. No truncation. |
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

## Webcams Page

`client/src/pages/Webcams.jsx`

A plain snapshot gallery, deliberately not the fleet status grid: no color-coded status highlighting, just a still image per printer plus one per-card action. Printer list comes from `GET /api/printers`, polled every 15 seconds. Each printer's camera info (does it have one, and its snapshot/stream URLs) is looked up once per page visit via `GET /api/printers/:id/camera`, since the URLs themselves are stable and only the image behind the snapshot URL changes; a card with no snapshot configured (or no camera at all) shows a placeholder instead. Every 30 seconds, each snapshot `<img>` gets a fresh cache-busting query param, triggering a new single-shot request, never the continuous MJPEG stream: same bandwidth discipline as the hover preview on the Dashboard's fleet grid (`useCameraHover.jsx`), for the same reason.

Each card is a `WebcamCard` component (so its rotation-fit natural-size state, see below, is a proper per-image hook instance rather than one object shared across a `.map()`) and shows what's loaded above the image: every `printer_lanes` row (`GET /api/printers`'s `lanes` field) if the printer has klipper-filament-sync, one line per lane, or the legacy `loaded_material`/`loaded_color` otherwise.

A card whose camera reports a `streamUrl` gets a **Watch Live** button. Live view is **single-instance**: the page keeps one `liveViewId` (the printer currently live, or `null`), so clicking Watch Live on a card switches live view to it and implicitly stops whatever other card was live, rather than opening a second concurrent MJPEG stream. Every rendered image (snapshot or live) has `client/src/cameraTransform.js`'s rotation/flip transform applied, the same as the printer detail camera card and the hover preview.

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
- IP address is not shown on cards, but a `klipper` or `octoprint` printer's card header has a web-interface link (**Mainsail ↗**, **OctoPrint ↗**, or **OctoEverywhere ↗** if the printer has an `octoeverywhere_url` set: see `client/src/webUiLink.js`) that opens in a new tab (`e.stopPropagation()` so it doesn't also trigger the card's own click-to-open-detail behavior)
- Loaded material/color, when set, shows a small colored swatch next to the text if that color has a hex code in the Filament Library (`ColorSwatch.jsx`, `filamentColorHex.js`); no swatch (just text) if the color has no hex set
- A ☆/★ button on each card pins/unpins it (`usePinnedPrinters.js`, `localStorage`, per-browser). Any pinned printers get their own **★ Pinned** section above the model-grouped ones, respecting the active status filter/search the same way; a pinned printer still also appears in its normal model group below, this is a shortcut, not a move
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

**Columns within a group:** Name, Group, IP, Status badge. (Model is implied by the group header.)

**Bulk edit:** selecting one or more printers (row checkboxes / select-all) reveals a bulk-edit bar. It can set **Material** and **Color** (dropdowns from the filament library) and **Group** (free-text input with a `<datalist>` autocomplete, now sourced from the persisted group registry, `GET /api/groups`, rather than derived from currently-loaded printers, so a registered group still autocompletes even if no printer currently carries it; typing a new name still works and registers it). "Apply to selected" loops `PUT /api/printers/:id` for each selected printer; only non-empty fields are sent, so empty fields are left unchanged. Each changed field is recorded as an `info_changed` event on the printer. Common use: funnel small prints to low-spool machines by bulk-assigning them a group, then targeting that group from the G-code's `allowed_groups` (or the project's, see the Projects page).

Click any row to navigate to `/printers/:id` (the Printer Detail view).

## Printer Detail View

`client/src/pages/PrinterDetail.jsx`

Per-machine history and annotation screen. Reached by clicking a printer card in the Fleet page, clicking a row in the Printers page, or via the "View History" button in the Decommissioned page.

**Header card:** printer name, live status badge (or DECOMMISSIONED), model, IP, connector type, decommissioned timestamp if applicable. When a material/color is loaded, it shows a small colored swatch next to the text if that color has a hex code in the Filament Library, same `ColorSwatch.jsx`/`filamentColorHex.js` as the Fleet page.

**Rename:** a **Rename** button next to the printer name swaps the header into an inline edit form. Save sends `PUT /api/printers/:id` with the new `name`; the server's UNIQUE-name 409 is surfaced inline. Escape or the Cancel button closes the form without saving.

**Edit Details form:** includes a Group field with a `<datalist>` autocomplete sourced from `GET /api/groups`, same free-text-plus-suggestions behavior as the Printers page bulk-edit and the Settings Add Printer form. A **Test Connection** button under the IP/hostname field posts whatever is currently typed there (plus API key and serial number) to `POST /api/printers/test-connection` and shows the result (`Connected`, or the specific failure reason) inline, without saving anything first.

For `klipper` and `octoprint` printers, a **Camera** section (rotation, flip horizontal, flip vertical) sets the display transform `client/src/cameraTransform.js` applies wherever this printer's camera image renders, purely a client-side preference, not read from or sent to the connector. `klipper` printers additionally get a camera picker: a **Find cameras** button calls `POST /api/printers/list-cameras` against the form's current connection settings and populates a dropdown of whatever crowsnest reports, for printers with more than one configured; "Default (first enabled)" keeps the previous no-selection behavior.

**Add note form:** freeform textarea → `POST /api/printers/:id/events`. Submitted note appears immediately at the top of the timeline.

**Event timeline:** all `printer_events` rows for this printer, newest first. Each entry shows:
- Color-coded type badge (`Job Finished` / `Job Failed` / `Decommissioned` / `Recommissioned` / `Note`)
- Note text (if any)
- Formatted timestamp

**Camera card:** fetched from `GET /api/printers/:id/camera` alongside the rest of the page's data; nothing is rendered for connectors that don't support one. The MJPEG stream URL is continuous video, not a single frame, so it never autoplays: the card defaults to the connector's snapshot URL if it has one (or a placeholder if it doesn't), and a "Watch Live" button swaps in the live `<img src={streamUrl}>`, with "Stop Live View" to close it again without navigating away. Switching printers (or any refetch of the page's data) resets the card back to the snapshot, so a stream is never left running against a printer you've navigated away from. Both the snapshot and the live image get `client/src/cameraTransform.js`'s rotation/flip CSS transform applied, from the response's `rotation`/`flipH`/`flipV` fields. See [docs/api.md](api.md).

**Catalog-print popup:** opens automatically (a fixed-position modal, not a page navigation) when the fetched printer has `needs_catalog: true`, meaning it is `PRINTING` or `FINISHED` with no job the farm dispatched, the signature of a print sent straight to it from outside the farm (e.g. OrcaSlicer). Prompts for a Part (grouped by project, open parts only) and a quantity, then submits to `POST /api/printers/:id/catalog-print`. A "Not now" button dismisses it for the rest of this page visit without submitting; reloading the page re-opens it as long as `needs_catalog` is still true server-side.

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

**Section order** (tuned for first-run flow): Server Alerts → Printer Models → Groups → Filament Library → Add Printer → CSV Import → Farm Name → Single Sign-On (admin only) → Dispatch Settings → Farm Backup → Polling info. Models, Groups, and Filaments come first because the Add Printer form depends on them.

**Groups section:** lists every registered group (`GET /api/groups`) with a Delete button per row and a name-only add form (`POST /api/groups`). Modeled on the Printer Models section, minus the type/color hierarchy Filament Library has. Deleting a group is blocked with an inline error naming the printer/G-code/project count still referencing it (`DELETE /api/groups/:name`, `409`). A group doesn't have to be created here first: typing a new name on a printer (Add Printer form, Printers bulk-edit, PrinterDetail, or CSV import) registers it automatically; this section exists for pre-creating a group before any printer uses it, and for cleanup.

**Add Printer form:** shows a per-brand help box (`CREDENTIAL_HELP`) explaining where to find each brand's credentials (PrusaLink API key, Bambu LAN access code + serial, Elegoo/Klipper no key). If no models exist for the selected brand, an inline hint points at the Printer Models section. The Group field is a `<datalist>` autocomplete, same as Printers bulk-edit and PrinterDetail. A **Test Connection** button under the IP/hostname field checks reachability against whatever is currently in the form, before the printer is ever saved (same `POST /api/printers/test-connection` the printer-edit form's button uses). The same **Camera** section (rotation, flip, and for `klipper` a crowsnest camera picker via `POST /api/printers/list-cameras`) and **OctoEverywhere URL** field as the printer-edit form's, described above, also work pre-save here.

**Farm Name section:** saves the `farm_name` setting (`PUT /api/settings/farm_name`); `App.jsx` fetches it on load and shows it in the sidebar/topbar, falling back to "Print Farm".

**Single Sign-On section (admin only, hidden entirely for an operator):** a checkbox for the `auto_sso_redirect` setting, saved immediately on toggle (`PUT /api/settings/auto_sso_redirect`) rather than needing a separate Save button. If OIDC itself isn't configured (`GET /api/auth/status`'s `oidcEnabled`), the checkbox is replaced with a note pointing at the environment variables instead, since the toggle would do nothing yet. See `docs/auth.md`'s "Automatic SSO redirect" section for the full behavior, including the `/backup-login` fallback.

**Dispatch Settings section:** the `dispatch_batch_size` concurrency target (`PUT /api/settings/dispatch_batch_size`), plus a **Color tolerance** sub-section (`color_tolerance`, `PUT /api/settings/color_tolerance`): a number input (0-450) with suggested values (`<datalist>`, matching the Group field's autocomplete pattern) explaining what a given number roughly means ("Off", "Very close", "Same color family", "Loose match"). `0` (default) keeps color matching exact-only. See `docs/filaments.md` for how this reads `filament_colors.hex_color` and `server/scheduler.js` for the matching rule itself.

**Farm Backup section:** Export and Restore buttons — see [api.md](api.md) for the backup endpoints.

**Polling info section:** displays the 15-second interval and explains concurrent polling behavior.

## Projects Page

`client/src/pages/Projects.jsx`

Primary operator screen for setting up and launching print runs. Reads `?open=<projectId>` (and optionally `&part=<partId>`) from the URL once on mount, to open the detail view and expand a part's panel when arriving from `CommandPalette.jsx` (see its own section above).

**List view (default):**
- Only `active` projects show by default, ordered by dispatch priority (drag the ⠿ handle to reorder → `PUT /api/projects/reorder`). `draft`, `paused`, and `completed` projects are each hidden behind their own "Show X (count)" checkbox above the list, so a farm with a long project history doesn't bury the in-flight work; a checkbox only appears when at least one project has that status. State persists per browser (`localStorage`), same pattern as the Printers page's "Show decommissioned". If every project is filtered out, an empty-state prompts to check a box rather than showing the first-run "create your first project" message.
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

**G-code upload wizard** (`client/src/components/GcodeUploadWizard.jsx`): an alternative path into the same upload, for when the destination Part doesn't exist yet or isn't already open in the detail view. Triggered by dropping a file anywhere on the list view (the page listens for `dragenter`/`dragover`/`dragleave`/`drop`, ignoring the page's own internal project/part row-reorder drag by checking `dataTransfer.types` for `Files`) or the "+ Upload G-code" header button; both open the same 3-step modal (destination, then G-code details, then a review step with the upload progress bar). Step 1 picks or creates the Project and Part inline (`POST /api/projects` / `POST /api/parts` only run if "New" is chosen); step 2 is the same fields as the Upload G-code panel above, pre-filled the same way via `POST /api/gcodes/parse-filename`; the final upload is the exact same `POST /api/gcodes/upload` call, XHR-based for progress, as the per-part panel: this is a second front door onto that endpoint, not a second upload mechanism. List-view only: dropping a file while a project's detail view is open does not currently open the wizard (use the "+ Upload G-code" button or the existing per-part panel there instead).

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

## Account Page

`client/src/pages/Account.jsx`

Self-service page for the signed-in user's own API keys. `GET /api/api-keys` lists them (never `key_hash`); the create form (`POST /api/api-keys`) shows the plaintext key exactly once, in a callout the operator must dismiss explicitly ("Done, I copied it") rather than one that just disappears. `DELETE /api/api-keys/:id` revokes; a revoked key shows greyed out with a `REVOKED` badge instead of being removed from the list, so `last_used_at` history stays visible.

## Users Page

`client/src/pages/Users.jsx`

Admin-only account management (see [docs/auth.md](auth.md) for the role model). Lists every user via `GET /api/users`, with an inline "+ Add User" form (`POST /api/users`, password optional for an SSO-only account) and a role `<select>` per row (`PUT /api/users/:id`) that updates immediately on change. Removing a user (`DELETE /api/users/:id`) goes through the shared `useConfirm` modal; the server itself refuses to demote or delete the last remaining admin, and refuses to delete the account you're currently signed in as, so this page just surfaces whatever error message comes back rather than duplicating those checks client-side.

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
