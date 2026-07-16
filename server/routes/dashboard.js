const express = require('express');
const router  = express.Router();
const { publicPrinter } = require('../printer-public');

// Completed job statuses — 'done' is a legacy alias retained for backward compat with older data.
const DONE_STATUSES = "('finished', 'done')";

module.exports = (db) => {
  // GET /api/dashboard — single endpoint for the TV dashboard
  // Returns stats, full printer list, active projects with parts, and recent activity.
  router.get('/', (req, res) => {
    const now    = Date.now();
    const since  = now - 24 * 60 * 60 * 1000; // rolling 24-hour window

    // ── Printers (same query as GET /api/printers, with last_parts_per_plate
    //    and last_event_at — most recent printer_events timestamp, used by the
    //    "Needs Attention" panel to show how long a printer has been waiting) ──
    const printers = db.prepare(`
      SELECT p.*,
        (SELECT j.parts_per_plate FROM jobs j
         WHERE j.printer_id = p.id AND j.status IN ${DONE_STATUSES}
         ORDER BY j.finished_at DESC LIMIT 1) AS last_parts_per_plate,
        (SELECT MAX(e.created_at) FROM printer_events e
         WHERE e.printer_id = p.id) AS last_event_at
      FROM printers p
      WHERE p.is_active = 1
      ORDER BY p.name
    `).all();

    // Derive fleet stats from the live printer list
    const printing = printers.filter(p => p.status === 'PRINTING').length;
    const idle     = printers.filter(p => p.status === 'IDLE' && !p.is_held).length;
    // Keep this condition identical to Fleet.jsx, Dashboard.jsx, Printers.jsx (see CLAUDE.md sync pairs).
    const awaiting = printers.filter(
      p => p.is_held === 1 && (p.status === 'FINISHED' || p.status === 'IDLE' || p.status === 'STOPPED')
    ).length;

    // Parts completed in the last 24 hours (sum of parts_per_plate on finished jobs)
    const partsToday = db.prepare(`
      SELECT COALESCE(SUM(parts_per_plate), 0) AS total
      FROM jobs
      WHERE status IN ${DONE_STATUSES} AND finished_at >= ?
    `).get(since).total;

    // ── Active projects with their parts ──────────────────────────────────────
    const activeProjects = db.prepare(`
      SELECT * FROM projects WHERE status = 'active' ORDER BY created_at ASC
    `).all();

    const elapsedFinishedStmt = db.prepare(`
      SELECT COALESCE(SUM(j.finished_at - j.started_at), 0) AS ms
      FROM jobs j
      JOIN parts p ON p.id = j.part_id
      WHERE p.project_id = ? AND j.status IN ${DONE_STATUSES}
        AND j.started_at IS NOT NULL AND j.finished_at IS NOT NULL
    `);

    const elapsedPrintingStmt = db.prepare(`
      SELECT COALESCE(SUM(? - j.started_at), 0) AS ms
      FROM jobs j
      JOIN parts p ON p.id = j.part_id
      WHERE p.project_id = ? AND j.status = 'printing' AND j.started_at IS NOT NULL
    `);

    const materialUsedStmt = db.prepare(`
      SELECT COALESCE(SUM(g.material_grams * 1.0 / g.parts_per_plate * j.parts_per_plate), 0) AS grams
      FROM jobs j
      JOIN gcodes g ON g.id = j.gcode_id
      JOIN parts p ON p.id = j.part_id
      WHERE p.project_id = ? AND j.status IN ${DONE_STATUSES} AND g.material_grams IS NOT NULL
    `);

    const modelBreakdownStmt = db.prepare(`
      SELECT g.printer_model,
        COUNT(*) AS jobs_count,
        SUM(j.parts_per_plate) AS parts_printed,
        COALESCE(SUM(g.material_grams * 1.0 / g.parts_per_plate * j.parts_per_plate), 0) AS material_grams,
        COALESCE(SUM(j.finished_at - j.started_at), 0) / 1000 AS elapsed_secs
      FROM jobs j
      JOIN gcodes g ON g.id = j.gcode_id
      JOIN parts p ON p.id = j.part_id
      WHERE p.project_id = ? AND j.status IN ${DONE_STATUSES}
        AND j.started_at IS NOT NULL AND j.finished_at IS NOT NULL
      GROUP BY g.printer_model
      ORDER BY parts_printed DESC
    `);

    const projectsWithParts = activeProjects.map(proj => {
      const parts = db.prepare(`
        SELECT parts.*,
          COALESCE((
            SELECT SUM(j.parts_per_plate) FROM jobs j
            WHERE j.part_id = parts.id AND j.status IN ('uploading', 'printing')
          ), 0) AS active_qty
        FROM parts WHERE project_id = ? ORDER BY sort_order ASC, created_at ASC
      `).all(proj.id);

      const finishedMs  = elapsedFinishedStmt.get(proj.id).ms;
      const printingMs  = elapsedPrintingStmt.get(now, proj.id).ms;
      const elapsed_secs = Math.round((finishedMs + printingMs) / 1000);
      const material_used_grams = materialUsedStmt.get(proj.id).grams || null;
      const model_breakdown = modelBreakdownStmt.all(proj.id);

      return { ...proj, parts, elapsed_secs, material_used_grams, model_breakdown };
    });

    // ── Recent activity: last 12 finished/failed jobs ─────────────────────────
    const recentActivity = db.prepare(`
      SELECT j.id, j.status, j.parts_per_plate, j.finished_at,
             p.name  AS part_name,
             pr.name AS printer_name
      FROM jobs j
      JOIN parts    p  ON p.id  = j.part_id
      JOIN printers pr ON pr.id = j.printer_id
      WHERE j.status IN ('finished', 'done', 'failed')
      ORDER BY j.finished_at DESC
      LIMIT 12
    `).all();

    res.json({
      stats: {
        printing,
        idle,
        awaiting,
        parts_today: partsToday,
      },
      printers: printers.map(publicPrinter),
      active_projects: projectsWithParts,
      recent_activity: recentActivity,
    });
  });

  return router;
};
