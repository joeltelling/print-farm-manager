import { initApi, apiGet, apiUrl } from "./api.js";
const $ = (id)=>document.getElementById(id);

let RP_STATE = { items: [], page: 1, total: 0, limit: 20, sort_by: "item_name", order: "asc", search: "" };
let SH_STATE = { items: [], total_qty: 0, total_revenue: 0, total_margin: 0, page: 1, limit: 25, total_items: 0 };

const fmtMoney = (n)=> `$${Number(n || 0).toFixed(2)}`;
const fmtPct = (n)=> `${Number(n || 0).toFixed(2)}%`;
const marginBadgeClass = (pct)=>{
  const val = Number(pct || 0);
  if (val < 20) return "badge red";
  if (val <= 40) return "badge orange";
  return "badge green";
};

function setDefaultDates(){
  $("shStart").value = "";
  $("shEnd").value = "";
}

function renderHistory(){
  const tbody = $("shRows");
  tbody.innerHTML = "";
  for (const r of (SH_STATE.items || [])){
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${(r.sale_date||"").split("T")[0]}</td>
      <td>${r.sku}</td>
      <td>${r.item_name || ""}</td>
      <td class="num">${Number(r.qty||0).toFixed(2)}</td>
      <td class="num">${fmtMoney(r.unit_price)}</td>
      <td class="num">${fmtMoney(r.total_price)}</td>
      <td class="num">${fmtMoney(r.unit_margin)}</td>
    `;
    tbody.appendChild(tr);
  }
  $("shTotalQty").textContent = Number(SH_STATE.total_qty || 0).toFixed(2);
  $("shTotalRev").textContent = fmtMoney(SH_STATE.total_revenue);
  $("shTotalMargin").textContent = fmtMoney(SH_STATE.total_margin);

  const totalPages = Math.max(1, Math.ceil((SH_STATE.total_items || 0) / (SH_STATE.limit || 25)));
  $("shPage").textContent = `Page ${SH_STATE.page || 1} / ${totalPages}`;
  $("shPrev").disabled = (SH_STATE.page || 1) <= 1;
  $("shNext").disabled = (SH_STATE.page || 1) >= totalPages;
}

async function loadHistory(){
  const start = $("shStart").value;
  const end = $("shEnd").value;
  $("shMsg").textContent = "loading...";
  try{
    const data = await apiGet("/sales/orders/report", { start_date: start || undefined, end_date: end || undefined, page: SH_STATE.page || 1, limit: SH_STATE.limit || 25 });
    SH_STATE = { ...(data || {}), page: data.page || SH_STATE.page || 1, limit: data.limit || SH_STATE.limit || 25 };
    renderHistory();
    $("shMsg").textContent = `${(SH_STATE.items||[]).length} rows`;
  }catch(e){
    console.error(e);
    $("shMsg").textContent = "error";
  }
}

async function downloadHistory(format){
  const start = $("shStart").value;
  const end = $("shEnd").value;
  const url = apiUrl("/sales/orders/report", { start_date: start || undefined, end_date: end || undefined, format });
  $("shMsg").textContent = `exporting ${format}...`;
  try{
    const r = await fetch(url);
    if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
    const blob = await r.blob();
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = format === "csv" ? "sales_report.csv" : "sales_report.pdf";
    a.click();
    setTimeout(()=> URL.revokeObjectURL(a.href), 1500);
    $("shMsg").textContent = `downloaded ${format}`;
  }catch(e){
    console.error(e);
    $("shMsg").textContent = "export error";
  }
}

function renderReportSortArrows(){
  document.querySelectorAll("[data-arrow]").forEach(span=>{
    const field = span.dataset.arrow;
    if (field === RP_STATE.sort_by){
      span.textContent = RP_STATE.order === "asc" ? "▲" : "▼";
      span.style.opacity = "1";
    }else{
      span.textContent = "↕";
      span.style.opacity = "0.6";
    }
  });
}

function renderReports(){
  const tbody = $("rpRows");
  tbody.innerHTML = "";
  for (const r of RP_STATE.items){
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>
        <div class="stack-vertical">
          <strong>${r.item_name}</strong>
          <span class="muted">${r.sku}</span>
        </div>
      </td>
      <td class="num">${fmtMoney(r.cost)}</td>
      <td class="num"><span class="${marginBadgeClass(r.margin_pct)}">${fmtPct(r.margin_pct)}</span></td>
      <td class="num">${fmtMoney(r.margin_usd)}</td>
      <td class="num">${fmtMoney(r.fees_usd)}</td>
      <td class="num">${fmtMoney(r.selling_price)}</td>
    `;
    tbody.appendChild(tr);
  }
  const totalPages = Math.max(1, Math.ceil(RP_STATE.total / RP_STATE.limit));
  $("rpPage").textContent = `Page ${RP_STATE.page} / ${totalPages}`;
  $("rpPrev").disabled = RP_STATE.page <= 1;
  $("rpNext").disabled = RP_STATE.page >= totalPages;
  renderReportSortArrows();
}

async function loadReports(page=1, opts={}){
  $("rpMsg").textContent = "loading...";
  const sort_by = opts.sort_by ?? RP_STATE.sort_by;
  const order = opts.order ?? RP_STATE.order;
  const search = opts.search ?? RP_STATE.search;
  try{
    const data = await apiGet("/sales/reports", {
      page,
      limit: RP_STATE.limit,
      sort_by,
      order,
      search: search || undefined,
    });
    RP_STATE = { ...RP_STATE, ...data, search: search || "" };
    renderReports();
    $("rpMsg").textContent = "";
  }catch(e){
    console.error(e);
    $("rpMsg").textContent = "error";
  }
}

let rpSearchTimer;
const doReportSearch = ()=>{
  const term = $("rpSearch").value.trim();
  loadReports(1, { search: term });
};
$("rpSearch").addEventListener("input", ()=>{
  clearTimeout(rpSearchTimer);
  rpSearchTimer = setTimeout(doReportSearch, 300);
});
$("rpSearchBtn").addEventListener("click", doReportSearch);
$("rpPrev").addEventListener("click", ()=> loadReports(Math.max(1, RP_STATE.page - 1)));
$("rpNext").addEventListener("click", ()=>{
  const totalPages = Math.max(1, Math.ceil(RP_STATE.total / RP_STATE.limit));
  const next = Math.min(totalPages, RP_STATE.page + 1);
  loadReports(next);
});
$("rpHead").addEventListener("click", (e)=>{
  const th = e.target.closest("th[data-sort]");
  if (!th) return;
  const field = th.dataset.sort;
  let nextOrder = "asc";
  if (RP_STATE.sort_by === field && RP_STATE.order === "asc") nextOrder = "desc";
  loadReports(1, { sort_by: field, order: nextOrder });
});

$("shLoad").addEventListener("click", loadHistory);
$("shCsv").addEventListener("click", ()=> downloadHistory("csv"));
$("shPdf").addEventListener("click", ()=> downloadHistory("pdf"));
$("shPrev").addEventListener("click", ()=>{ SH_STATE.page = Math.max(1, (SH_STATE.page||1)-1); loadHistory(); });
$("shNext").addEventListener("click", ()=>{
  const totalPages = Math.max(1, Math.ceil((SH_STATE.total_items || 0) / (SH_STATE.limit || 25)));
  SH_STATE.page = Math.min(totalPages, (SH_STATE.page||1)+1);
  loadHistory();
});

await initApi();
setDefaultDates();
await loadHistory();
loadReports();
