const fs = require('fs');

// Read both the file head (first 4KB) and tail (last 50KB) to cover
// slicers that put metadata in the header (Cura, Bambu Studio) and
// footer (PrusaSlicer, OrcaSlicer). Only scans comment lines, matches
// specific patterns, and exits early once all target fields are found.

const HEAD_BYTES = 4 * 1024;  // 4KB — sufficient for Cura/Bambu header blocks
const TAIL_BYTES = 50 * 1024; // 50KB — sufficient for PrusaSlicer/Orca footer blocks

// Tail patterns (PrusaSlicer / OrcaSlicer / Bambu Studio)
const TAIL_PATTERNS = [
  { key: 'filament_used_g',   regex: /filament used \[g\]\s*=\s*([\d.]+)/i },
  { key: 'estimated_time_s',  regex: /estimated (?:printing )?time[:\s]*[=]?\s*(.+)/i },
  { key: 'layer_height',      regex: /layer_height\s*=\s*([\d.]+)/i },
  { key: 'filament_type',     regex: /filament_type\s*=\s*(\w+)/i },
  { key: 'nozzle_temp',       regex: /(?:nozzle_temperature|temperature)\s*=\s*([\d.]+)/i },
  { key: 'bed_temp',          regex: /bed_temperature\s*=\s*([\d.]+)/i },
  { key: 'printer_model',     regex: /printer_model\s*=\s*([\w\s-]+)/i },
];

// Head patterns (Cura — runs in header, only a few fields)
const HEAD_PATTERNS = [
  { key: 'estimated_time_s',  regex: /^;TIME:(\d+)/ },                      // Cura: ;TIME:1838 (seconds)
  { key: 'layer_height',      regex: /^;Layer height:\s*([\d.]+)/i },       // Cura: ;Layer height: 0.2
  { key: 'printer_model',     regex: /^;TARGET_MACHINE\.NAME:(.+)/i },      // Cura: ;TARGET_MACHINE.NAME:Creality K1 Max
  { key: 'filament_used_g',   regex: /^;weight:\s*\[?([\d.]+)\]?/i },       // Cura custom start gcode: ;weight: [3.44]
];

/**
 * Parse a human-readable time string like "2h 30m 15s" or "1h 5m" into seconds.
 */
function parseTimeString(str) {
  let total = 0;
  const h = str.match(/(\d+)\s*h/i);
  const m = str.match(/(\d+)\s*m/i);
  const s = str.match(/(\d+)\s*s/i);
  if (h) total += parseInt(h[1], 10) * 3600;
  if (m) total += parseInt(m[1], 10) * 60;
  if (s) total += parseInt(s[1], 10);
  return total > 0 ? total : null;
}

/**
 * Scan comment lines against a pattern list, populating result and tracking found keys.
 * Returns the set of found keys.
 */
function scanLines(lines, patterns, result, found) {
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed.startsWith(';')) continue;

    for (const { key, regex } of patterns) {
      if (found.has(key)) continue;
      const match = trimmed.match(regex);
      if (!match) continue;

      switch (key) {
        case 'filament_used_g':
          result.filament_used_g = parseFloat(match[1]);
          break;
        case 'estimated_time_s': {
          // Cura ;TIME: is bare seconds; Prusa/Orca is human-readable like "2h 30m"
          const v = parseFloat(match[1]);
          result.estimated_time_s = isNaN(v) ? parseTimeString(match[1]) : v;
          break;
        }
        case 'layer_height':
          result.layer_height = parseFloat(match[1]);
          break;
        case 'filament_type':
          result.filament_type = match[1];
          break;
        case 'nozzle_temp':
          result.nozzle_temp = parseFloat(match[1]);
          break;
        case 'bed_temp':
          result.bed_temp = parseFloat(match[1]);
          break;
        case 'printer_model':
          if (!result.printer_model) {
            result.printer_model = match[1].trim();
          }
          break;
      }
      found.add(key);
    }
  }
  return found;
}

/**
 * Parse a gcode file and extract slicer metadata from comment lines.
 * Reads both file head (Cura/Bambu header metadata) and tail (PrusaSlicer/Orca footer metadata).
 * Tail patterns take priority over head patterns because they're richer.
 * @param {string} filePath - Absolute path to the gcode file
 * @returns {{ filament_used_g: number|null, estimated_time_s: number|null,
 *             layer_height: number|null, filament_type: string,
 *             nozzle_temp: number|null, bed_temp: number|null,
 *             printer_model: string }}
 */
function parseGcodeFile(filePath) {
  const result = {
    filament_used_g: null,
    estimated_time_s: null,
    layer_height: null,
    filament_type: '',
    nozzle_temp: null,
    bed_temp: null,
    printer_model: '',
  };

  const found = new Set();
  let fd;
  try {
    fd = fs.openSync(filePath, 'r');
    const stats = fs.fstatSync(fd);
    const size = stats.size;

    // Read head (first 4KB) — covers Cura header metadata
    if (size > 0) {
      const headLen = Math.min(size, HEAD_BYTES);
      const headBuf = Buffer.alloc(headLen);
      fs.readSync(fd, headBuf, 0, headLen, 0);
      const headLines = headBuf.toString('utf-8').split('\n');
      scanLines(headLines, HEAD_PATTERNS, result, found);
    }

    // Read tail (last 50KB) — covers PrusaSlicer/Orca footer metadata
    if (size > HEAD_BYTES) {
      const start = Math.max(0, size - TAIL_BYTES);
      const tailLen = size - start;
      const tailBuf = Buffer.alloc(tailLen);
      fs.readSync(fd, tailBuf, 0, tailLen, start);
      const tailLines = tailBuf.toString('utf-8').split('\n');
      scanLines(tailLines, TAIL_PATTERNS, result, found);
    }
  } catch (err) {
    console.error(`[gcode-parser] Error reading ${filePath}:`, err.message);
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch (_) { /* ignore */ }
    }
  }

  return result;
}

module.exports = { parseGcodeFile };