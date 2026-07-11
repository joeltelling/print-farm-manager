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

  // DELETE /api/jobs/:id — cancel a queued job only
  router.delete('/:id', (req, res) => {
    const job = db.prepare('SELECT * FROM jobs WHERE id = ?').get(req.params.id);
    if (!job) return res.status(404).json({ error: 'Job not found' });

    if (job.status !== 'queued') {
      return res.status(409).json({
        error: `Cannot cancel a job with status "${job.status}". Only queued jobs can be cancelled.`,
      });
    }

    db.prepare(`UPDATE jobs SET status = 'cancelled' WHERE id = ?`).run(req.params.id);
    res.json({ success: true });
  });

  return router;
};
