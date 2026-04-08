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

const db             = require('./db');
const PrinterPoller  = require('./poller');
const JobScheduler   = require('./scheduler');
const notifications  = require('./notifications');

const printersRouter  = require('./routes/printers')(db);
const partsRouter     = require('./routes/parts')(db);
const gcodesRouter    = require('./routes/gcodes')(db);
const jobsRouter      = require('./routes/jobs')(db);
const backupRouter    = require('./routes/backup')(db);
const dashboardRouter = require('./routes/dashboard')(db);
const settingsRouter  = require('./routes/settings')(db);

const app  = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

// API routes
app.use('/api/printers',  printersRouter);
app.use('/api/parts',     partsRouter);
app.use('/api/gcodes',    gcodesRouter);
app.use('/api/jobs',      jobsRouter);
app.use('/api/backup',    backupRouter);
app.use('/api/dashboard', dashboardRouter);
app.use('/api/settings',  settingsRouter);

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
  // batched sweep (10 at a time, waits for each batch to reach printing before the next).
  // Used by the "Set Ready (N)" action in the Fleet UI.
  app.post('/api/printers/set-ready-batch', (req, res) => {
    const { ids } = req.body;
    if (!Array.isArray(ids) || ids.length === 0) {
      return res.status(400).json({ error: 'ids array required' });
    }
    const placeholders = ids.map(() => '?').join(',');
    db.prepare(`UPDATE printers SET is_held = 0 WHERE id IN (${placeholders})`).run(...ids);
    const printers = db.prepare(`SELECT * FROM printers WHERE id IN (${placeholders}) AND is_active = 1`).all(...ids);
    console.log(`[server] Batch set-ready: ${printers.length} printer(s) — dispatching in batches of 10`);
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

    const finishedJob = db.prepare(`
      SELECT * FROM jobs WHERE printer_id = ? AND status = 'finished'
      ORDER BY finished_at DESC LIMIT 1
    `).get(printer.id);

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

      if (printingJob) {
        const creditQty = (confirmed_qty != null && !isNaN(parseInt(confirmed_qty, 10)))
          ? parseInt(confirmed_qty, 10)
          : printingJob.parts_per_plate;

        db.prepare(`UPDATE jobs SET status = 'finished', finished_at = ? WHERE id = ?`)
          .run(now, printingJob.id);

        db.prepare(`
          UPDATE parts SET completed_qty = completed_qty + ?, updated_at = ? WHERE id = ?
        `).run(creditQty, now, printingJob.part_id);

        const part = db.prepare('SELECT * FROM parts WHERE id = ?').get(printingJob.part_id);
        console.log(`[server] ${printer.name} missed-finish confirmed good — Part "${part.name}" ${part.completed_qty}/${part.target_qty}`);

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
