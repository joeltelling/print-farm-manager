/**
 * Shopfloor machine telemetry: status history by transition + per-job accumulators.
 * Used by ERP actual costing, OEE, and utilization reports.
 */

// Cap accumulated gap between poll samples so a server restart mid-print cannot
// credit hours of phantom machine time. Must exceed POLL_INTERVAL_MS (15 s).
const SAMPLE_GAP_CAP_MS = 30000;

// Coverage of wall-clock print window that still counts as "measured"
const MEASURED_COVERAGE_MIN = 0.7;
const MEASURED_MIN_SAMPLES = 2;

function activeJobId(db, printerId) {
  const row = db.prepare(`
    SELECT id FROM jobs
    WHERE printer_id = ? AND status IN ('uploading', 'printing')
    ORDER BY started_at DESC, id DESC
    LIMIT 1
  `).get(printerId);
  return row?.id ?? null;
}

/**
 * Close any open history row for this printer and open a new one for newStatus.
 */
function recordStatusTransition(db, { printerId, previousStatus, newStatus, now = Date.now() }) {
  if (!printerId || !newStatus || previousStatus === newStatus) return;

  const open = db.prepare(`
    SELECT id, started_at FROM printer_status_history
    WHERE printer_id = ? AND ended_at IS NULL
    ORDER BY started_at DESC LIMIT 1
  `).get(printerId);

  if (open) {
    const duration = Math.max(0, now - open.started_at);
    db.prepare(`
      UPDATE printer_status_history
      SET ended_at = ?, duration_ms = ?
      WHERE id = ?
    `).run(now, duration, open.id);
  }

  const jobId = activeJobId(db, printerId);
  db.prepare(`
    INSERT INTO printer_status_history (printer_id, job_id, status, started_at)
    VALUES (?, ?, ?, ?)
  `).run(printerId, jobId, newStatus, now);
}

/**
 * Accumulate printing / paused seconds on the active job for this printer.
 * Called every poll while status is PRINTING or PAUSED.
 */
function accumulateJobSample(db, { printerId, status, now = Date.now() }) {
  if (!printerId) return;
  if (status !== 'PRINTING' && status !== 'PAUSED') return;

  const job = db.prepare(`
    SELECT id, printing_seconds, paused_seconds, sample_count, last_sample_at
    FROM jobs
    WHERE printer_id = ? AND status = 'printing'
    ORDER BY started_at DESC, id DESC
    LIMIT 1
  `).get(printerId);
  if (!job) return;

  let deltaSec = 0;
  if (job.last_sample_at != null) {
    const gapMs = Math.min(Math.max(0, now - job.last_sample_at), SAMPLE_GAP_CAP_MS);
    deltaSec = gapMs / 1000;
  }

  const printing = Number(job.printing_seconds) || 0;
  const paused = Number(job.paused_seconds) || 0;
  const samples = (Number(job.sample_count) || 0) + 1;

  if (status === 'PRINTING') {
    db.prepare(`
      UPDATE jobs
      SET printing_seconds = ?, sample_count = ?, last_sample_at = ?
      WHERE id = ?
    `).run(printing + deltaSec, samples, now, job.id);
  } else {
    db.prepare(`
      UPDATE jobs
      SET paused_seconds = ?, sample_count = ?, last_sample_at = ?
      WHERE id = ?
    `).run(paused + deltaSec, samples, now, job.id);
  }
}

function machinePowerKw(db, printerId) {
  if (printerId == null) return 0;
  try {
    const m = db.prepare('SELECT power_kw FROM machine WHERE printer_id = ? LIMIT 1').get(printerId);
    return Number(m?.power_kw) || 0;
  } catch (_) {
    return 0;
  }
}

function computeTelemetryQuality(job) {
  const printingSec = Number(job.printing_seconds) || 0;
  const samples = Number(job.sample_count) || 0;
  if (samples < 1 && printingSec <= 0) return 'none';

  const started = job.started_at;
  const finished = job.finished_at || Date.now();
  if (!started || finished <= started) {
    return samples >= MEASURED_MIN_SAMPLES ? 'partial' : 'none';
  }

  const wallSec = (finished - started) / 1000;
  if (wallSec <= 0) return 'none';
  const coverage = printingSec / wallSec;
  if (samples >= MEASURED_MIN_SAMPLES && coverage >= MEASURED_COVERAGE_MIN) {
    return 'measured';
  }
  if (printingSec > 0 || samples > 0) return 'partial';
  return 'none';
}

/**
 * Seal energy, material, and quality on a job that just left the active state.
 * progressPct: 0-100 from printers.job_progress when available (failed jobs).
 */
function sealJobTelemetry(db, jobId, { progressPct = null } = {}) {
  const job = db.prepare('SELECT * FROM jobs WHERE id = ?').get(jobId);
  if (!job) return null;

  const powerKw = machinePowerKw(db, job.printer_id);
  const printingSec = Number(job.printing_seconds) || 0;
  const energyKwh = (printingSec / 3600) * powerKw;

  let materialGrams = null;
  try {
    const g = job.gcode_id != null
      ? db.prepare('SELECT material_grams FROM gcodes WHERE id = ?').get(job.gcode_id)
      : null;
    const plateGrams = Number(g?.material_grams);
    if (Number.isFinite(plateGrams) && plateGrams > 0) {
      let factor = 1;
      if (progressPct != null && Number.isFinite(Number(progressPct))) {
        factor = Math.min(Math.max(Number(progressPct) / 100, 0), 1);
      } else if (job.status === 'failed' || job.status === 'cancelled') {
        const printer = db.prepare('SELECT job_progress FROM printers WHERE id = ?').get(job.printer_id);
        if (printer?.job_progress != null) {
          factor = Math.min(Math.max(Number(printer.job_progress) / 100, 0), 1);
        }
      }
      materialGrams = plateGrams * factor;
    }
  } catch (_) { /* gcodes may be gone */ }

  const quality = computeTelemetryQuality(job);

  db.prepare(`
    UPDATE jobs
    SET energy_kwh = ?, material_grams_actual = COALESCE(?, material_grams_actual), telemetry_quality = ?
    WHERE id = ?
  `).run(energyKwh, materialGrams, quality, jobId);

  return db.prepare('SELECT * FROM jobs WHERE id = ?').get(jobId);
}

function getJobTelemetry(db, jobId) {
  const job = db.prepare(`
    SELECT jobs.*,
      printers.name AS printer_name,
      parts.name AS part_name,
      parts.erp_sku
    FROM jobs
    JOIN printers ON printers.id = jobs.printer_id
    JOIN parts ON parts.id = jobs.part_id
    WHERE jobs.id = ?
  `).get(jobId);
  if (!job) return null;

  const history = db.prepare(`
    SELECT * FROM printer_status_history
    WHERE job_id = ? OR (printer_id = ? AND started_at >= COALESCE(?, 0)
      AND (ended_at IS NULL OR ended_at <= COALESCE(?, ?)))
    ORDER BY started_at ASC
  `).all(
    jobId,
    job.printer_id,
    job.started_at,
    job.finished_at,
    Date.now()
  );

  return {
    job_id: job.id,
    printer_id: job.printer_id,
    printer_name: job.printer_name,
    part_id: job.part_id,
    part_name: job.part_name,
    erp_sku: job.erp_sku,
    status: job.status,
    started_at: job.started_at,
    finished_at: job.finished_at,
    printing_seconds: Number(job.printing_seconds) || 0,
    paused_seconds: Number(job.paused_seconds) || 0,
    sample_count: Number(job.sample_count) || 0,
    material_grams_actual: job.material_grams_actual != null ? Number(job.material_grams_actual) : null,
    energy_kwh: job.energy_kwh != null ? Number(job.energy_kwh) : null,
    telemetry_quality: job.telemetry_quality || 'none',
    history,
  };
}

function getPrinterUtilization(db, printerId, { days = 30 } = {}) {
  const printer = db.prepare('SELECT id, name FROM printers WHERE id = ?').get(printerId);
  if (!printer) return null;

  const windowMs = Math.max(1, Number(days) || 30) * 24 * 60 * 60 * 1000;
  const since = Date.now() - windowMs;

  const rows = db.prepare(`
    SELECT status,
      SUM(COALESCE(duration_ms,
        CASE WHEN ended_at IS NULL THEN (? - started_at) ELSE 0 END
      )) AS ms
    FROM printer_status_history
    WHERE printer_id = ? AND started_at >= ?
    GROUP BY status
  `).all(Date.now(), printerId, since);

  const byStatus = {};
  let totalMs = 0;
  for (const r of rows) {
    const ms = Number(r.ms) || 0;
    byStatus[r.status] = ms;
    totalMs += ms;
  }

  const printingMs = byStatus.PRINTING || 0;
  const idleMs = byStatus.IDLE || 0;
  const offlineMs = byStatus.OFFLINE || 0;
  const errorMs = (byStatus.ERROR || 0) + (byStatus.STOPPED || 0);

  const jobs = db.prepare(`
    SELECT status, COUNT(*) AS n,
      COALESCE(SUM(printing_seconds), 0) AS printing_seconds,
      COALESCE(SUM(energy_kwh), 0) AS energy_kwh
    FROM jobs
    WHERE printer_id = ? AND COALESCE(finished_at, started_at, created_at) >= ?
    GROUP BY status
  `).all(printerId, since);

  return {
    printer_id: printer.id,
    printer_name: printer.name,
    days: Number(days) || 30,
    since,
    total_ms: totalMs,
    by_status: byStatus,
    utilization_pct: totalMs > 0 ? Math.round((printingMs / totalMs) * 10000) / 100 : 0,
    printing_ms: printingMs,
    idle_ms: idleMs,
    offline_ms: offlineMs,
    error_ms: errorMs,
    jobs,
  };
}

module.exports = {
  SAMPLE_GAP_CAP_MS,
  MEASURED_COVERAGE_MIN,
  MEASURED_MIN_SAMPLES,
  recordStatusTransition,
  accumulateJobSample,
  sealJobTelemetry,
  getJobTelemetry,
  getPrinterUtilization,
  computeTelemetryQuality,
};
