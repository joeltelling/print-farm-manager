# Server

## Purpose

`server/index.js` is the Express entry point. It wires together the database, all route handlers, and the polling loop into a single process that starts with `npm run server`.

## Key Files

| File | Responsibility |
|---|---|
| `server/index.js` | App setup, route mounting, server start, poller + scheduler init |
| `server/db.js` | SQLite connection, schema creation, directory setup |
| `server/poller.js` | Printer status polling loop |
| `server/scheduler.js` | Job dispatch engine — listens to poller events, dispatches prints |
| `server/notifications.js` | Operator alert store for recoverable server errors — DB-backed (persists across restart) via `init(db)`, with an in-memory fallback |
| `server/routes/` | One file per resource (printers, projects, parts, gcodes, jobs, backup) |
| `server/data/farm.db` | SQLite database file (auto-created, gitignored) |
| `server/gcode/` | G-code file storage directory (auto-created, gitignored) |

## Startup Sequence

1. `db.js` is `require()`d — this synchronously creates `server/data/` and `server/gcode/` if missing, opens the SQLite database, and runs all `CREATE TABLE IF NOT EXISTS` statements.
2. All route modules are instantiated with the `db` instance injected.
3. Express app is configured with `express.json()` and route mounting.
4. `app.listen()` binds to the port.
5. Inside the listen callback, `PrinterPoller` and `JobScheduler` are instantiated. `scheduler.start()` is called first (subscribes to poller events), then `poller.start()` fires the first poll tick and starts the 15-second interval.
6. The startup sweep (`sweepIdlePrinters`) is deferred until the poller emits `pollComplete` after its first tick. This ensures dispatch works from live printer state rather than stale DB values from before the last shutdown — preventing accidental dispatch to a printer that started printing while the server was down.

## Process Resilience & Shutdown

`index.js` installs process-level handlers so a single failure doesn't take the whole farm down and a restart is clean:

- **`unhandledRejection` → log and continue.** A rejected promise from a flaky printer request or driver hiccup is logged (`[WARN] unhandledRejection (continuing)`) and the process keeps running. (It used to `process.exit(1)`, which meant one rejection killed polling for all printers.)
- **`uncaughtException` → clean shutdown, then exit 1.** The process is in an unknown state, so it runs `shutdown()` and exits non-zero for PM2/Docker to restart.
- **`SIGINT` / `SIGTERM` → graceful shutdown.** `shutdown()` stops the poller, tears down every persistent printer connection (`drivers.closeAllConnections()`), closes the SQLite DB, and stops accepting new HTTP connections (`server.close()`), then exits 0. A 5-second failsafe forces exit if a connection lingers. This runs on every PM2 restart, `docker stop`, and console Ctrl+C.
- **Global Express error handler.** Registered last (after the inline routes), it returns a clean `{ error }` JSON response for any uncaught route throw instead of Express's default HTML 500.

`poller`, `scheduler`, and `server` are hoisted to module scope so `shutdown()` can reach them.

## Configuration

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3000` | Express listening port — override with `process.env.PORT` |

No `.env` file is required. The only runtime configuration is `PORT`.

## Route Mounting

```
GET    /api/health                  → deep health check: DB + poll liveness (inline handler)
POST   /api/scheduler/dispatch      → scheduler.sweepIdlePrinters() (inline handler)
GET    /api/notifications           → notifications.list() (inline handler)
DELETE /api/notifications/:id       → notifications.dismiss() (inline handler)
*      /api/printers                → server/routes/printers.js
*      /api/projects                → server/routes/projects.js
*      /api/parts                   → server/routes/parts.js
*      /api/gcodes                  → server/routes/gcodes.js
*      /api/jobs                    → server/routes/jobs.js
*      /api/backup                  → server/routes/backup.js
```

All route modules export a factory function `(db) => router`. This passes the shared synchronous `better-sqlite3` instance into each router without any global state.

## Route Factory Pattern

Every route file follows the same pattern:

```js
module.exports = (db) => {
  const router = express.Router();
  // ... route definitions using db ...
  return router;
};
```

And is mounted in `index.js` as:

```js
const printersRouter = require('./routes/printers')(db);
app.use('/api/printers', printersRouter);
```

## Dependencies

| Package | Version | Purpose |
|---|---|---|
| `express` | ^4.19.2 | HTTP server and routing |
| `better-sqlite3` | ^9.6.0 | Synchronous SQLite driver |
| `multer` | ^2.1.1 | Multipart file upload handling (CSV import + G-code upload) |
| `papaparse` | ^5.4.1 | CSV parsing for printer import |
| `axios` | ^1.7.2 | HTTP client for PrusaLink API calls |
| `form-data` | ^4.0.0 | Multipart form construction for G-code uploads to PrusaLink |
| `concurrently` | ^8.2.2 | Runs server + client together via `npm run dev` |
