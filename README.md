# Print Farm Manager

A self-hosted web app for managing a multi-brand 3D printer farm. Replaces manual USB job distribution with centralized status monitoring and automated job dispatch — built to run 24/7 on a dedicated machine on your local network.

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
- **TV dashboard mode** — a heads-up fleet summary designed for a monitor on the shop wall
- **Farm backup and restore** — export your entire farm config and job history as a single JSON file

![Fleet view — per-printer cards with operator confirmation](docs/images/fleet.png)

---

## Supported Printers

| Brand | Protocol | Models |
|---|---|---|
| **Prusa** | PrusaLink REST API | MK4S, XL, and other PrusaLink-compatible models |
| **Elegoo** | SDCP WebSocket (Centauri Carbon) · MQTT (Centauri Carbon 2) | Centauri Carbon, Centauri Carbon 2 |
| **Bambu Lab** | MQTT + FTPS | X1C, P1S, and other Bambu models (with AMS slot selection) |
| **Klipper** | Moonraker REST API | Voron and any Klipper-firmware printer |

---

## Tech Stack

### Backend
| Package | Role |
|---|---|
| [Node.js](https://nodejs.org) + [Express](https://expressjs.com) | HTTP API server |
| [better-sqlite3](https://github.com/WiseLibs/better-sqlite3) | Embedded SQLite database — synchronous, zero configuration |
| [axios](https://axios-http.com) | HTTP communication with Prusa and Klipper printers |
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

## Quick Start (Development)

Requires **Node.js 22 LTS** — Node 24+ has known issues compiling the native SQLite dependency on Windows (see the [Installation Guide](docs/installation.md) for details).

```bash
git clone https://github.com/joeltelling/print-farm-manager.git
cd print-farm-manager
npm install
cd client && npm install && cd ..
npm run dev
```

- API server: `http://localhost:3000`
- Web UI (hot reload): `http://localhost:5173`

---

## Installation (Production)

### Option A — Docker (recommended)

Requires [Docker](https://docs.docker.com/get-docker/) (and Compose, bundled with Docker Desktop and modern Docker Engine installs). This runs the same production build described in Option B, packaged into a container — no local Node.js install needed on the host.

```bash
git clone https://github.com/joeltelling/print-farm-manager.git
cd print-farm-manager
docker compose up -d --build
```

This builds the image (compiling `better-sqlite3` and building the React client inside the container) and starts it in the background, restarting automatically on crash or host reboot. The SQLite database, hourly backups, and uploaded G-code files are stored in the named Docker volumes `farm-data` and `farm-gcode`, so they survive container rebuilds and updates.

Open `http://localhost:3000` in a browser, or replace `localhost` with the machine's LAN IP to access it from any device on the network.

**Updating** to a new version:

```bash
git pull
docker compose up -d --build
```

**Useful commands:**

| Command | What it does |
|---|---|
| `docker compose logs -f` | Follow server logs |
| `docker compose stop` | Stop the container (data is preserved) |
| `docker compose up -d` | Start it again |
| `docker compose down` | Stop and remove the container (volumes are preserved) |

Without Compose, the equivalent `docker run` is:

```bash
docker build -t print-farm-manager .
docker run -d --name print-farm-manager --restart unless-stopped \
  -p 3000:3000 \
  -v farm-data:/app/server/data \
  -v farm-gcode:/app/server/gcode \
  print-farm-manager
```

> Same security note as above applies inside Docker: only publish port 3000 to interfaces on your trusted LAN, not `0.0.0.0` on an internet-facing host.

### Option B — Bare metal (Node.js on the host)

For a full walkthrough covering prerequisites, network setup, auto-start with PM2, backup, updating, and troubleshooting on both Windows and macOS, see the **[Installation Guide](docs/installation.md)**.

The short version:

```bash
npm install
cd client && npm install && cd ..
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
| `type` | Yes | `prusa` / `elegoo-centauri` / `elegoo-centauri2` / `bambu` / `klipper` |
| `api_key` | Prusa (API key), Bambu and Centauri Carbon 2 (LAN access code) | `aK3jR7xQ2pLm9vN` |
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
│       ├── elegoo-centauri.js  # SDCP WebSocket
│       ├── bambu.js       # MQTT + FTPS
│       └── klipper.js     # Moonraker REST
├── client/               # React + Vite frontend
├── docs/                 # Full documentation
├── Dockerfile            # Multi-stage production image (build client + server, run on Node 22)
└── docker-compose.yml    # Production container with persistent data/gcode volumes
```

---

## License

MIT
