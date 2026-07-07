const express = require('express');
const multer = require('multer');
const Papa = require('papaparse');
const axios = require('axios');
const router = express.Router();
const events = require('../events');
const drivers = require('../drivers');

const upload = multer({ storage: multer.memoryStorage() });

const NO_API_KEY_TYPES = new Set(['elegoo-centauri', 'klipper']); // types that store no api_key

// Normalize a raw model string to a canonical ID (lowercase, trimmed).
// Validation against the registered model list is done via DB query at each call site.
function normalizeModel(raw) {
  if (!raw) return null;
  return raw.trim().toLowerCase() || null;
}

// Fallback: infer model from printer name when no model column is present.
function inferModel(name) {
  if (/^MK4S_/i.test(name)) return 'mk4s';
  if (/^MK4_/i.test(name))  return 'mk4';
  if (/^(CoreOneL_|Core1L_|C1L )/i.test(name)) return 'c1l';
  if (/^(CoreOne_|Core1_|C1 )/i.test(name))   return 'c1';
  if (/^XL_/i.test(name))   return 'xl';
  return null;
}

// Resolve model: explicit CSV column wins; name inference is the fallback.
function resolveModel(rawModel, name) {
  return normalizeModel(rawModel) || inferModel(name);
}

module.exports = (db) => {
  // GET /api/printers — list active printers only
  // Includes last_parts_per_plate from the most recent job (finished/printing/failed/cancelled),
  // used by the Fleet UI to pre-fill the confirmed-qty input on held printers.
  // Includes has_active_job — true when an uploading/printing job exists, used to
  // distinguish a held OFFLINE printer whose job is still running from one with no job.
  router.get('/', (req, res) => {
    const printers = db.prepare(`
      SELECT p.*,
        (SELECT j.parts_per_plate FROM jobs j
          WHERE j.printer_id = p.id AND j.status IN ('finished', 'printing', 'failed', 'cancelled')
          ORDER BY COALESCE(j.finished_at, j.started_at) DESC LIMIT 1
        ) AS last_parts_per_plate,
        EXISTS(
          SELECT 1 FROM jobs j WHERE j.printer_id = p.id AND j.status IN ('uploading', 'printing')
        ) AS has_active_job,
        EXISTS(
          SELECT 1 FROM jobs j WHERE j.printer_id = p.id AND j.status = 'uploading'
        ) AS has_uploading_job,
        (SELECT g.filename FROM jobs j JOIN gcodes g ON g.id = j.gcode_id
          WHERE j.printer_id = p.id AND j.status = 'uploading'
          ORDER BY j.created_at DESC LIMIT 1
        ) AS uploading_job_name,
        EXISTS(
          SELECT 1 FROM jobs j WHERE j.printer_id = p.id AND j.status = 'printing'
        ) AS has_printing_job
      FROM printers p
      WHERE p.is_active = 1
      ORDER BY p.name
    `).all();
    res.json(printers);
  });

  // GET /api/printers/groups — distinct non-null group names from active printers
  router.get('/groups', (req, res) => {
    const { model } = req.query;
    const groups = model
      ? db.prepare(
          "SELECT DISTINCT group_name FROM printers WHERE is_active = 1 AND group_name IS NOT NULL AND model = ? ORDER BY group_name"
        ).all(model).map(r => r.group_name)
      : db.prepare(
          "SELECT DISTINCT group_name FROM printers WHERE is_active = 1 AND group_name IS NOT NULL ORDER BY group_name"
        ).all().map(r => r.group_name);
    res.json(groups);
  });

  // GET /api/printers/filaments — distinct loaded_material and loaded_color values across all printers
  router.get('/filaments', (req, res) => {
    const materials = db.prepare(
      "SELECT DISTINCT loaded_material FROM printers WHERE loaded_material IS NOT NULL AND loaded_material != '' ORDER BY loaded_material"
    ).all().map(r => r.loaded_material);
    const colors = db.prepare(
      "SELECT DISTINCT loaded_color FROM printers WHERE loaded_color IS NOT NULL AND loaded_color != '' ORDER BY loaded_color"
    ).all().map(r => r.loaded_color);
    res.json({ materials, colors });
  });

  // GET /api/printers/decommissioned — list decommissioned printers
  router.get('/decommissioned', (req, res) => {
    const printers = db.prepare('SELECT * FROM printers WHERE is_active = 0 ORDER BY decommissioned_at DESC').all();
    res.json(printers);
  });

  // GET /api/printers/ams?model=x1c — returns AMS slot list from any connected
  // Bambu printer of the given model. Returns [] if none is connected or model
  // is not a Bambu type. Used by the upload form to populate the slot picker.
  router.get('/ams', (req, res) => {
    const { model } = req.query;
    if (!model) return res.json([]);

    const printer = db.prepare(
      "SELECT * FROM printers WHERE model = ? AND type = 'bambu' AND is_active = 1 LIMIT 1"
    ).get(model);
    if (!printer) return res.json([]);

    const { getAmsSlots } = require('../drivers/bambu');
    const slots = getAmsSlots(printer);
    res.json(slots || []);
  });

  // GET /api/printers/:id
  router.get('/:id', (req, res) => {
    const printer = db.prepare('SELECT * FROM printers WHERE id = ?').get(req.params.id);
    if (!printer) return res.status(404).json({ error: 'Printer not found' });
    res.json(printer);
  });

  // POST /api/printers — add single printer
  router.post('/', (req, res) => {
    const { name, ip, api_key, serial_number, group_name, type, model } = req.body;
    const printerType = type || 'prusa';
    const requiresApiKey = !NO_API_KEY_TYPES.has(printerType);
    if (!name || !ip || !model || (requiresApiKey && !api_key)) {
      const keyMsg = requiresApiKey ? ', api_key' : '';
      return res.status(400).json({ error: `name, ip${keyMsg}, and model are required` });
    }
    const normalized = normalizeModel(model);
    if (!normalized || !db.prepare('SELECT 1 FROM printer_models WHERE model_id = ?').get(normalized)) {
      return res.status(400).json({ error: `Unknown model "${model}". Add it in Settings → Printer Models first.` });
    }
    const { loaded_material, loaded_color } = req.body;
    try {
      const result = db.prepare(`
        INSERT INTO printers (name, ip, api_key, serial_number, group_name, type, model, loaded_material, loaded_color, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(name, ip, api_key || '', serial_number || '', group_name || null, printerType, normalized,
             loaded_material || null, loaded_color || null, Date.now());
      res.status(201).json(db.prepare('SELECT * FROM printers WHERE id = ?').get(result.lastInsertRowid));
    } catch (err) {
      if (err.message.includes('UNIQUE')) {
        return res.status(409).json({ error: `Printer name "${name}" already exists` });
      }
      throw err;
    }
  });

  // PUT /api/printers/:id — update printer
  router.put('/:id', (req, res) => {
    const printer = db.prepare('SELECT * FROM printers WHERE id = ?').get(req.params.id);
    if (!printer) return res.status(404).json({ error: 'Printer not found' });

    const { name, ip, api_key, serial_number, group_name, type, model, is_held, decommission_note, loaded_material, loaded_color } = req.body;
    let normalized = undefined;
    if (model !== undefined) {
      normalized = normalizeModel(model);
      if (!normalized || !db.prepare('SELECT 1 FROM printer_models WHERE model_id = ?').get(normalized)) {
        return res.status(400).json({ error: `Unknown model "${model}". Add it in Settings → Printer Models first.` });
      }
    }

    // loaded_material / loaded_color: if key is present in body, use the value (even if empty → null to clear)
    const newMaterial = 'loaded_material' in req.body ? (loaded_material || null) : printer.loaded_material;
    const newColor    = 'loaded_color'    in req.body ? (loaded_color    || null) : printer.loaded_color;

    // Compute effective new values for all tracked fields (COALESCE: body wins, else keep existing)
    const after = {
      name:            name          !== undefined ? name          : printer.name,
      ip:              ip            !== undefined ? ip            : printer.ip,
      group_name:      group_name    !== undefined ? group_name    : printer.group_name,
      type:            type          !== undefined ? type          : printer.type,
      model:           normalized    !== undefined ? normalized    : printer.model,
      serial_number:   serial_number !== undefined ? serial_number : printer.serial_number,
      loaded_material: newMaterial,
      loaded_color:    newColor,
    };

    const FIELD_LABELS = {
      name: 'Name', ip: 'IP address', group_name: 'Group', type: 'Connector type',
      model: 'Model', serial_number: 'Serial number',
      loaded_material: 'Material', loaded_color: 'Color',
    };

    try {
      db.prepare(`
        UPDATE printers
        SET name = COALESCE(?, name),
            ip = COALESCE(?, ip),
            api_key = COALESCE(?, api_key),
            serial_number = COALESCE(?, serial_number),
            group_name = COALESCE(?, group_name),
            type = COALESCE(?, type),
            model = COALESCE(?, model),
            is_held = COALESCE(?, is_held),
            decommission_note = COALESCE(?, decommission_note),
            loaded_material = ?,
            loaded_color = ?
        WHERE id = ?
      `).run(name, ip, api_key, serial_number, group_name, type, normalized, is_held, decommission_note ?? null,
             newMaterial, newColor, req.params.id);

      // Log one event per changed field
      for (const [field, label] of Object.entries(FIELD_LABELS)) {
        const oldVal = printer[field] ?? null;
        const newVal = after[field]   ?? null;
        if (oldVal !== newVal) {
          const fmt = v => (v == null ? '(none)' : v);
          events.insert(printer.id, 'info_changed', `${label}: ${fmt(oldVal)} → ${fmt(newVal)}`);
        }
      }

      res.json(db.prepare('SELECT * FROM printers WHERE id = ?').get(req.params.id));
    } catch (err) {
      if (err.message.includes('UNIQUE')) {
        return res.status(409).json({ error: `Printer name "${name}" already exists` });
      }
      throw err;
    }
  });

  // DELETE /api/printers/:id
  router.delete('/:id', (req, res) => {
    const printer = db.prepare('SELECT * FROM printers WHERE id = ?').get(req.params.id);
    if (!printer) return res.status(404).json({ error: 'Printer not found' });
    drivers.dropConnection(printer); // tear down any persistent MQTT/WS connection
    db.prepare('DELETE FROM printers WHERE id = ?').run(req.params.id);
    res.json({ success: true });
  });

  // POST /api/printers/:id/decommission — remove from active duty
  router.post('/:id/decommission', (req, res) => {
    const printer = db.prepare('SELECT * FROM printers WHERE id = ?').get(req.params.id);
    if (!printer) return res.status(404).json({ error: 'Printer not found' });
    const now = Date.now();
    db.prepare('UPDATE printers SET is_active = 0, decommissioned_at = ? WHERE id = ?').run(now, printer.id);
    drivers.dropConnection(printer); // tear down any persistent MQTT/WS connection
    events.insert(printer.id, 'decommission', req.body?.note ?? null);
    console.log(`[printers] ${printer.name} decommissioned`);
    res.json(db.prepare('SELECT * FROM printers WHERE id = ?').get(printer.id));
  });

  // POST /api/printers/:id/complete-and-decommission — operator confirmed print was good; credit if
  // needed (missed-finish), then take machine offline for maintenance instead of releasing to queue.
  //
  // Optional confirmed_qty mirrors the set-ready confirmation: the operator can report fewer good
  // parts than the full plate (e.g. 24 of 25). The only difference from set-ready is the outcome —
  // the machine is decommissioned instead of released to take the next job. If the reduced count
  // drops the part below its target, the part (and its project) reopens and re-enters the queue for
  // the next available printer.
  router.post('/:id/complete-and-decommission', (req, res) => {
    const printer = db.prepare('SELECT * FROM printers WHERE id = ?').get(req.params.id);
    if (!printer) return res.status(404).json({ error: 'Printer not found' });

    const now = Date.now();
    const { confirmed_qty } = req.body || {};
    const parsedQty = (confirmed_qty != null && !isNaN(parseInt(confirmed_qty, 10)))
      ? parseInt(confirmed_qty, 10)
      : null;

    // Reconcile a part's status with its completed_qty: close (and maybe complete the project) when
    // the target is met, reopen (and reactivate the project) when a reduced count drops below it.
    const settlePart = (partId) => {
      const part = db.prepare('SELECT * FROM parts WHERE id = ?').get(partId);
      if (!part) return;
      if (part.completed_qty >= part.target_qty && part.status === 'open') {
        db.prepare(`UPDATE parts SET status = 'closed', updated_at = ? WHERE id = ?`).run(now, part.id);
        db.prepare(`UPDATE jobs SET status = 'cancelled' WHERE part_id = ? AND status = 'queued'`).run(part.id);
        const openCount = db.prepare(
          `SELECT COUNT(*) AS count FROM parts WHERE project_id = ? AND status = 'open'`
        ).get(part.project_id).count;
        if (openCount === 0) {
          db.prepare(`UPDATE projects SET status = 'completed', updated_at = ? WHERE id = ?`).run(now, part.project_id);
          console.log(`[printers] Project ${part.project_id} completed`);
        }
      } else if (part.completed_qty < part.target_qty && part.status === 'closed') {
        db.prepare(`UPDATE parts SET status = 'open', updated_at = ? WHERE id = ?`).run(now, part.id);
        const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(part.project_id);
        if (project && project.status === 'completed') {
          db.prepare(`UPDATE projects SET status = 'active', updated_at = ? WHERE id = ?`).run(now, project.id);
          console.log(`[printers] Project ${project.id} reopened — confirmed qty reduced on decommission`);
        }
      }
    };

    // Missed-finish case: job still shows 'printing' because the server didn't see the FINISHED
    // event. Credit qty now, same as set-ready would do before dispatching the next job.
    const printingJob = db.prepare(`
      SELECT * FROM jobs WHERE printer_id = ? AND status = 'printing'
      ORDER BY started_at DESC LIMIT 1
    `).get(printer.id);

    if (printingJob) {
      const creditQty = parsedQty != null ? parsedQty : printingJob.parts_per_plate;
      db.prepare(`UPDATE jobs SET status = 'finished', finished_at = ? WHERE id = ?`).run(now, printingJob.id);
      db.prepare(`UPDATE parts SET completed_qty = MAX(0, completed_qty + ?), updated_at = ? WHERE id = ?`)
        .run(creditQty, now, printingJob.part_id);
      settlePart(printingJob.part_id);
      console.log(`[printers] ${printer.name} missed-finish credited ${creditQty} — decommissioning for maintenance`);
    } else if (parsedQty != null) {
      // Normal case: job already 'finished' and credited the full plate by _handleFinished. If the
      // operator adjusted the count, apply the delta against what was already booked (same as set-ready).
      const finishedJob = db.prepare(`
        SELECT * FROM jobs WHERE printer_id = ? AND status = 'finished'
        ORDER BY finished_at DESC LIMIT 1
      `).get(printer.id);
      if (finishedJob && parsedQty !== finishedJob.parts_per_plate) {
        const delta = parsedQty - finishedJob.parts_per_plate; // negative = fewer good parts
        db.prepare(`UPDATE parts SET completed_qty = MAX(0, completed_qty + ?), updated_at = ? WHERE id = ?`)
          .run(delta, now, finishedJob.part_id);
        settlePart(finishedJob.part_id);
        console.log(`[printers] ${printer.name} confirmed ${parsedQty}/${finishedJob.parts_per_plate} good on decommission (delta ${delta > 0 ? '+' : ''}${delta})`);
      }
    }
    // Normal case with no qty adjustment: job already 'finished' was credited by _handleFinished — nothing to do.

    const decommNote = req.body?.note ?? null;
    db.prepare('UPDATE printers SET is_active = 0, is_held = 0, decommissioned_at = ?, decommission_note = ? WHERE id = ?').run(now, decommNote, printer.id);
    drivers.dropConnection(printer); // tear down any persistent MQTT/WS connection
    events.insert(printer.id, 'decommission', decommNote ?? 'operator confirmed successful print — taken offline for maintenance');
    console.log(`[printers] ${printer.name} decommissioned after confirmed good print`);
    res.json(db.prepare('SELECT * FROM printers WHERE id = ?').get(printer.id));
  });

  // POST /api/printers/:id/recommission — handled in server/index.js (needs scheduler access)

  // POST /api/printers/:id/mark-job-failure — mark last finished job as failed, undo completed_qty
  router.post('/:id/mark-job-failure', (req, res) => {
    const printer = db.prepare('SELECT * FROM printers WHERE id = ?').get(req.params.id);
    if (!printer) return res.status(404).json({ error: 'Printer not found' });

    // Active jobs (printing/uploading) take priority over finished ones.
    //
    //   printing  — active or stale; completed_qty was never credited
    //   uploading — upload stalled; completed_qty was never credited
    //   cancelled — operator stopped on printer screen; completed_qty was never credited
    //   finished  — fallback: _handleFinished already credited completed_qty; operator
    //               is confirming the print was bad
    //
    // The finished fallback is intentionally narrow: only match a finished job if no
    // subsequent job was created for this printer after it finished. This ensures we
    // find the job the printer is currently held for (awaiting operator sign-off), not
    // an older finished job from a previous cycle that would cause a wrong qty decrement.
    let job = db.prepare(`
      SELECT * FROM jobs WHERE printer_id = ? AND status IN ('printing', 'uploading')
      ORDER BY started_at DESC LIMIT 1
    `).get(printer.id);
    if (!job) {
      job = db.prepare(`
        SELECT * FROM jobs WHERE printer_id = ? AND status = 'cancelled'
        ORDER BY finished_at DESC LIMIT 1
      `).get(printer.id);
    }
    if (!job) {
      job = db.prepare(`
        SELECT * FROM jobs j
        WHERE j.printer_id = ? AND j.status = 'finished'
          AND NOT EXISTS (
            SELECT 1 FROM jobs j2
            WHERE j2.printer_id = j.printer_id
              AND j2.id != j.id
              AND j2.created_at > j.finished_at
          )
        ORDER BY j.finished_at DESC LIMIT 1
      `).get(printer.id);
    }

    if (!job) {
      // No tracked job (e.g. print was started outside the farm manager, or the
      // printer spent all night in an UNKNOWN status so _handleFinished never fired).
      // Operator intent is clear: take the machine offline regardless.
      const now = Date.now();
      const noJobNote = req.body?.note ?? null;
      db.prepare('UPDATE printers SET is_active = 0, decommissioned_at = ?, decommission_note = ? WHERE id = ?').run(now, noJobNote, printer.id);
      drivers.dropConnection(printer); // tear down any persistent MQTT/WS connection
      events.insert(printer.id, 'job_failed', noJobNote ?? 'No tracked job — printer decommissioned for investigation');
      console.log(`[printers] ${printer.name} decommissioned (no tracked job to mark failed)`);
      return res.json({ success: true, job_id: null });
    }

    const now = Date.now();

    db.prepare("UPDATE jobs SET status = 'failed' WHERE id = ?").run(job.id);

    if (job.status === 'finished') {
      // Normal case: job was already credited when FINISHED was seen. Undo the increment.
      db.prepare(`
        UPDATE parts SET completed_qty = MAX(0, completed_qty - ?), updated_at = ? WHERE id = ?
      `).run(job.parts_per_plate, now, job.part_id);

      // Reload part — reopen if it was closed by this job
      const part = db.prepare('SELECT * FROM parts WHERE id = ?').get(job.part_id);
      if (part.status === 'closed' && part.completed_qty < part.target_qty) {
        db.prepare("UPDATE parts SET status = 'open', updated_at = ? WHERE id = ?").run(now, part.id);

        // If project was marked completed, reopen it to active
        const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(part.project_id);
        if (project && project.status === 'completed') {
          db.prepare("UPDATE projects SET status = 'active', updated_at = ? WHERE id = ?").run(now, project.id);
          console.log(`[printers] Project ${project.id} reopened — bad print undid completion`);
        }
      }
    }
    // printing (missed-finish), uploading (upload stalled), and cancelled (stopped on printer
    // screen) cases: completed_qty was never incremented, so there is nothing to undo.

    // Decommission the printer — a failed print requires investigation before it can run again.
    // The operator must explicitly recommission it when the machine is confirmed safe.
    const failNote = req.body?.note ?? null;
    db.prepare('UPDATE printers SET is_active = 0, decommissioned_at = ?, decommission_note = ? WHERE id = ?').run(now, failNote, printer.id);
    drivers.dropConnection(printer); // tear down any persistent MQTT/WS connection

    const failedPart = db.prepare('SELECT name FROM parts WHERE id = ?').get(job.part_id);
    const eventNote = failNote
      ? `Job ${job.id} — part: ${failedPart?.name ?? 'unknown'} — ${failNote}`
      : `Job ${job.id} — part: ${failedPart?.name ?? 'unknown'}`;
    events.insert(printer.id, 'job_failed', eventNote);

    console.log(`[printers] Job ${job.id} marked failed — ${printer.name} decommissioned pending investigation`);
    res.json({ success: true, job_id: job.id });
  });

  // GET /api/printers/:id/raw-status — calls the printer's driver, returns raw response for debugging
  router.get('/:id/raw-status', async (req, res) => {
    const printer = db.prepare('SELECT * FROM printers WHERE id = ?').get(req.params.id);
    if (!printer) return res.status(404).json({ error: 'Printer not found' });
    try {
      const response = await axios.get(`http://${printer.ip}/api/v1/status`, {
        headers: { 'X-Api-Key': printer.api_key },
        timeout: 8000,
      });
      res.json({ printer: { id: printer.id, name: printer.name, ip: printer.ip }, raw: response.data });
    } catch (err) {
      res.json({ printer: { id: printer.id, name: printer.name, ip: printer.ip }, error: err.message });
    }
  });

  // POST /api/printers/import — CSV bulk import
  router.post('/import', upload.single('file'), (req, res) => {
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }

    const csvText = req.file.buffer.toString('utf-8');
    const parsed = Papa.parse(csvText, {
      header: true,
      skipEmptyLines: true,
      transformHeader: (h) => h.trim().toLowerCase(),
    });

    if (parsed.errors.length > 0) {
      return res.status(400).json({ error: 'CSV parse error', details: parsed.errors });
    }

    const rows = parsed.data;
    const summary = { imported: 0, skipped: 0, flagged: [] };

    const insertStmt = db.prepare(`
      INSERT INTO printers (name, ip, api_key, serial_number, group_name, type, model, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const existsStmt = db.prepare('SELECT id FROM printers WHERE name = ?');

    for (const row of rows) {
      const name          = (row.name          || '').trim();
      const ip            = (row.ip            || '').trim();
      const api_key       = (row.api_key       || '').trim();
      const serial_number = (row.serial_number || '').trim();
      const group_name    = (row.group         || '').trim() || null;
      const type          = (row.type          || 'prusa').trim();

      const rowRequiresApiKey = !NO_API_KEY_TYPES.has(type);
      if (!name || !ip || (rowRequiresApiKey && !api_key)) {
        summary.flagged.push({ row, reason: 'Missing required field (name, ip, or api_key)' });
        continue;
      }

      if (existsStmt.get(name)) {
        summary.skipped++;
        continue;
      }

      const model = resolveModel(row.model, name);
      if (!model) {
        summary.flagged.push({
          row,
          reason: `Could not determine model for "${name}". Add a "model" column or use a recognized name prefix.`,
        });
        continue;
      }
      if (!db.prepare('SELECT 1 FROM printer_models WHERE model_id = ?').get(model)) {
        summary.flagged.push({
          row,
          reason: `Model "${model}" is not registered. Add it in Settings → Printer Models first.`,
        });
        continue;
      }

      try {
        insertStmt.run(name, ip, api_key, serial_number, group_name, type, model, Date.now());
        summary.imported++;
      } catch (err) {
        summary.flagged.push({ row, reason: err.message });
      }
    }

    res.json(summary);
  });

  // GET /api/printers/:id/linkable-jobs — failed/uploading jobs whose gcode model matches this printer.
  // Used by the Fleet UI job-link picker.
  router.get('/:id/linkable-jobs', (req, res) => {
    const printer = db.prepare('SELECT * FROM printers WHERE id = ?').get(req.params.id);
    if (!printer) return res.status(404).json({ error: 'Printer not found' });

    const jobs = db.prepare(`
      SELECT j.id, j.printer_id AS original_printer_id, j.part_id, j.gcode_id,
             j.parts_per_plate, j.status, j.started_at, j.created_at,
             p.name AS part_name,
             g.filename AS gcode_filename,
             orig.name AS original_printer_name
      FROM jobs j
      JOIN gcodes g ON g.id = j.gcode_id
      JOIN parts p ON p.id = j.part_id
      LEFT JOIN printers orig ON orig.id = j.printer_id
      WHERE j.status IN ('failed', 'uploading')
        AND g.printer_model = ?
      ORDER BY j.created_at DESC
      LIMIT 20
    `).all(printer.model);

    res.json(jobs);
  });

  // POST /api/printers/:id/link-job — manually associate a failed/uploading job with this printer.
  // Sets job to 'printing', updates printer_id, sets started_at if not already set, releases hold.
  router.post('/:id/link-job', (req, res) => {
    const printer = db.prepare('SELECT * FROM printers WHERE id = ?').get(req.params.id);
    if (!printer) return res.status(404).json({ error: 'Printer not found' });

    const { job_id } = req.body || {};
    if (!job_id) return res.status(400).json({ error: 'job_id is required' });

    const job = db.prepare('SELECT * FROM jobs WHERE id = ?').get(job_id);
    if (!job) return res.status(404).json({ error: 'Job not found' });
    if (!['failed', 'uploading'].includes(job.status)) {
      return res.status(409).json({ error: `Job is in '${job.status}' status and cannot be linked` });
    }

    const now = Date.now();
    db.prepare(`
      UPDATE jobs SET status = 'printing', printer_id = ?, started_at = COALESCE(started_at, ?) WHERE id = ?
    `).run(printer.id, now, job.id);
    db.prepare('UPDATE printers SET is_held = 0 WHERE id = ?').run(printer.id);

    console.log(`[printers] Job ${job.id} manually linked to ${printer.name} by operator`);
    res.json(db.prepare('SELECT * FROM printers WHERE id = ?').get(printer.id));
  });

  // Mount events sub-router — GET/POST /api/printers/:id/events
  router.use('/:id/events', require('./events')(db));

  return router;
};
