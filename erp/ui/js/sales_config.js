import { initApi, apiGet, apiPost } from "./api.js";
const $ = (id)=>document.getElementById(id);
const msg = (t)=> $("cfgMsg").textContent = t || "";

let CONFIGS = [];

function renderConfig(){
  const container = $("configRows");
  container.innerHTML = "";
  for (const cfg of CONFIGS){
    const wrap = document.createElement("div");
    wrap.className = "form-grid-2";

    const label = document.createElement("label");
    label.textContent = cfg.name || cfg.code;

    const input = document.createElement("input");
    input.type = "number";
    input.step = "any";
    input.value = cfg.value ?? 0;
    input.dataset.code = cfg.code;
    input.className = "input";

    wrap.appendChild(label);
    wrap.appendChild(input);
    container.appendChild(wrap);
  }
}

async function loadConfig(){
  msg("loading...");
  try{
    CONFIGS = await apiGet("/sales/config");
    renderConfig();
    msg("");
  }catch(e){
    console.error(e);
    msg("error loading");
  }
}

$("saveConfig").addEventListener("click", async ()=>{
  const payload = [];
  document.querySelectorAll("#configRows input[data-code]").forEach(inp=>{
    payload.push({ code: inp.dataset.code, value: Number(inp.value || 0) });
  });
  msg("saving...");
  try{
    CONFIGS = await apiPost("/sales/config", payload);
    renderConfig();
    msg("saved");
    setTimeout(()=> msg(""), 1500);
  }catch(e){
    console.error(e);
    msg("error");
  }
});

await initApi();
loadConfig();
