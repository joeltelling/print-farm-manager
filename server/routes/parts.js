const express = require('express');
const path    = require('path');
const fs      = require('fs');
const partLedger = require('../partLedger');
const router  = express.Router();

const { normalizePrintTime } = require('../estimate-input');
const { candidateSql, PROJECTION_COLUMNS } = require('../candidate-query');

const GCODE_DIR = path.join(__dirname, '..', 'gcode');

// Shared message so the same hint appears whether the operator is creating a part or
// editing one.
const PRINT_TIME_HINT =
  'Cannot parse print time. Use formats like "2h15m", "90m", or "1:30:00".';

// Turns the optional operator-typed estimate into seconds, or reports why it could not.
// An empty value is not an error: the estimate is optional, and a part without one is
// scheduled at the documented default block length (see server/projection.js).
// Returns { ok: true, seconds } or { ok: false, error }.
function resolvePrintTime(raw) {
  if (raw === undefined || raw === null || raw === '') return { ok: true, seconds: null };
  const seconds = normalizePrintTime(raw);
  if (seconds === null) return { ok: false, error: PRINT_TIME_HINT };
  // Zero or negative is a typo, not "no estimate": a zero-length print would collapse to
  // a block with no duration on the schedule.
  if (seconds <= 0) return { ok: false, error: 'print_time must be greater than zero.' };
  return { ok: true, seconds };
}

// scheduler is optional, only needed at runtime for sweepIdlePrinters when adding a part
// reactivates a completed project. Tests pass null so there is no live scheduler dependency.
module.exports = (db, scheduler = null) => {
  const ACTIVE_QTY_SQL = `
    COALESCE((
      SELECT SUM(j.parts_per_plate) FROM jobs j
      WHERE j.part_id = parts.id AND j.status IN ('uploading', 'printing')
    ), 0) AS active_qty
  `;

  // Mirrors sweepIdlePrinters: the statuses an unheld printer is dispatched from.
  function isDispatchReady(p) {
    return (p.status === 'IDLE' || p.status === 'FINISHED' || p.status === 'STOPPED') && p.is_held === 0;
  }

  const activePartsStmt = db.prepare(`
    SELECT COALESCE(SUM(parts_per_plate), 0) AS total FROM jobs
    WHERE part_id = ? AND status IN ('uploading', 'printing')
  `);

  // What the scheduler would hand this printer right now: the shared candidate query
  // (server/candidate-query.js, so this cannot drift from dispatch), skipping parts whose
  // in-progress jobs already cover the remaining quantity, exactly as _reserveJob's
  // ceiling check does. Read-only: no probe job is written.
  function nextUpFor(printer) {
    const skip = [];
    while (true) {
      const row = db.prepare(candidateSql(PROJECTION_COLUMNS, skip.length)).get(
        printer.model, printer.group_name, printer.loaded_material, printer.loaded_color, ...skip
      );
      if (!row) return null;
      const remaining = Math.max(0, row.target_qty - row.completed_qty);
      if (activePartsStmt.get(row.part_id).total >= remaining) { skip.push(row.part_id); continue; }
      return row;
    }
  }

  // One printer's standing against one G-code's targeting. States are checked in the
  // same order the prose reasons use (group, then filament, then availability) so the
  // list and the sentence above it never disagree about why a printer is out.
  function describePrinter(p, partId, { requiredMaterial, requiredColor, allowedGroups }) {
    let state;
    if (allowedGroups && !allowedGroups.includes(p.group_name))          state = 'wrong_group';
    else if ((requiredMaterial && p.loaded_material !== requiredMaterial) ||
             (requiredColor    && p.loaded_color    !== requiredColor))  state = 'wrong_filament';
    else if (p.is_held === 1)                                            state = 'held';
    else if (!isDispatchReady(p))                                        state = 'busy';
    else                                                                 state = 'ready';

    let nextUp = null;
    if (state === 'ready') {
      const row = nextUpFor(p);
      if (row) {
        nextUp = {
          part_id:      row.part_id,
          part_name:    row.part_name,
          project_name: row.project_name,
          is_this_part: row.part_id === partId,
        };
      }
    }

    return {
      id:              p.id,
      name:            p.name,
      status:          p.status,
      is_held:         p.is_held,
      group_name:      p.group_name,
      loaded_material: p.loaded_material,
      loaded_color:    p.loaded_color,
      state,
      next_up:         nextUp,
    };
  }

  router.get('/', (req, res) => {
    const { project_id } = req.query;
    const parts = project_id
      ? db.prepare(`SELECT parts.*, ${ACTIVE_QTY_SQL} FROM parts WHERE project_id = ? ORDER BY sort_order ASC, created_at ASC`).all(project_id)
      : db.prepare(`SELECT parts.*, ${ACTIVE_QTY_SQL} FROM parts ORDER BY sort_order ASC, created_at ASC`).all();
    res.json(parts);
  });

  router.get('/:id', (req, res) => {
    const part = db.prepare(`SELECT parts.*, ${ACTIVE_QTY_SQL} FROM parts WHERE parts.id = ?`).get(req.params.id);
    if (!part) return res.status(404).json({ error: 'Part not found' });
    res.json(part);
  });

  // Diagnostic: why is (or isn't) this part dispatching?
  // Mirrors the scheduler's eligibility rules (sweepIdlePrinters + candidate query)
  // so operators can self-diagnose "why isn't my part printing" from the UI.
  // GET /api/parts/:id/audit: the part's quantity audit trail (see server/partLedger.js).
  router.get('/:id/audit', (req, res) => {
    const audit = partLedger.getPartAudit(db, req.params.id);
    if (!audit) return res.status(404).json({ error: 'Part not found' });
    res.json(audit);
  });

  router.get('/:id/dispatch-status', (req, res) => {
    const part = db.prepare(`
      SELECT parts.*, ${ACTIVE_QTY_SQL},
             projects.status            AS project_status,
             projects.required_material AS project_material,
             projects.required_color    AS project_color,
             projects.allowed_groups    AS project_allowed_groups
      FROM parts JOIN projects ON projects.id = parts.project_id
      WHERE parts.id = ?
    `).get(req.params.id);
    if (!part) return res.status(404).json({ error: 'Part not found' });

    // Blockers stop dispatch entirely; per-gcode notes explain why individual
    // G-codes can't run right now. The part is dispatchable if there are no
    // blockers and at least one G-code has a ready printer.
    const blockers = [];
    const notes = [];
    let anyGcodeReady = false;

    if (part.project_status !== 'active') {
      blockers.push('Project is not Active — activate it to enable dispatch');
    }
    if (part.status !== 'open') {
      blockers.push('Part is complete — target quantity reached');
    }

    const remaining = Math.max(0, part.target_qty - part.completed_qty);
    if (part.status === 'open' && part.active_qty >= remaining && remaining > 0) {
      blockers.push(`Jobs already printing cover the remaining ${remaining} part(s) — waiting for them to finish`);
    }

    const gcodes = db.prepare('SELECT * FROM gcodes WHERE part_id = ?').all(part.id);
    if (gcodes.length === 0) {
      blockers.push('No G-code uploaded — upload one per printer model this part can print on');
    }

    // Per-gcode printer availability, using the same filters as the scheduler.
    // Alongside the prose reasons, every active printer of the G-code's model is
    // listed with its match state, so the operator can see exactly which printer
    // is (or is not) a match and jump straight to it, instead of hunting for one.
    const gcodeDetails = [];
    for (const gc of gcodes) {
      const requiredMaterial = gc.required_material || part.project_material || null;
      const requiredColor    = gc.required_color    || part.project_color    || null;
      const allowedGroups    = gc.allowed_groups
        ? JSON.parse(gc.allowed_groups)
        : (part.project_allowed_groups ? JSON.parse(part.project_allowed_groups) : null);

      const modelPrinters = db.prepare(
        'SELECT * FROM printers WHERE model = ? AND is_active = 1 ORDER BY name'
      ).all(gc.printer_model);

      gcodeDetails.push({
        gcode_id:          gc.id,
        filename:          gc.filename,
        printer_model:     gc.printer_model,
        required_material: requiredMaterial,
        required_color:    requiredColor,
        allowed_groups:    allowedGroups,
        printers:          modelPrinters.map(p => describePrinter(p, part.id, { requiredMaterial, requiredColor, allowedGroups })),
      });

      if (modelPrinters.length === 0) {
        notes.push(`${gc.filename}: no active printers of model "${gc.printer_model}"`);
        continue;
      }

      const groupOk    = modelPrinters.filter(p => !allowedGroups || allowedGroups.includes(p.group_name));
      if (groupOk.length === 0) {
        notes.push(`${gc.filename}: no printers in allowed group(s) ${allowedGroups.join(', ')}`);
        continue;
      }

      const materialOk = groupOk.filter(p =>
        (!requiredMaterial || p.loaded_material === requiredMaterial) &&
        (!requiredColor    || p.loaded_color    === requiredColor)
      );
      if (materialOk.length === 0) {
        const want = [requiredMaterial, requiredColor].filter(Boolean).join(' / ');
        notes.push(`${gc.filename}: no printer has ${want} loaded (set it on the printer's detail page)`);
        continue;
      }

      // Mirrors sweepIdlePrinters eligibility: unheld STOPPED printers are
      // dispatchable (Bambu latches the stopped state until the next print starts).
      const ready = materialOk.filter(isDispatchReady);
      if (ready.length === 0) {
        const held = materialOk.filter(p => p.is_held === 1).length;
        notes.push(
          `${gc.filename}: all ${materialOk.length} matching printer(s) are busy` +
          (held > 0 ? ` (${held} awaiting operator sign-off)` : '')
        );
      } else {
        anyGcodeReady = true;
      }
    }

    // A ready, matching printer does not guarantee this part is what it prints: the
    // scheduler hands each printer the highest-priority candidate it matches, which may
    // be another part. Say so plainly rather than promising a dispatch that will not come.
    const readyPrinters = gcodeDetails.flatMap(g => g.printers.filter(p => p.state === 'ready'));
    if (blockers.length === 0 && anyGcodeReady && !readyPrinters.some(p => p.next_up?.is_this_part)) {
      notes.push('Every ready matching printer has higher-priority work queued first; this part prints after that work');
    }

    const dispatchable = blockers.length === 0 && anyGcodeReady;
    res.json({
      dispatchable,
      reasons: dispatchable ? [] : [...blockers, ...notes],
      notes: dispatchable ? notes : [],
      gcodes: gcodeDetails,
    });
  });

  router.post('/', (req, res) => {
    const { project_id, name, target_qty, print_time } = req.body;
    if (!project_id || !name || !target_qty) {
      return res.status(400).json({ error: 'project_id, name, and target_qty are required' });
    }

    // Optional estimated time to print. Used by the forward schedule as the block length
    // for this part until a sliced G-code supplies a real per-model figure.
    const printTime = resolvePrintTime(print_time);
    if (!printTime.ok) return res.status(400).json({ error: printTime.error });

    const now = Date.now();
    // Place the new part at the end of the project's sort order so it gets the lowest
    // dispatch priority. The operator can drag it up if they want it printed sooner.
    const maxRow = db.prepare('SELECT MAX(sort_order) AS max FROM parts WHERE project_id = ?').get(project_id);
    const sortOrder = (maxRow?.max ?? -1) + 1;
    const result = db.prepare(`
      INSERT INTO parts (project_id, name, target_qty, sort_order, print_time_seconds, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(project_id, name, parseInt(target_qty, 10), sortOrder, printTime.seconds, now, now);

    // A new part always starts open and unmet, so reopen a completed project immediately
    // so it's active by the time the operator uploads G-code for the part, rather than
    // requiring a separate manual reactivate step. This new part itself is NOT yet
    // dispatchable: the scheduler's candidate query joins on gcodes, and a brand-new
    // part has none, so the sweep here can't pick it up. It's still worth doing: other
    // parts already in this project (or elsewhere) may become dispatchable now that the
    // project is active again. The part becomes dispatchable, and gets its own sweep,
    // once G-code is uploaded for it (see POST /api/gcodes/upload).
    const project = db.prepare('SELECT id, status FROM projects WHERE id = ?').get(project_id);
    if (project && project.status === 'completed') {
      db.prepare("UPDATE projects SET status = 'active', updated_at = ? WHERE id = ?").run(now, project.id);
      console.log(`[server] Project ${project.id} reactivated: new part added after completion`);
      if (scheduler) scheduler.sweepIdlePrinters();
    }

    res.status(201).json(db.prepare('SELECT * FROM parts WHERE id = ?').get(result.lastInsertRowid));
  });

  // PUT /api/parts/reorder — set sort_order for a list of part IDs
  // Body: { ids: [3, 1, 2] } — ordered array; index becomes sort_order
  // Must be defined before /:id so Express doesn't match 'reorder' as an id.
  router.put('/reorder', (req, res) => {
    const { ids } = req.body;
    if (!Array.isArray(ids) || ids.length === 0) {
      return res.status(400).json({ error: 'ids must be a non-empty array' });
    }
    const update = db.prepare('UPDATE parts SET sort_order = ?, updated_at = ? WHERE id = ?');
    const now = Date.now();
    db.transaction(() => {
      ids.forEach((id, index) => update.run(index, now, id));
    })();
    res.json({ success: true });
  });

  router.put('/:id', (req, res) => {
    const part = db.prepare('SELECT * FROM parts WHERE id = ?').get(req.params.id);
    if (!part) return res.status(404).json({ error: 'Part not found' });

    const { name, target_qty, completed_qty, status } = req.body;

    // print_time: present in the body wins (an empty value clears the estimate), absent
    // keeps whatever is stored. Same convention as PUT /api/gcodes/:id.
    let printTimeSeconds = part.print_time_seconds;
    if ('print_time' in req.body) {
      const resolved = resolvePrintTime(req.body.print_time);
      if (!resolved.ok) return res.status(400).json({ error: resolved.error });
      printTimeSeconds = resolved.seconds;
    }

    // Auto-calculate status when completed_qty is explicitly provided
    let resolvedStatus = part.status;
    if (completed_qty !== undefined) {
      const effectiveTarget = target_qty !== undefined ? parseInt(target_qty, 10) : part.target_qty;
      resolvedStatus = parseInt(completed_qty, 10) >= effectiveTarget ? 'closed' : 'open';
    } else if (status !== undefined) {
      resolvedStatus = status;
    }

    const now = Date.now();
    const newCompleted = completed_qty !== undefined ? parseInt(completed_qty, 10) : null;
    db.transaction(() => {
      // completed_qty changes go through the part ledger so the audit trail records
      // the manual edit. Only an actual change is recorded: the Projects page sends
      // completed_qty with every qty save, even when only the target changed.
      if (newCompleted != null && !isNaN(newCompleted) && newCompleted !== part.completed_qty) {
        partLedger.adjustPartQty(db, {
          partId: part.id,
          setTo: newCompleted,
          source: partLedger.SOURCES.MANUAL_EDIT,
          note: `Completed count edited from ${part.completed_qty} to ${newCompleted}`,
          now,
        });
      }
      db.prepare(`
        UPDATE parts
        SET name               = COALESCE(?, name),
            target_qty         = COALESCE(?, target_qty),
            status             = ?,
            print_time_seconds = ?,
            updated_at         = ?
        WHERE id = ?
      `).run(
        name,
        target_qty !== undefined ? parseInt(target_qty, 10) : null,
        resolvedStatus,
        printTimeSeconds,
        now,
        req.params.id
      );
    })();

    // If this update reopened a closed part, also reopen the project if it was
    // completed. This happens when the operator raises target_qty via the UI
    // (which sends both completed_qty and target_qty), causing the auto-status
    // logic above to flip the part from 'closed' to 'open'. Without this, the
    // project stays 'completed' and reactivation finds nothing to reopen.
    if (part.status === 'closed' && resolvedStatus === 'open') {
      const project = db.prepare('SELECT id, status FROM projects WHERE id = ?').get(part.project_id);
      if (project && project.status === 'completed') {
        db.prepare("UPDATE projects SET status = 'active', updated_at = ? WHERE id = ?").run(now, project.id);
        console.log(`[parts] Project ${project.id} reopened — part ${part.id} target_qty raised above completed_qty`);
        if (scheduler) scheduler.sweepIdlePrinters();
      }
    }

    res.json(db.prepare('SELECT * FROM parts WHERE id = ?').get(req.params.id));
  });

  router.delete('/:id', (req, res) => {
    const part = db.prepare('SELECT * FROM parts WHERE id = ?').get(req.params.id);
    if (!part) return res.status(404).json({ error: 'Part not found' });

    // Block if any job for this part is actively uploading or printing
    const activeJob = db.prepare(
      "SELECT id FROM jobs WHERE part_id = ? AND status IN ('uploading', 'printing') LIMIT 1"
    ).get(req.params.id);
    if (activeJob) {
      return res.status(409).json({ error: 'Cannot delete — this part has an active job in progress.' });
    }

    db.transaction(() => {
      // Delete all jobs for this part — job history has no meaning without the part context.
      // (Active uploading/printing jobs are already blocked above.)
      db.prepare('DELETE FROM jobs WHERE part_id = ?').run(req.params.id);

      // Delete each gcode: remove physical file, then DB record
      const gcodes = db.prepare('SELECT * FROM gcodes WHERE part_id = ?').all(req.params.id);
      for (const gcode of gcodes) {
        const gcodeFilename = gcode.filepath.split(/[\\/]/).pop();
        const fullPath = path.join(GCODE_DIR, gcodeFilename);
        if (fs.existsSync(fullPath)) fs.unlinkSync(fullPath);
        db.prepare('DELETE FROM gcodes WHERE id = ?').run(gcode.id);
      }

      partLedger.deleteForPart(db, req.params.id);
      db.prepare('DELETE FROM parts WHERE id = ?').run(req.params.id);
    })();

    res.json({ success: true });
  });

  return router;
};
