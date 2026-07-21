const EventEmitter = require('events');
const fs = require('fs');
const path = require('path');
const { getDriver } = require('./drivers');
const notifications = require('./notifications');
const events = require('./events');

const GCODE_DIR = path.join(__dirname, 'gcode');

// A job we just dispatched looks identical to a stale orphaned job: the job is
// 'printing'/'uploading' but the printer's stored status is still its last polled
// value (IDLE/FINISHED) because the next poll hasn't run yet. Don't treat an active
// job younger than this as stale — give the printer time to be re-polled as PRINTING.
// Comfortably exceeds the 15s poll interval plus typical print-start (bed-heating) latency.
const STALE_JOB_GRACE_MS = 90000;

class JobScheduler extends EventEmitter {
  constructor(db, poller) {
    super();
    this.db = db;
    this.poller = poller;
    this._isSweeping = false;
    this._pendingPrinters = [];
    this._activeUploads = new Set(); // printer IDs with an upload currently in flight
    // Stamped in start(). Used to gate the failed-job recovery fallback so
    // that only jobs failed during the current process lifetime are eligible.
    // Prevents stale failed jobs from a previous session being credited when a
    // Bambu printer transitions OFFLINE → FINISHED on reconnect.
    this.startedAt = 0;
  }

  start() {
    this.startedAt = Date.now();
    console.log('[scheduler] Starting job scheduler');

    this.poller.on('printerIdle', ({ printer }) => {
      this._dispatchToPrinter(printer).catch((err) =>
        console.error(`[scheduler] Unhandled error dispatching to ${printer.name}:`, err)
      );
    });

    this.poller.on('statusChange', ({ printer, newStatus }) => {
      if (newStatus === 'FINISHED') {
        this._handleFinished(printer);
      }
      if (newStatus === 'ERROR') {
        this._handlePrinterUnavailable(printer);
      }
      if (newStatus === 'OFFLINE') {
        this._handlePrinterOffline(printer);
      }
      if (newStatus === 'PRINTING') {
        this._handleRecoveredToPrinting(printer);
      }
      if (newStatus === 'STOPPED') {
        this._handlePrinterStopped(printer);
      }
    });
  }

  // Sweep all currently idle non-held active printers. Dispatches in waves that keep
  // drawing from the ready queue until dispatch_batch_size printers actually have a
  // job reserved (or the queue runs out): see _sweepInBatches. A printer with no
  // dispatchable candidate right now doesn't count against the target; the wave
  // reaches past it to find enough real work to hit the configured concurrency.
  // Called when a project is activated or the server starts.
  sweepIdlePrinters() {
    // Include FINISHED printers with is_held = 0 — this state means the operator
    // confirmed the print was good (released the hold) but the upload failed.
    // They need a new job just as much as an IDLE printer does.
    //
    // Include STOPPED printers with is_held = 0 — no hold means there is no
    // unresolved outcome (any farm job was already resolved, or the stopped print
    // was never ours). Some printers (Bambu) latch the stopped state until the
    // next print starts, so they never transition to IDLE on their own —
    // dispatching to them is what returns them to service.
    const eligiblePrinters = this.db.prepare(`
      SELECT * FROM printers
      WHERE status IN ('IDLE', 'FINISHED', 'STOPPED') AND is_held = 0 AND is_active = 1
    `).all();

    console.log(`[scheduler] Sweeping ${eligiblePrinters.length} eligible printer(s) (IDLE, operator-confirmed FINISHED, or resolved STOPPED)`);

    if (eligiblePrinters.length === 0) return;

    this._sweepInBatches(eligiblePrinters).catch((err) =>
      console.error('[scheduler] Sweep error:', err)
    );
  }

  async _sweepInBatches(printers) {
    // If a sweep is already running, defer these printers to the end of it.
    // This prevents concurrent sweeps when set-ready-batch is called mid-sweep,
    // and ensures newly-ready printers don't jump the queue.
    if (this._isSweeping) {
      this._pendingPrinters.push(...printers);
      console.log(`[scheduler] Sweep in progress — ${printers.length} printer(s) deferred to end of current sweep`);
      return;
    }

    this._isSweeping = true;
    try {
      let toDispatch = [...printers];
      while (toDispatch.length > 0) {
        const setting = this.db.prepare("SELECT value FROM settings WHERE key = 'dispatch_batch_size'").get();
        const batchSize = setting ? Math.max(1, parseInt(setting.value, 10) || 10) : 10;

        // Keep drawing from the queue, cheaply skipping any printer with no
        // dispatchable candidate right now, until batchSize printers actually
        // have a job reserved, or the queue runs out. _reserveJob is fully
        // synchronous, so this scan never yields control mid-way: no new
        // interleaving risk for the per-part ceiling check, which already
        // relies on that same synchronous-reservation guarantee.
        const activeJobIds = [];
        const uploadPromises = [];
        let consideredCount = 0;
        while (activeJobIds.length < batchSize && toDispatch.length > 0) {
          const printer = toDispatch.shift();
          consideredCount++;
          let reservation;
          try {
            reservation = this._reserveJob(printer);
          } catch (err) {
            console.error(`[scheduler] Reservation error for ${printer.name}:`, err);
            reservation = null;
          }
          if (reservation) {
            activeJobIds.push(reservation.jobId);
            uploadPromises.push(
              this._executeUpload(printer, reservation).catch(err => {
                console.error(`[scheduler] Sweep dispatch error for ${printer.name}:`, err);
                return null;
              })
            );
          }
        }

        if (activeJobIds.length > 0) {
          console.log(`[scheduler] Wave: ${activeJobIds.length}/${batchSize} printer(s) actually dispatching (considered ${consideredCount})`);
          await this._waitForBatch(activeJobIds);
        } else if (consideredCount > 0) {
          console.log(`[scheduler] Wave: none of ${consideredCount} considered printer(s) had a dispatchable candidate`);
        }

        // Make sure every upload this wave started has settled before starting
        // the next wave, even if _waitForBatch's own poll already returned:
        // this just guards against leaving a promise dangling.
        await Promise.all(uploadPromises);

        // Append, don't replace: toDispatch may still hold printers left over
        // from this pass that didn't fit because the wave already hit
        // batchSize. Unlike the old fixed-chunk loop (which always drained
        // toDispatch fully before reaching this line), this wave can stop
        // early, so reassigning here would silently drop and starve those
        // leftover printers.
        const deferredCount = this._pendingPrinters.length;
        toDispatch.push(...this._pendingPrinters.splice(0));
        if (deferredCount > 0) {
          console.log(`[scheduler] Picked up ${deferredCount} deferred printer(s)`);
        }
      }
    } finally {
      this._isSweeping = false;
    }
  }

  // Dispatch a single printer, respecting any in-progress sweep.
  // Use this instead of _dispatchToPrinter directly for set-ready and recommission paths,
  // so that a printer set ready mid-sweep is added to the end of the current batch sequence
  // rather than firing concurrently with it.
  scheduleForPrinter(printer) {
    if (this._isSweeping) {
      this._pendingPrinters.push(printer);
      console.log(`[scheduler] ${printer.name} set ready during sweep — deferred to end of sweep`);
      return;
    }
    this._sweepInBatches([printer]).catch(err =>
      console.error(`[scheduler] Unhandled error dispatching to ${printer.name}:`, err)
    );
  }

  // Poll jobs table until all given job IDs are printing or terminal.
  // A job left as 'uploading' with its printer held counts as terminal — the upload
  // failed and operator confirmation is needed before anything changes. The batch
  // must not block on it indefinitely.
  // Gives up after 10 minutes — large files on slow networks can take several minutes to transfer.
  _waitForBatch(jobIds, pollIntervalMs = 3000, timeoutMs = 600000) {
    return new Promise((resolve) => {
      const start = Date.now();
      const placeholders = jobIds.map(() => '?').join(',');

      const check = () => {
        const rows = this.db.prepare(`
          SELECT j.status, p.is_held
          FROM jobs j JOIN printers p ON p.id = j.printer_id
          WHERE j.id IN (${placeholders})
        `).all(...jobIds);

        const allSettled = rows.every(r =>
          r.status === 'printing' || r.status === 'failed' || r.status === 'cancelled' ||
          (r.status === 'uploading' && r.is_held === 1)
        );

        if (allSettled || Date.now() - start > timeoutMs) {
          resolve();
        } else {
          setTimeout(check, pollIntervalMs);
        }
      };

      check();
    });
  }

  // ─── Dispatch ───────────────────────────────────────────────────────────────

  // Find a dispatchable candidate for this printer and reserve it, synchronously.
  // Everything here (the held/active-job/upload-lock guards, driver resolution,
  // candidate selection, the per-part ceiling check, and the file-existence check)
  // is synchronous (better-sqlite3, fs.existsSync, a synchronous driver-registry
  // lookup): no network I/O, no await. That is what makes the ceiling check safe to
  // call for many printers back to back in a tight loop (see _sweepInBatches's wave
  // loop): each reservation, including its job INSERT, fully completes before the
  // next one begins, so a concurrent reservation for the same part always sees this
  // one's already-committed probe when it sums in-progress quantity.
  //
  // Returns null if nothing was reserved (nothing to wait on, nothing to upload).
  // Returns { jobId, candidate, driver, gcodeFullPath } if a job was created as
  // 'uploading': that INSERT is the dispatch lock; _executeUpload takes it from here.
  _reserveJob(printer) {
    // Re-read is_held and status from DB — the printer object passed in may be stale
    const fresh = this.db.prepare('SELECT is_held, status FROM printers WHERE id = ?').get(printer.id);
    if (!fresh || fresh.is_held) {
      console.log(`[scheduler] ${printer.name} is held — skipping dispatch`);
      return null;
    }

    // Guard against double-dispatch: if this printer already has an active job
    // (uploading or printing) from a concurrent dispatch path, skip it.
    // This can happen when set-ready and the initial sweep fire simultaneously.
    //
    // Special case: if the printer is IDLE but has an active job, the job is stale —
    // the print finished or was cancelled outside our view (e.g. we missed a FINISHED
    // transition between two polls, or a post-recommission upload succeeded but the
    // printer stopped the job on its own). Hold the printer so the operator can confirm
    // the outcome rather than leaving it permanently locked out of dispatch.
    const activeJob = this.db.prepare(
      "SELECT id, status, created_at, started_at FROM jobs WHERE printer_id = ? AND status IN ('uploading', 'printing') LIMIT 1"
    ).get(printer.id);
    if (activeJob) {
      // A 'printing' job is only legitimate while the printer is actively printing or
      // paused. Any other status (IDLE, STOPPED, FINISHED, ERROR, etc.) usually means the
      // job is stale — the print ended outside our view. Auto-fail it so the operator can
      // use the normal green/red Fleet UI without a special resolution flow.
      //
      // EXCEPT when the job was dispatched moments ago: a freshly dispatched job is
      // 'printing'/'uploading' while the printer's stored status still reads IDLE/FINISHED
      // until the next poll catches up. Without this grace window, a second dispatch firing
      // in that gap auto-fails the job it just created and re-holds the printer. This is
      // exactly the recommission case — recommission queues a dispatch, and a near-simultaneous
      // "scan for jobs" enqueues the same printer again before it has been re-polled as PRINTING.
      const jobAge = Date.now() - (activeJob.started_at ?? activeJob.created_at);
      const isStaleEligible = fresh.status !== 'PRINTING' && fresh.status !== 'PAUSED';
      if (isStaleEligible && jobAge > STALE_JOB_GRACE_MS) {
        this.db.prepare("UPDATE jobs SET status = 'failed', finished_at = ? WHERE id = ?")
          .run(Date.now(), activeJob.id);
        this.db.prepare('UPDATE printers SET is_held = 1 WHERE id = ?').run(printer.id);
        notifications.add(
          `${printer.name}: stale job ${activeJob.id} automatically cancelled — printer held. Use Fleet to resume when ready.`
        );
        console.warn(`[scheduler] ${printer.name} stale job ${activeJob.id} auto-failed — printer is ${fresh.status}, held for operator review`);
      } else if (isStaleEligible) {
        console.log(`[scheduler] ${printer.name} has a freshly dispatched job ${activeJob.id} (${Math.round(jobAge / 1000)}s old, printer ${fresh.status}) — skipping duplicate dispatch, not yet stale`);
      } else {
        console.log(`[scheduler] ${printer.name} already has an active job — skipping duplicate dispatch`);
      }
      return null;
    }

    // Guard against starting a new upload while one is already in flight for this printer.
    // Prevents the 409-Conflict retry cycle where a slow transfer causes a retry that
    // immediately hits the still-running first attempt.
    if (this._activeUploads.has(printer.id)) {
      console.log(`[scheduler] ${printer.name} upload already in flight — skipping dispatch`);
      return null;
    }

    // Resolve driver up-front — before any job row is created.
    // A printer with an unknown type should never have jobs farmed to it.
    // Holding the printer surfaces the misconfiguration to an operator without
    // leaving any stale job record behind.
    let driver;
    try {
      driver = getDriver(printer.type);
    } catch (err) {
      this.db.prepare('UPDATE printers SET is_held = 1 WHERE id = ?').run(printer.id);
      console.error(`[scheduler] ${printer.name} has unknown type "${printer.type}" — held, no job created: ${err.message}`);
      return null;
    }

    // Walk candidates in priority order (project priority → part sort_order) until
    // we find a part that still needs a job, skipping any whose active jobs already
    // cover the remaining qty (ceiling). This allows a printer to fall through to
    // the next part in the list when the highest-priority part is fully covered.
    const skippedPartIds = [];
    let candidate = null;
    let jobId = null;
    let gcodeFullPath = null;

    while (true) {
      const excludeClause = skippedPartIds.length > 0
        ? `AND parts.id NOT IN (${skippedPartIds.map(() => '?').join(',')})`
        : '';

      candidate = this.db.prepare(`
        SELECT
          parts.id          AS part_id,
          parts.target_qty,
          parts.completed_qty,
          parts.project_id,
          gcodes.id         AS gcode_id,
          gcodes.filename,
          gcodes.filepath,
          gcodes.parts_per_plate,
          gcodes.ams_slot
        FROM parts
        JOIN gcodes   ON gcodes.part_id    = parts.id
        JOIN projects ON projects.id       = parts.project_id
        WHERE parts.status    = 'open'
          AND projects.status = 'active'
          AND gcodes.printer_model = ?
          AND (COALESCE(gcodes.allowed_groups, projects.allowed_groups) IS NULL OR EXISTS (
            SELECT 1 FROM json_each(COALESCE(gcodes.allowed_groups, projects.allowed_groups)) WHERE value = ?
          ))
          AND (COALESCE(gcodes.required_material, projects.required_material) IS NULL OR COALESCE(gcodes.required_material, projects.required_material) = ?)
          AND (COALESCE(gcodes.required_color, projects.required_color) IS NULL OR COALESCE(gcodes.required_color, projects.required_color) = ?)
          ${excludeClause}
        ORDER BY projects.priority ASC, projects.created_at ASC, parts.sort_order ASC, parts.created_at ASC
        LIMIT 1
      `).get(printer.model, printer.group_name, printer.loaded_material, printer.loaded_color, ...skippedPartIds);

      if (!candidate) {
        console.log(`[scheduler] No candidate found for ${printer.name} (model: ${printer.model}) — no open parts with matching G-code in an active project`);
        return null;
      }

      // Synchronously insert a job as 'uploading' — this acts as a dispatch lock
      // so concurrent printerIdle events for printers of the same model don't
      // over-dispatch the same Part.
      const jobRow = this.db.prepare(`
        INSERT INTO jobs (part_id, printer_id, gcode_id, parts_per_plate, status, created_at)
        VALUES (?, ?, ?, ?, 'uploading', ?)
      `).run(candidate.part_id, printer.id, candidate.gcode_id, candidate.parts_per_plate, Date.now());
      jobId = jobRow.lastInsertRowid;

      // Ceiling check: are the parts already in progress enough to cover what's needed?
      //
      // We sum parts_per_plate across all active jobs (including the probe just inserted)
      // rather than counting jobs. This correctly handles parts whose G-codes have
      // different parts_per_plate on different printer models (e.g. XL=4ppp, MK4S=10ppp).
      // Counting jobs and dividing by the current dispatch's ppp would overestimate the
      // ceiling in those cases and dispatch more printers than needed.
      //
      // The probe is already in the DB with status 'uploading', so inProgressParts
      // includes it. The ceiling is hit when the existing in-progress parts — i.e.
      // everything except this probe — already cover the remaining target:
      //   (inProgressParts - candidate.parts_per_plate) >= remainingParts
      const remainingParts = Math.max(0, candidate.target_qty - candidate.completed_qty);
      const inProgressParts = this.db.prepare(`
        SELECT COALESCE(SUM(parts_per_plate), 0) AS total FROM jobs
        WHERE part_id = ? AND status IN ('uploading', 'printing')
      `).get(candidate.part_id).total;

      if (inProgressParts - candidate.parts_per_plate >= remainingParts) {
        // Already covered without this probe — try the next part down the list
        this.db.prepare('DELETE FROM jobs WHERE id = ?').run(jobId);
        console.log(`[scheduler] Ceiling hit for part ${candidate.part_id} (${inProgressParts - candidate.parts_per_plate} of ${remainingParts} parts already in progress) — trying next part for ${printer.name}`);
        skippedPartIds.push(candidate.part_id);
        continue;
      }

      // Verify the G-code file exists on disk before committing to this candidate.
      // A missing file is a permanent condition — retrying won't fix it. Delete the
      // probe job, notify the operator, and fall through to the next part so the
      // printer can still pick up other work. No job record is left behind.
      const gcodeFilename = candidate.filepath.split(/[\\/]/).pop();
      gcodeFullPath = path.join(GCODE_DIR, gcodeFilename);
      if (!fs.existsSync(gcodeFullPath)) {
        this.db.prepare('DELETE FROM jobs WHERE id = ?').run(jobId);
        const part = this.db.prepare('SELECT parts.name, projects.name AS project_name FROM parts JOIN projects ON projects.id = parts.project_id WHERE parts.id = ?').get(candidate.part_id);
        notifications.add(
          `G-code file missing for "${candidate.filename}" — re-upload the file for part "${part?.name}" in project "${part?.project_name}".`
        );
        console.warn(`[scheduler] G-code missing for part ${candidate.part_id} ("${candidate.filename}") — skipping to next part for ${printer.name}`);
        skippedPartIds.push(candidate.part_id);
        continue;
      }

      // Candidate has room and file exists — proceed with upload
      break;
    }

    return { jobId, candidate, driver, gcodeFullPath };
  }

  // Perform the actual upload for an already-reserved job (see _reserveJob). This is
  // the only async part of dispatch: real network I/O to the printer.
  async _executeUpload(printer, reservation) {
    const { jobId, candidate, driver, gcodeFullPath } = reservation;

    // Upload with retries. A transient network timeout (common when many printers
    // start simultaneously) will self-heal. Only after all attempts are exhausted
    // does the printer get held for operator attention.
    //
    // 409 CONFLICT means a file transfer is already in progress on the printer
    // (typically a previous attempt that timed out on our side but continued on the printer).
    // We wait 60 s before retrying in that case — much longer than the 5 s used for other errors.
    const MAX_RETRIES = 2;
    let lastErr = null;

    this._activeUploads.add(printer.id);
    try {
      for (let attempt = 1; attempt <= MAX_RETRIES + 1; attempt++) {
        try {
          await driver.uploadAndPrint(printer, gcodeFullPath, candidate.filename, { amsSlot: candidate.ams_slot });
          lastErr = null;
          break;
        } catch (err) {
          lastErr = err;
          if (attempt <= MAX_RETRIES) {
            const isConflict = err.code === 'UPLOAD_CONFLICT';
            const waitMs = isConflict ? 60000 : 5000;
            console.warn(
              `[scheduler] ${printer.name} upload attempt ${attempt}/${MAX_RETRIES + 1} failed ` +
              `(${err.message}) — retrying in ${waitMs / 1000}s`
            );
            await new Promise(r => setTimeout(r, waitMs));
          }
        }
      }
    } finally {
      this._activeUploads.delete(printer.id);
    }

    if (lastErr) {
      // Before giving up, check whether the printer is actually printing.
      // This handles the case where our request timed out but the printer
      // received the file and started the job anyway. If it is printing, treat
      // the upload as a success so the job is tracked correctly.
      const isActuallyPrinting = await driver.checkIfPrinting(printer);
      if (isActuallyPrinting) {
        this.db.prepare(`UPDATE jobs SET status = 'printing', started_at = ? WHERE id = ?`).run(Date.now(), jobId);
        console.log(`[scheduler] ${printer.name} upload appeared to fail but printer is printing — job ${jobId} recovered`);
        return jobId;
      }

      // Upload failed and printer is not printing. Hold the printer and leave the job
      // as 'uploading' — the operator must confirm the outcome via Fleet UI.
      // Job Running: confirms the print is actually running (changes job to printing).
      // Upload Failed: marks the job failed and decommissions.
      // Never auto-fail here — the operator decides.
      this.db.prepare('UPDATE printers SET is_held = 1 WHERE id = ?').run(printer.id);
      notifications.add(
        `Upload to ${printer.name} failed after ${MAX_RETRIES + 1} attempts — check the printer and confirm the outcome in Fleet.`
      );
      console.error(`[scheduler] ${printer.name} upload failed after ${MAX_RETRIES + 1} attempts — held, job ${jobId} left as uploading for operator confirmation`);
      return null;
    }

    this.db.prepare(`
      UPDATE jobs SET status = 'printing', started_at = ? WHERE id = ?
    `).run(Date.now(), jobId);

    console.log(`[scheduler] ${printer.name} ← ${candidate.filename}`);
    return jobId;
  }

  // Reserve-then-upload for a single printer, used by callers that dispatch one
  // printer at a time outside the wave-fill loop (the organic printerIdle listener,
  // and _handleFinished's fallback dispatch). Kept async so a synchronous throw
  // inside _reserveJob still surfaces as a rejected promise, same as before this
  // method was split; callers here use .catch(...) and rely on that.
  async _dispatchToPrinter(printer) {
    const reservation = this._reserveJob(printer);
    if (!reservation) return null;
    return this._executeUpload(printer, reservation);
  }

  // ─── Finished handling ───────────────────────────────────────────────────────

  _handleFinished(printer) {
    // Find the job currently marked printing for this printer.
    // Fallback: also check for a job marked failed *during this session*. Bambu
    // printers use a persistent MQTT connection — if it briefly drops during a print,
    // the 'reconnect' event fires, getStatus() returns OFFLINE, and
    // _handlePrinterUnavailable marks the job 'failed'. But the printer keeps
    // printing. When it finishes, there is no 'printing' job to find, so we
    // recover the recently-failed one.
    //
    // Critical: the fallback is gated on finished_at > this.startedAt — the job
    // must have been marked failed DURING the current server process. Without this
    // gate, a stale FINISHED state reported by a Bambu printer on startup (first
    // poll = OFFLINE while MQTT connects, second poll = FINISHED) can match ANY
    // old failed job and falsely credit the part.
    let job = this.db.prepare(`
      SELECT * FROM jobs
      WHERE printer_id = ? AND status = 'printing'
      ORDER BY started_at DESC
      LIMIT 1
    `).get(printer.id);

    if (!job) {
      job = this.db.prepare(`
        SELECT * FROM jobs
        WHERE printer_id = ? AND status = 'failed' AND finished_at > ?
        ORDER BY finished_at DESC
        LIMIT 1
      `).get(printer.id, this.startedAt);

      if (job) {
        console.log(`[scheduler] FINISHED on ${printer.name} — recovering job ${job.id} (marked failed during this session, likely transient MQTT disconnect during print)`);
      }
    }

    if (!job) {
      console.warn(`[scheduler] FINISHED on ${printer.name} but no printing job found — may be outside system`);
      // Still try to dispatch the next job
      this._dispatchToPrinter(printer).catch(() => {});
      return;
    }

    const now = Date.now();

    // Mark job finished
    this.db.prepare(`UPDATE jobs SET status = 'finished', finished_at = ? WHERE id = ?`)
      .run(now, job.id);

    // Increment completed_qty
    this.db.prepare(`
      UPDATE parts SET completed_qty = completed_qty + ?, updated_at = ? WHERE id = ?
    `).run(job.parts_per_plate, now, job.part_id);

    const part = this.db.prepare('SELECT * FROM parts WHERE id = ?').get(job.part_id);

    console.log(`[scheduler] ${printer.name} finished — Part "${part.name}" ${part.completed_qty}/${part.target_qty}`);

    if (part.completed_qty >= part.target_qty) {
      this._closePart(part, now);
    }

    // Hold the printer — operator must confirm print quality before next job dispatches
    this.db.prepare('UPDATE printers SET is_held = 1 WHERE id = ?').run(printer.id);
    events.insert(printer.id, 'job_finished', `Job ${job.id} — ${part.name} (${job.parts_per_plate} parts)`);
    console.log(`[scheduler] ${printer.name} held — awaiting operator confirmation`);

    // Clean up the file from the printer's SD card (Bambu only — other drivers ignore this)
    if (job.gcode_id) {
      const gcode = this.db.prepare('SELECT filepath FROM gcodes WHERE id = ?').get(job.gcode_id);
      if (gcode) {
        const driver = getDriver(printer.type);
        if (typeof driver.deleteFile === 'function') {
          driver.deleteFile(printer, path.basename(gcode.filepath)).catch(() => {});
        }
      }
    }
  }

  _closePart(part, now) {
    this.db.prepare(`UPDATE parts SET status = 'closed', updated_at = ? WHERE id = ?`)
      .run(now, part.id);

    // Cancel any queued (not yet dispatched) jobs for this part
    this.db.prepare(`
      UPDATE jobs SET status = 'cancelled' WHERE part_id = ? AND status = 'queued'
    `).run(part.id);

    console.log(`[scheduler] Part "${part.name}" closed (${part.completed_qty}/${part.target_qty})`);

    // Check if all parts in the project are now closed
    const openCount = this.db.prepare(`
      SELECT COUNT(*) AS count FROM parts WHERE project_id = ? AND status = 'open'
    `).get(part.project_id).count;

    if (openCount === 0) {
      this.db.prepare(`UPDATE projects SET status = 'completed', updated_at = ? WHERE id = ?`)
        .run(now, part.project_id);
      console.log(`[scheduler] Project ${part.project_id} completed!`);
    }
  }

  // ─── Error / offline handling ────────────────────────────────────────────────

  // OFFLINE is treated as a transient network event, not a definitive failure.
  // The job is left as 'printing' so it can resume naturally if the printer
  // comes back. The printer is held so the operator sees it needs attention.
  // If the printer comes back PRINTING, _handleRecoveredToPrinting auto-unhollds.
  // If the operator confirms via green (set-ready), the job keeps running.
  // If the operator confirms via red (mark-job-failure), the job is failed.
  _handlePrinterOffline(printer) {
    const activeJob = this.db.prepare(
      "SELECT id FROM jobs WHERE printer_id = ? AND status IN ('uploading', 'printing') LIMIT 1"
    ).get(printer.id);

    if (activeJob) {
      this.db.prepare('UPDATE printers SET is_held = 1 WHERE id = ?').run(printer.id);
      events.insert(printer.id, 'offline_with_job', `Printer went offline with job ${activeJob.id} in progress — awaiting operator confirmation`);
      console.warn(`[scheduler] ${printer.name} went OFFLINE with active job — held for operator review (job left as printing)`);
    } else {
      console.warn(`[scheduler] ${printer.name} went OFFLINE (no active job) — not held`);
    }
  }

  // When a held printer transitions to PRINTING, it has recovered from a transient
  // OFFLINE. If it still has a printing job, auto-unhold — no operator action needed.
  _handleRecoveredToPrinting(printer) {
    const fresh = this.db.prepare('SELECT is_held FROM printers WHERE id = ?').get(printer.id);
    if (!fresh || !fresh.is_held) return;

    const activeJob = this.db.prepare(
      "SELECT id FROM jobs WHERE printer_id = ? AND status = 'printing' LIMIT 1"
    ).get(printer.id);

    if (activeJob) {
      this.db.prepare('UPDATE printers SET is_held = 0 WHERE id = ?').run(printer.id);
      events.insert(printer.id, 'recovered', `Printer came back online and resumed printing — hold released automatically`);
      console.log(`[scheduler] ${printer.name} auto-unhold — came back online and is printing (job ${activeJob.id})`);
    }
  }

  // Operator stopped the print from the printer's own screen. Cancel the active job
  // so the Jobs view reflects reality. The poller has already set is_held = 1 (STOPPED
  // is not a SAFE_STATE), so the printer waits for operator confirmation before the
  // next job dispatches.
  _handlePrinterStopped(printer) {
    const job = this.db.prepare(
      "SELECT id FROM jobs WHERE printer_id = ? AND status = 'printing' LIMIT 1"
    ).get(printer.id);

    if (job) {
      this.db.prepare("UPDATE jobs SET status = 'cancelled', finished_at = ? WHERE id = ?")
        .run(Date.now(), job.id);
      events.insert(printer.id, 'job_cancelled', `Job ${job.id} — stopped by operator on printer screen`);
      console.log(`[scheduler] ${printer.name} stopped — job ${job.id} cancelled`);
    }
  }

  _handlePrinterUnavailable(printer) {
    // Mark any uploading/printing job on this printer as failed
    const job = this.db.prepare(`
      SELECT * FROM jobs
      WHERE printer_id = ? AND status IN ('uploading', 'printing')
      ORDER BY started_at DESC LIMIT 1
    `).get(printer.id);

    if (job) {
      this.db.prepare(`UPDATE jobs SET status = 'failed', finished_at = ? WHERE id = ?`)
        .run(Date.now(), job.id);
      console.warn(`[scheduler] Marked job ${job.id} failed — ${printer.name} went ${printer.status}`);
    }

    // Hold the printer — any error or offline state requires operator sign-off.
    // The poller also sets this, but we do it here too for defense in depth.
    this.db.prepare('UPDATE printers SET is_held = 1 WHERE id = ?').run(printer.id);
    console.warn(`[scheduler] ${printer.name} held — entered ${printer.status}, operator confirmation required`);
  }
}

module.exports = JobScheduler;
