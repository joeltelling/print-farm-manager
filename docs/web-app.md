# Web App (Client)

## Purpose

The React single-page application served by Vite. In development, Vite runs on port 5173 and proxies all `/api/*` requests to the Express server on port 3000. The app provides:

- **Fleet page** — live grid of all printers with PrusaLink status, filterable and searchable
- **Settings page** — CSV import UI for the printer registry, with flagged-row resolution
- **Dashboard** — fleet summary stats
- **Projects page** — project/part/G-code management and production tracking
- **Jobs page** — live job queue with filters and cancel action

## Key Files

| File | Responsibility |
|---|---|
| `client/src/main.jsx` | React root — mounts `<App />` into `#root` |
| `client/src/App.jsx` | Layout shell, sidebar/topbar nav, `<Routes>` |
| `client/src/pages/Fleet.jsx` | Live printer grid |
| `client/src/pages/Settings.jsx` | CSV import, flagged-row resolution |
| `client/src/pages/Dashboard.jsx` | Fleet summary stats |
| `client/src/pages/Projects.jsx` | Project/Part/G-code management |
| `client/src/pages/Jobs.jsx` | Job queue table with filters |
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
│  Projects         │                       │
│  Jobs             │                       │
│  Settings         │                       │
└───────────────────┴───────────────────────┘
```

**Responsive breakpoint at 600px:** the sidebar is hidden and replaced by a horizontal top nav bar. All page content is still fully accessible on mobile.

Navigation uses `react-router-dom` `<NavLink>` — active links are highlighted in blue (`#1e40af`).

## Fleet Page

`client/src/pages/Fleet.jsx`

Live printer grid that polls `GET /api/printers` every 15 seconds (matching the server-side poll interval).

**Features:**
- Status filter chips: All, Printing, Idle, Error, Attention, Offline — each shows live count
- Search box filters by printer name, IP, or group name (case-insensitive)
- Printers grouped by model: MK4S → Core One → Core 1L → XL → Other (in that order)
- Each printer card shows: name, status badge (color-coded), model tag, group name
- **While PRINTING:** job filename (monospace, truncated), left-to-right blue progress bar, percentage and time remaining (formatted as "1h 23m left")
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

**Confirmation button visibility:** "Set Ready" and "Bad Print" buttons (and the green card highlight) only appear when `is_held === 1` AND `status` is `FINISHED` or `IDLE`. Printers in ATTENTION, ERROR, OFFLINE, or PAUSED never show these buttons — a filament runout or error is not a completed print.

## Settings Page

`client/src/pages/Settings.jsx`

**CSV Import flow:**
1. Operator picks a `.csv` file and clicks "Import CSV"
2. `POST /api/printers/import` (multipart)
3. Result summary shown: imported count, skipped count, flagged count
4. Flagged rows with "Cannot infer model" show a model dropdown + Save button
5. Clicking Save calls `POST /api/printers` with the operator-selected model
6. Saved rows are removed from the flagged list and the imported count increments

**Polling info section:** displays the 15-second interval and explains concurrent polling behavior.

## Projects Page

`client/src/pages/Projects.jsx`

Primary operator screen for setting up and launching print runs.

**List view (default):**
- All projects with name and status badge, click to open detail
- "New Project" inline form: name + optional description → `POST /api/projects`

**Detail view:**
- Header with project name, status badge, and context-sensitive action button:
  - `draft` → "Activate" → `PUT /api/projects/:id { status: 'active' }` + `POST /api/scheduler/dispatch`
  - `active` → "Pause" → `PUT /api/projects/:id { status: 'paused' }`
  - `paused` → "Resume" → same as Activate
  - `completed` → no button
- **Parts list:** each row is read-only — name (with ▲/▼ priority buttons), progress bar (`completed_qty / target_qty`), status badge, G-code model chips (read-only). All editing is behind the Details button.
- **▲/▼ ordering buttons:** move a part up or down in dispatch priority. Updates `sort_order` via `PUT /api/parts/reorder`. Optimistic — local state reorders immediately.
- **Details panel** (per part, toggle with "Details" button): three sections:
  - *Quantities* — editable Have (completed_qty) and Need (target_qty) fields, single Save button. Confirm dialogs guard open↔closed transitions. Server auto-calculates status.
  - *G-code Files* — lists each uploaded file with filename, printer model badge, and × delete button (with confirm) → `DELETE /api/gcodes/:id`
  - *Upload G-code* — file picker → `POST /api/gcodes/parse-filename` pre-fills `parts_per_plate` and model. `409` duplicate error shown inline.
- **Add Part form:** name + target quantity → `POST /api/parts`

## Jobs Page

`client/src/pages/Jobs.jsx`

Live job queue that polls `GET /api/jobs` every 15 seconds.

**Columns:** ID, Part, Project, Printer, Model, Status, Started, Duration, Actions

**Filters:** status dropdown (all / queued / uploading / printing / finished / failed / cancelled), project dropdown, printer dropdown — all passed as query params on each fetch.

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
