# Print Farm Manager: Documentation

A locally-hosted web app for managing a multi-brand 3D printer farm. Replaces manual USB job distribution with centralized status monitoring and automated job dispatch. Supports Prusa (PrusaLink), Elegoo Centauri Carbon (SDCP) and Centauri Carbon 2 (MQTT), Bambu (MQTT), Klipper (Moonraker), and OctoPrint printers.

This is the doc index and the current project map. The code and the files below are the source of truth; `ARCHITECTURE.md` is the original spec and its phase briefings are historical.

## Quick Start

```bash
npm install
cd client && npm install && cd ..
npm run dev
```

- API: `http://localhost:3000`
- UI: `http://localhost:5173`

Prefer Docker over a local Node.js install? `docker compose up --build print-farm-manager-dev` runs the same workflow in a container, see the [README](../README.md#quick-start-development). Run the tests with `npm test`, or `docker compose run --rm print-farm-manager-dev npm test`. Set `DEMO_MODE=true` to skip real printer polling while developing.

## Documentation Index

| File | What it covers |
|---|---|
| [README.md](../README.md) | Project overview, supported printers, tech stack, install options |
| [CONTRIBUTING.md](../CONTRIBUTING.md) | How to set up, test, and contribute, whether you work on this repository or your own fork of it |
| [ARCHITECTURE.md](../ARCHITECTURE.md) | The original product spec and phase planning (historical) |
| [docs/installation.md](installation.md) | Bare-metal install guide for Windows and macOS: prerequisites, setup, auto-start with PM2, updating, troubleshooting |
| [docs/server.md](server.md) | Express entry point, scheduler wiring, port config, route mounting, startup sequence |
| [docs/database.md](database.md) | SQLite schema: all tables, column types, conventions, migrations |
| [docs/poller.md](poller.md) | Printer polling loop, concurrency model, event emissions |
| [docs/api.md](api.md) | All REST endpoints: request/response shapes, error codes |
| [docs/web-app.md](web-app.md) | React client: pages, routing, layout, live-update pattern, internationalization |
| [docs/CHANGELOG.md](CHANGELOG.md) | Dated log of all implemented features and changes |
| [docs/multi-brand.md](multi-brand.md) | Phase 6 design: driver abstraction for non-Prusa brands |
| [docs/driver-authoring.md](driver-authoring.md) | Connector authoring guide for manufacturers and contributors: driver contract, canonical statuses, registration checklist, hardware test matrix |
| [docs/filaments.md](filaments.md) | Filament Library: admin-managed type and color lists, API endpoints, client usage |
| [docs/spoolman.md](spoolman.md) | Optional Spoolman integration: settings, proxy API, and the incremental delivery status |
| [docs/docker-publish.md](docker-publish.md) | CI workflow that tests, builds, and publishes multi-arch Docker images to GHCR |
| [docs/TRANSLATING.md](TRANSLATING.md) | How to add a new UI language (react-i18next): key conventions and en.json as the source of truth |
| [.github/dependabot.yml](../.github/dependabot.yml) | Dependency update config: monthly grouped updates, and which major versions are ignored on purpose and why |

## Project Structure

```
print-farm-manager/
├── server/
│   ├── index.js            # Express entry point; also hosts the set-ready / recommission endpoints
│   ├── db.js               # SQLite connection + schema init + startup migrations
│   ├── poller.js           # Printer polling loop (EventEmitter)
│   ├── scheduler.js        # Job dispatch engine (EventEmitter)
│   ├── events.js           # Printer event log helper: insert(printerId, type, note)
│   ├── notifications.js    # In-memory operator alert store
│   ├── backup.js           # Hourly automatic database snapshots (24 kept)
│   ├── gcode-decode.js     # Decodes .bgcode / .3mf into plain G-code text for preview and metadata
│   ├── security-headers.js # helmet configuration
│   ├── seed-demo.js        # Fills a demo database (use with DEMO_MODE=true)
│   ├── drivers/            # One module per brand behind a lazy registry: prusa, bambu,
│   │                       #   elegoo-centauri, elegoo-centauri2, klipper, octoprint
│   ├── integrations/
│   │   └── spoolman.js     # Optional Spoolman API client (off by default)
│   ├── routes/
│   │   ├── printers.js     # CRUD + CSV import + decommission/recommission
│   │   ├── printer-jobs.js # Per-printer lifetime job stats
│   │   ├── events.js       # GET/POST /api/printers/:id/events
│   │   ├── projects.js     # Project CRUD + complete/reactivate/reorder
│   │   ├── parts.js        # Part CRUD + completed_qty state machine + reorder
│   │   ├── gcodes.js       # G-code upload, preview, parse-filename, delete
│   │   ├── jobs.js         # Job listing, filtering, cancel
│   │   ├── models.js       # Printer model registry CRUD
│   │   ├── groups.js       # Printer group registry CRUD
│   │   ├── filaments.js    # Filament type and color CRUD
│   │   ├── spoolman.js     # Spoolman proxy endpoints
│   │   ├── settings.js     # Key/value operator settings
│   │   ├── backup.js       # Farm export + restore
│   │   └── dashboard.js    # TV command center: single-endpoint fleet summary
│   └── tests/              # Jest + supertest suites (in-memory SQLite, mocked transports)
├── client/
│   ├── src/
│   │   ├── App.jsx                  # Layout + router
│   │   ├── main.jsx                 # React root
│   │   ├── i18n.js                  # i18next setup
│   │   ├── locales/en.json          # Every user-facing string (source of truth for translations)
│   │   ├── GcodeViewerModal.jsx     # 3D G-code preview (three.js)
│   │   ├── gcode-parser.worker.js   # Parses G-code off the main thread for the viewer
│   │   ├── useToast.jsx, useConfirm.jsx, useFilamentLibrary.js, useFormattingLocale.js
│   │   ├── components/              # Shared components (EmptyState, PollTimer)
│   │   └── pages/
│   │       ├── Fleet.jsx            # Live printer grid
│   │       ├── Printers.jsx         # All-printers directory
│   │       ├── PrinterDetail.jsx    # Per-printer event timeline + notes
│   │       ├── Decommissioned.jsx   # Decommissioned printers + recommission
│   │       ├── Settings.jsx         # CSV import, add printer, models, groups, filaments, Spoolman, backup
│   │       ├── Dashboard.jsx        # Fleet summary (TV mode)
│   │       ├── Projects.jsx         # Project/Part/G-code management
│   │       └── Jobs.jsx             # Job queue table
├── docs/                 # This folder
├── .github/
│   ├── dependabot.yml    # Dependency update config
│   └── workflows/        # CI: tests, image build and publish (see docs/docker-publish.md)
├── ARCHITECTURE.md       # Original product spec and phase planning
├── CONTRIBUTING.md       # Contributor guide
├── Dockerfile            # Multi-stage: server-deps/client-build/runtime (production) + dev
└── docker-compose.yml    # Production container + persistent volumes, plus an opt-in `dev` profile
```

## Development Phases

| Phase | Status | Description |
|---|---|---|
| 1 | Complete | Scaffold, DB schema, printer registry, polling, live Fleet UI |
| 2 | Complete | Job scheduling, dispatch, Part/Project/G-code management |
| 3 | Complete | Error handling, operator safety workflows, UI improvements |
| 4 | Complete | Hardening, retry logic, 409 conflict handling, configurable batch size, post-failure recovery |
| 5 | Deferred | Mobile-responsive polish: Fleet UI already works on iPhone; no immediate need |
| 6A | Complete | Driver abstraction layer: Prusa extracted into `server/drivers/prusa.js`; registry wired |
| 6B | Complete | Elegoo Centauri Carbon SDCP driver via `sdcp` package; UI and route changes for non-Prusa brands |
| 6C | Complete | Klipper (Moonraker) driver: Voron and all Klipper-firmware printers via plain HTTP on port 7125 |
| 6D | Complete | OctoPrint driver: any OctoPrint/OctoPi-managed printer via OctoPrint's own REST API |

Work after Phase 6D (Bambu and Elegoo Centauri Carbon 2 support, the Filament Library, printer groups, the 3D G-code preview, internationalization, the optional Spoolman integration, and more) is not tracked as numbered phases. See [CHANGELOG.md](CHANGELOG.md) for the dated record.

See [ARCHITECTURE.md](../ARCHITECTURE.md) for the original product spec.
