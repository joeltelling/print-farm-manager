// Part quantity ledger: the audit trail behind parts.completed_qty.
//
// Every change to parts.completed_qty goes through adjustPartQty(), which runs the
// UPDATE and appends one ledger row in the same transaction. The ledger is written
// only from inside the events that already change the count (a FINISHED transition,
// an operator confirmation, a mark-failed, a manual edit), so it cannot credit
// anything on its own and cannot double-fire across restarts or reconnects: it
// records exactly the changes the existing code paths make, no more.
//
// server/tests/part-ledger-guard.test.js scans the server source and fails if any
// other file writes completed_qty directly, so a new path cannot silently skip the
// ledger.
//
// Rows are append-only. They are deleted only together with their part (part or
// project delete, backup restore). There are deliberately no FK constraints: printers
// can be deleted while their history stays (printer_name is a snapshot for that
// reason), and a missed cleanup must never turn a part delete into a 500.

// Every source value a ledger row can carry. The client maps these to labels.
const SOURCES = {
  PRINT_FINISHED:   'print_finished',   // scheduler saw FINISHED, credited the plate
  OPERATOR_CONFIRM: 'operator_confirm', // operator confirmed a job the scheduler never credited
  OPERATOR_ADJUST:  'operator_adjust',  // operator corrected the count of an already-credited plate
  MARKED_FAILED:    'marked_failed',    // operator marked a credited plate as a failed print
  MANUAL_EDIT:      'manual_edit',      // operator typed a new completed count on the part
  REBUILT_JOB:      'rebuilt_job',      // one-time rebuild from a finished job that predates the ledger
  BASELINE:         'baseline',         // one-time balancing row for history the old system never recorded
};

const SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS part_qty_ledger (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    part_id        INTEGER NOT NULL,
    job_id         INTEGER,
    printer_id     INTEGER,
    printer_name   TEXT,
    gcode_id       INTEGER,
    delta          INTEGER NOT NULL,
    balance_after  INTEGER NOT NULL,
    source         TEXT NOT NULL,
    note           TEXT,
    created_at     INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_part_qty_ledger_part ON part_qty_ledger(part_id, created_at);
`;

// Schema lives here, not in db.js, so there is exactly one definition. db.js calls
// ensureSchema at startup; adjustPartQty also calls it (once per connection) so route
// tests that build a minimal inline schema get the table without repeating it.
const _ensured = new WeakSet();
function ensureSchema(db) {
  if (_ensured.has(db)) return;
  db.exec(SCHEMA_SQL);
  _ensured.add(db);
}

// Change a part's completed_qty and record why.
//
//   partId    required
//   source    required, one of SOURCES
//   delta     relative change (use this OR setTo)
//   setTo     absolute new value (manual edits)
//   clamp     true to floor the result at 0, matching the MAX(0, ...) the old
//             inline SQL used on that path. Paths that never clamped pass false.
//   job       optional job row; fills job_id, printer_id, gcode_id
//   printer   optional printer row; fills printer_id and the printer_name snapshot
//   note      optional human-readable detail
//   now       timestamp (ms) for both parts.updated_at and the ledger row
//
// The ledger row stores the change that actually happened after clamping, so the
// sum of a part's ledger deltas always equals its completed_qty. Returns the
// updated part row, or null when the part does not exist (nothing is written).
function adjustPartQty(db, {
  partId, source, delta = null, setTo = null, clamp = false,
  job = null, printer = null, note = null, now = Date.now(),
}) {
  if (!Object.values(SOURCES).includes(source)) {
    throw new Error(`[partLedger] unknown source: ${source}`);
  }
  if ((delta == null) === (setTo == null)) {
    throw new Error('[partLedger] pass exactly one of delta or setTo');
  }
  ensureSchema(db);

  return db.transaction(() => {
    const before = db.prepare('SELECT completed_qty FROM parts WHERE id = ?').get(partId);
    if (!before) return null;

    if (setTo != null) {
      db.prepare('UPDATE parts SET completed_qty = ?, updated_at = ? WHERE id = ?')
        .run(setTo, now, partId);
    } else if (clamp) {
      db.prepare('UPDATE parts SET completed_qty = MAX(0, completed_qty + ?), updated_at = ? WHERE id = ?')
        .run(delta, now, partId);
    } else {
      db.prepare('UPDATE parts SET completed_qty = completed_qty + ?, updated_at = ? WHERE id = ?')
        .run(delta, now, partId);
    }

    const part = db.prepare('SELECT * FROM parts WHERE id = ?').get(partId);
    const actualDelta = (part.completed_qty || 0) - (before.completed_qty || 0);

    const printerId = printer?.id ?? job?.printer_id ?? null;
    let printerName = printer?.name ?? null;
    if (printerName == null && printerId != null) {
      printerName = db.prepare('SELECT name FROM printers WHERE id = ?').get(printerId)?.name ?? null;
    }

    db.prepare(`
      INSERT INTO part_qty_ledger
        (part_id, job_id, printer_id, printer_name, gcode_id, delta, balance_after, source, note, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      partId, job?.id ?? null, printerId, printerName, job?.gcode_id ?? null,
      actualDelta, part.completed_qty || 0, source, note, now
    );

    return part;
  })();
}

// Delete a part's ledger rows. Called wherever the part itself is deleted.
function deleteForPart(db, partId) {
  ensureSchema(db);
  db.prepare('DELETE FROM part_qty_ledger WHERE part_id = ?').run(partId);
}

// One-time history rebuild for parts that have no ledger rows yet: existing parts on
// the first start after upgrading, and parts restored from a backup that predates the
// ledger. Parts created after the upgrade get a ledger row on their first credit, so
// they never qualify with a non-zero count and this is a no-op for them.
//
// Each finished job becomes a rebuilt_job row (+parts_per_plate at its finish time).
// 'done' is a legacy alias for 'finished' still present in older installs' data (see
// DONE_STATUSES in routes/dashboard.js), so it counts too.
// Failed jobs are NOT rebuilt as deductions: the old schema cannot tell a job that was
// credited then marked failed from one that was never credited, and the net effect on
// the count is zero either way. The audit endpoint lists them as uncredited failures.
//
// The old system never stored operator count corrections or manual edits, so the
// rebuilt rows may not add up to completed_qty. One baseline row, dated at the time of
// the rebuild, covers the difference and says so, instead of guessing where it went.
//
// Never changes parts.completed_qty. Returns { parts, rebuiltRows, baselineRows }.
function rebuildMissingLedgers(db, { now = Date.now() } = {}) {
  ensureSchema(db);

  const parts = db.prepare(`
    SELECT p.id, p.completed_qty FROM parts p
    WHERE NOT EXISTS (SELECT 1 FROM part_qty_ledger l WHERE l.part_id = p.id)
  `).all();

  const finishedJobs = db.prepare(`
    SELECT j.*, pr.name AS printer_name FROM jobs j
    LEFT JOIN printers pr ON pr.id = j.printer_id
    WHERE j.part_id = ? AND j.status IN ('finished', 'done')
    ORDER BY COALESCE(j.finished_at, j.started_at, j.created_at), j.id
  `);
  const insert = db.prepare(`
    INSERT INTO part_qty_ledger
      (part_id, job_id, printer_id, printer_name, gcode_id, delta, balance_after, source, note, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const result = { parts: 0, rebuiltRows: 0, baselineRows: 0 };

  db.transaction(() => {
    for (const part of parts) {
      const current = part.completed_qty || 0;
      const jobs = finishedJobs.all(part.id);
      if (jobs.length === 0 && current === 0) continue;

      let balance = 0;
      for (const job of jobs) {
        balance += job.parts_per_plate;
        insert.run(
          part.id, job.id, job.printer_id, job.printer_name ?? null, job.gcode_id ?? null,
          job.parts_per_plate, balance, SOURCES.REBUILT_JOB,
          'Rebuilt from job history (recorded before audit tracking)',
          job.finished_at ?? job.started_at ?? job.created_at
        );
        result.rebuiltRows++;
      }

      if (balance !== current) {
        insert.run(
          part.id, null, null, null, null, current - balance, current, SOURCES.BASELINE,
          'Unrecorded prior adjustments (operator count changes or manual edits before audit tracking)',
          now
        );
        result.baselineRows++;
      }
      result.parts++;
    }
  })();

  return result;
}

// Sources whose rows represent one plate crediting the part (for per-printer plate counts).
const PLATE_CREDIT_SOURCES = [SOURCES.PRINT_FINISHED, SOURCES.OPERATOR_CONFIRM, SOURCES.REBUILT_JOB];

// Everything the part audit page needs, in one read. Returns null when the part does
// not exist.
//
//   entries              ledger rows, oldest first, joined to job and gcode details
//   uncredited_failures  jobs that started printing and ended failed or cancelled
//                        without ever changing the count (no ledger row). These are
//                        context only: they had no effect on completed_qty.
//   printers             per-printer summary, largest net contribution first. Rows with
//                        no printer (manual edits, baseline) are grouped under
//                        printer_id null.
//   reconciliation       ledger_sum vs completed_qty; matches is false if they differ
function getPartAudit(db, partId) {
  ensureSchema(db);

  const part = db.prepare(`
    SELECT id, project_id, name, target_qty, completed_qty, status, created_at, updated_at
    FROM parts WHERE id = ?
  `).get(partId);
  if (!part) return null;

  const project = db.prepare('SELECT id, name, status FROM projects WHERE id = ?').get(part.project_id) || null;

  const entries = db.prepare(`
    SELECT l.id, l.created_at, l.source, l.delta, l.balance_after, l.note,
           l.job_id, l.printer_id, l.printer_name, l.gcode_id,
           pr.id IS NOT NULL AS printer_exists,
           pr.name           AS printer_current_name,
           g.filename        AS gcode_filename,
           j.parts_per_plate AS parts_per_plate,
           j.status          AS job_status,
           j.started_at      AS job_started_at,
           j.finished_at     AS job_finished_at
    FROM part_qty_ledger l
    LEFT JOIN printers pr ON pr.id = l.printer_id
    LEFT JOIN gcodes   g  ON g.id  = l.gcode_id
    LEFT JOIN jobs     j  ON j.id  = l.job_id
    WHERE l.part_id = ?
    ORDER BY l.created_at, l.id
  `).all(partId).map(e => ({ ...e, printer_exists: !!e.printer_exists }));

  // started_at excludes queued jobs cancelled when the part closed (never printed).
  // 'failed' jobs from a previous session that the scheduler recovered are 'finished'
  // by now, so they are not listed here.
  const uncreditedFailures = db.prepare(`
    SELECT j.id AS job_id, j.status, j.parts_per_plate, j.started_at, j.finished_at,
           COALESCE(j.finished_at, j.started_at) AS created_at,
           j.printer_id, pr.name AS printer_name, pr.id IS NOT NULL AS printer_exists,
           j.gcode_id, g.filename AS gcode_filename
    FROM jobs j
    LEFT JOIN printers pr ON pr.id = j.printer_id
    LEFT JOIN gcodes   g  ON g.id  = j.gcode_id
    WHERE j.part_id = ?
      AND j.status IN ('failed', 'cancelled')
      AND j.started_at IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM part_qty_ledger l WHERE l.job_id = j.id)
    ORDER BY COALESCE(j.finished_at, j.started_at), j.id
  `).all(partId).map(f => ({ ...f, printer_exists: !!f.printer_exists }));

  const byPrinter = new Map();
  const bucket = (printerId, name, exists) => {
    const key = printerId ?? 'none';
    if (!byPrinter.has(key)) {
      byPrinter.set(key, {
        printer_id: printerId ?? null, printer_name: name ?? null, printer_exists: !!exists,
        plates: 0, added: 0, removed: 0, net: 0, failed_plates: 0,
      });
    }
    return byPrinter.get(key);
  };
  for (const e of entries) {
    const b = bucket(e.printer_id, e.printer_current_name ?? e.printer_name, e.printer_exists);
    if (PLATE_CREDIT_SOURCES.includes(e.source)) b.plates++;
    if (e.source === SOURCES.MARKED_FAILED) b.failed_plates++;
    if (e.delta > 0) b.added += e.delta;
    if (e.delta < 0) b.removed -= e.delta;
    b.net += e.delta;
  }
  for (const f of uncreditedFailures) {
    bucket(f.printer_id, f.printer_name, f.printer_exists).failed_plates++;
  }
  const printers = [...byPrinter.values()].sort((a, b) =>
    (a.printer_id == null) - (b.printer_id == null) || b.net - a.net || String(a.printer_name).localeCompare(String(b.printer_name)));

  const ledgerSum = entries.reduce((sum, e) => sum + e.delta, 0);

  return {
    part,
    project,
    entries,
    uncredited_failures: uncreditedFailures,
    printers,
    reconciliation: {
      ledger_sum: ledgerSum,
      completed_qty: part.completed_qty || 0,
      matches: ledgerSum === (part.completed_qty || 0),
    },
  };
}

module.exports = { SOURCES, ensureSchema, adjustPartQty, deleteForPart, rebuildMissingLedgers, getPartAudit };
