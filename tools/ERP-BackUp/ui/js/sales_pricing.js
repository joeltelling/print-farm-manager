import { initApi, apiGet, apiPost } from "./api.js";
const $ = (id)=>document.getElementById(id);

let PR_STATE = { items: [], page: 1, total: 0, limit: 20, search: "" };
let PR_DIRTY = new Map();
const prFieldMap = { margin_pct: "custom_margin", ads_pct: "custom_ads", fee_pct: "custom_fee" };

function fmt(n, digits=4){ return Number(n||0).toFixed(digits); }
const fmtMoney = (n)=> `$${Number(n || 0).toFixed(2)}`;

function renderPricing(){
  const tbody = $("prRows");
  tbody.innerHTML = "";
  for (const r of PR_STATE.items){
    const dirty = PR_DIRTY.get(r.item_id) || {};
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${r.name}</td>
      <td>${r.sku}</td>
      <td class="num">${fmt(r.cost,4)}</td>
      <td class="num editable" data-field="margin_pct" data-id="${r.item_id}" data-dirty="${dirty.margin_pct!==undefined}">${fmt(dirty.margin_pct ?? r.margin_pct,4)}</td>
      <td class="num">${fmt(r.margin_value,4)}</td>
      <td class="num editable" data-field="ads_pct" data-id="${r.item_id}" data-dirty="${dirty.ads_pct!==undefined}">${fmt(dirty.ads_pct ?? r.ads_pct,4)}</td>
      <td class="num editable" data-field="fee_pct" data-id="${r.item_id}" data-dirty="${dirty.fee_pct!==undefined}">${fmt(dirty.fee_pct ?? r.fee_pct,4)}</td>
      <td class="num">${fmt(r.selling_price,4)}</td>
      <td><button class="btn btn-reset" data-action="reset" data-id="${r.item_id}">Reset</button></td>
    `;
    tr.querySelectorAll('[data-dirty="true"]').forEach(td=> td.style.background = "#5a4a00");
    tbody.appendChild(tr);
  }
  const totalPages = Math.max(1, Math.ceil(PR_STATE.total / PR_STATE.limit));
  $("prPage").textContent = `Page ${PR_STATE.page} / ${totalPages}`;
  $("prPrev").disabled = PR_STATE.page <= 1;
  $("prNext").disabled = PR_STATE.page >= totalPages;
  $("prSave").disabled = PR_DIRTY.size === 0;
  if (PR_DIRTY.size > 0) {
    $("prStatus").textContent = "Unsaved changes";
    $("prStatus").classList.add("warning");
    $("prStatus").classList.remove("success");
  } else {
    $("prStatus").textContent = "";
    $("prStatus").classList.remove("warning","success");
  }
}

async function loadPricing(page=1, search=""){
  $("prMsg").textContent = "loading...";
  try{
    const data = await apiGet("/sales/pricing", { page, limit: 20, search: search || undefined });
    PR_STATE = { ...data, search };
    renderPricing();
    $("prMsg").textContent = "";
  }catch(e){
    console.error(e);
    $("prMsg").textContent = "error";
  }
}

function markDirty(itemId, fieldKey, val){
  const dirty = PR_DIRTY.get(itemId) || {};
  dirty[fieldKey] = val;
  PR_DIRTY.set(itemId, dirty);
  renderPricing();
}

function makeEditable(td, row){
  if (td.dataset.editing === "1") return;
  const fieldKey = td.dataset.field;
  const field = prFieldMap[fieldKey];
  if (!field) return;
  td.dataset.editing = "1";
  const input = document.createElement("input");
  input.type = "number";
  input.step = "any";
  input.value = td.textContent.trim();
  td.textContent = "";
  td.appendChild(input);
  input.focus(); input.select();

  const cancel = ()=>{ td.dataset.editing = ""; td.textContent = fmt(row[fieldKey],4); };
  input.addEventListener("keydown", (e)=>{
    if (e.key === "Escape") { cancel(); }
    if (e.key === "Enter") { e.preventDefault(); input.blur(); }
  });
  input.addEventListener("blur", async ()=>{
    const val = Number(input.value || "0");
    markDirty(row.item_id, fieldKey, val);
    td.dataset.editing = "";
  });
}

$("prRows").addEventListener("click", (e)=>{
  if (e.target.closest("button[data-action='reset']")){
    const id = Number(e.target.dataset.id);
    resetRow(id);
    return;
  }
  const td = e.target.closest("td.editable");
  if (!td) return;
  const id = Number(td.dataset.id);
  const row = PR_STATE.items.find(x => x.item_id === id);
  if (!row) return;
  makeEditable(td, row);
});

async function resetRow(itemId){
  $("prMsg").textContent = "resetting...";
  try{
    const url = new URL(`/sales/pricing/${itemId}/reset`, window.location.origin).toString();
    const r = await fetch(url, { method: "POST", cache: "no-store" });
    if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
    const updated = await r.json();
    const idx = PR_STATE.items.findIndex(x => x.item_id === itemId);
    if (idx >= 0) PR_STATE.items[idx] = updated;
    PR_DIRTY.delete(itemId);
    renderPricing();
    $("prMsg").textContent = "reset";
    setTimeout(()=> $("prMsg").textContent="", 1200);
  }catch(err){
    console.error(err);
    $("prMsg").textContent = "error";
    setTimeout(()=> $("prMsg").textContent="", 1500);
  }
}

let searchTimer;
const doSearch = ()=>{
  const term = $("prSearch").value.trim();
  loadPricing(1, term);
};
$("prSearch").addEventListener("input", ()=>{
  clearTimeout(searchTimer);
  searchTimer = setTimeout(doSearch, 300);
});
$("prSearchBtn").addEventListener("click", doSearch);
$("prPrev").addEventListener("click", ()=> loadPricing(Math.max(1, PR_STATE.page-1), PR_STATE.search));
$("prNext").addEventListener("click", ()=>{
  const totalPages = Math.max(1, Math.ceil(PR_STATE.total / PR_STATE.limit));
  const next = Math.min(totalPages, PR_STATE.page+1);
  loadPricing(next, PR_STATE.search);
});

async function saveAllDirty(){
  if (PR_DIRTY.size === 0) return;
  $("prMsg").textContent = "saving...";
  try{
    for (const [itemId, fields] of PR_DIRTY.entries()){
      for (const [fieldKey, val] of Object.entries(fields)){
        const field = prFieldMap[fieldKey];
        if (!field) continue;
        const body = { field, value: val };
        const url = new URL(`/sales/pricing/${itemId}`, window.location.origin).toString();
        const r = await fetch(url, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
          cache: "no-store",
        });
        if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
        const updated = await r.json();
        const idx = PR_STATE.items.findIndex(x => x.item_id === itemId);
        if (idx >= 0) PR_STATE.items[idx] = updated;
      }
    }
    PR_DIRTY.clear();
    renderPricing();
    $("prMsg").textContent = "saved";
    $("prStatus").textContent = "Saved";
    $("prStatus").classList.remove("warning");
    $("prStatus").classList.add("success");
    setTimeout(()=> { $("prStatus").textContent=""; $("prStatus").classList.remove("success"); $("prMsg").textContent=""; }, 1500);
  }catch(e){
    console.error(e);
    $("prMsg").textContent = "error";
    setTimeout(()=> $("prMsg").textContent="", 1500);
  }
}
$("prSave").addEventListener("click", saveAllDirty);

await initApi();
loadPricing();
