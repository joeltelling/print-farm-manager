// /ui/js/intl.js
// Global helpers to enforce en-US formatting (dot decimals) and USD.

const USD_FMT = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
  useGrouping: false, // <-- no commas anywhere
});

export const fmtUSD = (n, d = 2) =>
  new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: d,
    maximumFractionDigits: d,
    useGrouping: false,
  }).format(Number(n || 0));

export const fmtQty = (n, d = 3) =>
  Number(n || 0).toLocaleString("en-US", {
    minimumFractionDigits: d,
    maximumFractionDigits: d,
    useGrouping: false, // <-- no commas anywhere
  });

export const toFixedUS = (n, d = 6) => Number(n || 0).toFixed(d);

// Robust number parsing from any input/primitive, forcing dot decimals.
export function numFrom(val, fallback = 0) {
  if (typeof val === "number" && Number.isFinite(val)) return val;
  if (val == null) return fallback;
  const s = String(val).trim().replace(/,/g, ""); // remove commas entirely
  const x = parseFloat(s);
  return Number.isFinite(x) ? x : fallback;
}

// Read <input type="number"> safely (handles comma keyboards too)
export function readNumberInput(input, fallback = 0) {
  if (!input) return fallback;
  if (typeof input.valueAsNumber === "number" && !Number.isNaN(input.valueAsNumber)) {
    return input.valueAsNumber;
  }
  return numFrom(input.value, fallback);
}

// Hard-enforce en-US in the document and sanitize number inputs.
export function enforceEnUS() {
  try {
    document.documentElement.lang = "en";
  } catch {}
  // hint the keyboard and deny commas while typing
  document.querySelectorAll('input[type="number"]').forEach((inp) => {
    inp.setAttribute("inputmode", "decimal");
    if (!inp.hasAttribute("step")) inp.setAttribute("step", "0.001");
    // live sanitize: remove commas, keep digits, dot, minus
    inp.addEventListener("input", () => {
      if (!inp.value) return;
      // strip thousands commas, normalize decimal dot
      const clean = inp.value.replace(/,/g, "");
      if (clean !== inp.value) inp.value = clean;
    });
  });
}

// Quick formatters you can import everywhere
export const fmt = { usd: fmtUSD, qty: fmtQty, fixed: toFixedUS, usd2: (n) => USD_FMT.format(n || 0) };
