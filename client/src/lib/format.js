// Pure display formatters shared across pages. Everything here is side-effect free and takes
// the translate function `t` and the formatting locale as arguments instead of reading them
// from React, so it can be unit tested without a DOM (see client/tests/format.test.js).
//
// These were extracted from Dashboard, Jobs, PrinterDetail, Decommissioned, Fleet and Projects
// without changing behavior. The duration helpers are deliberately kept separate: they look
// alike but differ in input unit, rounding (floor vs round) and largest unit shown.

// What the UI shows for a missing timestamp or duration. Written as an escape so this file
// stays free of literal em dashes (see CLAUDE.md), while the rendered character is unchanged.
export const EMPTY_PLACEHOLDER = '\u2014';

// ── Clock and dates ──────────────────────────────────────────────────────────

// Dashboard header clock, 24 hour with seconds.
export function formatClockTime(d, formattingLocale) {
  return d.toLocaleTimeString(formattingLocale, { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
}

// Dashboard header date, e.g. "Sat, Sep 19, 2026".
export function formatLongDate(d, formattingLocale) {
  return d.toLocaleDateString(formattingLocale, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
}

// Jobs table "started" column: month, day and time. Missing timestamp shows the placeholder.
export function formatShortDateTime(ms, formattingLocale) {
  if (!ms) return EMPTY_PLACEHOLDER;
  return new Date(ms).toLocaleString(formattingLocale, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

// Full date and time with year, no fallback. Callers supply their own missing-value text.
export function formatDateTime(ms, formattingLocale) {
  return new Date(ms).toLocaleString(formattingLocale, {
    year: 'numeric', month: 'short', day: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });
}

// Printer detail timestamps: formatDateTime with the placeholder for a missing value.
export function formatTimestamp(ms, formattingLocale) {
  if (!ms) return EMPTY_PLACEHOLDER;
  return formatDateTime(ms, formattingLocale);
}

// ── Durations ────────────────────────────────────────────────────────────────

// Dashboard project elapsed time. Input is seconds. Rolls up to weeks or days for long runs.
// Returns null for 0 or missing so callers can hide the field.
export function formatDurationSecs(secs, t) {
  if (!secs) return null;
  const MINUTE = 60, HOUR = 3600, DAY = 86400, WEEK = 604800;
  if (secs >= WEEK) {
    const w = Math.floor(secs / WEEK);
    const d = Math.floor((secs % WEEK) / DAY);
    return d > 0 ? t('common.durationWeeksDays', { w, d }) : t('common.durationWeeks', { w });
  }
  if (secs >= DAY) {
    const d = Math.floor(secs / DAY);
    const h = Math.floor((secs % DAY) / HOUR);
    return h > 0 ? t('common.durationDaysHours', { d, h }) : t('common.durationDays', { d });
  }
  const h = Math.floor(secs / HOUR);
  const m = Math.floor((secs % HOUR) / MINUTE);
  if (h > 0) return m > 0 ? t('common.durationHoursMinutes', { h, m }) : t('common.durationHours', { h });
  return t('common.durationMinutes', { m });
}

// Jobs table duration. Input is a start and optional end in epoch ms; a job with no end is
// measured up to `now`. Whole minutes are floored. Hours and minutes only.
export function formatJobDuration(startMs, endMs, t, now = Date.now()) {
  if (!startMs) return EMPTY_PLACEHOLDER;
  const ms  = (endMs || now) - startMs;
  const s   = Math.floor(ms / 1000);
  const h   = Math.floor(s / 3600);
  const m   = Math.floor((s % 3600) / 60);
  if (h > 0) return t('common.durationHoursMinutes', { h, m });
  return t('common.durationMinutes', { m });
}

// Printer detail event table duration. Input is milliseconds, rounded to the nearest minute.
export function formatDurationMs(ms, t) {
  if (!ms || ms <= 0) return EMPTY_PLACEHOLDER;
  const totalMin = Math.round(ms / 60000);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  if (h === 0) return t('common.durationMinutes', { m });
  return t('common.durationHoursMinutes', { h, m });
}

// Printer detail lifetime print hours. Input is milliseconds. maximumFractionDigits (no
// minimum) trims trailing zeros while using the locale's own decimal separator.
export function formatHours(ms, t, formattingLocale) {
  if (!ms || ms <= 0) return t('common.durationHours', { h: 0 });
  const h = ms / 3600000;
  const formatted = new Intl.NumberFormat(formattingLocale, {
    maximumFractionDigits: h >= 100 ? 0 : 1,
    useGrouping: false,
  }).format(h);
  return t('common.durationHours', { h: formatted });
}

// Fleet card time remaining. Input is seconds. Null for a missing or negative value.
export function formatTimeRemaining(t, secs) {
  if (secs == null || secs < 0) return null;
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  if (h > 0) return t('fleet.timeRemainingHm', { h, m });
  if (m > 0) return t('fleet.timeRemainingM', { m });
  return t('fleet.timeRemainingLessThanMin');
}

// Fleet card wall-clock finish time ("done 3:45 PM"), with a day marker if it rolls past
// midnight. `now` is injectable for tests; production callers leave it at the default.
export function formatEta(t, secs, formattingLocale, now = Date.now()) {
  if (secs == null || secs < 0) return null;
  const eta = new Date(now + secs * 1000);
  const time = eta.toLocaleTimeString(formattingLocale, { hour: 'numeric', minute: '2-digit' });
  const startOfToday = new Date(now);
  startOfToday.setHours(0, 0, 0, 0);
  const days = Math.floor((eta - startOfToday) / 86400000);
  if (days === 1) return t('fleet.etaTomorrow', { time });
  if (days > 1) return t('fleet.etaDay', { day: eta.toLocaleDateString(formattingLocale, { weekday: 'short' }), time });
  return t('fleet.etaToday', { time });
}

// ── Mass ─────────────────────────────────────────────────────────────────────

// Dashboard material used. Locale aware: uses the locale's decimal separator for kilograms.
export function formatMaterial(grams, t, formattingLocale) {
  if (grams == null) return null;
  if (grams < 1000) return t('common.massGrams', { g: Math.round(grams) });
  // maximumFractionDigits with no minimum trims trailing zeros the same way the
  // previous toFixed(2).replace(/\.?0+$/, '') did, while using the locale's own
  // decimal separator (',' for pl/de, '.' for en) instead of always a dot.
  const kg = new Intl.NumberFormat(formattingLocale, { maximumFractionDigits: 2, useGrouping: false }).format(grams / 1000);
  return t('common.massKilograms', { kg });
}

// ── Values that pre-fill editable inputs ─────────────────────────────────────

// Pre-fills an editable text input, not a translated display string, so this deliberately
// stays locale independent: the text round-trips through the server's own parser.
export function formatDurationForInput(secs) {
  if (!secs) return '';
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  if (h > 0) return m > 0 ? `${h}h ${m}m` : `${h}h`;
  return `${m}m`;
}

// Pre-fills an editable text input (materialDraft), so this deliberately stays dot-decimal
// regardless of locale: the value round-trips to server/routes/gcodes.js's
// normalizeMaterialGrams(), whose regex only accepts a literal dot. Locale-formatting this
// would produce a value the server rejects if the operator saves the field without editing it.
export function formatMaterialForInput(grams) {
  if (grams == null) return '';
  if (grams < 1000) return `${Math.round(grams)}g`;
  const kg = (grams / 1000).toFixed(2).replace(/\.?0+$/, '');
  return `${kg}kg`;
}
