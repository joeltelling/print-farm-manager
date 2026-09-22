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
  const m = /^#?([0-9a-fA-F]{6})$/.exec(hex.trim());
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return { r: (n >> 16) & 0xff, g: (n >> 8) & 0xff, b: n & 0xff };
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

module.exports = { hexDistance, colorsClose };
