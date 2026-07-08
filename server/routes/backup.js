const express = require('express');
const multer  = require('multer');
const path    = require('path');
const fs      = require('fs');

const drivers  = require('../drivers');

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

// Builds an INSERT statement covering the columns the live schema currently has for
// `table` (via PRAGMA table_info) that are actually present in the backup's `rows`,
// rather than a hand-maintained column list. A hardcoded list silently drifts out of
// sync as migrations add columns over time — this is what let restore round-trip
// printers/projects/parts/gcodes while quietly dropping serial_number,
// loaded_material/loaded_color, project targeting, and gcode
// allowed_groups/required_material/required_color/ams_slot/material_grams. Deriving the
// column list from the table itself makes that whole bug class structurally impossible:
// a newly-added column is included automatically, with no restore.js edit to remember.
//
// Columns missing from every row (e.g. an older backup predating a newer column) are
// left out of the INSERT entirely so SQLite applies the column's own DEFAULT — binding
// them as NULL instead would fail for NOT NULL DEFAULT columns like parts.sort_order.
function makeInserter(db, table, rows) {
  if (rows.length === 0) return { run() {} };

  const liveColumns = db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name);
  const presentColumns = new Set();
  for (const row of rows) {
    for (const key of Object.keys(row)) presentColumns.add(key);
  }
  const columns = liveColumns.filter(c => presentColumns.has(c));

  const stmt = db.prepare(`
    INSERT INTO ${table} (${columns.join(', ')})
    VALUES (${columns.map(c => '@' + c).join(', ')})
  `);
  return {
    run(row) {
      const params = {};
      for (const c of columns) params[c] = row[c] !== undefined ? row[c] : null;
      return stmt.run(params);
    },
  };
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
    const printer_models  = db.prepare('SELECT * FROM printer_models').all();
    const filament_types  = db.prepare('SELECT * FROM filament_types').all();
    const filament_colors = db.prepare('SELECT * FROM filament_colors').all();
    const settings        = db.prepare('SELECT * FROM settings').all();

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
      printer_models,
      filament_types,
      filament_colors,
      settings,
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

      // Write gcode files to disk before the DB transaction. Reject any key that isn't a
      // bare filename — a crafted key like `../../server/poller.js` would otherwise resolve
      // outside GCODE_DIR and let a malicious backup overwrite arbitrary app files.
      const gcodeEntries = Object.entries(backup.gcode_files || {});
      for (const [name] of gcodeEntries) {
        if (path.basename(name) !== name || name === '.' || name === '..') {
          return res.status(400).json({ error: `Invalid gcode file name in backup: ${name}` });
        }
      }
      for (const [basename, b64] of gcodeEntries) {
        fs.writeFileSync(path.join(GCODE_DIR, basename), Buffer.from(b64, 'base64'));
      }

      // Older backups (pre-dating printer_models/filament/settings export) won't have these
      // keys at all — guard each so restoring one doesn't wipe current config with nothing
      // to restore it from. New backups always include all of them together.
      const hasPrinterModels  = Array.isArray(backup.printer_models);
      const hasFilamentTypes  = Array.isArray(backup.filament_types);
      const hasFilamentColors = Array.isArray(backup.filament_colors);
      const hasSettings       = Array.isArray(backup.settings);

      const restore = db.transaction(() => {
        // Delete in FK dependency order
        db.prepare('DELETE FROM printer_events').run();
        db.prepare('DELETE FROM jobs').run();
        db.prepare('DELETE FROM gcodes').run();
        db.prepare('DELETE FROM parts').run();
        db.prepare('DELETE FROM projects').run();
        db.prepare('DELETE FROM printers').run();
        if (hasFilamentColors) db.prepare('DELETE FROM filament_colors').run(); // before filament_types — FK on type_id
        if (hasFilamentTypes)  db.prepare('DELETE FROM filament_types').run();
        if (hasPrinterModels)  db.prepare('DELETE FROM printer_models').run();
        if (hasSettings)       db.prepare('DELETE FROM settings').run();

        // Reinsert with original IDs so FK relationships are preserved. Each inserter
        // covers the live-schema columns actually present in this backup's rows for that
        // table — see makeInserter() above.
        const stmts = {
          printer:        makeInserter(db, 'printers', backup.printers || []),
          project:        makeInserter(db, 'projects', backup.projects || []),
          part:           makeInserter(db, 'parts', backup.parts || []),
          gcode:          makeInserter(db, 'gcodes', backup.gcodes || []),
          job:            makeInserter(db, 'jobs', backup.jobs || []),
          printer_event:  makeInserter(db, 'printer_events', backup.printer_events || []),
          printer_model:  makeInserter(db, 'printer_models', backup.printer_models || []),
          filament_type:  makeInserter(db, 'filament_types', backup.filament_types || []),
          filament_color: makeInserter(db, 'filament_colors', backup.filament_colors || []),
          setting:        makeInserter(db, 'settings', backup.settings || []),
        };

        // printer_models before printers — printers.model refers to it logically
        for (const m of (backup.printer_models || [])) stmts.printer_model.run(m);
        for (const p of (backup.printers || [])) stmts.printer.run(p);
        for (const p of (backup.projects || [])) stmts.project.run(p);
        for (const p of (backup.parts    || [])) stmts.part.run(p);
        for (const g of (backup.gcodes   || [])) {
          // filepath stores just the filename — no path rewriting needed
          stmts.gcode.run({ ...g, filepath: path.basename(g.filepath) });
        }
        for (const j of (backup.jobs || [])) stmts.job.run(j);
        for (const e of (backup.printer_events || [])) stmts.printer_event.run(e);
        // filament_types before filament_colors — FK on type_id
        for (const t of (backup.filament_types  || [])) stmts.filament_type.run(t);
        for (const c of (backup.filament_colors || [])) stmts.filament_color.run(c);
        for (const s of (backup.settings || [])) stmts.setting.run(s);

        // Sync auto-increment counters so new inserts don't collide
        for (const [table, col] of [
          ['printers', 'printers'], ['projects', 'projects'],
          ['parts', 'parts'], ['gcodes', 'gcodes'], ['jobs', 'jobs'],
          ['printer_events', 'printer_events'],
          ['filament_types', 'filament_types'], ['filament_colors', 'filament_colors'],
        ]) {
          db.prepare(`
            INSERT OR REPLACE INTO sqlite_sequence (name, seq)
            VALUES (?, (SELECT COALESCE(MAX(id), 0) FROM ${table}))
          `).run(col);
        }
      });

      restore();

      // The printers table was wiped and reinserted (possibly with changed IPs or
      // dropped ids). Stateful drivers cache a client per printer id, so drop them
      // all — the next poll rebuilds each connection from the restored config.
      try { drivers.closeAllConnections(); } catch (_) {}

      console.log(`[backup] Farm restored — ${backup.printers.length} printers, ${backup.projects.length} projects, ${backup.gcodes.length} gcodes, ${backup.jobs.length} jobs, ${(backup.printer_events || []).length} events, ${(backup.printer_models || []).length} printer models, ${(backup.filament_types || []).length} filament types, ${(backup.filament_colors || []).length} filament colors`);

      res.json({
        ok: true,
        printers:        (backup.printers        || []).length,
        projects:        (backup.projects        || []).length,
        parts:           (backup.parts           || []).length,
        gcodes:          (backup.gcodes          || []).length,
        jobs:            (backup.jobs            || []).length,
        printer_events:  (backup.printer_events  || []).length,
        printer_models:  (backup.printer_models  || []).length,
        filament_types:  (backup.filament_types  || []).length,
        filament_colors: (backup.filament_colors || []).length,
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
