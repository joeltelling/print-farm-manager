// Forward-looking schedule: what each printer is expected to run next, and when.
//
// Strictly read-only. Nothing in this file writes to the database, creates a job row, or
// touches parts.completed_qty. It answers "if the farm keeps doing what it is doing, what
// happens next" by replaying the scheduler's own selection rules against a simulated
// clock. A projection that could write would be a second dispatch path, and this farm
// already learned what a second path that credits quantity costs.
//
// How a printer's availability is decided
// ---------------------------------------
// Busy or free comes from the jobs table, not from printers.status. A job row is written
// synchronously the moment the scheduler reserves a dispatch, while printers.status is
// only refreshed by the 15 s poll, so a printer that was just handed a plate still reads
// FINISHED or IDLE for several seconds. Trusting the polled status there would show a
// just-dispatched printer as free and project a phantom second job onto it.
//
// Live time-remaining from the printer is preferred over the stored estimate for the job
// actually running, since the printer knows better than the slicer did.
//
// The operator model (the farm is staffed, not lights-out)
// -------------------------------------------------------
// A print does not roll straight into the next one: the plate has to be swapped and the
// result signed off. So every finish is followed by a changeover, and a finish outside
// staffed hours waits for the morning. These are farm policy, not physics, and they are
// reported to the client in `assumptions` so the page can state them rather than presenting
// the projection as fact.
//
// Ties
// ----
// When several printers come free close enough together to count as simultaneous and more
// than one of them can take the highest-priority part, the winner is picked at random
// among them. The generator is seeded from the schedule fingerprint, so an unchanged farm
// re-renders an identical schedule instead of shuffling blocks every time the page polls,
// while any real change reshuffles the tie.

const { candidateSql, PROJECTION_COLUMNS } = require('./candidate-query');
const { fingerprint } = require('./schedule-state');

// Block length used when neither the G-code nor the part carries an estimate. Blocks that
// fall back to this are flagged time_unknown so the page can label them instead of
// presenting two hours as though it were measured.
const DEFAULT_PRINT_SECS = 7200; // 2 h

// Plate swap plus operator sign-off between two prints on the same printer. Must exceed
// the time a person actually needs to walk over, clear the bed, and confirm quality;
// under-stating it makes every projected start time optimistic and compounds down the lane.
const CHANGEOVER_SECS = 15 * 60;

// Staffed hours, local time on the server. A print that finishes inside this window is
// signed off when it finishes; one that finishes outside it waits for the next STAFFED
// _START_HOUR, because nobody is there to swap the plate. STAFFED_END_HOUR is the hour
// after which no more changeovers happen, so it must be the end of the last shift, not
// the moment the building locks.
const STAFFED_START_HOUR = 6;  // 06:00
const STAFFED_END_HOUR   = 22; // 22:00

// Two printers "finish at the same time" if their free moments land within this window.
// Exact millisecond equality would almost never happen against live printer estimates,
// which would make the random tie-break dead code and let sub-second noise decide which
// printer gets the highest-priority part. Must be small enough that a real ordering
// difference is still respected.
const TIE_WINDOW_MS = 60 * 1000;

const DEFAULT_HORIZON_HOURS = 24;
const MAX_HORIZON_HOURS     = 24 * 7;

// Safety rails. A farm with many printers and large open quantities can project a lot of
// blocks; these keep one request from turning into an unbounded loop if a rule above ever
// stops shrinking remaining demand.
const MAX_PROJECTED_BLOCKS = 2000;
const MAX_ITERATIONS       = 10000;

// Mirrors sweepIdlePrinters in server/scheduler.js: these are the statuses an unheld
// printer can be dispatched to. READY is deliberately absent, because dispatch does not
// pick it up either, and a schedule that disagrees with dispatch is worse than an honest
// gap.
const DISPATCHABLE_IDLE_STATUSES = new Set(['IDLE', 'FINISHED', 'STOPPED']);

// Statuses that mean the plate is off the nozzle, whatever the job row still says. A job
// left as 'printing' against a printer reporting one of these has finished in the real
// world and is waiting to be resolved (the "awaiting sign-off" case Jobs.jsx renders):
// drawing its block out to the original estimate would invent time the farm is not using.
// OFFLINE and ERROR are absent on purpose, because a printer can be unreachable while its
// print carries on, which is exactly the transient MQTT case the scheduler protects.
const PRINT_OVER_STATUSES = new Set(['FINISHED', 'IDLE', 'STOPPED']);

// A job younger than this is treated as genuinely running even when the printer's stored
// status still says FINISHED or IDLE, because the poll that would have reported PRINTING
// has not happened yet. Without this window, a plate dispatched seconds ago would be read
// as already over, its block would collapse, and the lane would project a phantom next
// job on top of a printer that is actually busy.
//
// Must match STALE_JOB_GRACE_MS in server/scheduler.js, which draws the same
// freshly-dispatched versus stale line for the same reason. If one changes, change both.
const FRESH_DISPATCH_GRACE_MS = 90000;

// ── Clock helpers ────────────────────────────────────────────────────────────────

// The moment a human is next available to sign off, given something finished at `ms`.
function nextStaffedMoment(ms) {
  const at = new Date(ms);
  const hour = at.getHours();
  if (hour >= STAFFED_START_HOUR && hour < STAFFED_END_HOUR) return ms;

  const next = new Date(ms);
  // After the last shift, the next opportunity is tomorrow morning; before the first
  // shift (the small hours), it is this morning.
  if (hour >= STAFFED_END_HOUR) next.setDate(next.getDate() + 1);
  next.setHours(STAFFED_START_HOUR, 0, 0, 0);
  return next.getTime();
}

// When a printer that finished at `endMs` can start its next print.
function nextAvailableAfter(endMs) {
  return nextStaffedMoment(endMs) + CHANGEOVER_SECS * 1000;
}

// ── Estimates ────────────────────────────────────────────────────────────────────

// G-code estimate wins (it is per plate and per model, parsed from the sliced file),
// then the part-level operator estimate, then the documented default.
function effectiveEstimate(estPrintSecs, partPrintTimeSeconds) {
  if (estPrintSecs > 0)          return { secs: estPrintSecs,        source: 'gcode',   unknown: false };
  if (partPrintTimeSeconds > 0)  return { secs: partPrintTimeSeconds, source: 'part',    unknown: false };
  return { secs: DEFAULT_PRINT_SECS, source: 'default', unknown: true };
}

// ── Seeded shuffle ───────────────────────────────────────────────────────────────

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function seedFromFingerprint(fp) {
  return parseInt(String(fp).slice(0, 8), 16) >>> 0 || 1;
}

// Fisher-Yates, in place, using the seeded generator.
function shuffleInPlace(arr, rng) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

// ── Projection ───────────────────────────────────────────────────────────────────

function clampHorizonHours(raw) {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_HORIZON_HOURS;
  return Math.min(MAX_HORIZON_HOURS, Math.max(1, n));
}

function projectSchedule(db, options = {}) {
  const now           = options.now ?? Date.now();
  const horizonHours  = clampHorizonHours(options.horizonHours);
  const version       = options.version ?? fingerprint(db);
  const horizonEnd    = now + horizonHours * 3600 * 1000;
  const rng           = mulberry32(seedFromFingerprint(version));

  const printers = db.prepare(`
    SELECT id, name, model, group_name, status, is_held, job_time_remaining,
           loaded_material, loaded_color
    FROM printers WHERE is_active = 1
    ORDER BY COALESCE(group_name, '') COLLATE NOCASE, name COLLATE NOCASE
  `).all();

  const activeJobStmt = db.prepare(`
    SELECT jobs.id, jobs.part_id, jobs.gcode_id, jobs.status, jobs.parts_per_plate,
           jobs.started_at, jobs.created_at,
           parts.name               AS part_name,
           parts.print_time_seconds AS part_print_time_seconds,
           parts.project_id,
           projects.name            AS project_name,
           gcodes.est_print_secs,
           gcodes.filename
    FROM jobs
    JOIN parts    ON parts.id    = jobs.part_id
    JOIN projects ON projects.id = parts.project_id
    LEFT JOIN gcodes ON gcodes.id = jobs.gcode_id
    WHERE jobs.printer_id = ? AND jobs.status IN ('uploading', 'printing')
    ORDER BY jobs.created_at DESC
    LIMIT 1
  `);

  const blocks = [];
  const lanes  = [];
  const printerRows = [];

  for (const printer of printers) {
    const job = activeJobStmt.get(printer.id);
    let availableAt = null;
    let blockedReason = null;

    if (job) {
      const est = effectiveEstimate(job.est_print_secs, job.part_print_time_seconds);
      const jobAge = now - (job.started_at ?? job.created_at);
      let end;
      if (job.status === 'printing') {
        // The printer's own countdown beats a pre-print estimate, but only while it is
        // really printing: a stale time_remaining from a finished or offline printer
        // would move the block for no reason.
        if (printer.status === 'PRINTING' && printer.job_time_remaining > 0) {
          end = now + printer.job_time_remaining * 1000;
        } else if (PRINT_OVER_STATUSES.has(printer.status) && jobAge > FRESH_DISPATCH_GRACE_MS) {
          // The printer says the plate is done while the job row still says printing: the
          // print is over and waiting on a person, so the block ends now rather than
          // running on to an estimate the farm has already outlived.
          end = now;
        } else {
          end = (job.started_at ?? job.created_at) + est.secs * 1000;
        }
      } else {
        // Still uploading: the print has not begun, so the plate's clock starts now.
        end = now + est.secs * 1000;
      }
      // A print past its estimate is finishing imminently, not in the past.
      const start = job.status === 'printing' ? (job.started_at ?? job.created_at) : now;
      if (end < now) end = now;

      blocks.push({
        id: `job-${job.id}`,
        kind: 'active',
        printer_id: printer.id,
        job_id: job.id,
        job_status: job.status,
        part_id: job.part_id,
        part_name: job.part_name,
        project_id: job.project_id,
        project_name: job.project_name,
        gcode_id: job.gcode_id,
        filename: job.filename ?? null,
        parts_per_plate: job.parts_per_plate,
        start,
        end,
        est_secs: Math.max(1, Math.round((end - start) / 1000)),
        time_source: est.source,
        time_unknown: est.unknown,
      });

      availableAt = nextAvailableAfter(end);
    } else if (printer.is_held) {
      // Holds are resolved by a person. The plate is still on the bed, so the next print
      // cannot start until someone clears it, which is a changeover from now.
      availableAt = nextAvailableAfter(now);
      blockedReason = 'Awaiting operator sign-off';
    } else if (DISPATCHABLE_IDLE_STATUSES.has(printer.status)) {
      // Unheld and idle means the last plate was already cleared and confirmed.
      availableAt = now;
    } else {
      blockedReason = `Printer is ${printer.status}`;
    }

    printerRows.push({
      id: printer.id,
      name: printer.name,
      model: printer.model,
      group_name: printer.group_name,
      status: printer.status,
      is_held: printer.is_held,
      available_at: availableAt,
      blocked_reason: blockedReason,
    });

    if (availableAt !== null) {
      lanes.push({
        printer_id: printer.id,
        model: printer.model,
        group_name: printer.group_name,
        loaded_material: printer.loaded_material,
        loaded_color: printer.loaded_color,
        availableAt,
        seq: 0,
      });
    }
  }

  // Quantity already committed per part by jobs in flight. Projected blocks add to this
  // as they are placed, which is what stops every printer from piling onto the same part.
  const plannedQty = new Map();
  for (const row of db.prepare(`
    SELECT part_id, SUM(parts_per_plate) AS qty FROM jobs
    WHERE status IN ('uploading', 'printing') GROUP BY part_id
  `).all()) {
    plannedQty.set(row.part_id, row.qty);
  }

  // Parts with nothing left to plan. Passed to the candidate query as an exclusion list so
  // a printer falls through to the next part down the priority order, exactly as
  // _reserveJob does when it hits a part's ceiling.
  const fullyPlanned = new Set();
  let truncated = false;

  function tryAssign(lane) {
    const skip = [...fullyPlanned];
    for (;;) {
      const row = db.prepare(candidateSql(PROJECTION_COLUMNS, skip.length)).get(
        lane.model, lane.group_name, lane.loaded_material, lane.loaded_color, ...skip
      );
      if (!row) return null;

      const committed = plannedQty.get(row.part_id) || 0;
      const remaining = row.target_qty - row.completed_qty - committed;
      if (remaining <= 0) {
        fullyPlanned.add(row.part_id);
        skip.push(row.part_id);
        continue;
      }

      const est   = effectiveEstimate(row.est_print_secs, row.print_time_seconds);
      const start = lane.availableAt;
      const end   = start + est.secs * 1000;

      const nowCommitted = committed + row.parts_per_plate;
      plannedQty.set(row.part_id, nowCommitted);
      if (row.target_qty - row.completed_qty - nowCommitted <= 0) fullyPlanned.add(row.part_id);

      lane.availableAt = nextAvailableAfter(end);
      lane.seq += 1;

      return {
        id: `proj-${lane.printer_id}-${lane.seq}`,
        kind: 'projected',
        printer_id: lane.printer_id,
        job_id: null,
        job_status: null,
        part_id: row.part_id,
        part_name: row.part_name,
        project_id: row.project_id,
        project_name: row.project_name,
        gcode_id: row.gcode_id,
        filename: row.filename,
        parts_per_plate: row.parts_per_plate,
        start,
        end,
        est_secs: est.secs,
        time_source: est.source,
        time_unknown: est.unknown,
      };
    }
  }

  let open = lanes.slice();
  let iterations = 0;
  while (open.length > 0) {
    if (++iterations > MAX_ITERATIONS || blocks.length >= MAX_PROJECTED_BLOCKS) {
      truncated = true;
      break;
    }

    // Lanes whose next slot is past the horizon stop being projected. Their remaining
    // demand is reported as beyond_horizon rather than silently dropped.
    const withinHorizon = open.filter(l => l.availableAt <= horizonEnd);
    if (withinHorizon.length === 0) {
      if (open.length > 0) truncated = true;
      break;
    }

    const earliest = Math.min(...withinHorizon.map(l => l.availableAt));
    const tied = withinHorizon.filter(l => l.availableAt - earliest <= TIE_WINDOW_MS);
    // The random pick that the tie-break rule asks for: seeded, so it is stable for a
    // given farm state.
    if (tied.length > 1) shuffleInPlace(tied, rng);

    const exhausted = new Set();
    for (const lane of tied) {
      const block = tryAssign(lane);
      if (block) {
        blocks.push(block);
      } else {
        // Demand only shrinks during a projection, so a lane with no candidate now can
        // never gain one later. Dropping it is what guarantees this loop terminates.
        exhausted.add(lane.printer_id);
      }
    }
    if (exhausted.size > 0) open = open.filter(l => !exhausted.has(l.printer_id));
  }

  // Open demand the projection could not place, so the page can say so instead of looking
  // complete. The per-part explanation already exists as
  // GET /api/parts/:id/dispatch-status, which is where the UI sends the operator next.
  const unscheduled = [];
  for (const part of db.prepare(`
    SELECT parts.id, parts.name, parts.target_qty, parts.completed_qty,
           projects.name AS project_name
    FROM parts JOIN projects ON projects.id = parts.project_id
    WHERE parts.status = 'open' AND projects.status = 'active'
    ORDER BY projects.priority ASC, parts.sort_order ASC
  `).all()) {
    const remaining = part.target_qty - part.completed_qty - (plannedQty.get(part.id) || 0);
    if (remaining <= 0) continue;
    unscheduled.push({
      part_id: part.id,
      part_name: part.name,
      project_name: part.project_name,
      remaining_qty: remaining,
      reason: truncated ? 'beyond_horizon' : 'no_eligible_printer',
    });
  }

  // Stable per-project colour slots, ordered by dispatch priority so the highest-priority
  // project keeps the same colour as the schedule evolves.
  const projectOrder = [];
  for (const b of blocks) {
    if (b.project_id != null && !projectOrder.includes(b.project_id)) projectOrder.push(b.project_id);
  }
  const projects = db.prepare(`
    SELECT id, name, priority FROM projects
    WHERE id IN (${projectOrder.map(() => '?').join(',') || 'NULL'})
    ORDER BY priority ASC, created_at ASC
  `).all(...projectOrder).map((p, i) => ({ ...p, color_index: i }));

  blocks.sort((a, b) => a.start - b.start || a.printer_id - b.printer_id);

  return {
    version,
    computed_at: Date.now(),
    now,
    horizon_hours: horizonHours,
    horizon_end: horizonEnd,
    truncated,
    assumptions: {
      default_print_secs: DEFAULT_PRINT_SECS,
      changeover_secs: CHANGEOVER_SECS,
      staffed_start_hour: STAFFED_START_HOUR,
      staffed_end_hour: STAFFED_END_HOUR,
      tie_window_secs: TIE_WINDOW_MS / 1000,
    },
    printers: printerRows,
    projects,
    blocks,
    unscheduled,
  };
}

module.exports = {
  projectSchedule,
  nextStaffedMoment,
  nextAvailableAfter,
  effectiveEstimate,
  clampHorizonHours,
  DEFAULT_PRINT_SECS,
  CHANGEOVER_SECS,
  STAFFED_START_HOUR,
  STAFFED_END_HOUR,
  TIE_WINDOW_MS,
  FRESH_DISPATCH_GRACE_MS,
  DEFAULT_HORIZON_HOURS,
  MAX_HORIZON_HOURS,
};
