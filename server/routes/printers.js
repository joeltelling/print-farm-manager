const express = require('express');
const multer = require('multer');
const Papa = require('papaparse');
const axios = require('axios');
const router = express.Router();

const upload = multer({ storage: multer.memoryStorage() });

const VALID_MODELS = ['mk4', 'mk4s', 'c1', 'c1l', 'xl'];

// Normalize a CSV model column value to internal ID.
// Accepts the canonical value set (case-insensitive): MK4, MK4S, C1, C1L, XL
function normalizeModel(raw) {
  if (!raw) return null;
  const lower = raw.trim().toLowerCase();
  return VALID_MODELS.includes(lower) ? lower : null;
}

// Fallback: infer model from printer name when no model column is present.
function inferModel(name) {
  if (/^MK4S_/i.test(name)) return 'mk4s';
  if (/^MK4_/i.test(name))  return 'mk4';
  if (/^(CoreOne_|Core1L_|C1L )/i.test(name)) return 'c1l';
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
  // Includes last_parts_per_plate from the most recent finished job, used by the
  // Fleet UI to pre-fill the confirmed-qty input on held printers.
  router.get('/', (req, res) => {
    const printers = db.prepare(`
      SELECT p.*,
        COALESCE(
          (SELECT j.parts_per_plate FROM jobs j WHERE j.printer_id = p.id AND j.status = 'finished' ORDER BY j.finished_at DESC LIMIT 1),
          (SELECT j.parts_per_plate FROM jobs j WHERE j.printer_id = p.id AND j.status = 'printing' ORDER BY j.started_at DESC LIMIT 1)
        ) AS last_parts_per_plate
      FROM printers p
      WHERE p.is_active = 1
      ORDER BY p.name
    `).all();
    res.json(printers);
  });

  // GET /api/printers/decommissioned — list decommissioned printers
  router.get('/decommissioned', (req, res) => {
    const printers = db.prepare('SELECT * FROM printers WHERE is_active = 0 ORDER BY decommissioned_at DESC').all();
    res.json(printers);
  });

  // GET /api/printers/:id
  router.get('/:id', (req, res) => {
    const printer = db.prepare('SELECT * FROM printers WHERE id = ?').get(req.params.id);
    if (!printer) return res.status(404).json({ error: 'Printer not found' });
    res.json(printer);
  });

  // POST /api/printers — add single printer
  router.post('/', (req, res) => {
    const { name, ip, api_key, group_name, type, model } = req.body;
    if (!name || !ip || !api_key || !model) {
      return res.status(400).json({ error: 'name, ip, api_key, and model are required' });
    }
    const normalized = normalizeModel(model);
    if (!normalized) {
      return res.status(400).json({ error: `model must be one of: ${VALID_MODELS.join(', ')}` });
    }
    try {
      const result = db.prepare(`
        INSERT INTO printers (name, ip, api_key, group_name, type, model, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(name, ip, api_key, group_name || null, type || 'prusa', normalized, Date.now());
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

    const { name, ip, api_key, group_name, type, model, is_held, decommission_note } = req.body;
    let normalized = undefined;
    if (model !== undefined) {
      normalized = normalizeModel(model);
      if (!normalized) {
        return res.status(400).json({ error: `model must be one of: ${VALID_MODELS.join(', ')}` });
      }
    }

    try {
      db.prepare(`
        UPDATE printers
        SET name = COALESCE(?, name),
            ip = COALESCE(?, ip),
            api_key = COALESCE(?, api_key),
            group_name = COALESCE(?, group_name),
            type = COALESCE(?, type),
            model = COALESCE(?, model),
            is_held = COALESCE(?, is_held),
            decommission_note = COALESCE(?, decommission_note)
        WHERE id = ?
      `).run(name, ip, api_key, group_name, type, normalized, is_held, decommission_note ?? null, req.params.id);

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
    db.prepare('DELETE FROM printers WHERE id = ?').run(req.params.id);
    res.json({ success: true });
  });

  // POST /api/printers/:id/decommission — remove from active duty
  router.post('/:id/decommission', (req, res) => {
    const printer = db.prepare('SELECT * FROM printers WHERE id = ?').get(req.params.id);
    if (!printer) return res.status(404).json({ error: 'Printer not found' });
    db.prepare('UPDATE printers SET is_active = 0, decommissioned_at = ? WHERE id = ?').run(Date.now(), printer.id);
    console.log(`[printers] ${printer.name} decommissioned`);
    res.json(db.prepare('SELECT * FROM printers WHERE id = ?').get(printer.id));
  });

  // POST /api/printers/:id/recommission — handled in server/index.js (needs scheduler access)

  // POST /api/printers/:id/mark-job-failure — mark last finished job as failed, undo completed_qty
  router.post('/:id/mark-job-failure', (req, res) => {
    const printer = db.prepare('SELECT * FROM printers WHERE id = ?').get(req.params.id);
    if (!printer) return res.status(404).json({ error: 'Printer not found' });

    // Find the most recent job that is either finished (normal case) or still marked
    // printing (missed-finish case: server was down when the print completed).
    const job = db.prepare(`
      SELECT * FROM jobs WHERE printer_id = ? AND status IN ('finished', 'printing')
      ORDER BY finished_at DESC, started_at DESC LIMIT 1
    `).get(printer.id);
    if (!job) return res.status(404).json({ error: 'No active or finished job found for this printer' });

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
    // Missed-finish case (job.status === 'printing'): completed_qty was never incremented,
    // so there is nothing to undo. Just mark failed and decommission below.

    // Decommission the printer — a failed print requires investigation before it can run again.
    // The operator must explicitly recommission it when the machine is confirmed safe.
    db.prepare('UPDATE printers SET is_active = 0, decommissioned_at = ? WHERE id = ?').run(now, printer.id);

    console.log(`[printers] Job ${job.id} marked failed — ${printer.name} decommissioned pending investigation`);
    res.json({ success: true, job_id: job.id });
  });

  // GET /api/printers/:id/raw-status — proxy to PrusaLink, returns raw response for debugging
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
      INSERT INTO printers (name, ip, api_key, group_name, type, model, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    const existsStmt = db.prepare('SELECT id FROM printers WHERE name = ?');

    for (const row of rows) {
      const name     = (row.name    || '').trim();
      const ip       = (row.ip      || '').trim();
      const api_key  = (row.api_key || '').trim();
      const group_name = (row.group || '').trim() || null;
      const type     = (row.type    || 'prusa').trim();

      if (!name || !ip || !api_key) {
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
          reason: `Could not determine model for "${name}". Add a "model" column (${VALID_MODELS.join(', ')}) or use a recognized name prefix.`,
        });
        continue;
      }

      try {
        insertStmt.run(name, ip, api_key, group_name, type, model, Date.now());
        summary.imported++;
      } catch (err) {
        summary.flagged.push({ row, reason: err.message });
      }
    }

    res.json(summary);
  });

  return router;
};
