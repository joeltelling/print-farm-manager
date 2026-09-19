import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import { formatDurationForInput, formatMaterialForInput } from '../src/lib/format.js';

// The estimate inputs in Projects.jsx are pre-filled by these formatters, and the text is sent
// back to the server if the operator saves without editing it. If the server's parser cannot
// read what the client wrote, saving silently fails or clears the value. These tests run the
// client output through the real server parsers, so the two sides cannot drift apart.
const require = createRequire(import.meta.url);
const { normalizePrintTime, normalizeMaterialGrams } = require('../../server/routes/gcodes.js');

describe('formatDurationForInput round trip through normalizePrintTime', () => {
  it.each([60, 300, 3600, 5400, 7300, 86400, 90060])('%i seconds survives the round trip', (secs) => {
    // formatDurationForInput drops seconds, so compare at minute resolution.
    expect(normalizePrintTime(formatDurationForInput(secs))).toBe(Math.floor(secs / 60) * 60);
  });
});

describe('formatMaterialForInput round trip through normalizeMaterialGrams', () => {
  it.each([1, 45, 45.6, 999, 1000, 1200, 1250, 1500, 2000, 50000])('%d grams survives the round trip', (grams) => {
    const parsed = normalizeMaterialGrams(formatMaterialForInput(grams));
    // Under 1000 g the input is rounded to whole grams; from 1000 g it is kilograms to two
    // decimals, so allow up to 5 g of rounding.
    const tolerance = grams < 1000 ? 0.5 : 5;
    expect(Math.abs(parsed - grams)).toBeLessThanOrEqual(tolerance);
  });

  it('never produces text the server parser rejects', () => {
    for (const grams of [0, 1, 45.4, 999, 1000, 1234.5, 99999]) {
      expect(normalizeMaterialGrams(formatMaterialForInput(grams))).not.toBeNull();
    }
  });
});
