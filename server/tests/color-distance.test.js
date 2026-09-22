const { hexDistance, colorsClose, normalizeHex } = require('../color-distance');

describe('hexDistance', () => {
  test('identical colors are 0 apart', () => {
    expect(hexDistance('#000000', '#000000')).toBe(0);
  });

  test('black to white is the maximum distance', () => {
    expect(hexDistance('#000000', '#FFFFFF')).toBeCloseTo(Math.sqrt(3 * 255 ** 2), 5);
  });

  test('accepts hex without a leading #', () => {
    expect(hexDistance('ff0000', 'FF0000')).toBe(0);
  });

  test('is case-insensitive', () => {
    expect(hexDistance('#AaBbCc', '#aabbcc')).toBe(0);
  });

  test('computes plain RGB Euclidean distance', () => {
    // #000000 vs #1A1A1A: each channel differs by 26
    expect(hexDistance('#000000', '#1A1A1A')).toBeCloseTo(Math.sqrt(3 * 26 ** 2), 5);
  });

  test('returns null for a missing or malformed hex on either side', () => {
    expect(hexDistance(null, '#000000')).toBeNull();
    expect(hexDistance('#000000', undefined)).toBeNull();
    expect(hexDistance('not-a-color', '#000000')).toBeNull();
  });

  test('supports 3-digit shorthand', () => {
    expect(hexDistance('#fff', '#ffffff')).toBe(0);
    expect(hexDistance('#000', '#fff')).toBeCloseTo(Math.sqrt(3 * 255 ** 2), 5);
  });
});

describe('normalizeHex', () => {
  test('adds a missing leading #', () => {
    expect(normalizeHex('ff0000')).toBe('#ff0000');
    expect(normalizeHex('f00')).toBe('#f00');
  });

  test('lowercases and trims', () => {
    expect(normalizeHex('  #FF0000  ')).toBe('#ff0000');
  });

  test('leaves 3-digit shorthand at 3 digits (both are valid CSS)', () => {
    expect(normalizeHex('#ABC')).toBe('#abc');
  });

  test('returns null for anything that is not a hex color', () => {
    expect(normalizeHex('red')).toBeNull();
    expect(normalizeHex('')).toBeNull();
    expect(normalizeHex('   ')).toBeNull();
    expect(normalizeHex('#12345')).toBeNull();
    expect(normalizeHex(null)).toBeNull();
    expect(normalizeHex(undefined)).toBeNull();
  });
});

describe('colorsClose', () => {
  test('true when within tolerance', () => {
    expect(colorsClose('#000000', '#1A1A1A', 50)).toBe(true);
  });

  test('false when tolerance is exceeded', () => {
    expect(colorsClose('#000000', '#FFFFFF', 50)).toBe(false);
  });

  test('false at exactly the boundary plus one', () => {
    const dist = hexDistance('#000000', '#1A1A1A');
    expect(colorsClose('#000000', '#1A1A1A', dist)).toBe(true);
    expect(colorsClose('#000000', '#1A1A1A', dist - 0.01)).toBe(false);
  });

  test('false when tolerance is 0 or negative, even for identical colors', () => {
    expect(colorsClose('#000000', '#000000', 0)).toBe(false);
    expect(colorsClose('#000000', '#000000', -5)).toBe(false);
  });

  test('false when either hex is missing, regardless of tolerance', () => {
    expect(colorsClose(null, '#000000', 999)).toBe(false);
    expect(colorsClose('#000000', null, 999)).toBe(false);
  });
});
