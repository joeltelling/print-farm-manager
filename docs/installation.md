# Installation Guide

This guide covers installing Print Farm Manager on a dedicated machine that sits on the same local network as your printer fleet. Steps that differ between **Windows** and **macOS** are clearly labelled. Where instructions are the same on both platforms, no label is shown.

> **Running in Docker instead?** This guide covers a bare-metal Node.js + PM2 install. If you'd rather run the app in a container (no local Node.js or build tooling required), see the **Docker** section in the [README](../README.md#installation-production) — it uses the `Dockerfile` and `docker-compose.yml` at the repo root and handles everything below (build, port, auto-restart, persistent data) through Docker instead.

---

## Prerequisites

### Node.js

Print Farm Manager requires **Node.js 22 LTS**. Use the 22 LTS release specifically — Node 24+ has known issues compiling the native SQLite dependency on Windows.

**Windows**
1. Go to [https://nodejs.org](https://nodejs.org) and download the **22 LTS** installer (`.msi`).
2. Run the installer with default options. Ensure **"Add to PATH"** is checked (it is by default).
3. Open a new Command Prompt and verify:
   ```
   node --version
   npm --version
   ```
   If either command is not found, restart your machine and try again.

**macOS**
The recommended approach is [Homebrew](https://brew.sh). If you do not have Homebrew installed, the one-line installer is at [https://brew.sh](https://brew.sh).

```
brew install node@22
```

Alternatively, download the macOS `.pkg` installer from [https://nodejs.org](https://nodejs.org).

Verify in Terminal:
```
node --version
npm --version
```

---

### Native Build Dependencies

`better-sqlite3` compiles a native binary during `npm install`. Each platform needs the right build tools available or the install will fail.

**Windows**
`better-sqlite3` requires a C++ compiler. The easiest way to get one is during the Node.js install itself:

When running the Node.js installer, you will see a screen titled **"Tools for Native Modules"**. Check the box labelled **"Automatically install the necessary tools"** and complete the installer. A separate PowerShell window will open after Node finishes and install Python and Visual Studio Build Tools — let it run to completion.

If you already installed Node.js without checking that box, install the build tools manually:

1. Install **Visual Studio Build Tools 2022** (free). The fastest way is with Windows Package Manager — run this in an Administrator PowerShell:
   ```
   winget install Microsoft.VisualStudio.2022.BuildTools --override "--add Microsoft.VisualStudio.Workload.VCTools --includeRecommended --quiet"
   ```
   Alternatively, download the installer from [https://visualstudio.microsoft.com/downloads/](https://visualstudio.microsoft.com/downloads/) (scroll to "Tools for Visual Studio" → "Build Tools for Visual Studio 2022") and select the **"Desktop development with C++"** workload.

2. Install Python 3 from [https://python.org/downloads/](https://python.org/downloads/).

3. Open a new **Administrator** Command Prompt and run:
   ```
   npm install -g node-gyp
   ```

> **Note:** The old `npm install --global windows-build-tools` command is deprecated and broken on modern Node.js — do not use it.

**macOS**
Install the Xcode Command Line Tools. Run in Terminal and follow the on-screen prompt:
```
xcode-select --install
```
This is a one-time step. If you have already installed Xcode or the CLI tools previously, you can skip it.

---

### Git (recommended)

Git makes updating the software straightforward. If you prefer to download a ZIP instead, skip this step.

**Windows**
Download from [https://git-scm.com/download/win](https://git-scm.com/download/win) and install with default options.

**macOS**
Git is installed as part of the Xcode Command Line Tools (see above). If you skipped that step:
```
brew install git
```

---

### What You Will Need From Each Printer

Before adding printers to the app, gather the following credentials. The app will ask for these during setup.

| Brand | What the app needs | Where to find it |
|---|---|---|
| **Prusa** | IP address + API key | Printer touchscreen: **Settings → Network** shows the IP. PrusaLink web UI (open the IP in a browser) → **Settings → API Key** shows the key. |
| **Bambu Lab** | IP address + serial number + access code | Enable **LAN Mode** on the printer first. The access code is on the printer screen under **Settings → WLAN**; the serial number is under **Settings → Device**. The access code changes every time LAN Mode is toggled. |
| **Elegoo Centauri Carbon** | IP address only | Printer touchscreen: **Settings → Network**. No access code required. |
| **Elegoo Centauri Carbon 2** | IP address + serial number + access code | Enable LAN mode on the printer. The access code and serial number are shown on the printer's network settings screen. |
| **Klipper (Voron, etc.)** | IP address of the Klipper host | The IP of the machine running Moonraker (same machine as Klipper). Port 7125 is used automatically. No API key required. |
| **OctoPrint** | IP address (with port) + API key | In OctoPrint: **Settings → API** shows the key. If OctoPrint is not on port 80, include the port in the IP field — e.g. `192.168.1.50:5000` (OctoPi commonly uses `:5000`). |

---

## Getting the Code

### Option A — Git clone (recommended)

**Windows** — open Command Prompt or PowerShell in the folder where you want to install (e.g. `C:\PrintFarm`):
```
git clone https://github.com/joeltelling/print-farm-manager.git
cd print-farm-manager
```

**macOS** — open Terminal and navigate to your preferred location (e.g. `~/PrintFarm`):
```
mkdir -p ~/PrintFarm && cd ~/PrintFarm
git clone https://github.com/joeltelling/print-farm-manager.git
cd print-farm-manager
```

### Option B — Download ZIP

1. Go to the GitHub repository page.
2. Click **Code → Download ZIP**.
3. Extract the ZIP:
   - **Windows:** to a folder such as `C:\PrintFarm\print-farm-manager`
   - **macOS:** to a folder such as `~/PrintFarm/print-farm-manager`
4. Open a terminal and `cd` into that folder.

---

## Installation

Run the following from inside the `print-farm-manager` folder:

```
npm install
```

Then install client dependencies. On Windows, use the `--legacy-peer-deps` flag to avoid peer dependency conflicts:

**Windows:**
```
cd client
npm install --legacy-peer-deps
cd ..
```

**macOS:**
```
cd client && npm install && cd ..
```

### Build the client

Before running in production, build the React client into static files:

```
npm run build
```

This only needs to be re-run after an update — see [Updating](#updating).

---

## Network Setup

The machine running Print Farm Manager must be on the **same local network** as your printers. All communication happens over HTTP directly to each printer's IP address — no internet connection is required.

Print Farm Manager runs as a single server on **port 3000** that serves both the API and the web UI. Any browser on the same network can access it.

### Finding the machine's IP address

**Windows:**
```
ipconfig
```
Look for **IPv4 Address** under your active network adapter (e.g. `192.168.1.50`).

**macOS:**
```
ipconfig getifaddr en0
```
Use `en1` if you are on Wi-Fi and `en0` returns nothing, or check **System Settings → Network**.

Once the server is running, open **`http://[machine-ip]:3000`** from any browser on the network.

### Firewall configuration

**Windows**
Windows Firewall may block connections from other devices on the network. To allow them:

1. Open **Windows Defender Firewall with Advanced Security** (search in the Start menu).
2. Click **Inbound Rules → New Rule**.
3. Select **Port**, click Next.
4. Select **TCP**, enter `3000`, click Next.
5. Select **Allow the connection**, click Next through the remaining steps and name the rule `Print Farm Manager`.

**macOS**
macOS does not block outbound connections and generally allows LAN traffic by default. If you have manually enabled the macOS Application Firewall (System Settings → Network → Firewall), you may need to add an exception, but most users will not need to do anything here.

---

## Running the Server

From the `print-farm-manager` folder:

```
npm start
```

You should see:

```
[server] Express running on http://localhost:3000
[poller] Starting poll loop (interval: 15000ms)
[scheduler] Starting job scheduler
```

- On the **local machine**: open a browser to **http://localhost:3000**
- From **any other device on the network**: use the machine's IP address — e.g. **http://192.168.1.50:3000**

To stop the server, press `Ctrl + C` in the terminal.

> **Development mode:** If you are actively developing the app, `npm run dev` starts both the Express server and the Vite dev server with hot reload. This is not needed for normal farm operation.

---

## First Run: Adding Your First Printer

When you open the app for the first time, the Fleet view will be empty. This is expected — no printers have been configured yet. Follow these steps:

### Step 1 — Add a Printer Model

Go to **Settings → Printer Models** and add a model entry for each type of printer you have. A model entry links a display name (e.g. "MK4S") to a brand connector (Prusa, Bambu, Elegoo Centauri Carbon, Elegoo Centauri Carbon 2, Klipper). A fresh install starts with an empty model list — add whichever models your farm uses.

Model IDs are free-form and only used internally — choose something descriptive (e.g. `voron-24` for a Klipper printer). One exception: CSV import can infer a printer's model from its name prefix, but only for the Prusa IDs `mk4s`, `mk4`, `c1`, `c1l`, and `xl` (e.g. a printer named `MK4S_01` resolves to `mk4s`).

### Step 2 — Add a Printer

Still in **Settings**, click **Add Printer**. Fill in:

- **Name** — a short identifier (e.g. `MK4S_01`). Used throughout the UI.
- **IP Address** — the local IP of the printer (see credential table above).
- **API Key / Access Code** — see credential table above. The field is labelled **Access Code** for Bambu and Centauri Carbon 2 printers. Not needed for Elegoo Centauri Carbon (original) or Klipper.
- **Serial Number** — Bambu and Elegoo Centauri Carbon 2 printers only.
- **Group** — optional, for organizing multiple printers (e.g. `MK4S Farm`).
- **Model** — select from the models you added in Step 1.

Click **Save**. The printer will appear in the Fleet view within 15 seconds as the poller makes its first contact.

### Step 3 — Verify the Connection

Open the **Fleet** page. If the printer is reachable, its status will change from `UNKNOWN` to its actual state (e.g. `IDLE` or `PRINTING`) within one poll cycle (15 seconds).

If the printer stays `OFFLINE` or `UNKNOWN`:
- Confirm the IP address is correct by opening `http://<printer-ip>` in a browser on the same machine.
- For Prusa: confirm the API key matches what PrusaLink shows.
- For Bambu: confirm LAN Mode is enabled and the access code matches.
- Check that the farm machine and the printer are on the same network subnet.

### Step 4 — Import a Large Fleet via CSV

For farms with many printers, use the **CSV Import** on the Settings page instead of adding them one by one. See the [CSV Import Format](../README.md#csv-import-format) section in the README for the required column names.

---

## Keeping It Running (Auto-start on Boot)

Running `npm start` manually is fine for testing, but a farm machine should start the server automatically on boot and restart it if it crashes. **PM2** is a Node.js process manager that handles this on both platforms.

### Install PM2

**Windows:**
```
npm install --global pm2
npm install --global pm2-windows-startup
```

**macOS:**
```
npm install --global pm2
```

### Start Print Farm Manager with PM2

From the `print-farm-manager` folder (same on both platforms):
```
pm2 start npm --name "print-farm-manager" -- start
```

Verify it is running:
```
pm2 list
```
You should see `print-farm-manager` with status `online`.

### Enable Auto-start on Boot

**Windows:**
```
pm2-startup install
pm2 save
```

**macOS:**
```
pm2 startup
```
PM2 will print a command beginning with `sudo env PATH=...` — copy and run that exact command, then:
```
pm2 save
```

Print Farm Manager will now start automatically whenever the machine boots, with no login required.

### Useful PM2 Commands

| Command | What it does |
|---|---|
| `pm2 list` | Show all running processes and their status |
| `pm2 logs print-farm-manager` | Stream live server logs |
| `pm2 logs print-farm-manager --lines 100` | Show last 100 log lines |
| `pm2 restart print-farm-manager` | Restart the server |
| `pm2 stop print-farm-manager` | Stop the server |
| `pm2 delete print-farm-manager` | Remove it from PM2 entirely |

---

## Data & File Storage

All persistent data lives inside the `print-farm-manager` folder:

| Path | Contents |
|---|---|
| `server/data/farm.db` | SQLite database — all printers, projects, parts, jobs |
| `server/gcode/` | Uploaded G-code files |

Neither folder is tracked by Git — they are created automatically on first run.

### Backup

Use the **Farm Backup** tool in the app's Settings page to export a full snapshot of your farm (printers, projects, parts, G-code files, and job history) as a single `.json` file. You can restore from this file on any machine running Print Farm Manager.

For an additional low-level backup, copy `server/data/farm.db` and `server/gcode/` to a safe location. Restoring is as simple as copying them back.

### Moving to a new machine

1. On the old machine, go to **Settings → Farm Backup → Export Farm** and save the `.json` file.
2. Install Print Farm Manager on the new machine following this guide.
3. Go to **Settings → Farm Backup**, select the `.json` file, and click **Restore Farm**.

Alternatively, copy the entire `print-farm-manager` folder to the new machine — the database and G-code files are included. After copying, delete `node_modules` and `client/node_modules` and run `npm install` fresh (native dependencies must be compiled for the new machine's OS and Node version).

---

## Updating

### Windows — using update.bat

Double-click `update.bat` in the repo root (or run it from a Command Prompt). It will:
1. Discard any local `package-lock.json` drift, then `git pull` the latest code
2. `npm install` server dependencies
3. Build the React client (`client/npm install` + `npm run build`)
4. Kill the process on port 3000 and start the server in the foreground

The lockfile discard in step 1 exists because `npm install` rewrites `package-lock.json` whenever the machine's npm version differs from the one that generated it. Without the discard, `git pull` fails with "Your local changes to the following files would be overwritten by merge: package-lock.json" the next time the lockfile changes upstream. If you hit that error on an older copy of `update.bat`, run `git restore package-lock.json` in the repo folder and update again.

The server runs in the bat's window — closing the window stops the server.

> **Note:** `update.bat` uses `call npm ...` for all npm commands. If you are writing your own Windows batch scripts that invoke npm, you must use `call npm` — without `call`, the batch script exits silently when npm finishes because `npm.cmd` is a `.cmd` file.

### macOS / Linux — manual steps

```
git pull
npm install
cd client && npm install && cd ..
npm run build
pm2 restart print-farm-manager
```

### ZIP install

1. Download the new ZIP from GitHub.
2. Extract it to a **new** folder — do not overwrite the existing one.
3. Copy `server/data/` and `server/gcode/` from the old folder into the new one.
4. Run the install and build steps in the new folder:
   ```
   npm install
   cd client && npm install --legacy-peer-deps && cd ..
   npm run build
   ```
5. Update PM2 to point at the new folder:

**Windows:**
```
pm2 delete print-farm-manager
cd C:\PrintFarm\print-farm-manager-NEW
pm2 start npm --name "print-farm-manager" -- start
pm2 save
```

**macOS:**
```
pm2 delete print-farm-manager
cd ~/PrintFarm/print-farm-manager-NEW
pm2 start npm --name "print-farm-manager" -- start
pm2 save
```

---

## Troubleshooting

**`node` or `npm` not found after installing Node.js**
Restart your machine. The PATH change from the installer requires a full restart to take effect.

**`npm install` fails with a native build error**

*Windows* — install Visual Studio Build Tools 2022. Run this in an Administrator PowerShell:
```
winget install Microsoft.VisualStudio.2022.BuildTools --override "--add Microsoft.VisualStudio.Workload.VCTools --includeRecommended --quiet"
```
Then install `node-gyp` in a new Administrator Command Prompt:
```
npm install -g node-gyp
```
> Do not use `npm install --global windows-build-tools` — it is deprecated and fails on modern Node.js.

*macOS* — install Xcode Command Line Tools:
```
xcode-select --install
```

Then retry `npm install`.

**`better_sqlite3.node is not a valid Win32 application`**
The native SQLite binary was compiled for a different operating system (e.g. the `node_modules` folder was copied from a Mac). Delete it and reinstall on the Windows machine:
```
rmdir /s /q node_modules
rmdir /s /q client\node_modules
npm install
cd client && npm install --legacy-peer-deps && cd ..
npm run build
```

**`npm install` in `client/` reports dependency conflicts on Windows**
Run with the `--legacy-peer-deps` flag:
```
npm install --legacy-peer-deps
```

**UI loads but shows no printers / API errors**
- Confirm the server is running: `pm2 list`
- Check server logs: `pm2 logs print-farm-manager`
- Confirm port 3000 is not blocked (Windows: check Firewall rules; macOS: check if Application Firewall is on)

**Printers show as OFFLINE**
- Confirm the farm machine and the printers are on the same network subnet.
- Open `http://<printer-ip>/api/v1/status` in a browser on the farm machine. If it loads, the server can reach the printer. If not, it is a network or switch issue.

**Port 3000 already in use**

*Windows:*
```
netstat -ano | findstr :3000
taskkill /PID <PID> /F
```

*macOS:*
```
lsof -i :3000
kill -9 <PID>
```

**Server starts but UI does not load on another device**
- Use the machine's LAN IP address — `localhost` only resolves on the machine itself.
- Windows: confirm the Firewall inbound rule covers port 3000.
- Check that both devices are on the same network VLAN. Some managed switches isolate VLANs from each other.
