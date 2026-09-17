# Linux Installation and Development Guide

This guide covers this fork's supported bare-metal workflow on Linux. Docker remains available when an isolated environment is preferable. CoMa gates entry behind a single operator account created on first run (see [docs/api.md](api.md#authentication)), but that login is basic (one shared account, no TLS, no rate limiting). CoMa must still run on the same trusted local network as the printers and must not be exposed directly to the internet.

## Supported Runtime

- Linux on x86-64 or ARM64
- Node.js 22 or 23, with Node.js 22 LTS recommended
- npm from the Node.js installation
- Git
- Python 3, `make`, and a C++ compiler for installing the native `better-sqlite3` package (build time only)
- `sha256sum` from GNU coreutils for dependency change detection
- `setsid` from util-linux for isolated development process management

Node.js 24 is intentionally rejected because the project declares `>=22 <24` in `package.json`.

## Install System Packages

### Debian and Ubuntu

```bash
sudo apt update
sudo apt install -y git curl ca-certificates build-essential python3 coreutils util-linux iproute2
```

### Fedora and RHEL-compatible distributions

```bash
sudo dnf install -y git curl ca-certificates gcc-c++ make python3 coreutils util-linux iproute
```

Install Node.js 22 using your distribution's supported Node.js repository or a version manager such as `nvm`. After installation, verify the complete toolchain:

```bash
node --version
npm --version
git --version
python3 --version
make --version
g++ --version
sha256sum --version
setsid --version
```

The Node.js version must begin with `v22.` or `v23.`.

## Clone This Fork

```bash
git clone https://github.com/mdwcoder/core-manufacturing.git
cd core-manufacturing
```

This repository is a fork of [joeltelling/print-farm-manager](https://github.com/joeltelling/print-farm-manager). To track the original project explicitly, add it as an upstream remote:

```bash
git remote add upstream https://github.com/joeltelling/print-farm-manager.git
git fetch upstream
```

## Development Workflow

Start the API and Vite development server:

```bash
./start.sh
```

On the first run, or after either lockfile or the Node/npm version changes, the script runs `npm ci` for the server and client. It also builds `client/dist` once because the API checks that the production client exists even while Vite serves the development UI.

The services start in the background:

- Development UI with hot reload: `http://localhost:5173`
- API and built UI: `http://localhost:3000` (shopfloor + embedded `/api/erp` on the same SQLite file)
- Combined log: `.run/dev.log`

The first time either URL is opened on a fresh dataset, CoMa asks you to create the operator account (username and password), then walks through a short one-time setup guide (site name, dispatch concurrency). Neither screen reappears after that unless the account is deleted from Settings > Account, which requires the current password. See [docs/api.md](api.md#authentication) for the endpoints involved.

ERP screens live in the CoMa React app under `/erp`. `start.sh` launches only Express and Vite through `setsid`; there is no Python, uvicorn, Next.js, or Acres HTML process at runtime.

Manage the environment with:

```bash
./stop.sh
./restart.sh
tail -f .run/dev.log
```

The scripts ask whether to include the local Virtual Klipper Printer when run from an interactive terminal. Pass `--with-simulator` or `--without-simulator` to make the choice explicit. `WITH_KLIPPER_SIMULATOR=true` and `WITH_KLIPPER_SIMULATOR=false` provide the same control for automated workflows. A simulator started by `start.sh` is remembered in `.run/`, so a non-interactive `stop.sh` or `restart.sh` manages it too.

The scripts store only local runtime files in `.run/`, which is excluded from Git. `stop.sh` targets the isolated process group created by `start.sh`; it does not search for and terminate unrelated Node.js processes. Stopping the simulator preserves its local printer data.

### Organic and Seed Databases

Local development separates normal data from generated test fixtures:

| Dataset | File | Purpose |
|---|---|---|
| Organic | `server/data/organic-data.db` | Printers, projects, and history entered through normal use |
| Seed | `server/data/seed-data.db` | Fictional repeatable data created by the seed command |

Organic data is the default:

```bash
./start.sh --organic-data
```

Create or reset only the seed database, then start with it:

```bash
npm run seed:data
./start.sh --seed-data
```

`--seed-data` defaults to `DEMO_MODE=true`, so the poller does not replace the fictional printer states. Set `DEMO_MODE=false` explicitly if a test needs real polling. `restart.sh` accepts the same `--organic-data` and `--seed-data` options. Automated workflows can use `PFM_DATASET=organic` or `PFM_DATASET=seed` instead.

Both database files and their SQLite WAL files remain local because the entire `server/data/` directory is excluded from Git. The seed command never opens or modifies `organic-data.db`.

Environment variables can be set for a single start. For example, development without real printer polling is available with:

```bash
DEMO_MODE=true ./start.sh
```

If the service is already running, stop it before changing environment variables.

Use alternate ports when the defaults are already assigned to another local service:

```bash
PORT=3100 VITE_PORT=5174 ./start.sh
```

## Virtual Klipper Printer

For development without physical hardware, clone the simulator once into its ignored local directory:

```bash
mkdir -p tools
git clone https://github.com/mainsail-crew/virtual-klipper-printer.git tools/virtual-klipper-printer
```

Docker with the Compose plugin is required for the simulator. Start the full environment interactively with `./start.sh`, or choose it explicitly:

```bash
./start.sh --with-simulator
```

The simulator exposes Moonraker at `http://localhost:7125` and its dummy webcam at `http://localhost:8110`. Seed data points **every** printer IP at `127.0.0.1` (the local simulator) and includes a **Virtual Klipper** row (group Sim Lab) for live Moonraker status and camera. Reset and start with:

```bash
npm run seed:data
./start.sh --seed-data --with-simulator
```

`DEMO_MODE=true` (the `--seed-data` default) keeps the fictional Prusa/Elegoo/Bambu statuses stable for the dashboard and Fleet, but still polls loopback hosts so Virtual Klipper reflects live Moonraker state and the incident camera works. In CoMa, open Virtual Klipper on the printer detail page: snapshot mode (default) refreshes every 5 seconds; stream mode proxies MJPEG through `/api/printers/:id/camera/stream`. Camera support is implemented from Moonraker webcam docs and the simulator, not yet validated on physical Klipper hardware.

To add another Klipper printer by hand, create a model with the Klipper connector and use `127.0.0.1` as its address. The Klipper driver uses Moonraker port 7125 automatically and does not require an API key for this local simulator.

The simulator directory and its printer data stay local and are excluded through `.git/info/exclude`. They are not part of commits from this fork. These commands control whether the lifecycle scripts include it:

```bash
./stop.sh --with-simulator
./restart.sh --with-simulator
./restart.sh --without-simulator
```

`--without-simulator` restarts only CoMa and leaves an already running simulator unchanged.

## Manual Development Commands

The scripts are the preferred workflow, but their equivalent setup commands are:

```bash
npm ci
npm ci --prefix client
npm run build
npm run dev
```

The manual `npm run dev` command stays in the foreground. Press `Ctrl+C` to stop both development services.

## Tests and Production Build

Run the complete server test suite and client production build before submitting changes:

```bash
npm test
npm run build
```

## Docker Development

Docker avoids installing Node.js and native build tools directly on the host:

```bash
docker compose up --build print-farm-manager-dev
```

Open `http://localhost:5173`. Stop the container with `Ctrl+C`, or use `docker compose stop print-farm-manager-dev` if it was started in the background.

Do not run the production and development Compose services together because both publish port 3000.

## Production on Linux

For the simplest production deployment, use the production service from `docker-compose.yml`:

```bash
docker compose up -d --build print-farm-manager
docker compose logs -f print-farm-manager
```

For bare-metal production, install and build the exact dependencies first:

```bash
npm ci
npm ci --prefix client
npm run build
```

Create `/etc/systemd/system/print-farm-manager.service` with the following content. Replace `YOUR_USER` and `/opt/core-manufacturing` with the actual Linux user and checkout path:

```ini
[Unit]
Description=CoreManufacturing (CoMa)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=YOUR_USER
WorkingDirectory=/opt/core-manufacturing
Environment=NODE_ENV=production
ExecStart=/usr/bin/npm start
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
```

Then enable and start it:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now print-farm-manager
sudo systemctl status print-farm-manager
journalctl -u print-farm-manager -f
```

Confirm the path to npm with `command -v npm`. If it is not `/usr/bin/npm`, use the returned absolute path in `ExecStart`. Node version managers installed only in an interactive shell are usually unsuitable for a system service unless their absolute runtime paths are configured explicitly.

## Network Access

The local machine uses `http://localhost:3000` in production or `http://localhost:5173` in development. Other trusted LAN devices need the Linux host's address:

```bash
hostname -I
```

The production API listens on port 3000. Native Vite development is localhost-only by default, so use the Docker development service if the hot-reload UI must be reached from another machine.

### Install as a PWA

The production client (`npm run build`, then open the server on port 3000) registers a service worker and ships a web app manifest. On Chromium or Edge (desktop or Android), use Install app / Add to Home screen from the browser menu. Safari on iOS uses Share → Add to Home Screen.

The service worker caches the UI shell only. Live `/api/*` calls are never cached, so printer status stays current. Install works on `localhost` and on HTTPS; plain HTTP on a LAN IP may be blocked by the browser unless you use localhost or terminate TLS.

If a firewall is enabled, allow port 3000 only from the trusted LAN. Example for UFW and a `192.168.1.0/24` network:

```bash
sudo ufw allow from 192.168.1.0/24 to any port 3000 proto tcp
```

Adjust the subnet to match the real network. Do not create an unrestricted public firewall rule.

## Printer Credentials

Gather these values before adding printers:

| Brand | Required values |
|---|---|
| Prusa | IP address and PrusaLink API key |
| Bambu Lab | IP address, serial number, LAN access code, and LAN Mode enabled |
| Elegoo Centauri Carbon | IP address |
| Elegoo Centauri Carbon 2 | IP address, serial number, and LAN access code |
| Klipper | IP address of the Moonraker host, which normally uses port 7125 |
| OctoPrint | IP address with port when needed, plus API key |

Add printer models and printers from Settings. A new printer should move from `UNKNOWN` to its current state within one 15-second poll cycle.

## Data and Backups

Persistent bare-metal data is stored in:

| Path | Contents |
|---|---|
| `server/data/organic-data.db` | Normal local farm configuration and job history |
| `server/data/seed-data.db` | Replaceable fictional data for development and UI testing |
| `server/gcode/` | Uploaded G-code files |

Use Settings → Backup → Shopfloor Backup to export a portable JSON backup. For a filesystem-level backup, stop the service before copying the selected database and `server/gcode/`.

Never copy `node_modules` between machines or operating systems. Restore the data, then run `npm ci` on the destination so native packages match its Node.js ABI and Linux architecture.

## Updating the Fork

For development:

```bash
./stop.sh
git pull --ff-only
./start.sh
```

`start.sh` automatically detects lockfile changes and refreshes dependencies. Run the tests after updating.

For the systemd production service:

```bash
sudo systemctl stop print-farm-manager
git pull --ff-only
npm ci
npm ci --prefix client
npm run build
sudo systemctl start print-farm-manager
```

## Troubleshooting

### A required command is missing

Install the package listed in [Install System Packages](#install-system-packages). `sha256sum` is normally supplied by coreutils.

### Node.js version is rejected

Run `node --version` and install Node.js 22 LTS. The scripts intentionally reject Node.js versions outside the range declared by the project.

### A native package fails to build

Verify Python 3, `make`, and `g++` are installed. Then remove only generated dependencies and reinstall from the lockfiles:

```bash
rm -rf node_modules client/node_modules
npm ci
npm ci --prefix client
```

### Development services do not become ready

Read the combined log:

```bash
tail -n 100 .run/dev.log
```

Typical causes are another application already using port 3000 or 5173, a failed native dependency build, or a missing client bundle. `start.sh` reports the last log lines when readiness fails.

To inspect the ports without stopping anything:

```bash
ss -ltnp | grep -E ':(3000|5173)\\b'
```

### A stale PID file is reported

Run `./stop.sh`. It safely removes stale or invalid PID state. Then use `./start.sh` again.

### Printers remain offline

Confirm the Linux host and printers are on the same LAN and VLAN, verify the saved IP address and credentials, and check that local firewall rules allow outbound printer traffic. Do not expose the application to the public internet as a workaround, even now that it sits behind a login.
