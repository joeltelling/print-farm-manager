// Plain RGB Euclidean distance between two hex colors, used by the scheduler's
// optional color-tolerance fallback (see scheduler.js and the `color_tolerance`
// setting). Not a perceptual color model (CIEDE2000 etc.): good enough to tell
// "same color family, different shade" from "a different color" without a
// color-science dependency for a farm-scheduling tolerance knob.
//
// Range: 0 (identical) to ~441.7 (pure black vs pure white), since each of the
// three channels can differ by at most 255 (sqrt(3 * 255^2)).
function parseHex(hex) {
  if (typeof hex !== 'string') return null;
  const trimmed = hex.trim();
  const m6 = /^#?([0-9a-fA-F]{6})$/.exec(trimmed);
  if (m6) {
    const n = parseInt(m6[1], 16);
    return { r: (n >> 16) & 0xff, g: (n >> 8) & 0xff, b: n & 0xff };
  }
  const m3 = /^#?([0-9a-fA-F]{3})$/.exec(trimmed);
  if (m3) {
    const [r, g, b] = m3[1];
    const n = parseInt(`${r}${r}${g}${g}${b}${b}`, 16);
    return { r: (n >> 16) & 0xff, g: (n >> 8) & 0xff, b: n & 0xff };
  }
  return null;
}

function hexDistance(hexA, hexB) {
  const a = parseHex(hexA);
  const b = parseHex(hexB);
  if (!a || !b) return null;
  return Math.sqrt((a.r - b.r) ** 2 + (a.g - b.g) ** 2 + (a.b - b.b) ** 2);
}

// True only when both hex values parse and their distance is within tolerance.
// A tolerance of 0 (or less, or missing/invalid hex on either side) never
// matches: fail closed rather than silently treating an unset hex as "close
// enough to anything".
function colorsClose(hexA, hexB, tolerance) {
  if (!(tolerance > 0)) return false;
  const dist = hexDistance(hexA, hexB);
  return dist !== null && dist <= tolerance;
}

// Accepts "#rrggbb", "rrggbb", "#rgb", or "rgb" (case-insensitive) and returns
// a normalized lowercase hex string (kept at whatever digit count was given,
// e.g. "#000" stays 3-digit, both are valid CSS), or null if the input isn't a
// hex color at all. filament_colors.hex_color is always stored through this
// (routes/filaments.js, and db.js's startup backfill for rows saved before this
// existed) so a value missing its leading "#" can never reach the DB: as a bare
// CSS `background` string that's silently ignored by the browser, which is why
// an un-normalized hex looked like a swatch that "doesn't work" instead of an
// obvious error, rather than actually being rejected.
function normalizeHex(input) {
  if (typeof input !== 'string') return null;
  const trimmed = input.trim();
  if (!trimmed) return null;
  const m6 = /^#?([0-9a-fA-F]{6})$/.exec(trimmed);
  if (m6) return `#${m6[1].toLowerCase()}`;
  const m3 = /^#?([0-9a-fA-F]{3})$/.exec(trimmed);
  if (m3) return `#${m3[1].toLowerCase()}`;
  return null;
}

module.exports = { hexDistance, colorsClose, normalizeHex };
