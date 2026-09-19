import { describe, it, expect } from 'vitest';
import { parseGcode } from '../src/lib/gcode-parse.js';

// parseGcode returns a Float32Array of segments, six numbers each: x0, z0, y0, x1, z1, y1.
// (Y and Z are swapped on purpose: three.js's "up" axis is the printer's Z.) Float32 cannot
// hold values like 0.2 exactly, so compare with toBeCloseTo.
function segments(text) {
  const a = Array.from(parseGcode(text));
  const out = [];
  for (let i = 0; i < a.length; i += 6) out.push(a.slice(i, i + 6));
  return out;
}

function expectSegment(actual, expected) {
  expect(actual).toHaveLength(6);
  expected.forEach((v, i) => expect(actual[i]).toBeCloseTo(v, 4));
}

describe('parseGcode: basic moves', () => {
  it('returns nothing for empty or comment-only input', () => {
    expect(parseGcode('')).toHaveLength(0);
    expect(parseGcode('; just a comment\n; another')).toHaveLength(0);
  });

  it('emits one segment for an extruding move, with Y and Z swapped', () => {
    const segs = segments('G90\nM83\nG1 X0 Y0 Z0.2\nG1 X10 Y5 E1');
    expect(segs).toHaveLength(1);
    // from (0, 0, 0.2) to (10, 5, 0.2) in printer axes -> (x, z, y) in viewer axes
    expectSegment(segs[0], [0, 0.2, 0, 10, 0.2, 5]);
  });

  it('discards travel moves (no extrusion)', () => {
    expect(segments('G90\nM83\nG1 X10 Y10\nG0 X20 Y20')).toHaveLength(0);
  });

  it('discards a bare retraction (extruder moves, nothing else does)', () => {
    expect(segments('G90\nM83\nG1 X5 E1\nG1 E-2\nG1 E2')).toHaveLength(1);
  });

  it('treats a retracting move as travel', () => {
    expect(segments('G90\nM82\nG1 X5 E10\nG1 X20 E5')).toHaveLength(1);
  });

  it('strips inline comments and ignores case and unrelated commands', () => {
    const segs = segments('m83\ng1 x4 e1 ; inline comment\nT0\nM104 S200\nG28');
    expect(segs).toHaveLength(1);
    expectSegment(segs[0], [0, 0, 0, 4, 0, 0]);
  });

  it('keeps a Z-only extruding move (vase mode style)', () => {
    const segs = segments('M83\nG1 Z1 E1');
    expect(segs).toHaveLength(1);
    expectSegment(segs[0], [0, 0, 0, 0, 1, 0]);
  });
});

describe('parseGcode: positioning and extruder modes are independent', () => {
  it('G91 makes X/Y/Z relative', () => {
    const segs = segments('G91\nM83\nG1 X5 E1\nG1 X5 E1');
    expect(segs).toHaveLength(2);
    expectSegment(segs[0], [0, 0, 0, 5, 0, 0]);
    expectSegment(segs[1], [5, 0, 0, 10, 0, 0]);
  });

  it('G90 with M83 (PrusaSlicer style) accumulates relative E while XYZ stay absolute', () => {
    const segs = segments('G90\nM83\nG1 X10 E0.5\nG1 X20 E0.5');
    expect(segs).toHaveLength(2);
    expectSegment(segs[1], [10, 0, 0, 20, 0, 0]);
  });

  it('M82 reads E as an absolute position, so only increases extrude', () => {
    const segs = segments('G90\nM82\nG1 X10 E1\nG1 X20 E1\nG1 X30 E2');
    // second move does not raise E (1 -> 1): travel. Third raises it: extrusion.
    expect(segs).toHaveLength(2);
  });

  it('G92 E0 resets the extruder position so the next move is not mistaken for travel', () => {
    const withReset = segments('G90\nM82\nG1 X10 E5\nG92 E0\nG1 X20 E1');
    expect(withReset).toHaveLength(2);
    const withoutReset = segments('G90\nM82\nG1 X10 E5\nG1 X20 E1');
    expect(withoutReset).toHaveLength(1);
  });

  it('G92 can also redefine the position of X, Y and Z without moving', () => {
    const segs = segments('G90\nM83\nG92 X100 Y50\nG1 X110 E1');
    expect(segs).toHaveLength(1);
    expectSegment(segs[0], [100, 0, 50, 110, 0, 50]);
  });
});

describe('parseGcode: feature types', () => {
  it('drops Custom and Skirt/Brim sections but keeps real features', () => {
    const text = [
      'G90', 'M83',
      ';TYPE:Custom', 'G1 X10 E1',
      ';TYPE:Skirt/Brim', 'G1 X20 E1',
      ';TYPE:Perimeter', 'G1 X30 E1',
      ';TYPE:Solid infill', 'G1 X40 E1',
    ].join('\n');
    const segs = segments(text);
    expect(segs).toHaveLength(2);
    expectSegment(segs[0], [20, 0, 0, 30, 0, 0]);
    expectSegment(segs[1], [30, 0, 0, 40, 0, 0]);
  });

  it('still tracks position through an excluded section', () => {
    const segs = segments('G90\nM83\n;TYPE:Custom\nG1 X100 E1\n;TYPE:Perimeter\nG1 X110 E1');
    expect(segs).toHaveLength(1);
    expectSegment(segs[0], [100, 0, 0, 110, 0, 0]);
  });
});

describe('parseGcode: arcs (G2 clockwise, G3 counter-clockwise)', () => {
  // A quarter circle of radius 10 centered on the origin, from (10, 0) to (0, 10), going
  // counter-clockwise. I and J are the center offset from the start point: (-10, 0).
  const quarter = 'G90\nM83\nG1 X10 Y0\nG3 X0 Y10 I-10 J0 E1';

  it('splits an arc into short chords instead of one straight line', () => {
    const segs = segments(quarter);
    // arc length = pi/2 * 10 ~ 15.7 mm at 1 mm per chord -> 16 segments
    expect(segs).toHaveLength(16);
  });

  it('starts and ends exactly where the command says, and stays on the circle', () => {
    const segs = segments(quarter);
    expect(segs[0].slice(0, 3)).toEqual([expect.closeTo(10, 3), expect.closeTo(0, 3), expect.closeTo(0, 3)]);
    const last = segs[segs.length - 1];
    expect(last[3]).toBeCloseTo(0, 3); // x
    expect(last[5]).toBeCloseTo(10, 3); // y (index 5 after the swap)
    for (const s of segs) {
      expect(Math.hypot(s[0], s[2])).toBeCloseTo(10, 3);
      expect(Math.hypot(s[3], s[5])).toBeCloseTo(10, 3);
    }
  });

  it('a clockwise G2 between the same points sweeps the long way round', () => {
    const cw = segments('G90\nM83\nG1 X10 Y0\nG2 X0 Y10 I-10 J0 E1');
    // three quarters of the circle: arc length ~ 47.1 mm -> 48 segments
    expect(cw).toHaveLength(48);
  });

  it('falls back to a single chord when I/J are missing', () => {
    const segs = segments('G90\nM83\nG1 X10 Y0\nG3 X0 Y10 E1');
    expect(segs).toHaveLength(1);
    expectSegment(segs[0], [10, 0, 0, 0, 0, 10]);
  });

  it('caps a huge or full-circle arc at 180 segments', () => {
    // Start and end coincide (a full circle) with radius 100: ~628 mm would be 629 chords.
    const segs = segments('G90\nM83\nG1 X100 Y0\nG3 X100 Y0 I-100 J0 E1');
    expect(segs).toHaveLength(180);
  });
});
