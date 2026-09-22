// Tests for server/gcode-thumbnail.js against hand-built, spec-accurate byte
// fixtures (not real slicer output: no network access from this environment
// to fetch a real sample), see the module's own header comment for the specs
// these fixtures follow. Fixture builders are shared with
// gcodes-thumbnail-route.test.js via tests/support/gcode-fixtures.js.

const { extractThumbnail, fromBgcode, fromThreeMf } = require('../gcode-thumbnail');
const { buildBgcode, buildZip } = require('./support/gcode-fixtures');

// ─── .bgcode ─────────────────────────────────────────────────────────────────

describe('fromBgcode', () => {
  test('returns null for a buffer with no GCDE magic', () => {
    expect(fromBgcode(Buffer.from('not a bgcode file'))).toBeNull();
  });

  test('returns null for a file with no thumbnail block', () => {
    const buf = buildBgcode([{ type: 3, data: Buffer.from('printer_model = MK4S\n') }]); // Printer metadata
    expect(fromBgcode(buf)).toBeNull();
  });

  test('extracts an uncompressed PNG thumbnail block', () => {
    const png = Buffer.from('FAKE_PNG_BYTES');
    const buf = buildBgcode([
      { type: 3, data: Buffer.from('printer_model = MK4S\n') },
      { type: 5, format: 0, width: 100, height: 100, data: png },
    ]);
    const result = fromBgcode(buf);
    expect(result).not.toBeNull();
    expect(result.mimeType).toBe('image/png');
    expect(result.data).toEqual(png);
  });

  test('extracts a Deflate-compressed thumbnail block', () => {
    const png = Buffer.from('FAKE_PNG_BYTES_LONGER_TO_ACTUALLY_COMPRESS'.repeat(5));
    const buf = buildBgcode([
      { type: 5, format: 0, width: 200, height: 200, compression: 1, data: png },
    ]);
    const result = fromBgcode(buf);
    expect(result.data).toEqual(png);
  });

  test('prefers the largest thumbnail when more than one is present', () => {
    const small = Buffer.from('SMALL');
    const large = Buffer.from('LARGE_ONE');
    const buf = buildBgcode([
      { type: 5, format: 0, width: 16, height: 16, data: small },
      { type: 5, format: 0, width: 400, height: 400, data: large },
    ]);
    expect(fromBgcode(buf).data).toEqual(large);
  });

  test('skips a Heatshrink-compressed thumbnail (unsupported, not guessed at)', () => {
    const buf = buildBgcode([
      { type: 5, format: 0, width: 100, height: 100, compression: 2, data: Buffer.from('irrelevant') },
    ]);
    expect(fromBgcode(buf)).toBeNull();
  });

  test('a JPG-format thumbnail is also extracted with the right mime type', () => {
    const jpg = Buffer.from('FAKE_JPG_BYTES');
    const buf = buildBgcode([{ type: 5, format: 1, width: 100, height: 100, data: jpg }]);
    const result = fromBgcode(buf);
    expect(result.mimeType).toBe('image/jpeg');
    expect(result.data).toEqual(jpg);
  });

  test('does not throw on a truncated/corrupt file', () => {
    const buf = buildBgcode([{ type: 5, format: 0, width: 100, height: 100, data: Buffer.from('x'.repeat(50)) }]);
    const truncated = buf.subarray(0, buf.length - 20);
    expect(() => fromBgcode(truncated)).not.toThrow();
  });
});

// ─── .3mf ────────────────────────────────────────────────────────────────────

describe('fromThreeMf', () => {
  test('returns null for a buffer with no valid ZIP structure', () => {
    expect(fromThreeMf(Buffer.from('not a zip file'))).toBeNull();
  });

  test('returns null when no known thumbnail path exists in the archive', () => {
    const zip = buildZip([{ name: '3D/3dmodel.model', data: Buffer.from('<xml/>') }]);
    expect(fromThreeMf(zip)).toBeNull();
  });

  test('extracts Metadata/plate_1.png (Bambu/OrcaSlicer default single-plate thumbnail)', () => {
    const png = Buffer.from('FAKE_PLATE_1_PNG');
    const zip = buildZip([
      { name: '3D/3dmodel.model', data: Buffer.from('<xml/>') },
      { name: 'Metadata/plate_1.png', data: png },
    ]);
    const result = fromThreeMf(zip);
    expect(result.mimeType).toBe('image/png');
    expect(result.data).toEqual(png);
  });

  test('extracts a deflate-compressed entry', () => {
    const png = Buffer.from('FAKE_PLATE_1_PNG_LONGER_FOR_COMPRESSION'.repeat(5));
    const zip = buildZip([{ name: 'Metadata/plate_1.png', data: png, method: 8 }]);
    expect(fromThreeMf(zip).data).toEqual(png);
  });

  test('falls back to any Metadata/plate_<N>.png when plate_1 is absent', () => {
    const png = Buffer.from('PLATE_2_PNG');
    const zip = buildZip([{ name: 'Metadata/plate_2.png', data: png }]);
    expect(fromThreeMf(zip).data).toEqual(png);
  });

  test('falls back to Metadata/bbl_thumbnail.png when no plate thumbnail exists', () => {
    const png = Buffer.from('BBL_THUMBNAIL_PNG');
    const zip = buildZip([{ name: 'Metadata/bbl_thumbnail.png', data: png }]);
    expect(fromThreeMf(zip).data).toEqual(png);
  });

  test('prefers plate_1.png over bbl_thumbnail.png when both exist', () => {
    const plate1 = Buffer.from('PLATE_1');
    const zip = buildZip([
      { name: 'Metadata/bbl_thumbnail.png', data: Buffer.from('PRINTER_THUMB') },
      { name: 'Metadata/plate_1.png', data: plate1 },
    ]);
    expect(fromThreeMf(zip).data).toEqual(plate1);
  });
});

// ─── extractThumbnail dispatch ───────────────────────────────────────────────

describe('extractThumbnail', () => {
  test('dispatches .bgcode files to fromBgcode', () => {
    const png = Buffer.from('X');
    const buf = buildBgcode([{ type: 5, format: 0, width: 10, height: 10, data: png }]);
    expect(extractThumbnail('part_MK4S.bgcode', buf).data).toEqual(png);
  });

  test('dispatches .3mf files to fromThreeMf', () => {
    const png = Buffer.from('Y');
    const zip = buildZip([{ name: 'Metadata/plate_1.png', data: png }]);
    expect(extractThumbnail('part.3mf', zip).data).toEqual(png);
  });

  test('is case-insensitive on extension', () => {
    const png = Buffer.from('Z');
    const buf = buildBgcode([{ type: 5, format: 0, width: 10, height: 10, data: png }]);
    expect(extractThumbnail('PART.BGCODE', buf)).not.toBeNull();
  });

  test('plain .gcode has no embedded thumbnail: always null, never attempts a parse', () => {
    expect(extractThumbnail('part.gcode', Buffer.from('G28\nG1 X10\n'))).toBeNull();
  });
});
