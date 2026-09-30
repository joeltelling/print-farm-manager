// Operator "N good" confirmations on an already-credited finished job.
//
// When a print finishes, _handleFinished credits the full plate. The operator then
// confirms how many parts were actually good (Set Ready, or Complete and Decommission),
// and the difference is applied to the part. Two request shapes are supported:
//
//   total (the request carries job_id, as the Fleet page sends): confirmed_qty is the
//     plate's TOTAL good count. The part is adjusted by confirmed_qty minus what the
//     job currently contributes (its ledger net). Confirming the same number again
//     changes nothing, so a printer re-held against the same job can never apply a
//     correction twice or re-credit one.
//   legacy (no job_id: older clients, scripts): confirmed_qty is compared to
//     parts_per_plate, exactly as before this module existed.
//
// The total shape is only safe if the operator saw the same job the server corrects.
// finishedConfirmTarget() is the single rule for "which job does a confirmation
// correct", used both by GET /api/printers (to pre-fill the Fleet input and hand out
// the job_id) and by the endpoints (to check it). A job_id that no longer matches is a
// 409: the printer's state changed since the page loaded, and the operator re-confirms
// against fresh data instead of the server guessing.

const partLedger = require('./partLedger');

// The finished job an "N good" confirmation corrects, or null when the confirmation
// takes a different path (an uploading or printing job is pending, or a job stopped on
// the printer after the last finish, which set-ready resolves as a missed finish).
// This is set-ready's normal-case selection; keep it the only copy.
function finishedConfirmTarget(db, printerId) {
  const pending = db.prepare(
    "SELECT 1 FROM jobs WHERE printer_id = ? AND status IN ('uploading', 'printing') LIMIT 1"
  ).get(printerId);
  if (pending) return null;

  const finished = db.prepare(`
    SELECT * FROM jobs WHERE printer_id = ? AND status = 'finished'
    ORDER BY finished_at DESC LIMIT 1
  `).get(printerId);
  if (!finished) return null;

  const newerCancelled = db.prepare(`
    SELECT 1 FROM jobs WHERE printer_id = ? AND status = 'cancelled' AND finished_at > ? LIMIT 1
  `).get(printerId, finished.finished_at);
  return newerCancelled ? null : finished;
}

// Parses an optional job_id from a request body. Returns null when absent, NaN when
// present but not a number (callers treat NaN as a mismatch).
function parseJobId(body) {
  if (!body || body.job_id == null || body.job_id === '') return null;
  return parseInt(body.job_id, 10);
}

// True when a job_id was sent and does not name the job a confirmation would correct.
function jobIdMismatch(db, printerId, jobId) {
  if (jobId == null) return false;
  const target = finishedConfirmTarget(db, printerId);
  return !target || target.id !== jobId;
}

const JOB_CHANGED_ERROR =
  "This printer's last print changed since the page loaded. Refresh and confirm the count again.";

// Applies an operator's confirmed good count to an already-credited finished job.
// `total` selects the request shape described above. Returns { part, delta, credited }
// when the count changed, or null when there was nothing to apply.
function applyConfirmedCount(db, { job, printer, confirmedQty, total, via, now = Date.now() }) {
  if (confirmedQty == null || isNaN(confirmedQty)) return null;
  const credited = total ? partLedger.jobNetCredit(db, job) : job.parts_per_plate;
  if (confirmedQty === credited) return null;

  const delta = confirmedQty - credited; // negative = fewer good parts
  const part = partLedger.adjustPartQty(db, {
    partId: job.part_id,
    delta,
    clamp: true,
    source: partLedger.SOURCES.OPERATOR_ADJUST,
    job,
    printer,
    note: `Operator confirmed ${confirmedQty} of ${job.parts_per_plate} good (${via})`,
    now,
  });
  return { part, delta, credited };
}

module.exports = { finishedConfirmTarget, parseJobId, jobIdMismatch, applyConfirmedCount, JOB_CHANGED_ERROR };
