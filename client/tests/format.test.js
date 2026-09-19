import { describe, it, expect } from 'vitest';
import {
  EMPTY_PLACEHOLDER,
  formatClockTime,
  formatLongDate,
  formatShortDateTime,
  formatDateTime,
  formatTimestamp,
  formatDurationSecs,
  formatJobDuration,
  formatDurationMs,
  formatHours,
  formatTimeRemaining,
  formatEta,
  formatMaterial,
  formatDurationForInput,
  formatMaterialForInput,
} from '../src/lib/format.js';

// A stand-in for i18next's t(): returns the key plus its interpolation values, so a test can
// assert exactly which translation key and values a formatter chose without loading en.json.
const t = (key, opts) => (opts ? `${key}|${JSON.stringify(opts)}` : key);

// Intl output can use a narrow no-break space (U+202F) before AM/PM depending on the ICU
// version. Normalize any whitespace so the tests do not depend on the Node build.
const norm = (s) => s.replace(/\s/g, ' ');

// vitest.config.js pins TZ=UTC, so these instants format identically everywhere.
const SEP_19_2026_1504 = Date.UTC(2026, 8, 19, 15, 4, 5);

describe('EMPTY_PLACEHOLDER', () => {
  it('is the em dash the UI has always shown for a missing value', () => {
    expect(EMPTY_PLACEHOLDER).toBe(String.fromCharCode(0x2014));
  });
});

describe('date and time formatters', () => {
  it('formatClockTime is 24 hour with seconds', () => {
    expect(formatClockTime(new Date(SEP_19_2026_1504), 'en-US')).toBe('15:04:05');
  });

  it('formatLongDate includes the weekday and year', () => {
    expect(norm(formatLongDate(new Date(SEP_19_2026_1504), 'en-US'))).toBe('Sat, Sep 19, 2026');
  });

  it('formatShortDateTime formats month, day and time, and shows the placeholder when missing', () => {
    expect(norm(formatShortDateTime(SEP_19_2026_1504, 'en-US'))).toBe('Sep 19, 03:04 PM');
    expect(formatShortDateTime(0, 'en-US')).toBe(EMPTY_PLACEHOLDER);
    expect(formatShortDateTime(null, 'en-US')).toBe(EMPTY_PLACEHOLDER);
  });

  it('formatDateTime includes the year', () => {
    expect(norm(formatDateTime(SEP_19_2026_1504, 'en-US'))).toBe('Sep 19, 2026, 03:04 PM');
  });

  it('formatTimestamp is formatDateTime with a placeholder for a missing value', () => {
    expect(formatTimestamp(SEP_19_2026_1504, 'en-US')).toBe(formatDateTime(SEP_19_2026_1504, 'en-US'));
    expect(formatTimestamp(null, 'en-US')).toBe(EMPTY_PLACEHOLDER);
    expect(formatTimestamp(0, 'en-US')).toBe(EMPTY_PLACEHOLDER);
  });
});

describe('formatDurationSecs (Dashboard project elapsed time)', () => {
  it('returns null for zero or missing so the caller can hide the field', () => {
    expect(formatDurationSecs(0, t)).toBeNull();
    expect(formatDurationSecs(null, t)).toBeNull();
    expect(formatDurationSecs(undefined, t)).toBeNull();
  });

  it('shows minutes under an hour', () => {
    expect(formatDurationSecs(90, t)).toBe('common.durationMinutes|{"m":1}');
  });

  it('shows hours, with minutes only when non-zero', () => {
    expect(formatDurationSecs(3600, t)).toBe('common.durationHours|{"h":1}');
    expect(formatDurationSecs(3660, t)).toBe('common.durationHoursMinutes|{"h":1,"m":1}');
  });

  it('rolls up to days, with hours only when non-zero', () => {
    expect(formatDurationSecs(86400, t)).toBe('common.durationDays|{"d":1}');
    expect(formatDurationSecs(90000, t)).toBe('common.durationDaysHours|{"d":1,"h":1}');
  });

  it('rolls up to weeks, with days only when non-zero', () => {
    expect(formatDurationSecs(604800, t)).toBe('common.durationWeeks|{"w":1}');
    expect(formatDurationSecs(691200, t)).toBe('common.durationWeeksDays|{"w":1,"d":1}');
  });
});

describe('formatJobDuration (Jobs table)', () => {
  it('shows the placeholder when the job has not started', () => {
    expect(formatJobDuration(null, null, t)).toBe(EMPTY_PLACEHOLDER);
    expect(formatJobDuration(0, 1000, t)).toBe(EMPTY_PLACEHOLDER);
  });

  it('measures a finished job from start to end, flooring to whole minutes', () => {
    const start = 1_000_000;
    expect(formatJobDuration(start, start + 90 * 60_000, t)).toBe('common.durationHoursMinutes|{"h":1,"m":30}');
    expect(formatJobDuration(start, start + 119_999, t)).toBe('common.durationMinutes|{"m":1}');
    expect(formatJobDuration(start, start + 5_000, t)).toBe('common.durationMinutes|{"m":0}');
  });

  it('measures a job with no end time up to now', () => {
    const start = 1_000_000;
    expect(formatJobDuration(start, null, t, start + 61 * 60_000)).toBe('common.durationHoursMinutes|{"h":1,"m":1}');
  });
});

describe('formatDurationMs (printer detail event table)', () => {
  it('shows the placeholder for zero, negative or missing input', () => {
    expect(formatDurationMs(0, t)).toBe(EMPTY_PLACEHOLDER);
    expect(formatDurationMs(-5, t)).toBe(EMPTY_PLACEHOLDER);
    expect(formatDurationMs(null, t)).toBe(EMPTY_PLACEHOLDER);
  });

  it('rounds to the nearest minute (unlike formatJobDuration, which floors)', () => {
    expect(formatDurationMs(89_000, t)).toBe('common.durationMinutes|{"m":1}');
    expect(formatDurationMs(90_000, t)).toBe('common.durationMinutes|{"m":2}');
  });

  it('shows hours and minutes at an hour or more', () => {
    expect(formatDurationMs(3_600_000, t)).toBe('common.durationHoursMinutes|{"h":1,"m":0}');
    expect(formatDurationMs(5_400_000, t)).toBe('common.durationHoursMinutes|{"h":1,"m":30}');
  });
});

describe('formatHours (printer detail lifetime print hours)', () => {
  it('shows zero hours for zero, negative or missing input', () => {
    expect(formatHours(0, t, 'en-US')).toBe('common.durationHours|{"h":0}');
    expect(formatHours(null, t, 'en-US')).toBe('common.durationHours|{"h":0}');
  });

  it('keeps one decimal below 100 hours and trims trailing zeros', () => {
    expect(formatHours(5_400_000, t, 'en-US')).toBe('common.durationHours|{"h":"1.5"}');
    expect(formatHours(7_200_000, t, 'en-US')).toBe('common.durationHours|{"h":"2"}');
  });

  it('drops decimals from 100 hours up', () => {
    expect(formatHours(361_440_000, t, 'en-US')).toBe('common.durationHours|{"h":"100"}');
  });

  it('uses the locale decimal separator', () => {
    expect(formatHours(5_400_000, t, 'de')).toBe('common.durationHours|{"h":"1,5"}');
  });
});

describe('formatTimeRemaining (Fleet card)', () => {
  it('returns null for missing or negative input', () => {
    expect(formatTimeRemaining(t, null)).toBeNull();
    expect(formatTimeRemaining(t, undefined)).toBeNull();
    expect(formatTimeRemaining(t, -1)).toBeNull();
  });

  it('distinguishes under a minute, minutes, and hours plus minutes', () => {
    expect(formatTimeRemaining(t, 30)).toBe('fleet.timeRemainingLessThanMin');
    expect(formatTimeRemaining(t, 300)).toBe('fleet.timeRemainingM|{"m":5}');
    expect(formatTimeRemaining(t, 3900)).toBe('fleet.timeRemainingHm|{"h":1,"m":5}');
  });
});

describe('formatEta (Fleet card wall-clock finish time)', () => {
  const now = Date.UTC(2026, 8, 19, 10, 0, 0); // Sat Sep 19 2026, 10:00 UTC

  it('returns null for missing or negative input', () => {
    expect(formatEta(t, null, 'en-US', now)).toBeNull();
    expect(formatEta(t, -1, 'en-US', now)).toBeNull();
  });

  it('shows just the time when it finishes today', () => {
    expect(norm(formatEta(t, 3600, 'en-US', now))).toBe('fleet.etaToday|{"time":"11:00 AM"}');
  });

  it('marks tomorrow once it rolls past midnight', () => {
    expect(norm(formatEta(t, 20 * 3600, 'en-US', now))).toBe('fleet.etaTomorrow|{"time":"6:00 AM"}');
  });

  it('shows the weekday for anything later than tomorrow', () => {
    expect(norm(formatEta(t, 50 * 3600, 'en-US', now))).toBe('fleet.etaDay|{"day":"Mon","time":"12:00 PM"}');
  });
});

describe('formatMaterial (Dashboard material used)', () => {
  it('returns null when there is no value', () => {
    expect(formatMaterial(null, t, 'en-US')).toBeNull();
    expect(formatMaterial(undefined, t, 'en-US')).toBeNull();
  });

  it('shows whole grams under a kilogram', () => {
    expect(formatMaterial(45.6, t, 'en-US')).toBe('common.massGrams|{"g":46}');
    expect(formatMaterial(999.4, t, 'en-US')).toBe('common.massGrams|{"g":999}');
  });

  it('switches to kilograms with up to two decimals and trims zeros', () => {
    expect(formatMaterial(1000, t, 'en-US')).toBe('common.massKilograms|{"kg":"1"}');
    expect(formatMaterial(1250, t, 'en-US')).toBe('common.massKilograms|{"kg":"1.25"}');
    expect(formatMaterial(1234.5, t, 'en-US')).toBe('common.massKilograms|{"kg":"1.23"}');
  });

  it('uses the locale decimal separator', () => {
    expect(formatMaterial(1250, t, 'de')).toBe('common.massKilograms|{"kg":"1,25"}');
  });
});

describe('input pre-fill formatters', () => {
  it('formatDurationForInput returns an empty string for zero or missing', () => {
    expect(formatDurationForInput(0)).toBe('');
    expect(formatDurationForInput(null)).toBe('');
  });

  it('formatDurationForInput uses compact component form', () => {
    expect(formatDurationForInput(60)).toBe('1m');
    expect(formatDurationForInput(3600)).toBe('1h');
    expect(formatDurationForInput(5400)).toBe('1h 30m');
  });

  it('formatMaterialForInput returns an empty string for a missing value', () => {
    expect(formatMaterialForInput(null)).toBe('');
    expect(formatMaterialForInput(undefined)).toBe('');
  });

  it('formatMaterialForInput stays dot-decimal and locale independent', () => {
    expect(formatMaterialForInput(0)).toBe('0g');
    expect(formatMaterialForInput(45.4)).toBe('45g');
    expect(formatMaterialForInput(1000)).toBe('1kg');
    expect(formatMaterialForInput(1200)).toBe('1.2kg');
    expect(formatMaterialForInput(1250)).toBe('1.25kg');
  });
});
