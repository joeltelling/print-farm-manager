# Server

## Purpose

`server/index.js` is the Express entry point. It wires together the database, all route handlers, and the polling loop into a single process that starts with `npm run server`.

## Key Files

| File | Responsibility |
|---|---|
| `server/index.js` | App setup, route mounting, server start, poller + scheduler init |
| `server/default-request-body.js` | Tiny middleware mounted right after `express.json()` that makes `req.body` an object when a request has no JSON body, so route handlers that destructure it still answer their documented 400 instead of throwing (Express 5 leaves `req.body` undefined; Express 4 left `{}`). Tested in `server/tests/default-request-body.test.js` |
| `server/paths.js` | Resolves the data, G-code, backup and client build locations from `PFM_DATA_DIR`, `PFM_GCODE_DIR` and `PFM_CLIENT_DIST` (defaults unchanged). Every module that touches those locations goes through it. Under Jest it refuses the real directories, so a test can never write to an operator's live data |
| `server/security-headers.js` | Helmet/CSP + `Permissions-Policy` setup, as an `(app) => void` factory so it can be mounted on a bare `express()` app in tests without booting the whole server |
| `server/db.js` | SQLite connection, schema creation, directory setup |
| `server/poller.js` | Printer status polling loop |
| `server/scheduler.js` | Job dispatch engine — listens to poller events, dispatches prints |
| `server/notifications.js` | In-memory alert store for recoverable server errors |
| `server/gcode-decode.js` | Normalizes `.bgcode`/`.3mf` to plain-text G-code, extracts bgcode metadata blocks, and parses slicer filament-usage stats (used by `GET /api/gcodes/:id/preview`) |
| `server/routes/` | One file per resource (printers, projects, parts, gcodes, jobs, backup) |
| `server/data/farm.db` | SQLite database file (auto-created, gitignored; default location, see `PFM_DATA_DIR`) |
| `server/gcode/` | G-code file storage directory (auto-created, gitignored; default location, see `PFM_GCODE_DIR`) |

## Startup Sequence

1. `db.js` is `require()`d — this synchronously creates `server/data/` and `server/gcode/` if missing, opens the SQLite database, and runs all `CREATE TABLE IF NOT EXISTS` statements.
2. All route modules are instantiated with the `db` instance injected.
3. Express app is configured with `applySecurityHeaders(app)` (`server/security-headers.js`: CSP, no `X-Powered-By`, etc.; see `docs/CHANGELOG.md` 2026-07-04 and its follow-up), `express.json()`, `defaultRequestBody` (keeps `req.body` an object when there is no JSON body), and route mounting.
4. `app.listen()` binds to the port.
5. Inside the listen callback, `PrinterPoller` and `JobScheduler` are instantiated. `scheduler.start()` is called first (subscribes to poller events), then `poller.start()` fires the first poll tick and starts the 15-second interval.
6. The startup sweep (`sweepIdlePrinters`) is deferred until the poller emits `pollComplete` after its first tick. This ensures dispatch works from live printer state rather than stale DB values from before the last shutdown — preventing accidental dispatch to a printer that started printing while the server was down.

## Configuration

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3000` | Express listening port |
| `DEMO_MODE` | unset | `true` skips real printer polling (use with `server/seed-demo.js`, or any time you do not want the server to contact printers) |
| `PFM_DATA_DIR` | `server/data` | Where the database (`farm.db`), the hourly backups and restore uploads live |
| `PFM_GCODE_DIR` | `server/gcode` | Where uploaded G-code and 3mf files are stored |
| `PFM_CLIENT_DIST` | `client/dist` | The built React client the server serves |
| `DEBUG_BAMBU`, `DEBUG_ELEGOO` | unset | Verbose driver logging |

No `.env` file is required. The defaults are the paths the server has always used, so Docker volumes (`/app/server/data`, `/app/server/gcode`), PM2 and `update.bat` are unaffected. The three `PFM_*` variables are resolved once in `server/paths.js`; set them to keep your data somewhere else, or (as the test suite does) to point a server at a scratch directory.

## Tests

`npm run test:server` runs Jest with `jest.config.js`, which gives every test file a private scratch data and G-code directory (created under the OS temp folder and removed at the end). This matters because some modules open the real database or write to the real upload folder merely by being required (`server/events.js` is one), so without it `npm test` on a machine with real printers would attach fake events to them. `server/tests/test-isolation.test.js` guards this, and `server/paths.js` throws if a test would use the real directories.

`server/tests/server-smoke.test.js` starts the real `server/index.js` as a child process on a temporary database and a stub client build, then makes real HTTP requests: startup, the static and SPA-fallback handling, security headers, no-body requests answering 400, and the inline operator endpoints. Route tests mount each router on a throwaway app, so this is the only test that exercises `index.js` itself, which is what makes an Express or Node upgrade safe to check in CI.

## Route Mounting

```
GET    /api/health                  → health check (inline handler)
POST   /api/scheduler/dispatch      → scheduler.sweepIdlePrinters() (inline handler)
GET    /api/notifications           → notifications.list() (inline handler)
DELETE /api/notifications/:id       → notifications.dismiss() (inline handler)
*      /api/printers                → server/routes/printers.js
*      /api/projects                → server/routes/projects.js (mounted after scheduler exists — see below)
*      /api/parts                   → server/routes/parts.js (mounted after scheduler exists — see below)
*      /api/gcodes                  → server/routes/gcodes.js (mounted after scheduler exists — see below)
*      /api/jobs                    → server/routes/jobs.js
*      /api/backup                  → server/routes/backup.js
```

All route modules export a factory function `(db) => router`. This passes the shared synchronous `better-sqlite3` instance into each router without any global state.

## Route Factory Pattern

Most route files follow this pattern:

```js
module.exports = (db) => {
  const router = express.Router();
  // ... route definitions using db ...
  return router;
};
```

And are mounted in `index.js` at module load time, before `app.listen()`:

```js
const printersRouter = require('./routes/printers')(db);
app.use('/api/printers', printersRouter);
```

**`projects.js`, `parts.js`, and `gcodes.js` take an optional second `scheduler` argument** (`(db, scheduler = null) => router`), needed for `sweepIdlePrinters()`:
- `projects.js` on `POST /:id/reactivate`
- `parts.js` on `POST /` (adding a part) and `PUT /:id` (raising `target_qty` above `completed_qty`), whenever either reactivates a completed project
- `gcodes.js` on `POST /upload` — a part only becomes a dispatch candidate once it has a matching G-code, so the sweep from reactivating the project alone isn't enough; the upload itself needs to trigger one too

`scheduler` is only constructed inside the `app.listen()` callback (it depends on `poller`, which is also constructed there), so all three routers are mounted lazily inside that callback instead of at module load time:

```js
app.listen(PORT, () => {
  const poller    = new PrinterPoller(db);
  const scheduler = new JobScheduler(db, poller);
  app.use('/api/projects', require('./routes/projects')(db, scheduler));
  app.use('/api/parts',    require('./routes/parts')(db, scheduler));
  app.use('/api/gcodes',   require('./routes/gcodes')(db, scheduler));
  // ...
});
```

Tests pass `null` (or omit the argument) for `scheduler`, so router unit tests never need a live scheduler/poller.

Each route file that needs this pattern also declares its `express.Router()` at module scope, outside the exported factory — harmless in production (each module is `require()`d exactly once for the server's lifetime) but worth knowing if a test ever needs two independent instances of the same router with different `scheduler` mocks in one process: Node's `require()` cache means a second call to the factory reuses the same router, and only the first-registered handler for a given path actually runs. Use `jest.resetModules()` before each `require(...)` to force a fresh instance (see `server/tests/parts-reactivate-sweep.test.js`, `server/tests/gcodes-upload-sweep.test.js`).

## Dependencies

| Package | Version | Purpose |
|---|---|---|
| `express` | ^4.19.2 | HTTP server and routing |
| `helmet` | ^8.2.0 | Security response headers (CSP, no `X-Powered-By`, etc.) |
| `better-sqlite3` | ^9.6.0 | Synchronous SQLite driver |
| `multer` | ^2.1.1 | Multipart file upload handling (CSV import + G-code upload) |
| `papaparse` | ^5.4.1 | CSV parsing for printer import |
| `axios` | ^1.7.2 | HTTP client for PrusaLink API calls |
| `form-data` | ^4.0.0 | Multipart form construction for G-code uploads to PrusaLink |
| `concurrently` | ^8.2.2 | Runs server + client together via `npm run dev` |
