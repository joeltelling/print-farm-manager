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
const helmet  = require('helmet');
const path    = require('path');
const fs      = require('fs');

const db             = require('./db');
const PrinterPoller  = require('./poller');
const JobScheduler   = require('./scheduler');
const notifications  = require('./notifications');
const events         = require('./events');
const backup         = require('./backup');

const printersRouter     = require('./routes/printers')(db);
const partsRouter        = require('./routes/parts')(db);
const gcodesRouter       = require('./routes/gcodes')(db);
const jobsRouter         = require('./routes/jobs')(db);
const backupRouter       = require('./routes/backup')(db);
const dashboardRouter    = require('./routes/dashboard')(db);
const settingsRouter     = require('./routes/settings')(db);
const modelsRouter       = require('./routes/models')(db);
const filamentsRouter    = require('./routes/filaments')(db);
const printerJobsRouter  = require('./routes/printer-jobs')(db);

const app  = express();
const PORT = process.env.PORT || 3000;

// Security headers. CSP is scoped to what the client actually needs:
// - style-src allows 'unsafe-inline' because every page in client/src uses React's
//   style={{...}} prop, which renders as inline style="" attributes — blocking that
//   would break the entire UI's styling, not just a few components.
// - style-src/font-src allow fonts.googleapis.com/fonts.gstatic.com for the Inter/Fira
//   Code font import in client/src/index.css.
// - crossOriginEmbedderPolicy is disabled — Google Fonts doesn't send the CORP header
//   COEP: require-corp would need, so leaving helmet's default on would silently break
//   font loading. This app has no need for cross-origin isolation (no SharedArrayBuffer).
// - hsts is disabled — this app is served over plain HTTP on the LAN (see README), and
//   browsers ignore Strict-Transport-Security entirely when it's not delivered over
//   HTTPS anyway, so sending it here is just misleading noise, not a real protection.
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
      fontSrc: ["'self'", 'https://fonts.gstatic.com'],
      imgSrc: ["'self'", 'data:'],
      connectSrc: ["'self'"],
      objectSrc: ["'none'"],
      baseUri: ["'self'"],
      formAction: ["'self'"],
      frameAncestors: ["'none'"],
    },
  },
  crossOriginEmbedderPolicy: false,
  hsts: false,
}));

// helmet dropped Permissions-Policy support (spec churn) — set a minimal one directly.
// This app doesn't use any of these browser features, so deny them outright.
app.use((_req, res, next) => {
  res.setHeader('Permissions-Policy', 'geolocation=(), camera=(), microphone=(), payment=(), usb=()');
  next();
});

app.use(express.json());

// API routes
app.use('/api/printers',        printersRouter);
app.use('/api/printers/:id/jobs', printerJobsRouter);
app.use('/api/parts',           partsRouter);
app.use('/api/gcodes',          gcodesRouter);
app.use('/api/jobs',            jobsRouter);
app.use('/api/backup',          backupRouter);
app.use('/api/dashboard',       dashboardRouter);
app.use('/api/settings',        settingsRouter);
app.use('/api/models',          modelsRouter);
app.use('/api/filaments',       filamentsRouter);

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: Date.now() });
});

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

  // Mount projects router here so it has access to the scheduler for complete/reactivate
  app.use('/api/projects', require('./routes/projects')(db, scheduler));

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
  // batched sweep (dispatch_batch_size at a time, waits for each batch to reach printing before the next).
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
    console.log(`[server] Batch set-ready: ${printers.length} printer(s) — dispatching in batches of ${batchSize}`);
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
});

module.exports = { app, server };
