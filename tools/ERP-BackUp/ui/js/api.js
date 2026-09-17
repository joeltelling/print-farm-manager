let API_BASE = "";

export function apiUrl(path, params){
  return buildUrl(path, params);
}

export async function initApi(){
  // mismo origen por defecto; si existe /ui/config.json lo respeta
  API_BASE = window.location.origin;
  try{
    const r = await fetch("/ui/config.json", { cache: "no-store" });
    if (r.ok) {
      const cfg = await r.json();
      if (cfg.api_base) API_BASE = cfg.api_base;
    }
  }catch{}
}

function buildUrl(path, params){
  const url = new URL(path, API_BASE);
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
