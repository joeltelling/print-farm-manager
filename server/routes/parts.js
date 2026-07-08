const express = require('express');
const multer  = require('multer');
const path    = require('path');
const fs      = require('fs');
const router  = express.Router();

const GCODE_DIR = path.join(__dirname, '..', 'gcode');
const { parseGcodeFile } = require('../gcode-parser');

// Multer setup for bulk gcode uploads
if (!fs.existsSync(GCODE_DIR)) {
  fs.mkdirSync(GCODE_DIR, { recursive: true });
}
const bulkStorage = multer.diskStorage({
  destination: GCODE_DIR,
  filename: (_req, file, cb) => cb(null, Date.now() + '_' + file.originalname),
});
const bulkUpload = multer({ storage: bulkStorage });

module.exports = (db) => {
  const ACTIVE_QTY_SQL = `
    COALESCE((
      SELECT SUM(j.parts_per_plate) FROM jobs j
      WHERE j.part_id = parts.id AND j.status IN ('uploading', 'printing')
    ), 0) AS active_qty
  `;

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
  router.get('/:id/dispatch-status', (req, res) => {
    const part = db.prepare(`
      SELECT parts.*, ${ACTIVE_QTY_SQL},
             projects.status            AS project_status,
             projects.required_material AS project_material,
             projects.required_color    AS project_color
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

    // Per-gcode printer availability, using the same filters as the scheduler
    for (const gc of gcodes) {
      const requiredMaterial = gc.required_material || part.project_material || null;
      const requiredColor    = gc.required_color    || part.project_color    || null;
      const allowedGroups    = gc.allowed_groups ? JSON.parse(gc.allowed_groups) : null;

      const modelPrinters = db.prepare(
        'SELECT * FROM printers WHERE model = ? AND is_active = 1'
      ).all(gc.printer_model);

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
      const ready = materialOk.filter(p =>
        (p.status === 'IDLE' || p.status === 'FINISHED' || p.status === 'STOPPED') && p.is_held === 0
      );
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

    const dispatchable = blockers.length === 0 && anyGcodeReady;
    res.json({
      dispatchable,
      reasons: dispatchable ? [] : [...blockers, ...notes],
      notes: dispatchable ? notes : [],
    });
  });

  router.post('/', (req, res) => {
    const { project_id, name, target_qty } = req.body;
    if (!project_id || !name || !target_qty) {
      return res.status(400).json({ error: 'project_id, name, and target_qty are required' });
    }
    const now = Date.now();
    // Place the new part at the end of the project's sort order so it gets the lowest
    // dispatch priority. The operator can drag it up if they want it printed sooner.
    const maxRow = db.prepare('SELECT MAX(sort_order) AS max FROM parts WHERE project_id = ?').get(project_id);
    const sortOrder = (maxRow?.max ?? -1) + 1;
    const result = db.prepare(`
      INSERT INTO parts (project_id, name, target_qty, sort_order, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(project_id, name, parseInt(target_qty, 10), sortOrder, now, now);
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

    // Auto-calculate status when completed_qty is explicitly provided
    let resolvedStatus = part.status;
    if (completed_qty !== undefined) {
      const effectiveTarget = target_qty !== undefined ? parseInt(target_qty, 10) : part.target_qty;
      resolvedStatus = parseInt(completed_qty, 10) >= effectiveTarget ? 'closed' : 'open';
    } else if (status !== undefined) {
      resolvedStatus = status;
    }

    const now = Date.now();
    db.prepare(`
      UPDATE parts
      SET name          = COALESCE(?, name),
          target_qty    = COALESCE(?, target_qty),
          completed_qty = COALESCE(?, completed_qty),
          status        = ?,
          updated_at    = ?
      WHERE id = ?
    `).run(
      name,
      target_qty !== undefined ? parseInt(target_qty, 10) : null,
      completed_qty !== undefined ? parseInt(completed_qty, 10) : null,
      resolvedStatus,
      now,
      req.params.id
    );

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

      db.prepare('DELETE FROM parts WHERE id = ?').run(req.params.id);
    })();

    res.json({ success: true });
  });

  // POST /api/parts/bulk-import — create multiple parts with gcode files at once.
  // Accepts multipart/form-data with 'files' (multiple gcode files) and optional
  // 'defaults' JSON string for fields applied to all parts.
  // Fields per-file can be overridden via 'overrides' JSON array keyed by original filename.
  router.post('/bulk-import', bulkUpload.array('files', 200), (req, res) => {
    const { project_id, overrides } = req.body;
    const files = req.files;

    // Clean up uploaded files on any early rejection — multer has already
    // written them to disk before this handler runs.
    const cleanupFiles = () => {
      for (const f of files || []) {
        try { if (fs.existsSync(f.path)) fs.unlinkSync(f.path); } catch (_) {}
      }
    };

    if (!project_id) {
      cleanupFiles();
      return res.status(400).json({ error: 'project_id is required' });
    }

    const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(project_id);
    if (!project) {
      cleanupFiles();
      return res.status(404).json({ error: 'Project not found' });
    }

    if (!files || files.length === 0) {
      return res.status(400).json({ error: 'At least one gcode file is required' });
    }

    // Parse per-file overrides: map filename → { name, quantity, parts_per_plate, printer_model }
    let overrideMap = {};
    try {
      const arr = overrides ? JSON.parse(overrides) : [];
      for (const o of arr) {
        overrideMap[o.fn] = o;
      }
    } catch (_) {
      cleanupFiles();
      return res.status(400).json({ error: 'Invalid overrides JSON' });
    }

    // Get the current max sort_order for this project
    const maxRow = db.prepare('SELECT MAX(sort_order) AS max FROM parts WHERE project_id = ?').get(project_id);
    let nextSort = (maxRow?.max ?? -1) + 1;

    const now = Date.now();
    const results = [];

    try {
      db.transaction(() => {
        for (const file of files) {
          const ov = overrideMap[file.originalname] || {};

          // Part name: override > fallback from filename
          const ext = path.extname(file.originalname);
          const baseName = path.basename(file.originalname, ext);
          const fallbackName = baseName.replace(/[_-]/g, ' ').replace(/\s+/g, ' ').trim() || 'Imported Part';
          const partName = ov.name || fallbackName;

          // Parse gcode file content for metadata (print time, filament, etc.)
          const gcodeMeta = parseGcodeFile(file.path);

          // Printer model: override > gcode metadata
          const printerModel = ov.printer_model || gcodeMeta.printer_model || '';

          if (!printerModel) {
            throw new Error(`No printer model for "${file.originalname}" — select one in the staging table`);
          }

          // Validate printer model exists
          const modelRow = db.prepare('SELECT connector FROM printer_models WHERE model_id = ?').get(printerModel);
          if (!modelRow) {
            throw new Error(`Unknown printer model "${printerModel}" for "${file.originalname}" — add it in Settings first`);
          }

          // Bambu printers require .3mf files — reject non-.3mf at import time so
          // the operator catches the problem now rather than at dispatch time when
          // the scheduler holds the printer with a failed job.
          if (modelRow.connector === 'bambu' && !file.originalname.toLowerCase().endsWith('.3mf')) {
            throw new Error(`"${file.originalname}" is not a .3mf file — Bambu printers require .3mf files`);
          }

          const partsPerPlate = ov.parts_per_plate || 1;
          const qty = ov.quantity || 1;

          // Print time/material: gcode metadata only (not user-settable in staging)
          const estPrintSecs = gcodeMeta.estimated_time_s || null;
          const materialGrams = gcodeMeta.filament_used_g || null;

          // Create the part
          const partResult = db.prepare(`
            INSERT INTO parts (project_id, name, target_qty, print_time_seconds, material_grams, sort_order, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          `).run(project_id, partName, qty, estPrintSecs, materialGrams, nextSort, now, now);

          // Create the gcode record
          db.prepare(`
            INSERT INTO gcodes (part_id, printer_model, filename, filepath, parts_per_plate, est_print_secs, material_grams, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          `).run(partResult.lastInsertRowid, printerModel, file.originalname, file.filename, partsPerPlate, estPrintSecs, materialGrams, now);

          nextSort++;

          results.push({
            id: partResult.lastInsertRowid,
            name: partName,
            target_qty: qty,
            printer_model: printerModel,
            parts_per_plate: partsPerPlate,
            est_print_secs: estPrintSecs,
            material_grams: materialGrams,
            filament_type: gcodeMeta.filament_type || '',
            layer_height: gcodeMeta.layer_height,
            nozzle_temp: gcodeMeta.nozzle_temp,
            bed_temp: gcodeMeta.bed_temp,
          });
        }
      })();

      res.status(201).json({ parts: results, count: results.length });
    } catch (err) {
      // Clean up uploaded files on failure
      for (const file of files) {
        try { if (fs.existsSync(file.path)) fs.unlinkSync(file.path); } catch (_) {}
      }
      return res.status(400).json({ error: err.message });
    }
  });

  return router;
};
