let API_BASE = "/api/erp";

export function apiUrl(path, params){
  return buildUrl(path, params);
}

export async function initApi(){
  // Same-origin under CoMa: /api/erp proxies to the FastAPI process.
  API_BASE = "/api/erp";
  try{
    const r = await fetch("/ui/config.json", { cache: "no-store" });
    if (r.ok) {
      const cfg = await r.json();
      if (cfg.api_base) API_BASE = String(cfg.api_base).replace(/\/$/, "");
    }
  }catch{}
}

function buildUrl(path, params){
  const p = path.startsWith("/") ? path : `/${path}`;
  const url = new URL(`${API_BASE}${p}`, window.location.origin);
  if (params) for (const [k,v] of Object.entries(params)) if (v!==undefined && v!==null) url.searchParams.set(k, v);
  return url.toString();
}

export async function apiGet(path, params){
  const url = buildUrl(path, params);
  const r = await fetch(url, { cache: "no-store" });
  if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
  return r.json();
}

export async function apiPost(path, body){
  const url = buildUrl(path);
  const r = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    cache: "no-store"
  });
  if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
  return r.json();
}

export async function apiPatch(path, body){
  const url = buildUrl(path);
  const r = await fetch(url, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body ?? {}),
    cache: "no-store"
  });
  if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
  return r.json();
}
