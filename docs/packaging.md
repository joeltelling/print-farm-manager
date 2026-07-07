# Packaging — Windows Portable Bundle

A one-folder, double-click distribution of Print Farm Manager for Windows farm
machines. Operators unzip it and run **Print Farm Manager.exe** — no Node.js
install, no `git clone`, no `npm install`, no Visual Studio Build Tools, no
Docker.

This is an *additional* distribution target. The `npm run dev` workflow
(`docs/installation.md`) and the Docker image (`docs/docker-publish.md`) are
unchanged.

## What the bundle contains

```
PrintFarmManager/
├── Print Farm Manager.exe        # launcher (a Node SEA executable)
├── Start Print Farm Manager.bat  # fallback launcher (plain, no SEA)
├── README.txt                    # operator instructions
├── node/
│   └── node.exe                  # pinned portable Node.js runtime (win-x64)
└── app/
    ├── server/                   # server source (no tests, no seed script)
    ├── client/dist/              # pre-built React client
    ├── node_modules/             # production deps, patched, native binary prebuilt
    └── package.json
```

The launcher starts `node/node.exe app/server/index.js` and, after a short
delay, opens the default browser to `http://localhost:3000`. `server/index.js`
already serves the built client from the same process, so the whole app is one
Node process on one port.

### Runtime data lives inside the bundle

The server creates and writes:

- `app/server/data/farm.db` — the SQLite database (WAL mode)
- `app/server/gcode/` — uploaded G-code files
- `app/server/data/backups/` — automatic farm backups

These paths are `__dirname`-relative in `server/db.js` and are **not** part of
the shipped bundle — they appear on first run. **To update an installed bundle,
replace everything except `app/server/data` and `app/server/gcode`** (or copy
those two folders into the new bundle). See the update note in `README.txt`.

## Building the bundle

```bash
npm run build:portable
```

Output: `dist/portable/PrintFarmManager/` (and the folder is what you zip and
ship). Re-runnable; it cleans the output folder each time.

### Build requirements

- **Windows x64** — the script downloads the Windows Node runtime and builds a
  Windows `.exe`.
- **Node.js 22.x** on the build machine. This is enforced: the bundled runtime
  is pinned to the build machine's exact Node version (`process.version`) so the
  native `better-sqlite3` binary — resolved by `npm ci` against that same
  version — is ABI-compatible with it. Building on Node 24+ or a non-22 line is
  rejected with a clear error.
- **Internet access** at build time, to download the Node runtime zip (cached
  under `dist/.cache/` for subsequent builds).
- **No C++ compiler required.** `better-sqlite3` (>= 12) ships a prebuilt
  Node 22 win-x64 binary, so the staging install fetches it rather than
  compiling. (This is why the dependency was bumped from 9.x — 9.x had no
  Node 22 Windows prebuild and forced a source build.)

### What the build script does (`scripts/build-portable.js`)

1. **Guards** that the build host is Node 22.x.
2. **Downloads** the matching `node-vX.Y.Z-win-x64.zip` from nodejs.org (cached)
   and extracts `node.exe` into `node/`.
3. **Builds the client** (`npm run build` → `client/dist`).
4. **Staging install** — a clean `npm ci --omit=dev` in a throwaway dir with the
   repo's `package.json`, `package-lock.json`, and `patches/`, so the bundled
   `node_modules` is production-only, has the `sdcp` patch applied, and carries
   the prebuilt native binary. This does not disturb the repo's own
   `node_modules`.
5. **Assembles `app/`** — copies `server/` (excluding `data/`, `gcode/`,
   `tests/`, and `seed-demo.js`), `client/dist`, the staged `node_modules`, and
   `package.json`.
6. **Builds the launcher exe** — generates a Node Single Executable Application
   (SEA) blob from `scripts/launcher.js` via `sea-config.json`, copies the
   portable `node.exe` to `Print Farm Manager.exe`, and injects the blob with
   `postject`.
7. **Writes** `Start Print Farm Manager.bat`, `README.txt`, and copies the Node
   `LICENSE` alongside the runtime.

### The launcher (`scripts/launcher.js`)

A tiny script embedded in the exe via SEA. It only uses Node built-ins, so it
needs nothing on disk except the bundle. It:

- resolves the bundle root from `process.execPath` (the exe's own location),
- spawns `node/node.exe app/server/index.js` with `stdio: 'inherit'` (the
  console window shows server logs; closing it stops the server),
- opens the default browser to the app URL after ~2.5 s,
- exits with the server's exit code.

A SEA executable always runs its embedded script and cannot be used as a plain
`node`, which is exactly why the separate `node/node.exe` is shipped to actually
run the server.

## Known limitations (v1)

- **Foreground console window.** The app runs in a visible console; closing it
  stops the farm manager. A tray-icon / background-service variant is a possible
  follow-up.
- **No code signing.** Injecting the SEA blob invalidates Node's Authenticode
  signature, so SmartScreen may warn on first run ("More info → Run anyway").
  Signing would require a code-signing certificate.
- **No auto-start on boot.** Use Task Scheduler or the PM2 approach in
  `docs/installation.md` if the farm box should launch it at login.
- **Windows x64 only.** The build targets the Windows Node runtime.

## Related docs

- `docs/installation.md` — the from-source setup (Node + build tools) this
  bundle replaces for operators.
- `docs/docker-publish.md` — the container distribution target.
- `docs/server.md` — how `server/index.js` serves the client and starts the
  poller/scheduler.
