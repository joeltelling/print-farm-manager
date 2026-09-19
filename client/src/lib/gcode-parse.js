// Pure G-code parser used by the 3D viewer's worker (client/src/gcode-parser.worker.js).
// Kept free of any worker or DOM globals so it can be unit tested in plain Node
// (client/tests/gcode-parse.test.js).
//
// Parses plain-text G-code into a flat Float32Array of extrusion-move vertex pairs (start/end
// per segment), off the main thread so large files don't freeze the UI. Travel (non-extruding)
// moves are discarded - the viewer only renders the printed material itself. G2/G3 arc moves
// are interpolated into several small chord segments rather than one chord spanning the whole
// arc - a single chord is only a good approximation for a small sweep; for a large-radius,
// large-sweep arc (e.g. a funnel's rounded wall, sliced as long single arc commands) one chord
// visibly cuts straight across empty space instead of following the curve.
//
// X/Y/Z positioning mode (G90/G91) and extruder mode (M82/M83) are independent axes in real
// G-code - PrusaSlicer's standard output is `G90` (absolute XYZ) followed by `M83` (relative
// E), so E deltas must be accumulated onto a running total even while X/Y/Z stay absolute.
// Tracking both under one flag misreads every E value as an absolute position instead of a
// small per-move delta, which makes the extrusion-vs-travel check below essentially random.
//
// PrusaSlicer (and Bambu/Orca, which share its lineage) tags each section of G-code with a
// `;TYPE:<feature>` comment. Segments under `Custom` (custom start/end G-code, including the
// nozzle-priming "intro line" drawn away from the actual part) and `Skirt/Brim` (the loop
// printed around the part's footprint before the real print starts) aren't part of the part
// being previewed, so they're excluded from the rendered geometry.
const EXCLUDED_FEATURE_TYPES = new Set(['Custom', 'Skirt/Brim']);

// Target arc length per interpolated sub-segment, in mm - matches Marlin's own default
// MM_PER_ARC_SEGMENT, a reasonable balance between visual smoothness and segment count.
const MM_PER_ARC_SEGMENT = 1;
// Hard ceiling on sub-segments for a single arc command, so a malformed or pathological
// (huge radius, full circle) arc can't blow up the output - 180 is generous (2° resolution
// for a full circle) for anything a real print would produce.
const MAX_ARC_SEGMENTS = 180;

// Returns the XYZ waypoints (including the start point) tracing a G2 (clockwise) / G3
// (counter-clockwise) arc from (x0,y0,z0) to (x1,y1,z1), given the I/J center offset - always
// relative to the start point per the G-code spec, regardless of G90/G91 mode. Falls back to
// just [start, end] (the previous chord-only behavior) if the radius can't be determined (e.g.
// a malformed arc, or an R-form arc this parser doesn't handle).
function arcWaypoints(x0, y0, z0, x1, y1, z1, i, j, clockwise) {
  const radius = Math.hypot(i, j);
  if (!(radius > 0)) return [[x0, y0, z0], [x1, y1, z1]];

  const centerX = x0 + i;
  const centerY = y0 + j;
  const startAngle = Math.atan2(-j, -i);
  const endAngle = Math.atan2(y1 - centerY, x1 - centerX);

  let angularTravel = endAngle - startAngle;
  if (clockwise && angularTravel >= 0) angularTravel -= 2 * Math.PI;
  else if (!clockwise && angularTravel <= 0) angularTravel += 2 * Math.PI;
  // A full circle: start and end coordinates coincide, so the angle-based delta above
  // computes to ~0 instead of a full turn.
  if (x1 === x0 && y1 === y0) angularTravel = clockwise ? -2 * Math.PI : 2 * Math.PI;

  const travelZ = z1 - z0;
  const arcLength = Math.hypot(angularTravel * radius, travelZ);
  const segments = Math.min(MAX_ARC_SEGMENTS, Math.max(1, Math.ceil(arcLength / MM_PER_ARC_SEGMENT)));

  const points = [[x0, y0, z0]];
  for (let s = 1; s <= segments; s++) {
    const t = s / segments;
    const angle = startAngle + angularTravel * t;
    points.push([
      centerX + radius * Math.cos(angle),
      centerY + radius * Math.sin(angle),
      z0 + travelZ * t,
    ]);
  }
  return points;
}

// Parses plain-text G-code and returns a flat Float32Array of extrusion-move vertex pairs:
// six numbers (x0, y0, z0, x1, y1, z1) per segment, with Y and Z swapped so three.js's
// "up" axis is the printer's Z.
export function parseGcode(text) {
  const lines = text.split('\n');

  const extrude = [];

  let x = 0, y = 0, z = 0, e_ = 0;
  let relative = false;
  let eRelative = false;
  let currentType = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const semi = line.indexOf(';');
    const cmd = (semi === -1 ? line : line.slice(0, semi)).trim();
    if (!cmd) {
      const trimmed = line.trimStart();
      if (trimmed.startsWith(';TYPE:')) currentType = trimmed.slice(6).trim();
      continue;
    }

    const first = cmd[0];
    if (first === 'M' || first === 'm') {
      const spaceIdx = cmd.indexOf(' ');
      const code = spaceIdx === -1 ? cmd.slice(1) : cmd.slice(1, spaceIdx);
      if (code === '83') eRelative = true;
      else if (code === '82') eRelative = false;
      continue;
    }
    if (first !== 'G' && first !== 'g') continue;

    const spaceIdx = cmd.indexOf(' ');
    const code = spaceIdx === -1 ? cmd.slice(1) : cmd.slice(1, spaceIdx);

    if (code === '91') { relative = true; continue; }
    if (code === '90') { relative = false; continue; }
    if (code === '92') {
      // Set Position - redefines the current coordinate for whichever axes are given,
      // independent of relative/absolute mode, without moving the toolhead. Slicers commonly
      // emit `G92 E0` every so often (even under M83/relative E) to reset the extruder's
      // position register; skipping this line entirely left the tracked E value stale, so the
      // next real extrusion move could compare against a much larger prior value and be
      // misclassified as a non-extruding travel.
      for (const p of cmd.split(/\s+/).slice(1)) {
        const axis = p[0];
        const value = parseFloat(p.slice(1));
        if (Number.isNaN(value)) continue;
        switch (axis) {
          case 'X': case 'x': x = value; break;
          case 'Y': case 'y': y = value; break;
          case 'Z': case 'z': z = value; break;
          case 'E': case 'e': e_ = value; break;
          default: break;
        }
      }
      continue;
    }
    if (code !== '0' && code !== '1' && code !== '2' && code !== '3') continue;

    const prevX = x, prevY = y, prevZ = z, prevE = e_;

    const parts = cmd.split(/\s+/).slice(1);
    let hasXY = false;
    let arcI = null, arcJ = null;
    for (const p of parts) {
      const axis = p[0];
      const value = parseFloat(p.slice(1));
      if (Number.isNaN(value)) continue;
      switch (axis) {
        case 'X': case 'x': x = relative ? x + value : value; hasXY = true; break;
        case 'Y': case 'y': y = relative ? y + value : value; hasXY = true; break;
        case 'Z': case 'z': z = relative ? z + value : value; break;
        case 'E': case 'e': e_ = eRelative ? e_ + value : value; break;
        case 'I': case 'i': arcI = value; break;
        case 'J': case 'j': arcJ = value; break;
        default: break;
      }
    }

    if (!hasXY && z === prevZ) continue; // no actual movement (e.g. bare E retraction)

    if (e_ > prevE && !EXCLUDED_FEATURE_TYPES.has(currentType)) {
      if ((code === '2' || code === '3') && arcI !== null && arcJ !== null) {
        const waypoints = arcWaypoints(prevX, prevY, prevZ, x, y, z, arcI, arcJ, code === '2');
        for (let w = 1; w < waypoints.length; w++) {
          const [ax0, ay0, az0] = waypoints[w - 1];
          const [ax1, ay1, az1] = waypoints[w];
          extrude.push(ax0, az0, ay0, ax1, az1, ay1); // Y/Z swapped: three.js Y is "up"
        }
      } else {
        extrude.push(prevX, prevZ, prevY, x, z, y); // Y/Z swapped: three.js Y is "up"
      }
    }
  }

  return new Float32Array(extrude);
}
