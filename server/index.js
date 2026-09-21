// Catch unhandled errors before anything else so they're always logged,
// even if Node exits before stdout is flushed (common on Windows).
process.on('uncaughtException', (err) => {
  process.stderr.write(`[FATAL] uncaughtException: ${err.stack || err}\n`);
  process.exit(1);
});
process.on('unhandledRejection', (reason) => {
  process.stderr.write(`[FATAL] unhandledRejection: ${reason?.stack || reason}\n`);
  process.exit(1);
});

const express = require('express');
const path    = require('path');
const fs      = require('fs');

const db             = require('./db');
const PrinterPoller  = require('./poller');
const JobScheduler   = require('./scheduler');
const notifications  = require('./notifications');
const events         = require('./events');
const backup         = require('./backup');
const auth           = require('./auth');

const authRouter         = require('./routes/auth')(db);
const usersRouter        = require('./routes/users')(db);
const apiKeysRouter      = require('./routes/api-keys')(db);
const printersRouter     = require('./routes/printers')(db);
const jobsRouter         = require('./routes/jobs')(db);
const backupRouter       = require('./routes/backup')(db);
const dashboardRouter    = require('./routes/dashboard')(db);
const settingsRouter     = require('./routes/settings')(db);
const modelsRouter       = require('./routes/models')(db);
const groupsRouter       = require('./routes/groups')(db);
const filamentsRouter    = require('./routes/filaments')(db);
const printerJobsRouter  = require('./routes/printer-jobs')(db);

const app  = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

// Health check: always public, used by uptime checks that never authenticate.
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: Date.now() });
});

// Auth routes: mounted ahead of the global auth gate below because most of
// them (status, bootstrap, login, OIDC start/callback) are exactly what an
// unauthenticated visitor must be able to reach. GET /api/auth/me is the one
// route in this router that does require auth; it applies requireAuth
// directly on itself (see routes/auth.js) rather than depending on the
// global gate below, since that gate is registered after this router and
// would never run for a request this router already finished handling.
app.use('/api/auth', authRouter);

// Global auth gate: every other /api/* route requires a valid session
// cookie or API key. Static asset serving and the SPA catch-all below stay
// unauthenticated at the Express layer; the client redirects to /login itself
// when GET /api/auth/me comes back 401, and every route that actually reads
// or writes farm data lives behind this gate regardless.
app.use('/api', auth.requireAuth(db));

// API routes
app.use('/api/users',           auth.requireRole('admin'), usersRouter);
app.use('/api/api-keys',        apiKeysRouter);
app.use('/api/printers',        printersRouter);
app.use('/api/printers/:id/jobs', printerJobsRouter);
app.use('/api/jobs',            jobsRouter);
app.use('/api/backup',          backupRouter);
app.use('/api/dashboard',       dashboardRouter);
app.use('/api/settings',        settingsRouter);
app.use('/api/models',          modelsRouter);
app.use('/api/groups',          groupsRouter);
app.use('/api/filaments',       filamentsRouter);

// Server notifications — surfaced in the Settings UI
app.get('/api/notifications', (_req, res) => res.json(notifications.list()));
app.delete('/api/notifications/:id', (req, res) => {
  const ok = notifications.dismiss(parseInt(req.params.id, 10));
  if (!ok) return res.status(404).json({ error: 'Notification not found' });
  res.json({ ok: true });
});

// Serve built React client (production mode)
const clientDist = path.join(__dirname, '../client/dist');
if (!fs.existsSync(path.join(clientDist, 'index.html'))) {
  console.error('');
  console.error('  ERROR: client/dist/index.html not found.');
  console.error('  The React client has not been built yet.');
  console.error('');
  console.error('  Run this once before starting the server:');
  console.error('    npm run build');
  console.error('');
  console.error('  (See docs/installation.md for the full setup steps.)');
  console.error('');
  process.exit(1);
}
app.use(express.static(clientDist));
// SPA catch-all — non-API routes serve index.html
app.get(/^(?!\/api).*/, (_req, res) => {
  res.sendFile(path.join(clientDist, 'index.html'));
});

// Start server
const server = app.listen(PORT, () => {
  console.log(`[server] Express running on http://localhost:${PORT}`);

  const poller    = new PrinterPoller(db);
  const scheduler = new JobScheduler(db, poller);

  // Mount projects, parts, and gcodes routers here so they have access to the
  // scheduler: projects for complete/reactivate, parts for the sweep after adding a
  // part (or raising target_qty) reactivates a completed project, gcodes for the sweep
  // after an upload gives a part its first matching G-code.
  app.use('/api/projects', require('./routes/projects')(db, scheduler));
  app.use('/api/parts',    require('./routes/parts')(db, scheduler));
  app.use('/api/gcodes',   require('./routes/gcodes')(db, scheduler));

  scheduler.start();
  poller.start();
  backup.start(db);

  // Wait for the first poll to complete before sweeping — ensures DB status reflects
  // live printer state rather than whatever was last persisted before shutdown.
  // This prevents dispatching to a printer that started printing while the server was down.
  poller.once('pollComplete', () => {
    console.log('[server] Initial poll complete — sweeping for idle printers');
    scheduler.sweepIdlePrinters();
  });

  // Dispatch trigger — called by the UI when a project is activated
  app.post('/api/scheduler/dispatch', (req, res) => {
    scheduler.sweepIdlePrinters();
    res.json({ ok: true });
  });

  // Bulk set-ready — releases hold for multiple printers and dispatches through the
  // batched sweep, which keeps pulling from the ready queue until dispatch_batch_size
  // printers actually have a job reserved (or the queue runs out), not a fixed chunk
  // of dispatch_batch_size printers evaluated at a time (see _sweepInBatches).
  // Used by the "Set Ready (N)" action in the Fleet UI.
  app.post('/api/printers/set-ready-batch', (req, res) => {
    const { ids } = req.body;
    if (!Array.isArray(ids) || ids.length === 0) {
      return res.status(400).json({ error: 'ids array required' });
    }
    const placeholders = ids.map(() => '?').join(',');
    db.prepare(`UPDATE printers SET is_held = 0 WHERE id IN (${placeholders})`).run(...ids);
    const printers = db.prepare(`SELECT * FROM printers WHERE id IN (${placeholders}) AND is_active = 1`).all(...ids);
    const batchSetting = db.prepare("SELECT value FROM settings WHERE key = 'dispatch_batch_size'").get();
    const batchSize = batchSetting ? parseInt(batchSetting.value, 10) : 10;
    console.log(`[server] Batch set-ready: ${printers.length} printer(s), target concurrency ${batchSize}`);
    scheduler._sweepInBatches(printers).catch(err =>
      console.error('[scheduler] Batch set-ready sweep error:', err)
    );
    res.json({ ok: true, count: printers.length });
  });

  // Recommission a printer — returns it to the active fleet and immediately dispatches
  // a job if one is available. Operator has completed investigation; no hold needed.
  app.post('/api/printers/:id/recommission', (req, res) => {
    const printer = db.prepare('SELECT * FROM printers WHERE id = ?').get(req.params.id);
    if (!printer) return res.status(404).json({ error: 'Printer not found' });
    db.prepare(`
      UPDATE printers
      SET is_active = 1, is_held = 0, decommissioned_at = NULL, decommission_note = NULL
      WHERE id = ?
    `).run(printer.id);
    events.insert(printer.id, 'recommission', req.body?.note ?? null);
    const updated = db.prepare('SELECT * FROM printers WHERE id = ?').get(printer.id);
    console.log(`[server] ${printer.name} recommissioned — dispatching...`);
    scheduler.scheduleForPrinter(updated);
    res.json(updated);
  });

  // Set a held printer ready — releases hold and dispatches next job to it.
  //
  // Two cases:
  //
  // Normal finish: _handleFinished already ran when FINISHED was seen — the job is
  // 'finished' and completed_qty has already been credited. confirmed_qty here is an
  // operator adjustment (e.g. 24 good out of 25) applied as a delta to what was credited.
  //
  // Missed finish: server was down when the print completed. The job is still 'printing'.
  // Operator clicking Set Ready is the explicit success confirmation. We credit qty now
  // (using confirmed_qty if provided, otherwise the full parts_per_plate) and mark the
  // job finished. No assumptions are made without operator input.
  app.post('/api/printers/:id/set-ready', (req, res) => {
    const printer = db.prepare('SELECT * FROM printers WHERE id = ?').get(req.params.id);
    if (!printer) return res.status(404).json({ error: 'Printer not found' });

    const { confirmed_qty } = req.body || {};
    const now = Date.now();

    // Check for an uploading or printing job FIRST — they take priority over a stale
    // 'finished' job from a previous print cycle. Without this check, a printer that has
    // both a previous 'finished' job and a current 'uploading'/'printing' job would take
    // the normal-confirmation path, skip the active job, then have _dispatchToPrinter find
    // the stale active job, auto-fail it, and re-hold the printer.
    //
    // The uploading case was caught earlier; the printing case hits when a printer goes
    // OFFLINE mid-job (leaving it 'printing'), comes back online, and the operator clicks
    // Set Ready. The old finished job was from a prior cycle — the printing job is the one
    // that needs to be credited now.
    const uploadingJobEarly = db.prepare(
      "SELECT * FROM jobs WHERE printer_id = ? AND status = 'uploading' ORDER BY created_at DESC LIMIT 1"
    ).get(printer.id);

    const printingJobEarly = !uploadingJobEarly && db.prepare(
      "SELECT id FROM jobs WHERE printer_id = ? AND status = 'printing' ORDER BY started_at DESC LIMIT 1"
    ).get(printer.id);

    let finishedJob = (uploadingJobEarly || printingJobEarly) ? null : db.prepare(`
      SELECT * FROM jobs WHERE printer_id = ? AND status = 'finished'
      ORDER BY finished_at DESC LIMIT 1
    `).get(printer.id);

    // A cancelled job newer than the last finished one means the printer was stopped
    // (STOPPED status) after its last normal finish. The stopped job is the one the
    // operator is confirming — fall through to the missed-finish path below, which
    // resolves it via the cancelled lookup. Without this, confirmed_qty would be
    // misapplied as a delta against the older finished job's part.
    if (finishedJob) {
      const newerCancelled = db.prepare(`
        SELECT 1 FROM jobs WHERE printer_id = ? AND status = 'cancelled' AND finished_at > ? LIMIT 1
      `).get(printer.id, finishedJob.finished_at);
      if (newerCancelled) finishedJob = null;
    }

    if (finishedJob) {
      // Normal case: apply confirmed_qty delta if the operator adjusted the count.
      if (confirmed_qty != null) {
        const confirmedQty = parseInt(confirmed_qty, 10);
        if (!isNaN(confirmedQty) && confirmedQty !== finishedJob.parts_per_plate) {
          const delta = confirmedQty - finishedJob.parts_per_plate; // negative = fewer good parts
          db.prepare(`
            UPDATE parts SET completed_qty = MAX(0, completed_qty + ?), updated_at = ? WHERE id = ?
          `).run(delta, now, finishedJob.part_id);

          const part = db.prepare('SELECT * FROM parts WHERE id = ?').get(finishedJob.part_id);
          if (part.completed_qty < part.target_qty && part.status === 'closed') {
            db.prepare(`UPDATE parts SET status = 'open', updated_at = ? WHERE id = ?`).run(now, part.id);
            console.log(`[server] Part "${part.name}" reopened — confirmed qty reduced`);
          } else if (part.completed_qty >= part.target_qty && part.status === 'open') {
            db.prepare(`UPDATE parts SET status = 'closed', updated_at = ? WHERE id = ?`).run(now, part.id);
          }
          console.log(`[server] ${printer.name} confirmed ${confirmedQty}/${finishedJob.parts_per_plate} good (delta ${delta > 0 ? '+' : ''}${delta})`);
        }
      }
    } else {
      // Missed-finish case: job never got resolved because the server was down.
      // The operator clicking Set Ready is the success confirmation — credit qty now.
      const printingJob = db.prepare(`
        SELECT * FROM jobs WHERE printer_id = ? AND status = 'printing'
        ORDER BY started_at DESC LIMIT 1
      `).get(printer.id);

      // Also check for a job marked failed during this session — handles Bambu MQTT
      // reconnect during a print, where _handlePrinterUnavailable marked the job
      // 'failed' but the printer kept printing and finished. _handleFinished should
      // have recovered it already, but cover the race where the operator hits Set
      // Ready before the next poll cycle.
      //
      // Gated on finished_at > scheduler.startedAt — the job must have been marked
      // failed in the current server process. A stale failed job from a previous
      // session must not be credited just because the operator clicked Set Ready.
      //
      // Also check for a cancelled job (operator stopped on printer screen). No
      // startedAt gate — a cancelled job that survived a server restart is still
      // the right job to credit when the operator confirms it was good.
      const activeJob = printingJob
        || db.prepare(`
            SELECT * FROM jobs WHERE printer_id = ? AND status = 'failed' AND finished_at > ?
            ORDER BY finished_at DESC LIMIT 1
          `).get(printer.id, scheduler.startedAt)
        || db.prepare(`
            SELECT * FROM jobs WHERE printer_id = ? AND status = 'cancelled'
            ORDER BY finished_at DESC LIMIT 1
          `).get(printer.id);

      if (activeJob) {
        // OFFLINE-with-job: operator is saying "job is still running, resume" — do not
        // credit qty or mark the job finished. The job stays as 'printing' and will
        // resolve normally when the printer finishes and _handleFinished fires.
        if (printer.status === 'OFFLINE' && activeJob.status === 'printing') {
          console.log(`[server] ${printer.name} set ready from OFFLINE — job ${activeJob.id} still printing, no qty credited`);
        } else {
        const creditQty = (confirmed_qty != null && !isNaN(parseInt(confirmed_qty, 10)))
          ? parseInt(confirmed_qty, 10)
          : activeJob.parts_per_plate;

        db.prepare(`UPDATE jobs SET status = 'finished', finished_at = ? WHERE id = ?`)
          .run(now, activeJob.id);

        db.prepare(`
          UPDATE parts SET completed_qty = completed_qty + ?, updated_at = ? WHERE id = ?
        `).run(creditQty, now, activeJob.part_id);

        const part = db.prepare('SELECT * FROM parts WHERE id = ?').get(activeJob.part_id);
        const label = printingJob ? 'missed-finish' : activeJob.status === 'cancelled' ? 'cancelled-confirmed-good' : 'MQTT-recovered finish';
        console.log(`[server] ${printer.name} ${label} confirmed good — Part "${part.name}" ${part.completed_qty}/${part.target_qty}`);

        if (part.completed_qty >= part.target_qty) {
          db.prepare(`UPDATE parts SET status = 'closed', updated_at = ? WHERE id = ?`).run(now, part.id);
          db.prepare(`UPDATE jobs SET status = 'cancelled' WHERE part_id = ? AND status = 'queued'`).run(part.id);
          console.log(`[server] Part "${part.name}" closed (${part.completed_qty}/${part.target_qty})`);

          const openCount = db.prepare(`
            SELECT COUNT(*) AS count FROM parts WHERE project_id = ? AND status = 'open'
          `).get(part.project_id).count;
          if (openCount === 0) {
            db.prepare(`UPDATE projects SET status = 'completed', updated_at = ? WHERE id = ?`).run(now, part.project_id);
            console.log(`[server] Project ${part.project_id} completed!`);
          }
        }
        } // end else (not OFFLINE-with-job)
      } else {
        // Upload-stalled case: no finished/printing/recently-failed job, but there may
        // be a stalled 'uploading' job whose upload failed after exhausting retries.
        // uploadingJobEarly was already fetched above (and is non-null when finishedJob is null).
        const uploadingJob = uploadingJobEarly;
        if (uploadingJob) {
          if (printer.status === 'FINISHED' || printer.status === 'IDLE') {
            // Printer already reports done — credit qty directly. Transitioning to
            // 'printing' here would trigger the stale-job auto-fail in _dispatchToPrinter
            // (printing job + non-PRINTING printer → auto-failed, hold re-set), requiring
            // a second operator confirmation. Skip that loop and resolve in one click.
            const creditQty = (confirmed_qty != null && !isNaN(parseInt(confirmed_qty, 10)))
              ? parseInt(confirmed_qty, 10)
              : uploadingJob.parts_per_plate;
            db.prepare("UPDATE jobs SET status = 'finished', finished_at = ?, started_at = COALESCE(started_at, ?) WHERE id = ?")
              .run(now, now, uploadingJob.id);
            db.prepare("UPDATE parts SET completed_qty = completed_qty + ?, updated_at = ? WHERE id = ?")
              .run(creditQty, now, uploadingJob.part_id);
            const part = db.prepare('SELECT * FROM parts WHERE id = ?').get(uploadingJob.part_id);
            console.log(`[server] ${printer.name} upload-stalled job ${uploadingJob.id} confirmed finished — Part "${part.name}" ${part.completed_qty}/${part.target_qty}`);
            if (part.completed_qty >= part.target_qty) {
              db.prepare(`UPDATE parts SET status = 'closed', updated_at = ? WHERE id = ?`).run(now, part.id);
              db.prepare(`UPDATE jobs SET status = 'cancelled' WHERE part_id = ? AND status = 'queued'`).run(part.id);
              console.log(`[server] Part "${part.name}" closed (${part.completed_qty}/${part.target_qty})`);
              const openCount = db.prepare(
                `SELECT COUNT(*) AS count FROM parts WHERE project_id = ? AND status = 'open'`
              ).get(part.project_id).count;
              if (openCount === 0) {
                db.prepare(`UPDATE projects SET status = 'completed', updated_at = ? WHERE id = ?`).run(now, part.project_id);
                console.log(`[server] Project ${part.project_id} completed!`);
              }
            }
          } else {
            // Printer is still mid-print — transition to 'printing' so _handleFinished
            // picks it up normally when the print completes.
            db.prepare("UPDATE jobs SET status = 'printing', started_at = ? WHERE id = ?")
              .run(now, uploadingJob.id);
            console.log(`[server] ${printer.name} upload-stalled job ${uploadingJob.id} confirmed running by operator — changed to printing`);
          }
        }
      }
    }

    db.prepare('UPDATE printers SET is_held = 0 WHERE id = ?').run(printer.id);
    const updated = db.prepare('SELECT * FROM printers WHERE id = ?').get(printer.id);
    console.log(`[server] ${printer.name} set ready by operator — dispatching...`);
    scheduler.scheduleForPrinter(updated);
    res.json(updated);
  });

  // Catalog a print the farm never dispatched: the operator sliced and sent it straight
  // to the printer (e.g. from OrcaSlicer) instead of going through a Project/Part upload.
  // Only reachable while GET /api/printers reports needs_catalog: true for this printer
  // (see the NEEDS_CATALOG_SQL comment in routes/printers.js for exactly what that means
  // and why it can't collide with the normal awaiting-sign-off flow), and re-checked here
  // server-side as the mutex against a double-submit race, the same role the synchronous
  // job INSERT plays in the scheduler's own dispatch path.
  //
  // completed_qty analysis (see CLAUDE.md "Part counts are sacred"): the real-world event
  // backing a credit here is the operator's own one-time submission of this form for a
  // printer currently showing FINISHED with no job of any kind attached to it. It cannot
  // double-fire because inserting the job row immediately makes needs_catalog false for
  // every subsequent check (a job now exists), and the FINISHED branch below is the only
  // place in this handler that touches completed_qty. The PRINTING branch touches nothing:
  // the job is created as 'printing' and credited later exactly once, through the existing,
  // unmodified _handleFinished path when the poller sees the real FINISHED transition,
  // the same mechanism every normally-dispatched job already goes through.
  app.post('/api/printers/:id/catalog-print', (req, res) => {
    const printer = db.prepare('SELECT * FROM printers WHERE id = ?').get(req.params.id);
    if (!printer) return res.status(404).json({ error: 'Printer not found' });

    const { part_id, parts_per_plate, note } = req.body || {};
    const qty = parseInt(parts_per_plate, 10);
    if (!part_id || !qty || qty < 1) {
      return res.status(400).json({ error: 'part_id and a positive parts_per_plate are required' });
    }

    const part = db.prepare('SELECT * FROM parts WHERE id = ?').get(part_id);
    if (!part) return res.status(404).json({ error: 'Part not found' });

    if (!['PRINTING', 'FINISHED'].includes(printer.status)) {
      return res.status(409).json({ error: `Printer is ${printer.status}, not PRINTING or FINISHED: nothing to catalog` });
    }
    const hasUnownedActivity = !db.prepare(`
      SELECT 1 FROM jobs WHERE printer_id = ? AND status IN ('uploading', 'printing')
    `).get(printer.id) && !db.prepare(`
      SELECT 1 FROM jobs j WHERE j.printer_id = ? AND j.status = 'finished'
        AND NOT EXISTS (SELECT 1 FROM jobs j2 WHERE j2.printer_id = j.printer_id AND j2.id != j.id AND j2.created_at > j.finished_at)
    `).get(printer.id);
    if (!hasUnownedActivity) {
      return res.status(409).json({ error: 'This printer already has a tracked job: nothing to catalog' });
    }

    const now = Date.now();

    // Reuse the Part's existing gcode for this printer's model if one is already
    // registered (the common case: the operator just chose to slice and send this one
    // print manually instead of going through the farm's own dispatch). Otherwise record a
    // placeholder: there is no file to point at since the farm never received one.
    let gcode = db.prepare(
      'SELECT * FROM gcodes WHERE part_id = ? AND printer_model = ?'
    ).get(part.id, printer.model);
    if (!gcode) {
      const result = db.prepare(`
        INSERT INTO gcodes (part_id, printer_model, filename, filepath, parts_per_plate, created_at)
        VALUES (?, ?, ?, '', ?, ?)
      `).run(part.id, printer.model, `External upload via ${printer.name}`, qty, now);
      gcode = db.prepare('SELECT * FROM gcodes WHERE id = ?').get(result.lastInsertRowid);
    }

    const wasFinished = printer.status === 'FINISHED';
    const jobResult = db.prepare(`
      INSERT INTO jobs (part_id, printer_id, gcode_id, parts_per_plate, status, started_at, finished_at, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(part.id, printer.id, gcode.id, qty, wasFinished ? 'finished' : 'printing', now, wasFinished ? now : null, now);

    events.insert(printer.id, 'note',
      `Catalogued externally-started print: part "${part.name}", ${qty}/plate${note ? `, ${note}` : ''}`);

    if (wasFinished) {
      db.prepare(`UPDATE parts SET completed_qty = completed_qty + ?, updated_at = ? WHERE id = ?`).run(qty, now, part.id);
      const updatedPart = db.prepare('SELECT * FROM parts WHERE id = ?').get(part.id);
      console.log(`[server] ${printer.name} catalogued job ${jobResult.lastInsertRowid}: Part "${updatedPart.name}" ${updatedPart.completed_qty}/${updatedPart.target_qty}`);
      if (updatedPart.completed_qty >= updatedPart.target_qty && updatedPart.status === 'open') {
        db.prepare(`UPDATE parts SET status = 'closed', updated_at = ? WHERE id = ?`).run(now, updatedPart.id);
        db.prepare(`UPDATE jobs SET status = 'cancelled' WHERE part_id = ? AND status = 'queued'`).run(updatedPart.id);
        console.log(`[server] Part "${updatedPart.name}" closed (${updatedPart.completed_qty}/${updatedPart.target_qty})`);
        const openCount = db.prepare(
          `SELECT COUNT(*) AS count FROM parts WHERE project_id = ? AND status = 'open'`
        ).get(updatedPart.project_id).count;
        if (openCount === 0) {
          db.prepare(`UPDATE projects SET status = 'completed', updated_at = ? WHERE id = ?`).run(now, updatedPart.project_id);
          console.log(`[server] Project ${updatedPart.project_id} completed!`);
        }
      }
      db.prepare('UPDATE printers SET is_held = 0 WHERE id = ?').run(printer.id);
      const updated = db.prepare('SELECT * FROM printers WHERE id = ?').get(printer.id);
      scheduler.scheduleForPrinter(updated);
      return res.json(updated);
    }

    console.log(`[server] ${printer.name} catalogued job ${jobResult.lastInsertRowid} (still printing): Part "${part.name}"`);
    res.json(db.prepare('SELECT * FROM printers WHERE id = ?').get(printer.id));
  });
});

module.exports = { app, server };
