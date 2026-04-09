const express = require('express');
const router  = express.Router({ mergeParams: true });

const PAGE_SIZE = 100;

module.exports = (db) => {
  // GET /api/printers/:id/jobs/stats
  // Lifetime aggregate for this printer — total jobs, parts produced, success rate, print hours.
  // Only 'finished' jobs contribute to parts and hours; 'failed' jobs count toward totals.
  router.get('/stats', (req, res) => {
    const printer = db.prepare('SELECT id FROM printers WHERE id = ?').get(req.params.id);
    if (!printer) return res.status(404).json({ error: 'Printer not found' });

    const row = db.prepare(`
      SELECT
        COUNT(*)                                                        AS total_jobs,
        COUNT(CASE WHEN status = 'finished' THEN 1 END)                AS finished_jobs,
        COUNT(CASE WHEN status = 'failed'   THEN 1 END)                AS failed_jobs,
        COALESCE(SUM(CASE WHEN status = 'finished' THEN parts_per_plate ELSE 0 END), 0)
                                                                        AS total_parts,
        COALESCE(SUM(CASE WHEN status = 'finished' AND started_at IS NOT NULL AND finished_at IS NOT NULL
                          THEN finished_at - started_at ELSE 0 END), 0) AS total_print_ms
      FROM jobs
      WHERE printer_id = ? AND status IN ('finished', 'failed')
    `).get(req.params.id);

    const totalTracked = row.finished_jobs + row.failed_jobs;
    res.json({
      total_jobs:      row.total_jobs,
      finished_jobs:   row.finished_jobs,
      failed_jobs:     row.failed_jobs,
      total_parts:     row.total_parts,
      success_rate:    totalTracked > 0 ? Math.round((row.finished_jobs / totalTracked) * 100) : null,
      total_print_ms:  row.total_print_ms,
    });
  });

  // GET /api/printers/:id/jobs?page=1
  // Paginated job history, 100 per page, newest first.
  // Joins to parts, projects, gcodes for display context.
  router.get('/', (req, res) => {
    const printer = db.prepare('SELECT id FROM printers WHERE id = ?').get(req.params.id);
    if (!printer) return res.status(404).json({ error: 'Printer not found' });

    const page   = Math.max(1, parseInt(req.query.page, 10) || 1);
    const offset = (page - 1) * PAGE_SIZE;

    const totalRow = db.prepare(`
      SELECT COUNT(*) AS count FROM jobs WHERE printer_id = ?
    `).get(req.params.id);
    const total      = totalRow.count;
    const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

    const jobs = db.prepare(`
      SELECT
        j.id, j.status, j.parts_per_plate, j.started_at, j.finished_at,
        j.finished_at - j.started_at   AS duration_ms,
        p.name                          AS part_name,
        pr.name                         AS project_name,
        g.filename                      AS gcode_filename
      FROM jobs j
      LEFT JOIN parts    p  ON p.id  = j.part_id
      LEFT JOIN projects pr ON pr.id = p.project_id
      LEFT JOIN gcodes   g  ON g.id  = j.gcode_id
      WHERE j.printer_id = ?
      ORDER BY j.started_at DESC
      LIMIT ? OFFSET ?
    `).all(req.params.id, PAGE_SIZE, offset);

    res.json({ page, total_pages: totalPages, total, jobs });
  });

  return router;
};
