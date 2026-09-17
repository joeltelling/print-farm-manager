const EventEmitter = require('events');
const { getDriver } = require('./drivers');
const { recordStatusTransition, accumulateJobSample } = require('./telemetry');
const timelapse = require('./timelapse');

const POLL_INTERVAL_MS = 15000;

function isLocalSimulatorHost(ip) {
  const host = String(ip || '')
    .replace(/^https?:\/\//, '')
    .replace(/\/+$/, '')
    .split('/')[0]
    .split(':')[0]
    .toLowerCase();
  return host === '127.0.0.1' || host === 'localhost' || host === '::1';
}

class PrinterPoller extends EventEmitter {
  constructor(db) {
    super();
    this.db = db;
    this.timer = null;
  }

  start() {
    console.log(`[poller] Starting poll loop (interval: ${POLL_INTERVAL_MS}ms)`);
    this._tick();
    this.timer = setInterval(() => this._tick(), POLL_INTERVAL_MS);
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  async _tick() {
    const printers = this.db
      .prepare('SELECT * FROM printers WHERE is_active = 1')
      .all();

    // DEMO_MODE freezes seeded non-Klipper statuses. Only Klipper rows are polled
    // live (typically Virtual Klipper at 127.0.0.1) so the simulator stays connected
    // without overwriting the rest of the demo fleet.
    const toPoll = process.env.DEMO_MODE === 'true'
      ? printers.filter((p) => p.type === 'klipper')
      : printers;

    if (toPoll.length === 0) {
      this.emit('pollComplete');
      return;
    }

    const results = await Promise.allSettled(
      toPoll.map((printer) => this._pollPrinter(printer))
    );

    results.forEach((result, i) => {
      if (result.status === 'rejected') {
        console.error(`[poller] Unexpected error polling ${toPoll[i].name}:`, result.reason);
      }
    });

    this.emit('pollComplete');
  }

  async _pollPrinter(printer) {
    const previousStatus = printer.status;
    let newStatus;
    let jobName = null;
    let jobProgress = null;
    let jobTimeRemaining = null;

    let driver;
    try {
      driver = getDriver(printer.type);
    } catch (err) {
      console.error(`[poller] ${printer.name} has unknown type "${printer.type}" — skipping poll: ${err.message}`);
      return;
    }
    const result = await driver.getStatus(printer);
    newStatus = result.status;
    jobProgress = result.progress;
    jobTimeRemaining = result.timeRemaining;

    if (newStatus !== previousStatus) {
      // Only hold when there is a tracked active job to protect. This gates all three
      // hold triggers — FINISHED, missed-finish (PRINTING→IDLE), and non-safe states
      // (OFFLINE, ERROR, PAUSED, etc.).
      //
      // Without this gate a printer that had its job already confirmed (is_held cleared
      // by Set Ready) can be re-held by a subsequent status transition. The common case
      // is a Prusa printer that stays in FINISHED state until the display is cleared:
      // a network blip causes FINISHED→OFFLINE→FINISHED, the FINISHED re-entry sets
      // is_held=1, and Fleet shows stale confirmation buttons for the already-confirmed job.
      //
      // _handleFinished, _handlePrinterOffline, and _handlePrinterUnavailable in the
      // scheduler also set is_held=1 only when they find an active job — they do their
      // own job lookup before holding, so this gate is not needed there.
      const SAFE_STATES = new Set(['IDLE', 'PRINTING', 'FINISHED', 'READY']);
      const missedFinished = newStatus === 'IDLE' && previousStatus === 'PRINTING';
      const hasActiveJob = !!this.db.prepare(
        "SELECT id FROM jobs WHERE printer_id = ? AND status IN ('uploading', 'printing') LIMIT 1"
      ).get(printer.id);
      const shouldHold = hasActiveJob && (newStatus === 'FINISHED' || missedFinished || !SAFE_STATES.has(newStatus));
      const holdUpdate = shouldHold ? ', is_held = 1' : '';
      // Clear job fields when leaving PRINTING state
      const clearJob = previousStatus === 'PRINTING' && newStatus !== 'PRINTING'
        ? ', job_name = NULL, job_progress = NULL, job_time_remaining = NULL'
        : '';
      this.db
        .prepare(`UPDATE printers SET status = ?${holdUpdate}${clearJob} WHERE id = ?`)
        .run(newStatus, printer.id);

      try {
        recordStatusTransition(this.db, {
          printerId: printer.id,
          previousStatus,
          newStatus,
        });
      } catch (err) {
        console.error(`[poller] telemetry transition failed for ${printer.name}:`, err.message);
      }

      try {
        timelapse.onPrinterStatus(this.db, {
          printerId: printer.id,
          newStatus,
        });
      } catch (err) {
        console.error(`[poller] timelapse hook failed for ${printer.name}:`, err.message);
      }

      console.log(`[poller] ${printer.name}: ${previousStatus} → ${newStatus}`);
      this.emit('statusChange', { printer, previousStatus, newStatus });

      if (newStatus === 'IDLE' && previousStatus !== 'IDLE') {
        this.emit('printerIdle', { printer: { ...printer, status: newStatus } });
      }
    }

    // Always persist latest job progress while printing (status may not have changed)
    if (newStatus === 'PRINTING' || newStatus === 'PAUSED') {
      if (newStatus === 'PRINTING') {
        // Prefer the filename reported directly by the printer (Elegoo SDCP).
        // Fall back to a DB lookup via the jobs table (Prusa Link and others).
        if (result.currentFile) {
          jobName = result.currentFile;
        } else {
          const activeJob = this.db.prepare(`
            SELECT gcodes.filename FROM jobs
            JOIN gcodes ON gcodes.id = jobs.gcode_id
            WHERE jobs.printer_id = ? AND jobs.status = 'printing'
            ORDER BY jobs.started_at DESC LIMIT 1
          `).get(printer.id);
          jobName = activeJob?.filename ?? null;
        }
        this.db
          .prepare('UPDATE printers SET job_name = ?, job_progress = ?, job_time_remaining = ? WHERE id = ?')
          .run(jobName, jobProgress, jobTimeRemaining, printer.id);
      }
      try {
        accumulateJobSample(this.db, { printerId: printer.id, status: newStatus });
      } catch (err) {
        console.error(`[poller] telemetry sample failed for ${printer.name}:`, err.message);
      }
    }
  }
}

module.exports = PrinterPoller;
module.exports.isLocalSimulatorHost = isLocalSimulatorHost;
