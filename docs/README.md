# Print Farm Manager — Documentation

A locally-hosted web app for managing a 50+ printer Prusa fleet via PrusaLink. Replaces manual USB job distribution with centralized status monitoring and automated job dispatch.

## Quick Start

```bash
npm install
cd client && npm install && cd ..
npm run dev
```

- API: `http://localhost:3000`
- UI: `http://localhost:5173`

## Documentation Index

| File | What it covers |
|---|---|
| [docs/installation.md](installation.md) | Windows install guide — prerequisites, setup, auto-start with PM2, updating, troubleshooting |
| [docs/server.md](server.md) | Express entry point, scheduler wiring, port config, route mounting, startup sequence |
| [docs/database.md](database.md) | SQLite schema — all 5 tables, column types, conventions |
| [docs/poller.md](poller.md) | Printer polling loop, concurrency model, event emissions |
| [docs/api.md](api.md) | All REST endpoints — request/response shapes, error codes |
| [docs/web-app.md](web-app.md) | React client — pages, routing, layout, live-update pattern |
| [docs/CHANGELOG.md](CHANGELOG.md) | Dated log of all implemented features and changes |
| [docs/multi-brand.md](multi-brand.md) | Phase 6 design — driver abstraction for non-Prusa brands (Elegoo Centauri Carbon) |

## Project Structure

```
print-farm-manager/
├── server/
│   ├── index.js          # Express entry point
│   ├── db.js             # SQLite connection + schema init
│   ├── poller.js         # Printer polling loop (EventEmitter)
│   ├── scheduler.js      # Job dispatch engine (EventEmitter)
│   └── routes/
│       ├── printers.js   # CRUD + CSV import
│       ├── projects.js   # Project CRUD + complete/reactivate/reorder
│       ├── parts.js      # Part CRUD + completed_qty state machine + reorder
│       ├── gcodes.js     # G-code upload, parse-filename, delete
│       ├── jobs.js       # Job listing, filtering, cancel
│       ├── settings.js   # Key/value operator settings (dispatch_batch_size)
│       └── dashboard.js  # TV command center — single-endpoint fleet summary
├── client/
│   ├── src/
│   │   ├── App.jsx       # Layout + router
│   │   ├── main.jsx      # React root
│   │   └── pages/
│   │       ├── Fleet.jsx     # Live printer grid
│   │       ├── Settings.jsx  # CSV import, add printer, dispatch batch size
│   │       ├── Dashboard.jsx # Fleet summary
│   │       ├── Projects.jsx  # Project/Part/G-code management
│   │       └── Jobs.jsx      # Job queue table
├── docs/                 # This folder
└── ARCHITECTURE.md       # Full product spec and phase planning
```

## Development Phases

| Phase | Status | Description |
|---|---|---|
| 1 | Complete | Scaffold, DB schema, printer registry, polling, live Fleet UI |
| 2 | Complete | Job scheduling, dispatch, Part/Project/G-code management |
| 3 | Complete | Error handling, operator safety workflows, UI improvements |
| 4 | Complete | Hardening, retry logic, 409 conflict handling, configurable batch size, post-failure recovery |
| 5 | Deferred | Mobile-responsive polish — Fleet UI already works on iPhone; no immediate need |
| 6A | Complete | Driver abstraction layer — Prusa extracted into `server/drivers/prusa.js`; registry wired |
| 6B | Complete | Elegoo Centauri Carbon SDCP driver via `sdcp` package; UI and route changes for non-Prusa brands |

See [ARCHITECTURE.md](../ARCHITECTURE.md) for full product spec.
