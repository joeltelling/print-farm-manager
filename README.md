# CoMa / CoreManufacturing

Self-hosted web app for a multi-brand 3D printer fleet **and** an embedded manufacturing ERP (inventory, costing, work orders, sales, eBay Sell sync) in one Node process and one SQLite file.

Fork of [joeltelling/print-farm-manager](https://github.com/joeltelling/print-farm-manager), focused on Linux ops. Product name: **CoMa** (short) / **CoreManufacturing** (long).

No cloud. No subscriptions. No vendor lock-in.

> **Security:** There is no built-in auth. Run only on a trusted LAN (or VPN). Do not expose ports 3000 / 5173 to the internet; printer API keys are reachable by anyone who can hit the server.

---

## Screenshots

Captured from the seed demo dataset (`./start.sh --seed-data`). Dark UI: shopfloor + ERP share one sidebar.

### Shopfloor dashboard

Utilization, fleet mix, Needs Attention, live printer cards, and active projects.

![Shopfloor dashboard with utilization KPIs and fleet grid](docs/images/dashboard.png)

### Live fleet

Multi-brand cards (Bambu, Voron/Klipper, Centauri, MK4S) with Set Ready / Bad Print on finished holds.

![Fleet view with printer cards and operator confirmation](docs/images/fleet.png)

### Projects

Active production jobs (parts + G-code targeting) from the shopfloor.

![Projects list with Benchy Fleet and Gridfinity](docs/images/projects.png)

### Embedded ERP dashboard

Shopfloor sync, pending postings, stock value, and "needs ERP data" action queue.

![ERP dashboard KPIs and shopfloor link](docs/images/erp-dashboard.png)

### Inventory

On-hand by warehouse (donut + bars) and receive-by-SKU form.

![ERP inventory value by warehouse](docs/images/erp-inventory.png)

### Sales

Revenue / margin snapshot and finished-goods pricing matrix.

![ERP sales dashboard](docs/images/erp-sales.png)

### eBay Sell

Sandbox credentials, SKU to offer mapping, pending order lines, inventory push. (Not yet validated on a real eBay account.)

![eBay integration page under ERP Ventas](docs/images/erp-ebay.png)

### Settings

Farm name, camera mode, timelapse, and dispatch batch size.

![Settings general tab](docs/images/settings.png)

---

## What it does

### Shopfloor

- Live fleet every 15 s (status, progress, time remaining)
- Automated dispatch: projects, parts, G-code; idle printers get the next job
- Operator hold on finish: Set Ready / Bad Print before the next dispatch
- Brands: Prusa, Elegoo, Bambu, Klipper, OctoPrint
- CSV fleet import, TV dashboard, per-printer incident view (camera + events)
- Timelapses (JPEG frames; optional MP4 via host `ffmpeg`)
- Telemetry for utilization / OEE and actual costing

### Embedded ERP (same app, same DB)

- Masters linked to shopfloor: project↔product, part↔component, printer↔machine, filament↔raw
- Inventory + WAC, machine rates (manual or calculated), BOM, work orders, QR pick lists
- Sales: pricing (`EBAY_FEE` included), orders, CSV/PDF history
- Shopfloor posting queue after Set Ready (never invents `completed_qty`)
- Analytics: project profitability, machine OEE, std vs actual variance
- **eBay Sell APIs:** import paid orders (hybrid auto-post / operator queue), push price+qty to existing offers, seller analytics. Guide: [docs/erp/ebay.md](docs/erp/ebay.md)

### Ops

- One JSON backup for shopfloor + ERP + G-code (eBay secrets excluded on purpose)
- Organic vs seed databases so demos never overwrite real farm data

**New here?** Operator walkthrough (Spanish): **[docs/user-guide.md](docs/user-guide.md)**. Tech index: **[docs/README.md](docs/README.md)**.

---

## Supported printers

| Brand | Protocol | Notes |
|---|---|---|
| **Prusa** | PrusaLink REST | MK4S, XL, and other PrusaLink models |
| **Elegoo** | SDCP (Centauri) · MQTT (CC2) | Centauri Carbon, Centauri Carbon 2 |
| **Bambu Lab** | MQTT + FTPS | X1C, P1S, AMS slot selection |
| **Klipper** | Moonraker REST | Voron and any Klipper printer; webcam via Moonraker |
| **OctoPrint** | OctoPrint REST | Any printer behind OctoPrint / OctoPi |

Camera auto-discovery: Klipper. Optional snapshot/stream URL overrides on any printer.

---

## Quick start (Linux)

Needs Linux, Git, Node.js 22 or 23, npm, `setsid`, and the native build toolchain for `better-sqlite3` (Python 3, `make`, C++ compiler at install time only). Distro notes: [docs/installation.md](docs/installation.md).

```bash
git clone https://github.com/mdwcoder/core-manufacturing.git
cd core-manufacturing
./start.sh
```

| URL | Role |
|---|---|
| `http://localhost:3000` | API + ERP + production SPA |
| `http://localhost:5173` | Vite UI (dev hot reload) |

Helpers: `./stop.sh`, `./restart.sh`. Logs: `.run/dev.log`.

**Demo with seed data** (screenshots above were taken this way):

```bash
npm run seed:data
./start.sh --seed-data --with-simulator
```

| Flag | Database file | Use |
|---|---|---|
| `--organic-data` (default) | `server/data/organic-data.db` | Real operator data |
| `--seed-data` | `server/data/seed-data.db` | Demo fixtures |

### Docker (dev)

```bash
docker compose up --build print-farm-manager-dev
```

Same ports as above. Tests: `docker compose exec print-farm-manager-dev npm test`.

---

## Production install

### Option A: Docker

Upstream publishes multi-arch images to GHCR ([docs/docker-publish.md](docs/docker-publish.md)). To run **this fork** (ERP, telemetry, timelapse, eBay), build from source until a fork image is published:

```bash
git clone https://github.com/mdwcoder/core-manufacturing.git
cd core-manufacturing
docker compose up -d --build
```

Open `http://localhost:3000` (or the machine LAN IP). Update with `git pull` then `docker compose up -d --build`.

For timelapse MP4, install `ffmpeg` on the host or in a custom image. Without it, JPEG frames still work.

### Option B: bare metal

Full guide: **[docs/installation.md](docs/installation.md)**.

```bash
npm ci
npm ci --prefix client
npm run build
npm start
```

---

## Operator map

| Goal | Where |
|---|---|
| See fleet / confirm prints | Shopfloor → Fleet |
| Projects, parts, G-code | Shopfloor → Projects |
| Sync printers into ERP | ERP → Dashboard → Sync from shopfloor |
| Receive filament / raw | ERP → Inventory |
| Machine USD/h or kW | ERP → Machines |
| Confirm stock after Set Ready | ERP → Postings |
| OEE / margin / cost variance | ERP → Analytics |
| eBay orders and inventory push | ERP → Ventas → eBay |
| Timelapse gallery | Shopfloor → Timelapses |
| Backup | Settings → Backup |

---

## CSV import

Settings → Hardware → CSV import.

| Column | Required | Example |
|---|---|---|
| `name` | Yes | `MK4S_01` |
| `ip` | Yes | `192.168.1.100` |
| `type` | Yes | `prusa` / `elegoo-centauri` / `elegoo-centauri2` / `bambu` / `klipper` / `octoprint` |
| `api_key` | Prusa, OctoPrint; Bambu/CC2 LAN code | `aK3jR7xQ2pLm9vN` |
| `serial_number` | Bambu and Centauri Carbon 2 | `01S00C123456789` |
| `group` | No | `MK4S Farm` |
| `model` | No | `mk4s` |

---

## Tech stack

| Layer | Stack |
|---|---|
| Server | Node 22/23, Express, better-sqlite3, axios, mqtt, basic-ftp, sdcp, multer, papaparse |
| Client | React 18, React Router 6, Vite (no CSS framework; design tokens in `client/src/theme.js`) |
| Data | One SQLite file for shopfloor + ERP (`server/data/*.db`) |

No Python runtime for CoMa or the ERP. Optional host `ffmpeg` for timelapse render. Optional PM2 for bare-metal process management.

---

## Project structure

```
core-manufacturing/
├── server/
│   ├── index.js          # Express: shopfloor + /api/erp + /api/erp/ebay + SPA
│   ├── db.js             # SQLite + additive migrations
│   ├── poller.js         # 15 s poll + telemetry + timelapse hooks
│   ├── scheduler.js      # Dispatch + job close
│   ├── erp/              # Embedded ERP
│   ├── ebay/             # eBay Sell client, orders, inventory push, runner
│   ├── drivers/          # prusa, elegoo-*, bambu, klipper, octoprint
│   └── routes/
├── client/               # React + Vite
├── docs/                 # Guides, API, images used in this README
├── start.sh / stop.sh
├── Dockerfile
└── docker-compose.yml
```

---

## Documentation

| Doc | Contents |
|---|---|
| [docs/user-guide.md](docs/user-guide.md) | Operator walkthrough (Spanish) |
| [docs/README.md](docs/README.md) | Technical index |
| [docs/installation.md](docs/installation.md) | Linux install, scripts, systemd, simulator |
| [docs/erp/README.md](docs/erp/README.md) | Embedded ERP |
| [docs/erp/ebay.md](docs/erp/ebay.md) | eBay Sell integration |
| [docs/api.md](docs/api.md) | REST contracts |
| [docs/web-app.md](docs/web-app.md) | React pages and UI |
| [docs/database.md](docs/database.md) | Schema |
| [docs/CHANGELOG.md](docs/CHANGELOG.md) | Dated change log |

---

## License

MIT
