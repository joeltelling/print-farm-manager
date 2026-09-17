// /ui/js/us.js
// Global US locale helpers + numeric UI normalization (0/2/3 decimals)

//
// ---- Formatting helpers (compat) -----------------------------------------
//
export function usd(n, dec = 2) { return "$" + Number(n ?? 0).toFixed(dec); }
export function n0(n) { return Number(n ?? 0).toFixed(0); }
export function n2(n) { return Number(n ?? 0).toFixed(2); }
export function n3(n) { return Number(n ?? 0).toFixed(3); }
export function n6(n) { return Number(n ?? 0).toFixed(6); }

export function readNum(el) {
  if (!el) return 0;
  const raw = String((el.value ?? el.textContent ?? "")).trim();
  if (!raw) return 0;
  // force dot decimal (en-US), strip non numeric except dot and minus
  const cleaned = raw.replace(/,/g, ".").replace(/[^\d.\-]/g, "");
  const x = parseFloat(cleaned);
  return Number.isFinite(x) ? x : 0;
}

//
// ---- Locale enforcement ---------------------------------------------------
//
export function enforceUS(root = document) {
  // Ensure HTML lang and number inputs use dot decimal
  try { document.documentElement.setAttribute("lang", "en-US"); } catch {}
  const nums = root.querySelectorAll('input[type="number"]');
  nums.forEach(inp => {
    // Default attributes (will be refined by applyUSNumericUI)
    if (!inp.hasAttribute("inputmode")) inp.setAttribute("inputmode", "decimal");
    // sanitize commas to dots while typing
    inp.addEventListener("input", () => {
      const v = inp.value ?? "";
      const vv = v.replace(/,/g, ".");
      if (vv !== v) inp.value = vv;
    });
  });
}

//
// ---- Numeric UI policy (0 / 2 / 3 decimals) ------------------------------
//
// How it works:
// - You can OPT-IN explicitly with data-num="int|qty|time|money|rate" on inputs.
// - If not present, we infer the kind from id/name (qty, time, rate, money, int).
// - Kind → decimals & step:
//   int  → 0 dec, step=1
//   qty  → 2 dec, step=0.01
//   time → 3 dec, step=0.001
//   money/rate → 2 dec, step=0.01
//
// This runs on every page load (via nav.js) and normalizes values on blur/change.
//

function inferKind(input) {
  const exp = String(input.dataset.num || "").trim().toLowerCase();
  if (exp) return exp; // explicit override

  const key = (input.id || input.name || "").toLowerCase();
  // time-like fields
  if (/std[_-]?min|stdmin|minutes?|mins?|hours?|time/.test(key)) return "time";
  // money/rate
  if (/price|cost|amount|value|wac|unit[_-]?cost|total|rate|hourly/.test(key)) {
    return /rate|hourly/.test(key) ? "rate" : "money";
  }
  // integer hints
  if (/count|pieces?|pcs|units?/.test(key)) return "int";
  // quantities (default if cannot infer)
  if (/qty|quantity/.test(key)) return "qty";
  return "qty";
}

function decimalsFor(kind) {
  switch (kind) {
    case "int": return 0;
    case "time": return 3;
    case "money": return 2;
    case "rate": return 2;
    case "qty": default: return 2;
  }
}
function stepFor(kind) {
  switch (kind) {
    case "int": return "1";
    case "time": return "0.001";
    case "money": return "0.01";
    case "rate": return "0.01";
    case "qty": default: return "0.01";
  }
}

function normalizeInputValue(input, kind) {
  const dec = decimalsFor(kind);
  let x = readNum(input);
  if (kind === "int") {
    x = Math.round(x);
    input.value = n0(x);
  } else if (dec === 2) {
    input.value = n2(x);
  } else if (dec === 3) {
    input.value = n3(x);
  } else {
    input.value = String(x);
  }
}

export function applyUSNumericUI(root = document) {
  const inputs = root.querySelectorAll('input[type="number"], input[data-num]');
  inputs.forEach(inp => {
    const kind = inferKind(inp);
    // set attributes
    inp.setAttribute("inputmode", kind === "int" ? "numeric" : "decimal");
    inp.setAttribute("step", stepFor(kind));
    // initial normalize only if the field already has a value
    if (String(inp.value || "").trim() !== "") {
      normalizeInputValue(inp, kind);
    }
    // normalize on blur/change
    const handler = () => normalizeInputValue(inp, kind);
    inp.addEventListener("blur", handler);
    inp.addEventListener("change", handler);
  });
}
