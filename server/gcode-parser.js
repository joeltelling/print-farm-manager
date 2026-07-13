const fs = require('fs');

// Read both the file head (first 4KB) and tail (last 50KB) to cover
// slicers that put metadata in the header (Cura) and footer (PrusaSlicer,
// OrcaSlicer). The head buffer is scanned with both head and tail patterns
// so metadata is found regardless of where the slicer places it. Bambu
// .3mf files are handled separately by ../3mf-parser.js.

const HEAD_BYTES = 4 * 1024;  // 4KB — sufficient for Cura/Bambu header blocks
const TAIL_BYTES = 50 * 1024; // 50KB — sufficient for PrusaSlicer/Orca footer blocks

// Tail patterns (PrusaSlicer / OrcaSlicer / Bambu Studio)
const TAIL_PATTERNS = [
  { key: 'filament_used_g',   regex: /filament used \[g\]\s*=\s*([\d.]+)/i },
  { key: 'estimated_time_s',  regex: /estimated (?:printing )?time[:\s]*[=]?\s*(.+)/i },
  { key: 'layer_height',      regex: /layer_height\s*=\s*([\d.]+)/i },
  { key: 'filament_type',     regex: /filament_type\s*=\s*(\w+)/i },
  { key: 'nozzle_temp',       regex: /\bnozzle_temperature\s*=\s*([\d.]+)/i },
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
 * Parse a human-readable time string like "2h 30m 15s" or "1d 2h" into seconds.
 */
function parseTimeString(str) {
  let total = 0;
  const d = str.match(/(\d+)\s*d(?:ays?)?/i);
  const h = str.match(/(\d+)\s*h/i);
  const m = str.match(/(\d+)\s*m/i);
  const s = str.match(/(\d+)\s*s/i);
  if (d) total += parseInt(d[1], 10) * 86400;
  if (h) total += parseInt(h[1], 10) * 3600;
  if (m) total += parseInt(m[1], 10) * 60;
  if (s) total += parseInt(s[1], 10);
  return total > 0 ? total : null;
}

/**
 * Scan comment lines against a pattern list, populating result and tracking found keys.
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
          const raw = match[1].trim();
          if (/[dhms]/i.test(raw)) {
            result.estimated_time_s = parseTimeString(raw);
          } else {
            result.estimated_time_s = parseFloat(raw) || null;
          }
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
 * Scans the head (first 4KB) with both head and tail patterns to catch
 * metadata regardless of which slicer produced it, then scans the tail
 * (last 50KB) for footer-format patterns from PrusaSlicer/Orca.
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

    if (size > 0) {
      const headLen = Math.min(size, HEAD_BYTES);
      const headBuf = Buffer.alloc(headLen);
      fs.readSync(fd, headBuf, 0, headLen, 0);
      scanLines(headBuf.toString('utf-8').split('\n'), HEAD_PATTERNS, result, found);
      scanLines(headBuf.toString('utf-8').split('\n'), TAIL_PATTERNS, result, found);
    }

    if (size > HEAD_BYTES) {
      const start = Math.max(0, size - TAIL_BYTES);
      const tailLen = size - start;
      const tailBuf = Buffer.alloc(tailLen);
      fs.readSync(fd, tailBuf, 0, tailLen, start);
      scanLines(tailBuf.toString('utf-8').split('\n'), TAIL_PATTERNS, result, found);
    }
  } catch (err) {
    console.error(`[gcode-parser] Error reading ${filePath}:`, err.message);
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch (_) {}
    }
  }

  return result;
}

module.exports = { parseGcodeFile };