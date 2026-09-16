# CoMa / CoreManufacturing

A self-hosted web app for managing a multi-brand 3D printer fleet. This repository is a Linux-focused fork of [joeltelling/print-farm-manager](https://github.com/joeltelling/print-farm-manager). The original project and its contributors remain the upstream source.

The operator-facing product name is **CoMa** (short) / **CoreManufacturing** (long). Internal keys such as `farm_name` and Docker service names stay unchanged so existing installs keep working.

No cloud. No subscriptions. No vendor lock-in.

![Dashboard — live fleet status and active projects](docs/images/dashboard.png)

> **Security note:** This app has no built-in authentication. It is designed to run on a trusted local network only. Do not expose port 3000 (or 5173 in dev) to the internet — your printer API keys are served to any client that can reach the server. Run it behind your router's firewall or a local VPN.

---

## What It Does

- **Live fleet view** — see every printer's status, progress, and time remaining at a glance, auto-refreshing every 15 seconds
- **Automated job dispatch** — define projects and parts, upload G-code, and let the scheduler assign jobs to idle printers automatically
- **Operator confirmation flow** — every finished print requires a human sign-off before the next job dispatches, preventing runaway failures
- **Multi-brand support** — Prusa, Elegoo, Bambu, and Klipper printers in the same fleet, managed from one interface
- **CSV fleet import** — add 50 printers at once from a spreadsheet
- **TV dashboard:** utilization donut, parts-per-hour bars, clickable fleet grid, and a Needs Attention queue
- **Incident view:** per-printer camera (Klipper) plus event log
- **Site backup and restore:** export config and job history as a single JSON file

![Fleet view — per-printer cards with operator confirmation](docs/images/fleet.png)

---

## Supported Printers

| Brand | Protocol | Models |
|---|---|---|
| **Prusa** | PrusaLink REST API | MK4S, XL, and other PrusaLink-compatible models |
| **Elegoo** | SDCP WebSocket (Centauri Carbon) · MQTT (Centauri Carbon 2) | Centauri Carbon, Centauri Carbon 2 |
| **Bambu Lab** | MQTT + FTPS | X1C, P1S, and other Bambu models (with AMS slot selection) |
| **Klipper** | Moonraker REST API | Voron and any Klipper-firmware printer |
| **OctoPrint** | OctoPrint REST API | Any printer running OctoPrint / OctoPi |

---

## Tech Stack

### Backend
| Package | Role |
|---|---|
| [Node.js](https://nodejs.org) + [Express](https://expressjs.com) | HTTP API server |
| [better-sqlite3](https://github.com/WiseLibs/better-sqlite3) | Embedded SQLite database — synchronous, zero configuration |
| [axios](https://axios-http.com) | HTTP communication with Prusa, Klipper, and OctoPrint printers |
| [mqtt](https://github.com/mqttjs/MQTT.js) | MQTT over TLS for Bambu printer communication |
| [basic-ftp](https://github.com/patrickjuchli/basic-ftp) | FTPS file transfer to Bambu printers |
| [sdcp](https://github.com/blakejrobinson/sdcp) | WebSocket protocol driver for Elegoo SDCP printers |
| [multer](https://github.com/expressjs/multer) | G-code file upload handling |
| [papaparse](https://www.papaparse.com) | CSV fleet import |
| [form-data](https://github.com/form-data/form-data) | Multipart upload for Klipper/Moonraker |
| [PM2](https://pm2.keymetrics.io) | Process manager — auto-start on boot, crash recovery |

### Frontend
| Package | Role |
|---|---|
| [React 18](https://react.dev) | UI framework |
| [React Router v6](https://reactrouter.com) | Client-side routing |
| [Vite](https://vitejs.dev) | Build tool and dev server |

### Data
| Technology | Role |
|---|---|
| SQLite (via better-sqlite3) | Single-file embedded database — no database server required |

---

## Quick Start (Linux Development)

Requires Linux, Git, Node.js 22 or 23, npm, Python 3, `make`, and a C++ compiler. The [Linux installation guide](docs/installation.md) includes commands for Debian, Ubuntu, Fedora, and RHEL-compatible systems.

```bash
git clone https://github.com/mdwcoder/core-manufacturing.git
cd core-manufacturing
./start.sh
```

- API server: `http://localhost:3000`
- Web UI (hot reload): `http://localhost:5173`

`start.sh` validates Node.js, installs the locked server and client dependencies when needed, builds the initial client bundle, and starts both development services in the background. Use `./stop.sh` and `./restart.sh` to manage them. Logs are written to `.run/dev.log`.

Development keeps real entries and generated test fixtures in separate local databases. `./start.sh --organic-data` uses `organic-data.db` and is the default. Run `npm run seed:data` once, then use `./start.sh --seed-data --with-simulator` to open `seed-data.db` with a live Virtual Klipper row at `127.0.0.1` while fictional LAN printers keep their seeded statuses. Both database files live under the Git-ignored `server/data/` directory.

The scripts can also manage a local [Virtual Klipper Printer](https://github.com/mainsail-crew/virtual-klipper-printer) for development without physical hardware. In a terminal they ask whether to include it. Use `--with-simulator` or `--without-simulator` to choose explicitly, including in automated workflows. See the [Linux installation guide](docs/installation.md#virtual-klipper-printer) for the one-time local clone and application setup.

### Prefer Docker instead of a local Node.js install?

```bash
git clone https://github.com/mdwcoder/core-manufacturing.git
cd core-manufacturing
docker compose up --build print-farm-manager-dev
```

- API server: `http://localhost:3000`
- Web UI (hot reload): `http://localhost:5173`

Run tests with `docker compose exec print-farm-manager-dev npm test`. See the `dev` service in `docker-compose.yml` for details.

---

## Installation (Production)

### Option A — Docker (recommended)

Requires [Docker](https://docs.docker.com/get-docker/) (and Compose, bundled with Docker Desktop and modern Docker Engine installs).

#### Quickest start — pull the published image

No clone, no local build. A multi-arch image (`linux/amd64` + `linux/arm64`) is published automatically to GitHub Container Registry on every release — see [docs/docker-publish.md](docs/docker-publish.md). Save this as `docker-compose.yml`:

This image is published by the upstream project. To run this fork's changes, use the source-build option below until the fork publishes its own image.

```yaml
services:
  print-farm-manager:
    image: ghcr.io/joeltelling/print-farm-manager:latest
    container_name: print-farm-manager
    restart: unless-stopped
    ports:
      - "3000:3000"
    volumes:
      - farm-data:/app/server/data
      - farm-gcode:/app/server/gcode

volumes:
  farm-data:
  farm-gcode:
```

```bash
docker compose up -d
```

This same file works as a drop-in stack in Portainer (**Stacks → Add stack → Web editor**, paste it in, deploy) — no repo checkout needed there either.

Open `http://localhost:3000` in a browser, or replace `localhost` with the machine's LAN IP to access it from any device on the network.

**Updating** to the latest published image:

```bash
docker compose pull
docker compose up -d
```

**Useful commands:**

| Command | What it does |
|---|---|
| `docker compose logs -f` | Follow server logs |
| `docker compose stop` | Stop the container (data is preserved) |
| `docker compose up -d` | Start it again |
| `docker compose down` | Stop and remove the container (volumes are preserved) |

Pin to a specific release instead of always tracking `latest` by using a version tag, e.g. `ghcr.io/joeltelling/print-farm-manager:1.2.0`. `edge` tracks the latest build of `main` between releases.

#### Building from source instead

If you're testing local changes rather than running a release, clone the repo and build with the `docker-compose.yml` at its root (uses `build:` instead of `image:`):

```bash
git clone https://github.com/mdwcoder/core-manufacturing.git
cd core-manufacturing
docker compose up -d --build
```

Updating this path pulls new source and rebuilds:

```bash
git pull
docker compose up -d --build
```

Without Compose, the equivalent `docker run` (published image) is:

```bash
docker run -d --name print-farm-manager --restart unless-stopped \
  -p 3000:3000 \
  -v farm-data:/app/server/data \
  -v farm-gcode:/app/server/gcode \
  ghcr.io/joeltelling/print-farm-manager:latest
```

> Same security note as above applies inside Docker: only publish port 3000 to interfaces on your trusted LAN, not `0.0.0.0` on an internet-facing host.

### Option B — Bare metal (Node.js on the host)

For a full Linux walkthrough covering prerequisites, the development scripts, network setup, systemd, backup, updating, and troubleshooting, see the **[Installation Guide](docs/installation.md)**.

The short version:

```bash
npm ci
npm ci --prefix client
npm run build
npm start
```

Open `http://localhost:3000` in a browser, or replace `localhost` with the machine's LAN IP to access it from any device on the network.

---

## CSV Import Format

The fastest way to add a large fleet is via CSV import on the Settings page.

| Column | Required | Example |
|---|---|---|
| `name` | Yes | `MK4S_01` |
| `ip` | Yes | `192.168.1.100` |
| `type` | Yes | `prusa` / `elegoo-centauri` / `elegoo-centauri2` / `bambu` / `klipper` / `octoprint` |
| `api_key` | Prusa and OctoPrint (API key), Bambu and Centauri Carbon 2 (LAN access code) | `aK3jR7xQ2pLm9vN` |
| `serial_number` | Bambu and Centauri Carbon 2 | `01S00C123456789` |
| `group` | No | `MK4S Farm` |
| `model` | No | `mk4s` |

If the `model` column is omitted, the model is inferred automatically from the printer name where possible; unrecognised models prompt for manual selection after import.

---

## Project Structure

```
print-farm-manager/
├── server/
│   ├── index.js          # Express entry point
│   ├── db.js             # SQLite schema + migrations
│   ├── poller.js         # 15-second printer poll loop
│   ├── scheduler.js      # Job dispatch engine
│   └── drivers/          # Per-brand printer drivers
│       ├── prusa.js       # PrusaLink REST
│       ├── elegoo-centauri.js   # SDCP WebSocket (Centauri Carbon)
│       ├── elegoo-centauri2.js  # MQTT + chunked HTTP PUT (Centauri Carbon 2)
│       ├── bambu.js       # MQTT + FTPS
│       ├── klipper.js     # Moonraker REST
│       └── octoprint.js   # OctoPrint REST
├── client/               # React + Vite frontend
├── docs/                 # Full documentation
├── Dockerfile            # Multi-stage: server-deps/client-build/runtime (production) + dev
└── docker-compose.yml    # Production container + persistent volumes, plus an opt-in `dev` profile
```

---

## License

MIT
