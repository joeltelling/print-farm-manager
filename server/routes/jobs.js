const express = require('express');
const router = express.Router();

module.exports = (db) => {
  // GET /api/jobs — list with optional filters, joined with part/project/printer names
  router.get('/', (req, res) => {
    const { printer_id, part_id, project_id, status } = req.query;

    let query = `
      SELECT
        jobs.*,
        parts.name        AS part_name,
        projects.id       AS project_id,
        projects.name     AS project_name,
        printers.name     AS printer_name,
        printers.model    AS printer_model,
        printers.is_held  AS printer_is_held,
        printers.status   AS printer_status
      FROM jobs
      JOIN parts    ON parts.id    = jobs.part_id
      JOIN projects ON projects.id = parts.project_id
      JOIN printers ON printers.id = jobs.printer_id
      WHERE 1=1
    `;
    const params = [];

    if (printer_id) { query += ' AND jobs.printer_id = ?';   params.push(printer_id); }
    if (part_id)    { query += ' AND jobs.part_id = ?';      params.push(part_id); }
    if (project_id) { query += ' AND projects.id = ?';       params.push(project_id); }
    if (status)     { query += ' AND jobs.status = ?';       params.push(status); }

    query += ' ORDER BY jobs.created_at DESC';

    res.json(db.prepare(query).all(...params));
  });

  // GET /api/jobs/:id
  router.get('/:id', (req, res) => {
    const job = db.prepare(`
      SELECT jobs.*,
        parts.name        AS part_name,
        projects.id       AS project_id,
        projects.name     AS project_name,
        printers.name     AS printer_name,
        printers.model    AS printer_model,
        printers.is_held  AS printer_is_held,
        printers.status   AS printer_status
      FROM jobs
      JOIN parts    ON parts.id    = jobs.part_id
      JOIN projects ON projects.id = parts.project_id
      JOIN printers ON printers.id = jobs.printer_id
      WHERE jobs.id = ?
    `).get(req.params.id);
    if (!job) return res.status(404).json({ error: 'Job not found' });
    res.json(job);
  });

  // DELETE /api/jobs/:id: cancel a queued job. With ?force=true, also cancel an
  // uploading or printing job: the escape hatch for a stuck row, e.g. a dispatch
  // whose print-start command the printer silently ignored, leaving a job
  // 'printing' forever against an idle machine (and blocking part deletion).
  //
  // Force-cancel only touches the job row. It never credits completed_qty (an
  // active job has credited nothing yet), never clears a printer hold (holds are
  // resolved by the operator through Fleet's Set Ready / Bad Print), and never
  // contacts the printer (if a print is physically running, stop it at the
  // printer or from Fleet; the UI confirm says exactly that).
  router.delete('/:id', (req, res) => {
    const job = db.prepare('SELECT * FROM jobs WHERE id = ?').get(req.params.id);
    if (!job) return res.status(404).json({ error: 'Job not found' });

    const force = req.query.force === 'true' || req.query.force === '1';
    const cancellable = force ? ['queued', 'uploading', 'printing'] : ['queued'];

    if (!cancellable.includes(job.status)) {
      const hint = force
        ? 'Only queued, uploading, or printing jobs can be cancelled.'
        : 'Only queued jobs can be cancelled (pass ?force=true for a stuck uploading/printing job).';
      return res.status(409).json({
        error: `Cannot cancel a job with status "${job.status}". ${hint}`,
      });
    }

    // finished_at is stamped on force-cancel to match the scheduler's own cancelled
    // writes; operator flows (mark-job-failure) order cancelled jobs by finished_at.
    // The queued path stays exactly as before.
    if (job.status === 'queued') {
      db.prepare(`UPDATE jobs SET status = 'cancelled' WHERE id = ?`).run(req.params.id);
    } else {
      db.prepare(`UPDATE jobs SET status = 'cancelled', finished_at = ? WHERE id = ?`)
        .run(Date.now(), req.params.id);
      console.log(`[jobs] Job ${job.id} force-cancelled by operator (was ${job.status})`);
    }
    res.json({ success: true });
  });

  return router;
};
