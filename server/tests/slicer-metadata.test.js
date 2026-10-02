// Unit tests for server/slicer-metadata.js and server/zip-reader.js.
//
// These parsers decide how long a block is on the schedule, so the failure mode that
// matters is a silent wrong number: a format we half-recognise must report null ("time
// unknown", which the schedule labels) rather than a plausible-looking guess.
//
// The field names and units asserted here come from slicer source, not from sample files:
// see the header comment in server/slicer-metadata.js for the exact references.

const fs   = require('fs');
const os   = require('os');
const path = require('path');

const zip = require('../zip-reader');
const {
  readSlicerMetadata,
  parseSliceInfoConfig,
  parseGcodeComments,
  parseSlicerDuration,
} = require('../slicer-metadata');
const { buildZip, buildSliceInfoConfig } = require('./helpers/build-zip');

const tempFiles = [];

function writeTemp(name, contents) {
  const p = path.join(os.tmpdir(), `slicermeta_${Date.now()}_${name}`);
  fs.writeFileSync(p, contents);
  tempFiles.push(p);
  return p;
}

afterAll(() => {
  for (const f of tempFiles) { try { fs.unlinkSync(f); } catch (_) {} }
});

// ── ZIP reader ───────────────────────────────────────────────────────────────────

describe('zip-reader', () => {
  test('reads a stored entry', () => {
    const buf = buildZip({ 'a.txt': 'hello', 'b.txt': 'world' });
    expect(zip.readEntry(buf, 'a.txt').toString('utf8')).toBe('hello');
    expect(zip.readEntry(buf, 'b.txt').toString('utf8')).toBe('world');
  });

  test('reads a deflated entry', () => {
    const body = 'compress me '.repeat(200);
    const buf = buildZip({ 'big.txt': body }, { deflate: true });
    expect(zip.readEntry(buf, 'big.txt').toString('utf8')).toBe(body);
  });

  test('lists entry names', () => {
    const buf = buildZip({ 'Metadata/slice_info.config': 'x', '3D/3dmodel.model': 'y' });
    expect(zip.listEntryNames(buf)).toEqual(['Metadata/slice_info.config', '3D/3dmodel.model']);
  });

  test('returns null for a missing entry, not an exception', () => {
    expect(zip.readEntry(buildZip({ 'a.txt': 'x' }), 'nope.txt')).toBeNull();
  });

  test('returns null for a buffer that is not a ZIP', () => {
    expect(zip.listEntryNames(Buffer.from('definitely not a zip'))).toBeNull();
    expect(zip.readEntry(Buffer.from('definitely not a zip'), 'a.txt')).toBeNull();
  });

  test('refuses an entry larger than the cap instead of inflating it', () => {
    // Guards the farm machine's memory: a .3mf's plate G-code can be hundreds of MB.
    const buf = buildZip({ 'big.bin': 'x'.repeat(2048) });
    expect(zip.readEntry(buf, 'big.bin', 1024)).toBeNull();
    expect(zip.readEntry(buf, 'big.bin', 4096).length).toBe(2048);
  });
});

// ── slice_info.config ────────────────────────────────────────────────────────────

describe('parseSliceInfoConfig', () => {
  test('reads prediction as seconds and weight as grams', () => {
    expect(parseSliceInfoConfig(buildSliceInfoConfig({ predictionSecs: 4383, weightGrams: 17.24 })))
      .toEqual({ est_print_secs: 4383, material_grams: 17.24 });
  });

  test('picks the plate the farm prints when several are present', () => {
    // The Bambu driver always prints Metadata/plate_1.gcode, so plate 1 is the one whose
    // numbers apply, regardless of document order.
    const xml = [
      '<config>',
      '  <plate>',
      '    <metadata key="index" value="2"/>',
      '    <metadata key="prediction" value="9999"/>',
      '    <metadata key="weight" value="99.9"/>',
      '  </plate>',
      '  <plate>',
      '    <metadata key="index" value="1"/>',
      '    <metadata key="prediction" value="1234"/>',
      '    <metadata key="weight" value="12.5"/>',
      '  </plate>',
      '</config>',
    ].join('\n');
    expect(parseSliceInfoConfig(xml)).toEqual({ est_print_secs: 1234, material_grams: 12.5 });
  });

  test('accepts a lone plate that carries no index', () => {
    const xml = '<config><plate><metadata key="prediction" value="600"/></plate></config>';
    expect(parseSliceInfoConfig(xml).est_print_secs).toBe(600);
  });

  test('refuses to guess when several plates exist and none is plate 1', () => {
    const xml = [
      '<config>',
      '  <plate><metadata key="index" value="3"/><metadata key="prediction" value="10"/></plate>',
      '  <plate><metadata key="index" value="4"/><metadata key="prediction" value="20"/></plate>',
      '</config>',
    ].join('\n');
    expect(parseSliceInfoConfig(xml)).toEqual({ est_print_secs: null, material_grams: null });
  });

  test('a missing weight is unknown, not zero', () => {
    const xml = buildSliceInfoConfig({ predictionSecs: 300, weightGrams: null });
    expect(parseSliceInfoConfig(xml)).toEqual({ est_print_secs: 300, material_grams: null });
  });

  test('junk values are rejected rather than coerced', () => {
    const xml = '<config><plate><metadata key="index" value="1"/>' +
                '<metadata key="prediction" value="soon"/>' +
                '<metadata key="weight" value="heavy"/></plate></config>';
    expect(parseSliceInfoConfig(xml)).toEqual({ est_print_secs: null, material_grams: null });
  });

  test('empty and malformed input yields nulls', () => {
    expect(parseSliceInfoConfig('')).toEqual({ est_print_secs: null, material_grams: null });
    expect(parseSliceInfoConfig('<config></config>')).toEqual({ est_print_secs: null, material_grams: null });
    expect(parseSliceInfoConfig(null)).toEqual({ est_print_secs: null, material_grams: null });
  });
});

// ── G-code comments ──────────────────────────────────────────────────────────────

describe('parseSlicerDuration', () => {
  test.each([
    ['1h 13m 3s',   4383],
    ['13m 3s',       783],
    ['42s',           42],
    ['2h',          7200],
    ['3d 5h 13m 42s', 3 * 86400 + 5 * 3600 + 13 * 60 + 42],
  ])('parses %s', (input, expected) => {
    expect(parseSlicerDuration(input)).toBe(expected);
  });

  test('returns null for an unrecognised format', () => {
    expect(parseSlicerDuration('quite a while')).toBeNull();
    expect(parseSlicerDuration('')).toBeNull();
    expect(parseSlicerDuration(null)).toBeNull();
  });
});

describe('parseGcodeComments', () => {
  test('reads the PrusaSlicer footer', () => {
    const text = [
      '; filament used [mm] = 1234.5',
      '; filament used [g] = 3.68',
      '; total filament used [g] = 45.67',
      '; estimated printing time (normal mode) = 1h 13m 3s',
      '; estimated printing time (silent mode) = 1h 20m 0s',
    ].join('\n');
    expect(parseGcodeComments(text)).toEqual({ est_print_secs: 4383, material_grams: 45.67 });
  });

  test('reads the Orca and Bambu form', () => {
    const text = [
      '; model printing time: 1h 10m 0s; total estimated time: 1h 13m 3s',
      '; total filament used [g] = 17.24',
    ].join('\n');
    expect(parseGcodeComments(text)).toEqual({ est_print_secs: 4383, material_grams: 17.24 });
  });

  test('prefers the total over the silent-mode estimate', () => {
    const text = [
      '; estimated printing time (silent mode) = 5h 0m 0s',
      '; estimated printing time (normal mode) = 1h 0m 0s',
    ].join('\n');
    expect(parseGcodeComments(text).est_print_secs).toBe(3600);
  });

  test('sums a multi-extruder filament list', () => {
    const text = '; total filament used [g] = 10.5, 4.5';
    expect(parseGcodeComments(text).material_grams).toBeCloseTo(15.0, 5);
  });

  test('falls back to the per-extruder line when no total was written', () => {
    expect(parseGcodeComments('; filament used [g] = 8.25').material_grams).toBeCloseTo(8.25, 5);
  });

  test('a file with no such comments yields nulls', () => {
    expect(parseGcodeComments('G28\nG1 X0 Y0\nM104 S200\n'))
      .toEqual({ est_print_secs: null, material_grams: null });
  });
});

// ── End to end over real files ───────────────────────────────────────────────────

describe('readSlicerMetadata', () => {
  test('reads a deflated .3mf as a slicer actually writes it', () => {
    const buf = buildZip({
      'Metadata/slice_info.config': buildSliceInfoConfig({ predictionSecs: 7380, weightGrams: 52.5 }),
      'Metadata/plate_1.gcode': 'G28\n; total estimated time: 9h 9m\n',
      '3D/3dmodel.model': '<model/>',
    }, { deflate: true });
    const file = writeTemp('sliced.3mf', buf);

    expect(readSlicerMetadata(file, 'sliced.3mf')).toEqual({
      est_print_secs: 7380,
      material_grams: 52.5,
      source: '3mf',
    });
  });

  test('a .3mf with no slice_info reports nothing found', () => {
    const file = writeTemp('bare.3mf', buildZip({ '3D/3dmodel.model': '<model/>' }));
    expect(readSlicerMetadata(file, 'bare.3mf')).toEqual({
      est_print_secs: null, material_grams: null, source: 'none',
    });
  });

  test('reads a plain .gcode footer', () => {
    const file = writeTemp('part.gcode',
      'G28\nG1 X0\n; total filament used [g] = 21.0\n; estimated printing time (normal mode) = 2h 30m 0s\n');
    expect(readSlicerMetadata(file, 'part.gcode')).toEqual({
      est_print_secs: 9000, material_grams: 21.0, source: 'gcode',
    });
  });

  test('finds an estimate written near the top of a large .gcode', () => {
    // Orca and Bambu put the estimate in the header so the printer can display it, and
    // the file can be far larger than one scan window.
    const filler = ('G1 X1 Y1 E0.5\n').repeat(30000);
    const file = writeTemp('big.gcode',
      '; total estimated time: 3h 0m 0s\n' + filler + '; end of file\n');
    expect(readSlicerMetadata(file, 'big.gcode').est_print_secs).toBe(10800);
  });

  test('finds an estimate written at the very end of a large .gcode', () => {
    const filler = ('G1 X1 Y1 E0.5\n').repeat(30000);
    const file = writeTemp('bigtail.gcode',
      filler + '; estimated printing time (normal mode) = 45m 0s\n');
    expect(readSlicerMetadata(file, 'bigtail.gcode').est_print_secs).toBe(2700);
  });

  test('.bgcode is left to the filename parser rather than guessed at', () => {
    const file = writeTemp('part.bgcode', Buffer.from([0x47, 0x43, 0x44, 0x45, 0x01, 0x02]));
    expect(readSlicerMetadata(file, 'part.bgcode')).toEqual({
      est_print_secs: null, material_grams: null, source: 'none',
    });
  });

  test('a missing file reports nothing found instead of throwing', () => {
    expect(readSlicerMetadata(path.join(os.tmpdir(), 'does-not-exist.3mf'), 'x.3mf'))
      .toEqual({ est_print_secs: null, material_grams: null, source: 'none' });
    expect(readSlicerMetadata(path.join(os.tmpdir(), 'does-not-exist.gcode'), 'x.gcode'))
      .toEqual({ est_print_secs: null, material_grams: null, source: 'none' });
  });
});
