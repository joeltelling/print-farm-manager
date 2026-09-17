// Numeric display helpers matching Acres us.js conventions (embedded CoMa ERP).
// Currency 2 dp, WAC/price/rate 4 dp, stock qty 6 dp, std minutes 3 dp.

export function usd(n) {
  return `$${Number(n || 0).toFixed(2)}`;
}

export function qty6(n) {
  return Number(n || 0).toFixed(6);
}

export function qty0(n) {
  return String(Math.round(Number(n || 0)));
}

export function wac4(n) {
  return Number(n || 0).toFixed(4);
}

export function min3(n) {
  return Number(n || 0).toFixed(3);
}

export function pct1(n) {
  return Number(n || 0).toFixed(1);
}

/** Quantity formatter driven by GET /api/erp/config/ui decimals_display. */
export function fmtQty(n, decimalsDisplay = 2) {
  const d = Math.max(0, Math.min(6, Number(decimalsDisplay) || 2));
  return Number(n || 0).toFixed(d);
}

export function marginBadgeColor(pct) {
  const v = Number(pct) || 0;
  if (v < 20) return '#f87171';
  if (v <= 40) return '#f59e0b';
  return '#a3e635';
}
