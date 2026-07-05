const express = require('express');
const multer  = require('multer');
const path    = require('path');
const fs      = require('fs');

const router   = express.Router();
const GCODE_DIR = path.join(__dirname, '..', 'gcode');

// Multer for restore uploads — write to data/ dir, clean up after processing
const restoreUpload = multer({
  storage: multer.diskStorage({
    destination: path.join(__dirname, '..', 'data'),
    filename: (_req, _file, cb) => cb(null, `restore-upload-${Date.now()}.json`),
  }),
  limits: { fileSize: 500 * 1024 * 1024 }, // 500 MB
});

function runUpload(req, res) {
  return new Promise((resolve, reject) => {
    restoreUpload.single('file')(req, res, (err) => {
      if (err) reject(err);
      else resolve();
    });
  });
}

module.exports = (db) => {
  // GET /api/backup — export full farm as a downloadable JSON bundle
  router.get('/', (req, res) => {
    const printers        = db.prepare('SELECT * FROM printers').all();
    const projects        = db.prepare('SELECT * FROM projects').all();
    const parts           = db.prepare('SELECT * FROM parts').all();
    const gcodes          = db.prepare('SELECT * FROM gcodes').all();
    const jobs            = db.prepare('SELECT * FROM jobs').all();
    const printer_events  = db.prepare('SELECT * FROM printer_events').all();

    // Embed gcode files as base64, keyed by their on-disk basename
    const gcodeFiles = {};
    for (const g of gcodes) {
      const fullPath = path.join(GCODE_DIR, g.filepath);
      if (g.filepath && fs.existsSync(fullPath)) {
        gcodeFiles[g.filepath] = fs.readFileSync(fullPath).toString('base64');
      }
    }

    const backup = {
      version: 1,
      exported_at: Date.now(),
      printers,
      projects,
      parts,
      gcodes,
      jobs,
      printer_events,
      gcode_files: gcodeFiles,
    };

    const date = new Date().toISOString().slice(0, 10);
    res.setHeader('Content-Disposition', `attachment; filename="farm-backup-${date}.json"`);
    res.setHeader('Content-Type', 'application/json');
    res.json(backup);
  });

  // POST /api/backup/restore — replace all farm data from a backup JSON file
  router.post('/restore', async (req, res) => {
    let tmpPath = null;
    try {
      await runUpload(req, res);
      if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

      tmpPath = req.file.path;
      let backup;
      try {
        backup = JSON.parse(fs.readFileSync(tmpPath, 'utf8'));
      } catch {
        return res.status(400).json({ error: 'Invalid JSON in backup file' });
      }

      if (!backup.version || !Array.isArray(backup.printers)) {
        return res.status(400).json({ error: 'Unrecognised backup format' });
      }

      // Write gcode files to disk before the DB transaction. Keys come from the uploaded
      // backup; a genuine one only ever holds bare filenames, so reject anything that
      // isn't one (path separators, "..") before writing rather than after.
      const gcodeFileEntries = Object.entries(backup.gcode_files || {});
      const gcodeRoot = path.resolve(GCODE_DIR);
      for (const [name] of gcodeFileEntries) {
        if (path.basename(name) !== name || path.dirname(path.resolve(gcodeRoot, name)) !== gcodeRoot) {
          return res.status(400).json({ error: `Invalid gcode filename in backup: ${name}` });
        }
      }
      for (const [name, b64] of gcodeFileEntries) {
        fs.writeFileSync(path.join(gcodeRoot, name), Buffer.from(b64, 'base64'));
      }

      const restore = db.transaction(() => {
        // Delete in FK dependency order
        db.prepare('DELETE FROM printer_events').run();
        db.prepare('DELETE FROM jobs').run();
        db.prepare('DELETE FROM gcodes').run();
        db.prepare('DELETE FROM parts').run();
        db.prepare('DELETE FROM projects').run();
        db.prepare('DELETE FROM printers').run();

        // Reinsert with original IDs so FK relationships are preserved
        const stmts = {
          printer: db.prepare(`
            INSERT INTO printers
              (id, name, ip, api_key, group_name, type, model, status,
               is_held, is_active, created_at,
               decommissioned_at, decommission_note,
               job_name, job_progress, job_time_remaining)
            VALUES
              (@id, @name, @ip, @api_key, @group_name, @type, @model, @status,
               @is_held, @is_active, @created_at,
               @decommissioned_at, @decommission_note,
               @job_name, @job_progress, @job_time_remaining)
          `),
          project: db.prepare(`
            INSERT INTO projects (id, name, description, status, priority, created_at, updated_at)
            VALUES (@id, @name, @description, @status, @priority, @created_at, @updated_at)
          `),
          part: db.prepare(`
            INSERT INTO parts
              (id, project_id, name, target_qty, completed_qty, status, created_at, updated_at, sort_order)
            VALUES
              (@id, @project_id, @name, @target_qty, @completed_qty, @status, @created_at, @updated_at, @sort_order)
          `),
          gcode: db.prepare(`
            INSERT INTO gcodes
              (id, part_id, printer_model, filename, filepath, parts_per_plate, est_print_secs, created_at)
            VALUES
              (@id, @part_id, @printer_model, @filename, @filepath, @parts_per_plate, @est_print_secs, @created_at)
          `),
          job: db.prepare(`
            INSERT INTO jobs
              (id, part_id, printer_id, gcode_id, parts_per_plate, status, started_at, finished_at, created_at)
            VALUES
              (@id, @part_id, @printer_id, @gcode_id, @parts_per_plate, @status, @started_at, @finished_at, @created_at)
          `),
          printer_event: db.prepare(`
            INSERT INTO printer_events (id, printer_id, event_type, note, created_at)
            VALUES (@id, @printer_id, @event_type, @note, @created_at)
          `),
        };

        for (const p of (backup.printers || [])) stmts.printer.run(p);
        for (const p of (backup.projects || [])) stmts.project.run(p);
        for (const p of (backup.parts    || [])) stmts.part.run(p);
        for (const g of (backup.gcodes   || [])) {
          // filepath stores just the filename — no path rewriting needed
          stmts.gcode.run({ ...g, filepath: path.basename(g.filepath) });
        }
        for (const j of (backup.jobs || [])) stmts.job.run(j);
        for (const e of (backup.printer_events || [])) stmts.printer_event.run(e);

        // Sync auto-increment counters so new inserts don't collide
        for (const [table, col] of [
          ['printers', 'printers'], ['projects', 'projects'],
          ['parts', 'parts'], ['gcodes', 'gcodes'], ['jobs', 'jobs'],
          ['printer_events', 'printer_events'],
        ]) {
          db.prepare(`
            INSERT OR REPLACE INTO sqlite_sequence (name, seq)
            VALUES (?, (SELECT COALESCE(MAX(id), 0) FROM ${table}))
          `).run(col);
        }
      });

      restore();

      console.log(`[backup] Farm restored — ${backup.printers.length} printers, ${backup.projects.length} projects, ${backup.gcodes.length} gcodes, ${backup.jobs.length} jobs, ${(backup.printer_events || []).length} events`);

      res.json({
        ok: true,
        printers:       (backup.printers       || []).length,
        projects:       (backup.projects       || []).length,
        parts:          (backup.parts          || []).length,
        gcodes:         (backup.gcodes         || []).length,
        jobs:           (backup.jobs           || []).length,
        printer_events: (backup.printer_events || []).length,
      });
    } catch (err) {
      console.error('[backup] restore error:', err);
      res.status(500).json({ error: err.message });
    } finally {
      if (tmpPath && fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
    }
  });

  return router;
};
