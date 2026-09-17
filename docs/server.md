# Server

## Purpose

`server/index.js` is the Express entry point. It wires together the database, all route handlers, and the polling loop into a single process that starts with `npm run server`.

## Key Files

| File | Responsibility |
|---|---|
| `server/index.js` | App setup, route mounting, server start, poller + scheduler init |
| `server/auth.js` | Password hashing, session tokens, cookie helpers, `requireAuth` middleware |
| `server/db.js` | SQLite connection, schema creation, directory setup |
| `server/poller.js` | Printer status polling loop |
| `server/scheduler.js` | Job dispatch engine — listens to poller events, dispatches prints |
| `server/calendar-gate.js` | Shared `activeDispatchBlock(db)` used by scheduler and dispatch-status |
| `server/ebay/` | eBay Sell APIs (orders, inventory push, analytics); see [docs/erp/ebay.md](erp/ebay.md) |
| `server/notifications.js` | In-memory alert store for recoverable server errors |
| `server/routes/` | One file per resource (printers, projects, parts, gcodes, jobs, calendar, backup) |
| `server/data/farm.db` | SQLite database file (auto-created, gitignored) |
| `server/gcode/` | G-code file storage directory (auto-created, gitignored) |

## Startup Sequence

1. `db.js` is `require()`d — this synchronously creates `server/data/` and `server/gcode/` if missing, opens the SQLite database, and runs all `CREATE TABLE IF NOT EXISTS` statements.
2. All route modules are instantiated with the `db` instance injected.
3. Express app is configured with `express.json()` and route mounting.
4. `app.listen()` binds to the port.
5. Inside the listen callback, `PrinterPoller` and `JobScheduler` are instantiated. `scheduler.start()` is called first (subscribes to poller events), then `poller.start()` fires the first poll tick and starts the 15-second interval. Hourly DB file backup, timelapse retention, and the eBay sync runner (`server/ebay/runner.js`) also start here.
6. The startup sweep (`sweepIdlePrinters`) is deferred until the poller emits `pollComplete` after its first tick. This ensures dispatch works from live printer state rather than stale DB values from before the last shutdown — preventing accidental dispatch to a printer that started printing while the server was down.

## Configuration

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3000` | Express listening port — override with `process.env.PORT` |
| `EBAY_CLIENT_ID` / `EBAY_CLIENT_SECRET` / `EBAY_REFRESH_TOKEN` | unset | Optional eBay credentials (override DB); see [docs/erp/ebay.md](erp/ebay.md) |

No `.env` file is required for core shopfloor. eBay can use env vars or the ERP UI.

## Login Gate

Right after `express.json()` and before any router is mounted, `server/index.js` registers an inline middleware that 401s any `/api/*` request without a valid `coma_session` cookie, except `/api/auth/*` (which is what issues the cookie) and `/api/health`. Because Express checks middleware in registration order for every request regardless of when a later route was added during startup, this single middleware also covers `/api/projects`, `/api/parts`, and `/api/gcodes`, which are mounted later inside the `app.listen()` callback once the scheduler exists (see below). See [docs/api.md](api.md#authentication) for the auth endpoints themselves.

## Route Mounting

```
GET    /api/health                  → health check (inline handler; not gated by auth)
*      /api/auth                    → server/routes/auth.js (not gated by auth: this is what issues the session)
POST   /api/scheduler/dispatch      → scheduler.sweepIdlePrinters() (inline handler)
GET    /api/notifications           → notifications.list() (inline handler)
DELETE /api/notifications/:id       → notifications.dismiss() (inline handler)
*      /api/printers                → server/routes/printers.js
*      /api/projects                → server/routes/projects.js (mounted after scheduler exists, see below)
*      /api/parts                   → server/routes/parts.js (mounted after scheduler exists, see below)
*      /api/gcodes                  → server/routes/gcodes.js (mounted after scheduler exists, see below)
*      /api/jobs                    → server/routes/jobs.js
*      /api/calendar                → server/routes/calendar.js
*      /api/backup                  → server/routes/backup.js
*      /api/erp/ebay                → server/ebay (before /api/erp)
*      /api/erp                     → server/erp
```
All route modules export a factory function `(db) => router`. This passes the shared synchronous `better-sqlite3` instance into each router without any global state.

Production closures: when `calendar_events` has a planned row with `blocks_dispatch = 1` whose window contains now, `_reserveJob` and `sweepIdlePrinters` skip new reservations (see [docs/calendar.md](calendar.md)). The same check appears on `GET /api/parts/:id/dispatch-status`.

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
- `gcodes.js` on `POST /upload`: a part only becomes a dispatch candidate once it has a matching G-code, so the sweep from reactivating the project alone isn't enough; the upload itself needs to trigger one too

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

Each route file that needs this pattern also declares its `express.Router()` at module scope, outside the exported factory (harmless in production, since each module is `require()`d exactly once for the server's lifetime) but worth knowing if a test ever needs two independent instances of the same router with different `scheduler` mocks in one process: Node's `require()` cache means a second call to the factory reuses the same router, and only the first-registered handler for a given path actually runs. Use `jest.resetModules()` before each `require(...)` to force a fresh instance (see `server/tests/parts-reactivate-sweep.test.js`, `server/tests/gcodes-upload-sweep.test.js`).

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
