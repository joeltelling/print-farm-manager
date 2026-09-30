// Reads print time and material weight out of a sliced file, so the schedule can show a
// real block length instead of a guess and the operator does not have to retype what the
// slicer already computed. Read-only: nothing here touches the database.
//
// Sources, in the order they are trusted:
//
// 1. .3mf (Bambu Studio, Orca Slicer): Metadata/slice_info.config, a small XML file:
//
//      <config>
//        <plate>
//          <metadata key="index" value="1"/>
//          <metadata key="prediction" value="4383"/>
//          <metadata key="weight" value="17.24"/>
//          <filament id="1" type="PLA" used_m="5.75" used_g="17.24"/>
//        </plate>
//      </config>
//
//    "prediction" is whole seconds and "weight" is grams. Verified against OrcaSlicer
//    source, not inferred from a sample file: src/libslic3r/Format/bbs_3mf.cpp declares
//    SLICE_PREDICTION_ATTR = "prediction" / SLICE_WEIGHT_ATTR = "weight" and writes them
//    in _add_slice_info_config_file_to_archive, and src/slic3r/GUI/PartPlate.cpp fills
//    them from print_statistics.modes[Normal].time (an int cast, so seconds) and
//    ps.total_weight (formatted "%.2f", grams). PLATE_IDX_ATTR is "index", 1-based.
//
//    The farm always prints Metadata/plate_1.gcode (see server/drivers/bambu.js), so the
//    plate with index 1 is the one whose numbers apply.
//
// 2. .gcode: the footer/header comments both slicer families write:
//      PrusaSlicer: "; estimated printing time (normal mode) = 1h 13m 3s"
//      Orca/Bambu:  "; model printing time: 1h 10m; total estimated time: 1h 13m"
//      (both from src/libslic3r/GCode/GCodeProcessor.cpp)
//      Both:        "; total filament used [g] = 45.67"  (src/libslic3r/GCode.cpp)
//
// 3. .bgcode: not parsed. Prusa's binary container needs its own block reader plus
//    heatshrink decompression; callers fall back to the filename parse. Say "unknown"
//    rather than guess.

const fs = require('fs');
const path = require('path');
const zip = require('./zip-reader');

const SLICE_INFO_ENTRY = 'Metadata/slice_info.config';

// How much of a plain .gcode file to read from each end. Orca and Bambu emit the time
// estimate near the top (the printer's display reads it there), PrusaSlicer writes it in
// the footer, so both ends are scanned. Must comfortably exceed the size of a slicer's
// comment block, not the whole file: these files run to hundreds of MB.
const GCODE_SCAN_BYTES = 128 * 1024;

// Parse a slicer duration string into whole seconds: "3d 5h 13m 42s", "1h 13m 3s",
// "13m", "42s". Returns null when nothing parses, so a format change surfaces as
// "unknown" rather than as a wrong number.
function parseSlicerDuration(raw) {
  if (typeof raw !== 'string') return null;
  let total = 0;
  let found = false;
  for (const [unit, mult] of [['d', 86400], ['h', 3600], ['m', 60], ['s', 1]]) {
    const m = raw.match(new RegExp(`(\\d+(?:\\.\\d+)?)\\s*${unit}(?![a-z])`, 'i'));
    if (m) { total += parseFloat(m[1]) * mult; found = true; }
  }
  if (!found) return null;
  return Math.round(total);
}

// Pull the <plate> block the farm actually prints out of slice_info.config. Plates are
// matched on the "index" metadata rather than document order, since a multi-plate export
// is not guaranteed to list them in order.
function selectPlateBlock(xml) {
  const blocks = xml.match(/<plate\b[\s\S]*?<\/plate>/gi);
  if (!blocks || blocks.length === 0) return null;
  const plateOne = blocks.find(b => /key\s*=\s*"index"\s+value\s*=\s*"1"/i.test(b));
  // A single-plate export from an older Orca build may omit the index entirely; with
  // exactly one plate there is no ambiguity about which one is printed.
  if (plateOne) return plateOne;
  return blocks.length === 1 ? blocks[0] : null;
}

function metadataValue(block, key) {
  const m = block.match(new RegExp(`key\\s*=\\s*"${key}"\\s+value\\s*=\\s*"([^"]*)"`, 'i'));
  return m ? m[1] : null;
}

// Returns { est_print_secs, material_grams } with null for anything not found.
function parseSliceInfoConfig(xml) {
  const result = { est_print_secs: null, material_grams: null };
  if (typeof xml !== 'string') return result;

  const plate = selectPlateBlock(xml);
  if (!plate) return result;

  // "prediction" is already whole seconds; parse it as an integer rather than running it
  // through the duration parser, which expects unit suffixes.
  const prediction = metadataValue(plate, 'prediction');
  if (prediction !== null && /^\d+$/.test(prediction.trim())) {
    const secs = parseInt(prediction.trim(), 10);
    if (secs > 0) result.est_print_secs = secs;
  }

  // Orca omits weight entirely when the plate total is zero, so a missing value is
  // "unknown", not "zero grams".
  const weight = metadataValue(plate, 'weight');
  if (weight !== null && /^\d+(\.\d+)?$/.test(weight.trim())) {
    const grams = parseFloat(weight.trim());
    if (grams > 0) result.material_grams = grams;
  }

  return result;
}

// Sum a "[g] = " comment value. Multi-material slices write one comma-separated list
// per extruder ("1.20, 3.40"), and the plate's material cost is their total.
function sumGramsList(raw) {
  const nums = raw.split(',')
    .map(s => parseFloat(s.trim()))
    .filter(n => Number.isFinite(n) && n > 0);
  if (nums.length === 0) return null;
  return nums.reduce((a, b) => a + b, 0);
}

// Returns { est_print_secs, material_grams } from plain G-code comment text.
function parseGcodeComments(text) {
  const result = { est_print_secs: null, material_grams: null };
  if (typeof text !== 'string') return result;

  // Orca/Bambu first: when both appear, "total estimated time" is the number that
  // includes filament changes, so it is the one that matches wall-clock.
  let m = text.match(/^;\s*(?:.*?;\s*)?total estimated time:\s*([^\n;]+)$/im)
       || text.match(/^;\s*estimated printing time \(normal mode\)\s*=\s*([^\n]+)$/im)
       || text.match(/^;\s*estimated printing time\s*=\s*([^\n]+)$/im);
  if (m) result.est_print_secs = parseSlicerDuration(m[1]);

  // "total filament used" is the whole-plate number; the unprefixed form is per-extruder
  // and only used when no total was written.
  m = text.match(/^;\s*total filament used \[g\]\s*=\s*([^\n]+)$/im)
   || text.match(/^;\s*filament used \[g\]\s*=\s*([^\n]+)$/im);
  if (m) result.material_grams = sumGramsList(m[1]);

  return result;
}

// Read the head and tail of a file without loading the middle. Returns '' on any I/O
// error: an unreadable file is handled by the caller's own validation, not here.
function readEnds(filePath, bytes) {
  let fd;
  try {
    fd = fs.openSync(filePath, 'r');
    const size = fs.fstatSync(fd).size;
    if (size <= bytes * 2) {
      const buf = Buffer.alloc(size);
      fs.readSync(fd, buf, 0, size, 0);
      return buf.toString('latin1');
    }
    const head = Buffer.alloc(bytes);
    const tail = Buffer.alloc(bytes);
    fs.readSync(fd, head, 0, bytes, 0);
    fs.readSync(fd, tail, 0, bytes, size - bytes);
    return head.toString('latin1') + '\n' + tail.toString('latin1');
  } catch (_) {
    return '';
  } finally {
    if (fd !== undefined) { try { fs.closeSync(fd); } catch (_) {} }
  }
}

// Read whatever the sliced file knows about itself.
//
// Returns { est_print_secs, material_grams, source } where source is:
//   '3mf'      values came from Metadata/slice_info.config
//   'gcode'    values came from G-code comments
//   'none'     nothing was parseable (unsupported container, or a slicer that wrote
//              neither): the caller falls back to the filename parse
// Individual fields are null when that specific value was not found, so a file with a
// time but no weight reports source '3mf' with material_grams null.
function readSlicerMetadata(filePath, originalName = filePath) {
  const ext = path.extname(originalName).toLowerCase();

  if (ext === '.3mf') {
    let xmlBuf = null;
    try {
      xmlBuf = zip.readEntry(fs.readFileSync(filePath), SLICE_INFO_ENTRY);
    } catch (_) {
      xmlBuf = null;
    }
    if (!xmlBuf) return { est_print_secs: null, material_grams: null, source: 'none' };
    const parsed = parseSliceInfoConfig(xmlBuf.toString('utf8'));
    const found = parsed.est_print_secs !== null || parsed.material_grams !== null;
    return { ...parsed, source: found ? '3mf' : 'none' };
  }

  if (ext === '.gcode' || ext === '.gco' || ext === '.g') {
    const parsed = parseGcodeComments(readEnds(filePath, GCODE_SCAN_BYTES));
    const found = parsed.est_print_secs !== null || parsed.material_grams !== null;
    return { ...parsed, source: found ? 'gcode' : 'none' };
  }

  // .bgcode and anything else: not parseable here by design.
  return { est_print_secs: null, material_grams: null, source: 'none' };
}

module.exports = {
  readSlicerMetadata,
  parseSliceInfoConfig,
  parseGcodeComments,
  parseSlicerDuration,
  GCODE_SCAN_BYTES,
};
