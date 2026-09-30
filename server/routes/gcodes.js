const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const router = express.Router();

const zip = require('../zip-reader');
const { readSlicerMetadata } = require('../slicer-metadata');
const { normalizePrintTime, normalizeMaterialGrams } = require('../estimate-input');

const GCODE_DIR = path.join(__dirname, '..', 'gcode');

const storage = multer.diskStorage({
  destination: GCODE_DIR,
  filename: (_req, file, cb) => cb(null, Date.now() + '_' + file.originalname),
});
const upload = multer({ storage });

function runUpload(req, res) {
  return new Promise((resolve, reject) => {
    upload.single('file')(req, res, (err) => {
      if (err) reject(err);
      else resolve();
    });
  });
}

// Model token in filename → internal ID
const MODEL_TOKEN_MAP = {
  mk4s: 'mk4s',
  mk4:  'mk4',
  c1l:  'c1l',
  c1:   'c1',
  core1l: 'c1l',
  coreone: 'c1',
  core1:   'c1',
  xl:   'xl',
};

function parseFilename(filename) {
  // Allow an optional trailing token (e.g. _37grams, _45g) after the time field before the extension.
  const regex = /^(\d+)x\s+(.+?)_(\d+\.\d+n)_(\d+\.\d+mm)_([A-Za-z]+)_([A-Za-z0-9]+)_(\d+h\d+m)(?:_[^.]+)?\.(bgcode|gcode)$/i;
  const match = filename.match(regex);
  if (!match) return null;

  const parts_per_plate = parseInt(match[1], 10);
  const model_token = match[6].toLowerCase();
  const printer_model = MODEL_TOKEN_MAP[model_token] || null;

  // Parse "5h11m" → seconds
  const timeMatch = match[7].match(/(\d+)h(\d+)m/);
  const est_print_secs = timeMatch
    ? parseInt(timeMatch[1], 10) * 3600 + parseInt(timeMatch[2], 10) * 60
    : null;

  return { parts_per_plate, printer_model, est_print_secs, part_name_hint: match[2] };
}

// Extract material grams from any filename — flexible pattern matching.
// kg before g to avoid "1.2kg" matching "2" with /g/.
function extractMaterialGramsFromFilename(filename) {
  const kg = filename.match(/(?:^|[_\s\-\.])(\d+(?:\.\d+)?)\s*kg(?:[_\s\-\.\(]|$)/i);
  if (kg) return parseFloat(kg[1]) * 1000;
  const g = filename.match(/(?:^|[_\s\-\.])(\d+(?:\.\d+)?)\s*(?:grams?|g)(?:[_\s\-\.\(]|$)/i);
  if (g) return parseFloat(g[1]);
  return null;
}

// ZIP walking lives in server/zip-reader.js, shared with the slicer-metadata parser that
// reads print time and weight out of the same archive.

// The Bambu driver prints exactly Metadata/plate_1.gcode from the uploaded .3mf
// (see server/drivers/bambu.js, project_file payload). A project file saved
// without slicing has no gcode entry at all, and the printer ignores the print
// command silently: the job sits in 'printing' forever against an idle machine.
// Catch that at upload time with an instructive error instead.
// Returns null when the file is fine, or an error string.
function validateSliced3mf(filePath) {
  let names;
  try {
    names = zip.listEntryNames(fs.readFileSync(filePath));
  } catch (_) {
    names = null;
  }
  if (names === null) {
    return 'This file is not a readable .3mf archive. Export it again from your slicer.';
  }
  if (names.includes('Metadata/plate_1.gcode')) return null;

  const otherPlate = names.find(n => /^Metadata\/plate_\d+\.gcode$/.test(n));
  if (otherPlate) {
    return `This .3mf contains ${otherPlate.replace('Metadata/', '')} but the farm prints plate_1. ` +
           'In your slicer, export just the sliced plate (it becomes plate 1 in the exported file).';
  }
  return 'This .3mf contains no sliced G-code, so the printer would silently ignore it. ' +
         'In Bambu Studio / Orca Slicer: Slice Plate first, then File > Export > Export plate sliced file.';
}

// scheduler is optional, only needed at runtime for sweepIdlePrinters after an upload
// makes a part schedulable. Tests pass null so there is no live scheduler dependency.
module.exports = (db, scheduler = null) => {
  // GET /api/gcodes — list, optionally filtered by part_id
  router.get('/', (req, res) => {
    const { part_id } = req.query;
    const gcodes = part_id
      ? db.prepare('SELECT * FROM gcodes WHERE part_id = ?').all(part_id)
      : db.prepare('SELECT * FROM gcodes ORDER BY created_at DESC').all();
    res.json(gcodes);
  });

  // POST /api/gcodes/parse-filename — parse filename, return fields, don't save anything
  router.post('/parse-filename', (req, res) => {
    const { filename } = req.body;
    if (!filename) return res.status(400).json({ error: 'filename is required' });
    const parsed = parseFilename(filename);
    const material_grams = extractMaterialGramsFromFilename(filename);
    if (!parsed) {
      return res.json({ parse_failed: true, material_grams });
    }
    res.json({ parse_failed: false, ...parsed, material_grams });
  });

  // POST /api/gcodes/upload — upload G-code file and create DB record
  router.post('/upload', async (req, res) => {
    try {
      await runUpload(req, res);
    } catch (err) {
      return res.status(400).json({ error: err.message });
    }

    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

    const { part_id, parts_per_plate, printer_model, est_print_secs, ams_slot, material_grams,
            allowed_groups, required_material, required_color } = req.body;

    if (!part_id || !parts_per_plate || !printer_model) {
      fs.unlinkSync(req.file.path);
      return res.status(400).json({ error: 'part_id, parts_per_plate, and printer_model are required' });
    }

    if (!db.prepare('SELECT 1 FROM printer_models WHERE model_id = ?').get(printer_model)) {
      fs.unlinkSync(req.file.path);
      return res.status(400).json({ error: `Unknown model "${printer_model}". Add it in Settings → Printer Models first.` });
    }

    if (path.extname(req.file.originalname).toLowerCase() === '.3mf') {
      const sliceError = validateSliced3mf(req.file.path);
      if (sliceError) {
        fs.unlinkSync(req.file.path);
        return res.status(400).json({ error: sliceError });
      }
    }

    // Enforce uniqueness on (part_id, printer_model) at app layer
    const existing = db.prepare(
      'SELECT id FROM gcodes WHERE part_id = ? AND printer_model = ?'
    ).get(part_id, printer_model);
    if (existing) {
      fs.unlinkSync(req.file.path);
      return res.status(409).json({
        error: `This Part already has a G-code for ${printer_model}. Delete the existing one before uploading a replacement.`,
      });
    }

    // ams_slot: -1 = external spool, 0–N = AMS slot, null = not applicable (non-Bambu)
    const parsedAmsSlot = ams_slot !== undefined && ams_slot !== '' ? parseInt(ams_slot, 10) : null;

    // What the sliced file says about itself beats what the client inferred from the
    // filename: an Orca or Bambu .3mf carries the slicer's own seconds and grams, and a
    // plain .gcode carries them in its comments. The filename-derived values the client
    // posts are the fallback for a .bgcode or a file whose slicer wrote neither.
    // These estimates drive the forward schedule's block lengths, so a real number here
    // is the difference between a usable projection and a wall of two-hour defaults.
    const fileMeta = readSlicerMetadata(req.file.path, req.file.originalname);

    const clientEstSecs = est_print_secs ? parseInt(est_print_secs, 10) : null;
    const resolvedEstSecs = fileMeta.est_print_secs ?? (Number.isFinite(clientEstSecs) ? clientEstSecs : null);

    const clientGrams = material_grams ? parseFloat(material_grams) : null;
    const parsedMaterialGrams = fileMeta.material_grams ?? (Number.isFinite(clientGrams) ? clientGrams : null);

    if (fileMeta.source !== 'none') {
      console.log(`[gcodes] Read estimates from ${fileMeta.source} for "${req.file.originalname}": ` +
        `${fileMeta.est_print_secs ?? 'no'} secs, ${fileMeta.material_grams ?? 'no'} grams`);
    }

    // allowed_groups: JSON array string e.g. '["MK4S Farm","XL Farm"]', or null = all groups
    const parsedAllowedGroups = allowed_groups && allowed_groups !== '' ? allowed_groups : null;
    const parsedRequiredMaterial = required_material && required_material !== '' ? required_material.trim() : null;
    const parsedRequiredColor    = required_color    && required_color    !== '' ? required_color.trim()    : null;

    const gcode = db.prepare(`
      INSERT INTO gcodes (part_id, printer_model, filename, filepath, parts_per_plate, est_print_secs, material_grams, ams_slot, allowed_groups, required_material, required_color, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      part_id,
      printer_model,
      req.file.originalname,
      req.file.filename,
      parseInt(parts_per_plate, 10),
      resolvedEstSecs,
      parsedMaterialGrams,
      parsedAmsSlot,
      parsedAllowedGroups,
      parsedRequiredMaterial,
      parsedRequiredColor,
      Date.now()
    );

    // A part only becomes a real dispatch candidate once it has a matching G-code: the
    // scheduler's candidate query joins on gcodes. Sweep now so an idle printer picks up
    // work immediately instead of waiting for a manual dispatch or the next printer status
    // transition. Safe to call unconditionally: sweepIdlePrinters already filters to active
    // projects with open, unmet parts internally.
    if (scheduler) scheduler.sweepIdlePrinters();

    res.status(201).json(db.prepare('SELECT * FROM gcodes WHERE id = ?').get(gcode.lastInsertRowid));
  });

  // PUT /api/gcodes/:id — update est_print_secs and/or material_grams
  // Accepts human-readable strings ("2h15m", "45g") or raw numbers; omitting a field leaves it unchanged.
  router.put('/:id', (req, res) => {
    const gcode = db.prepare('SELECT * FROM gcodes WHERE id = ?').get(req.params.id);
    if (!gcode) return res.status(404).json({ error: 'G-code not found' });

    let estPrintSecs = gcode.est_print_secs;
    if ('print_time' in req.body) {
      if (!req.body.print_time) {
        estPrintSecs = null;
      } else {
        estPrintSecs = normalizePrintTime(req.body.print_time);
        if (estPrintSecs === null) {
          return res.status(400).json({ error: 'Cannot parse print time. Use formats like "2h15m", "90m", or "1:30:00".' });
        }
      }
    }

    let materialGrams = gcode.material_grams;
    if ('material_grams' in req.body) {
      if (!req.body.material_grams) {
        materialGrams = null;
      } else {
        materialGrams = normalizeMaterialGrams(req.body.material_grams);
        if (materialGrams === null) {
          return res.status(400).json({ error: 'Cannot parse material. Use formats like "45g", "45.5g", or "1.2kg".' });
        }
      }
    }

    // allowed_groups / required_material / required_color: present-in-body wins; absent = keep existing
    const allowedGroups      = 'allowed_groups'      in req.body ? (req.body.allowed_groups      || null) : gcode.allowed_groups;
    const requiredMaterial   = 'required_material'   in req.body ? (req.body.required_material   || null) : gcode.required_material;
    const requiredColor      = 'required_color'      in req.body ? (req.body.required_color       || null) : gcode.required_color;

    db.prepare('UPDATE gcodes SET est_print_secs = ?, material_grams = ?, allowed_groups = ?, required_material = ?, required_color = ? WHERE id = ?')
      .run(estPrintSecs, materialGrams, allowedGroups, requiredMaterial, requiredColor, req.params.id);

    // Loosening a G-code's group or filament targeting can make an already-idle printer a
    // match, and idle printers never re-ask on their own, so sweep when targeting changed.
    const targetingChanged =
      allowedGroups    !== gcode.allowed_groups ||
      requiredMaterial !== gcode.required_material ||
      requiredColor    !== gcode.required_color;
    if (targetingChanged && scheduler) scheduler.sweepIdlePrinters();

    res.json(db.prepare('SELECT * FROM gcodes WHERE id = ?').get(req.params.id));
  });

  // DELETE /api/gcodes/:id
  router.delete('/:id', (req, res) => {
    const gcode = db.prepare('SELECT * FROM gcodes WHERE id = ?').get(req.params.id);
    if (!gcode) return res.status(404).json({ error: 'G-code not found' });

    const activeJob = db.prepare(
      "SELECT id FROM jobs WHERE gcode_id = ? AND status IN ('queued', 'uploading', 'printing') LIMIT 1"
    ).get(req.params.id);
    if (activeJob) {
      return res.status(409).json({ error: 'Cannot delete — this G-code has an active job in progress.' });
    }

    // Detach historical jobs so the FK doesn't block deletion
    db.prepare("UPDATE jobs SET gcode_id = NULL WHERE gcode_id = ?").run(req.params.id);

    const gcodeFilename = gcode.filepath.split(/[\\/]/).pop();
    const fullPath = path.join(GCODE_DIR, gcodeFilename);
    if (fs.existsSync(fullPath)) {
      fs.unlinkSync(fullPath);
    }
    db.prepare('DELETE FROM gcodes WHERE id = ?').run(req.params.id);
    res.json({ success: true });
  });

  return router;
};
