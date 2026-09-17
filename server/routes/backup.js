const express = require('express');
const multer  = require('multer');
const path    = require('path');
const fs      = require('fs');

const router   = express.Router();
const GCODE_DIR = path.join(__dirname, '..', 'gcode');

const ERP_TABLES = [
  'uom',
  'warehouse',
  'location',
  'item',
  'machine',
  'bom',
  'bom_line',
  'stock_move',
  'item_cost',
  'mfg_component',
  'work_order',
  'wo_issue',
  'wo_labor',
  'pricing_config',
  'sales_order',
  'erp_posting',
];

const ERP_DELETE_ORDER = [
  'erp_posting',
  'sales_order',
  'wo_labor',
  'wo_issue',
  'stock_move',
  'work_order',
  'bom_line',
  'bom',
  'mfg_component',
  'item_cost',
  'machine',
  'item',
  'location',
  'warehouse',
  'uom',
  'pricing_config',
];

const ERP_INSERT_ORDER = [
  'uom',
  'warehouse',
  'location',
  'item',
  'machine',
  'bom',
  'bom_line',
  'item_cost',
  'mfg_component',
  'work_order',
  'stock_move',
  'wo_issue',
  'wo_labor',
  'pricing_config',
  'sales_order',
  'erp_posting',
];

const ERP_SEQUENCE_TABLES = ERP_TABLES.filter(table => !['uom', 'item_cost'].includes(table));

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

function exportErp(db) {
  return Object.fromEntries(ERP_TABLES.map(table => [
    table,
    db.prepare(`SELECT * FROM ${table}`).all(),
  ]));
}

function validateErpBackup(erp) {
  if (erp === undefined) return null;
  if (!erp || typeof erp !== 'object' || Array.isArray(erp)) {
    return 'erp must be an object containing every ERP table';
  }
  const missing = ERP_TABLES.filter(table => !Array.isArray(erp[table]));
  if (missing.length > 0) return `erp is missing table arrays: ${missing.join(', ')}`;
  return null;
}

function syncSequence(db, table) {
  db.prepare(`
    INSERT OR REPLACE INTO sqlite_sequence (name, seq)
    VALUES (?, (SELECT COALESCE(MAX(id), 0) FROM ${table}))
  `).run(table);
}

module.exports = (db) => {
  // GET /api/backup: export the complete CoMa SQLite domain as a JSON bundle.
  router.get('/', (req, res) => {
    const printers        = db.prepare('SELECT * FROM printers').all();
    const projects        = db.prepare('SELECT * FROM projects').all();
    const parts           = db.prepare('SELECT * FROM parts').all();
    const gcodes          = db.prepare('SELECT * FROM gcodes').all();
    const jobs            = db.prepare('SELECT * FROM jobs').all();
    const printer_events  = db.prepare('SELECT * FROM printer_events').all();
    const printer_status_history = db.prepare('SELECT * FROM printer_status_history').all();
    const timelapses      = db.prepare('SELECT * FROM timelapses').all();
    const printer_models  = db.prepare('SELECT * FROM printer_models').all();
    const printer_groups  = db.prepare('SELECT * FROM printer_groups').all();
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
      printer_status_history,
      timelapses,
      printer_models,
      printer_groups,
      filament_types,
      filament_colors,
      settings,
      erp: exportErp(db),
      gcode_files: gcodeFiles,
    };

    const date = new Date().toISOString().slice(0, 10);
    res.setHeader('Content-Disposition', `attachment; filename="shopfloor-backup-${date}.json"`);
    res.setHeader('Content-Type', 'application/json');
    res.json(backup);
  });

  // POST /api/backup/restore: replace all data represented by a backup JSON file.
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

      const erpValidationError = validateErpBackup(backup.erp);
      if (erpValidationError) return res.status(400).json({ error: erpValidationError });

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
      const hasPrinterGroups  = Array.isArray(backup.printer_groups);
      const hasFilamentTypes  = Array.isArray(backup.filament_types);
      const hasFilamentColors = Array.isArray(backup.filament_colors);
      const hasSettings       = Array.isArray(backup.settings);
      const hasErp            = backup.erp !== undefined;

      const restore = db.transaction(() => {
        // ERP rows are cleared only for backups that contain the complete ERP section.
        // Older shopfloor-only backups leave existing ERP data untouched.
        if (hasErp) {
          for (const table of ERP_DELETE_ORDER) db.prepare(`DELETE FROM ${table}`).run();
        }

        // Delete in FK dependency order
        db.prepare('DELETE FROM printer_events').run();
        try { db.prepare('DELETE FROM printer_status_history').run(); } catch (_) {}
        try { db.prepare('DELETE FROM timelapses').run(); } catch (_) {}
        db.prepare('DELETE FROM jobs').run();
        db.prepare('DELETE FROM gcodes').run();
        db.prepare('DELETE FROM parts').run();
        db.prepare('DELETE FROM projects').run();
        db.prepare('DELETE FROM printers').run();
        if (hasFilamentColors) db.prepare('DELETE FROM filament_colors').run(); // before filament_types — FK on type_id
        if (hasFilamentTypes)  db.prepare('DELETE FROM filament_types').run();
        if (hasPrinterModels)  db.prepare('DELETE FROM printer_models').run();
        if (hasPrinterGroups)  db.prepare('DELETE FROM printer_groups').run();
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
          printer_status_history: makeInserter(db, 'printer_status_history', backup.printer_status_history || []),
          timelapse:      makeInserter(db, 'timelapses', backup.timelapses || []),
          printer_model:  makeInserter(db, 'printer_models', backup.printer_models || []),
          printer_group:  makeInserter(db, 'printer_groups', backup.printer_groups || []),
          filament_type:  makeInserter(db, 'filament_types', backup.filament_types || []),
          filament_color: makeInserter(db, 'filament_colors', backup.filament_colors || []),
          setting:        makeInserter(db, 'settings', backup.settings || []),
        };

        const erpStmts = hasErp
          ? Object.fromEntries(ERP_TABLES.map(table => [table, makeInserter(db, table, backup.erp[table])]))
          : null;

        // printer_models before printers — printers.model refers to it logically
        for (const m of (backup.printer_models || [])) stmts.printer_model.run(m);
        for (const g of (backup.printer_groups || [])) stmts.printer_group.run(g);
        for (const p of (backup.printers || [])) stmts.printer.run(p);
        for (const p of (backup.projects || [])) stmts.project.run(p);
        for (const p of (backup.parts    || [])) stmts.part.run(p);
        for (const g of (backup.gcodes   || [])) {
          // filepath stores just the filename — no path rewriting needed
          stmts.gcode.run({ ...g, filepath: path.basename(g.filepath) });
        }
        for (const j of (backup.jobs || [])) stmts.job.run(j);
        for (const e of (backup.printer_events || [])) stmts.printer_event.run(e);
        for (const h of (backup.printer_status_history || [])) stmts.printer_status_history.run(h);
        for (const t of (backup.timelapses || [])) stmts.timelapse.run(t);
        // filament_types before filament_colors — FK on type_id
        for (const t of (backup.filament_types  || [])) stmts.filament_type.run(t);
        for (const c of (backup.filament_colors || [])) stmts.filament_color.run(c);
        for (const s of (backup.settings || [])) stmts.setting.run(s);

        if (hasErp) {
          for (const table of ERP_INSERT_ORDER) {
            for (const row of backup.erp[table]) erpStmts[table].run(row);
          }
        }

        // Sync auto-increment counters so new inserts don't collide
        for (const [table, col] of [
          ['printers', 'printers'], ['projects', 'projects'],
          ['parts', 'parts'], ['gcodes', 'gcodes'], ['jobs', 'jobs'],
          ['printer_events', 'printer_events'],
          ['printer_status_history', 'printer_status_history'],
          ['timelapses', 'timelapses'],
          ['filament_types', 'filament_types'], ['filament_colors', 'filament_colors'],
        ]) {
          try {
            db.prepare(`
              INSERT OR REPLACE INTO sqlite_sequence (name, seq)
              VALUES (?, (SELECT COALESCE(MAX(id), 0) FROM ${table}))
            `).run(col);
          } catch (_) { /* table may be empty / missing sequence */ }
        }
        if (hasErp) {
          for (const table of ERP_SEQUENCE_TABLES) syncSequence(db, table);
        }
      });

      restore();

      console.log(`[backup] CoMa restored: ${backup.printers.length} printers, ${backup.projects.length} projects, ${backup.gcodes.length} gcodes, ${backup.jobs.length} jobs, ERP ${hasErp ? 'included' : 'preserved from current database'}`);

      res.json({
        ok: true,
        printers:        (backup.printers        || []).length,
        projects:        (backup.projects        || []).length,
        parts:           (backup.parts           || []).length,
        gcodes:          (backup.gcodes          || []).length,
        jobs:            (backup.jobs            || []).length,
        printer_events:  (backup.printer_events  || []).length,
        printer_models:  (backup.printer_models  || []).length,
        printer_groups:  (backup.printer_groups  || []).length,
        filament_types:  (backup.filament_types  || []).length,
        filament_colors: (backup.filament_colors || []).length,
        erp: hasErp
          ? Object.fromEntries(ERP_TABLES.map(table => [table, backup.erp[table].length]))
          : null,
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
