# CoMa documentation

A locally-hosted web app for managing a multi-brand 3D printer fleet **and** an embedded manufacturing ERP (this fork of Print Farm Manager). Supports Prusa (PrusaLink), Elegoo Centauri (SDCP), Bambu (MQTT), Klipper (Moonraker), and OctoPrint printers. Shopfloor and ERP share one SQLite file and one Express process.

## Quick Start

```bash
./start.sh
```

- API + ERP: `http://localhost:3000`
- UI: `http://localhost:5173`

Prefer Docker? `docker compose up --build print-farm-manager-dev` - see the [README](../README.md#quick-start-linux-development).

**Operators:** start with the [user guide](user-guide.md) (Spanish walkthrough of Fleet, Projects, ERP, postings, timelapse, analytics).

## Documentation Index

| File | What it covers |
|---|---|
| [docs/user-guide.md](user-guide.md) | **How to use CoMa** - day-to-day operator guide (Spanish) |
| [docs/installation.md](installation.md) | Linux prerequisites, development scripts, production setup, updating, troubleshooting |
| [docs/server.md](server.md) | Express entry point, scheduler wiring, port config, route mounting, startup sequence |
| [docs/database.md](database.md) | SQLite schema - shopfloor + ERP tables, telemetry, timelapses |
| [docs/poller.md](poller.md) | Printer polling loop, telemetry hooks, event emissions |
| [docs/api.md](api.md) | All REST endpoints - request/response shapes, error codes |
| [docs/web-app.md](web-app.md) | React client - pages, routing, layout, live-update pattern |
| [docs/CHANGELOG.md](CHANGELOG.md) | Dated log of all implemented features and changes |
| [docs/multi-brand.md](multi-brand.md) | Phase 6 design - driver abstraction for non-Prusa brands |
| [docs/driver-authoring.md](driver-authoring.md) | Connector authoring guide: contract, registration, hardware matrix |
| [docs/filaments.md](filaments.md) | Filament Library - types/colors, API, client usage |
| [docs/calendar.md](calendar.md) | Planned events, production closures, dispatch gate |
| [docs/workspace.md](workspace.md) | Workspace tablero (kanban) and technical notebook |
| [docs/erp/README.md](erp/README.md) | Embedded ERP: sync, postings, actual costing, analytics |
| [docs/erp/ebay.md](erp/ebay.md) | eBay Sell APIs: order import, inventory push, credentials |
| [docs/docker-publish.md](docker-publish.md) | CI workflow that publishes multi-arch images to GHCR |

## Project Structure

```
core-manufacturing/
├── server/
│ ├── index.js # Express: shopfloor + /api/erp + SPA
│ ├── db.js # SQLite + additive migrations
│ ├── poller.js # Poll loop + telemetry + timelapse hooks
│ ├── scheduler.js # Job dispatch engine
│ ├── telemetry.js # Status history + job accumulators
│ ├── timelapse.js # Frame capture + ffmpeg render
│ ├── camera.js # Shared snapshot fetch
│ ├── events.js # Printer event log helper
│ ├── notifications.js # In-memory operator alerts
│ ├── erp/ # Embedded ERP (schema, costing, postings, reports, PDF)
│ ├── drivers/ # Per-brand connectors
│ └── routes/ # printers, projects, jobs, timelapses, backup, settings, ...
├── client/
│ └── src/pages/ # Fleet, Projects, Jobs, Timelapses, Settings, Erp, ...
├── docs/ # This folder
├── Dockerfile
└── docker-compose.yml
```

## Development Phases

| Phase | Status | Description |
|---|---|---|
| 1 | Complete | Scaffold, DB schema, printer registry, polling, live Fleet UI |
| 2 | Complete | Job scheduling, dispatch, Part/Project/G-code management |
| 3 | Complete | Error handling, operator safety workflows, UI improvements |
| 4 | Complete | Hardening, retry logic, 409 conflict handling, configurable batch size, post-failure recovery |
| 5 | Deferred | Mobile-responsive polish - Fleet UI already works on iPhone; no immediate need |
| 6A | Complete | Driver abstraction layer - Prusa extracted into `server/drivers/prusa.js`; registry wired |
| 6B | Complete | Elegoo Centauri Carbon SDCP driver via `sdcp` package; UI and route changes for non-Prusa brands |
| 6C | Complete | Klipper (Moonraker) driver - Voron and all Klipper-firmware printers via plain HTTP on port 7125 |
| 6D | Complete | OctoPrint driver - any OctoPrint/OctoPi-managed printer via OctoPrint's own REST API |
| ERP | Complete (this fork) | Embedded Express ERP, shopfloor sync, postings, actual costing, analytics, timelapse |

See [ARCHITECTURE.md](../ARCHITECTURE.md) for the original product spec (phases 1-6). Runtime truth is `docs/` and the code.
