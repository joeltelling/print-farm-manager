const express = require('express');
const path    = require('path');
const fs      = require('fs');
const router  = express.Router();

const GCODE_DIR = path.join(__dirname, '..', 'gcode');

// scheduler is optional — only needed at runtime for sweepIdlePrinters on reactivate.
// Tests pass null so there is no live scheduler dependency.
module.exports = (db, scheduler = null) => {
  router.get('/', (req, res) => {
    const projects = db.prepare('SELECT * FROM projects ORDER BY priority ASC, created_at ASC').all();
    res.json(projects);
  });

  router.get('/:id', (req, res) => {
    const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(req.params.id);
    if (!project) return res.status(404).json({ error: 'Project not found' });
    res.json(project);
  });

  router.post('/', (req, res) => {
    const { name, description } = req.body;
    if (!name) return res.status(400).json({ error: 'name is required' });
    const now = Date.now();
    const result = db.prepare(`
      INSERT INTO projects (name, description, created_at, updated_at)
      VALUES (?, ?, ?, ?)
    `).run(name, description || null, now, now);
    const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(result.lastInsertRowid);
    res.status(201).json(project);
  });

  // PUT /reorder — set priority for an ordered list of project IDs.
  // Body: { ids: [3, 1, 2] } — index becomes priority (0 = highest).
  // Must be defined before /:id so Express doesn't match 'reorder' as an id.
  router.put('/reorder', (req, res) => {
    const { ids } = req.body;
    if (!Array.isArray(ids) || ids.length === 0) {
      return res.status(400).json({ error: 'ids must be a non-empty array' });
    }
    const update = db.prepare('UPDATE projects SET priority = ?, updated_at = ? WHERE id = ?');
    const now = Date.now();
    db.transaction(() => {
      ids.forEach((id, index) => update.run(index, now, id));
    })();
    res.json({ success: true });
  });

  // Set project-level filament defaults — explicitly nullable (empty string → NULL)
  router.put('/:id/filament', (req, res) => {
    const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(req.params.id);
    if (!project) return res.status(404).json({ error: 'Project not found' });
    const mat = req.body?.required_material?.trim() || null;
    const col = req.body?.required_color?.trim()    || null;
    db.prepare(`
      UPDATE projects SET required_material = ?, required_color = ?, updated_at = ? WHERE id = ?
    `).run(mat, col, Date.now(), project.id);
    res.json(db.prepare('SELECT * FROM projects WHERE id = ?').get(project.id));
  });

  // Set project-level group defaults: cascades to every gcode in this project
  // that doesn't set its own allowed_groups override (see scheduler.js's
  // COALESCE(gcodes.allowed_groups, projects.allowed_groups)). Empty selection
  // stores NULL, never '[]': COALESCE(...) = '[]' would be non-NULL and match
  // zero printers, silently freezing dispatch for the whole project.
  router.put('/:id/groups', (req, res) => {
    const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(req.params.id);
    if (!project) return res.status(404).json({ error: 'Project not found' });
    const arr = Array.isArray(req.body?.allowed_groups)
      ? req.body.allowed_groups.map(s => String(s).trim()).filter(Boolean)
      : [];
    const value = arr.length > 0 ? JSON.stringify(arr) : null;
    db.prepare(`
      UPDATE projects SET allowed_groups = ?, updated_at = ? WHERE id = ?
    `).run(value, Date.now(), project.id);
    res.json(db.prepare('SELECT * FROM projects WHERE id = ?').get(project.id));
  });

  router.put('/:id', (req, res) => {
    const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(req.params.id);
    if (!project) return res.status(404).json({ error: 'Project not found' });
    const { name, description, status } = req.body;
    db.prepare(`
      UPDATE projects
      SET name = COALESCE(?, name),
          description = COALESCE(?, description),
          status = COALESCE(?, status),
          updated_at = ?
      WHERE id = ?
    `).run(name, description, status, Date.now(), req.params.id);
    res.json(db.prepare('SELECT * FROM projects WHERE id = ?').get(req.params.id));
  });

  router.delete('/:id', (req, res) => {
    const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(req.params.id);
    if (!project) return res.status(404).json({ error: 'Project not found' });
    if (project.status !== 'draft') {
      return res.status(400).json({ error: 'Only draft projects can be deleted.' });
    }

    const parts = db.prepare('SELECT id FROM parts WHERE project_id = ?').all(project.id);

    db.transaction(() => {
      for (const part of parts) {
        db.prepare('DELETE FROM jobs WHERE part_id = ?').run(part.id);

        const gcodes = db.prepare('SELECT * FROM gcodes WHERE part_id = ?').all(part.id);
        for (const gcode of gcodes) {
          const basename = gcode.filepath.split(/[\\/]/).pop();
          const fullPath = path.join(GCODE_DIR, basename);
          if (fs.existsSync(fullPath)) fs.unlinkSync(fullPath);
          db.prepare('DELETE FROM gcodes WHERE id = ?').run(gcode.id);
        }

        db.prepare('DELETE FROM parts WHERE id = ?').run(part.id);
      }
      db.prepare('DELETE FROM projects WHERE id = ?').run(project.id);
    })();

    res.json({ success: true });
  });

  // POST /:id/complete — force-close a project before all parts hit their target qty.
  // Closes all open parts and cancels any queued/uploading jobs for them.
  router.post('/:id/complete', (req, res) => {
    const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(req.params.id);
    if (!project) return res.status(404).json({ error: 'Project not found' });
    if (project.status === 'completed') return res.status(400).json({ error: 'Project is already completed' });

    const now = Date.now();
    const openParts = db.prepare("SELECT * FROM parts WHERE project_id = ? AND status = 'open'").all(project.id);

    db.prepare("UPDATE parts SET status = 'closed', updated_at = ? WHERE project_id = ? AND status = 'open'").run(now, project.id);

    let cancelledJobs = 0;
    if (openParts.length > 0) {
      const placeholders = openParts.map(() => '?').join(',');
      const result = db.prepare(
        `UPDATE jobs SET status = 'cancelled' WHERE part_id IN (${placeholders}) AND status IN ('queued', 'uploading')`
      ).run(...openParts.map(p => p.id));
      cancelledJobs = result.changes;
    }

    db.prepare("UPDATE projects SET status = 'completed', updated_at = ? WHERE id = ?").run(now, project.id);
    console.log(`[server] Project ${project.id} "${project.name}" force-completed — ${openParts.length} part(s) closed, ${cancelledJobs} job(s) cancelled`);

    res.json({
      project: db.prepare('SELECT * FROM projects WHERE id = ?').get(project.id),
      closed_parts: openParts.length,
      cancelled_jobs: cancelledJobs,
    });
  });

  // POST /:id/reactivate — re-open a completed project.
  // Reopens closed parts that still have remaining qty. Returns nothing_to_reopen: true
  // if all parts are already at or above target so the UI can warn before dispatching nothing.
  router.post('/:id/reactivate', (req, res) => {
    const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(req.params.id);
    if (!project) return res.status(404).json({ error: 'Project not found' });

    const now = Date.now();
    const eligible = db.prepare(`
      SELECT * FROM parts
      WHERE project_id = ? AND status = 'closed' AND completed_qty < target_qty
    `).all(project.id);

    if (eligible.length === 0) {
      return res.json({ nothing_to_reopen: true, project });
    }

    const placeholders = eligible.map(() => '?').join(',');
    db.prepare(`UPDATE parts SET status = 'open', updated_at = ? WHERE id IN (${placeholders})`)
      .run(now, ...eligible.map(p => p.id));

    db.prepare("UPDATE projects SET status = 'active', updated_at = ? WHERE id = ?").run(now, project.id);
    console.log(`[server] Project ${project.id} "${project.name}" re-activated — ${eligible.length} part(s) reopened`);

    if (scheduler) scheduler.sweepIdlePrinters();

    res.json({
      project: db.prepare('SELECT * FROM projects WHERE id = ?').get(project.id),
      reopened_parts: eligible.length,
    });
  });

  // POST /:id/duplicate — create a new draft project copied from an existing one.
  // Body: { name?: string } — defaults to "Copy of <source name>".
  // All parts are copied with completed_qty reset to 0 and status reset to open.
  // Each part's G-code files are physically copied to new unique filenames so the
  // two projects are fully independent — deleting one won't affect the other.
  router.post('/:id/duplicate', (req, res) => {
    const source = db.prepare('SELECT * FROM projects WHERE id = ?').get(req.params.id);
    if (!source) return res.status(404).json({ error: 'Project not found' });

    const name = (req.body.name || '').trim() || `Copy of ${source.name}`;
    const now  = Date.now();

    const sourceParts = db
      .prepare('SELECT * FROM parts WHERE project_id = ? ORDER BY sort_order ASC, created_at ASC')
      .all(source.id);

    let newProject;
    let copiedParts  = 0;
    let copiedGcodes = 0;

    db.transaction(() => {
      const projResult = db.prepare(`
        INSERT INTO projects (name, description, status, priority, created_at, updated_at)
        VALUES (?, ?, 'draft', 0, ?, ?)
      `).run(name, source.description ?? null, now, now);
      newProject = db.prepare('SELECT * FROM projects WHERE id = ?').get(projResult.lastInsertRowid);

      for (const part of sourceParts) {
        const partResult = db.prepare(`
          INSERT INTO parts (project_id, name, target_qty, completed_qty, status, sort_order,
                             print_time_seconds, material_grams, created_at, updated_at)
          VALUES (?, ?, ?, 0, 'open', ?, ?, ?, ?, ?)
        `).run(
          newProject.id, part.name, part.target_qty, part.sort_order,
          part.print_time_seconds ?? null, part.material_grams ?? null, now, now
        );
        copiedParts++;

        const gcodes = db.prepare('SELECT * FROM gcodes WHERE part_id = ?').all(part.id);
        for (const gcode of gcodes) {
          const srcBasename = gcode.filepath.split(/[\\/]/).pop();
          const srcPath     = path.join(GCODE_DIR, srcBasename);
          const newBasename = `${now}_dup${gcode.id}_${gcode.filename}`;
          let   newFilepath = newBasename;

          if (fs.existsSync(srcPath)) {
            try {
              fs.copyFileSync(srcPath, path.join(GCODE_DIR, newBasename));
            } catch (_) {
              newFilepath = gcode.filepath; // fallback: keep original path reference
            }
          } else {
            newFilepath = gcode.filepath; // source file missing — preserve metadata only
          }

          db.prepare(`
            INSERT INTO gcodes (part_id, printer_model, filename, filepath, parts_per_plate,
                                est_print_secs, material_grams, ams_slot, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
          `).run(
            partResult.lastInsertRowid, gcode.printer_model, gcode.filename, newFilepath,
            gcode.parts_per_plate, gcode.est_print_secs ?? null, gcode.material_grams ?? null,
            gcode.ams_slot ?? null, now
          );
          copiedGcodes++;
        }
      }
    })();

    res.status(201).json({ project: newProject, copied_parts: copiedParts, copied_gcodes: copiedGcodes });
  });

  return router;
};
