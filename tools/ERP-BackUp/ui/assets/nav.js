import { enforceUS, applyUSNumericUI } from "/ui/js/us.js";

(function(){
  // ===== Global favicon (round logo for all pages) ==========================
  (function ensureFavicons(){
    const head = document.head;
    // Remove previous icons to avoid duplicates
    [...head.querySelectorAll('link[rel~="icon"], link[rel="apple-touch-icon"]')].forEach(n => n.remove());

    // SVG (create /ui/assets/favicon.svg)
    const l1 = document.createElement('link');
    l1.rel = 'icon'; l1.type = 'image/svg+xml';
    l1.href = '/ui/assets/favicon.svg';
    head.appendChild(l1);

    // PNG fallback
    const l2 = document.createElement('link');
    l2.rel = 'icon'; l2.sizes = 'any';
    l2.href = '/ui/png/logoWB.png';
    head.appendChild(l2);

    // iOS
    const l3 = document.createElement('link');
    l3.rel = 'apple-touch-icon';
    l3.href = '/ui/png/logoWB.png';
    head.appendChild(l3);
  })();

  // Avoid mounting twice (SPA)
  if (document.querySelector('.ax-layout')) return;

  // ==== DASHBOARDS ==========================================================
  const INV_HOME   = "/ui/Inventory_dashboard.html";
  const MANU_HOME  = "/ui/manufacturing_dashboard.html";
const SALES_HOME = "/ui/sales.html";   // sales main

  // ==== MENU ================================================================
  const links = [
    { href: "/ui/index.html", text: "Dashboard" },

    { text: "Inventory", href: INV_HOME, submenu: [
        { href: "/ui/items.html",      text: "Items" },
        { href: "/ui/locations.html",  text: "Locations" },
        { href: "/ui/receive.html",    text: "Receive" },
      ]
    },

    { text: "Manufacturing", href: MANU_HOME, submenu: [
        { href: "/ui/manufacturingcomps.html",  text: "Manufacturing Comps" },
        { href: "/ui/machine_rates.html",       text: "Machine Rates" },
        { href: "/ui/bom.html",                 text: "BOM" },
        { href: "/ui/wo.html",                  text: "Work Orders" },
      ]
    },

    // ===== NUEVO: Sales =====================================================
    { text: "Sales", href: SALES_HOME, submenu: [
        { href: "/ui/sales_order.html", text: "Sales Order" },
        { href: "/ui/sales_config.html", text: "Config" },
        { href: "/ui/sales_pricing.html", text: "Pricing" },
        { href: "/ui/sales_reports.html", text: "Reports" }
      ]
    },
  ];

  // ==== HELPERS =============================================================
  const path = (u)=> new URL(u, location.origin).pathname.replace(/\/+$/,'').toLowerCase();
  const same = (a,b)=> path(a) === path(b);

  // ==== LAYOUT ============================================================== 
  const wrap  = document.createElement("div");  wrap.className  = "ax-layout";
  const aside = document.createElement("aside"); aside.className = "ax-aside";

  // Brand with round logo (style via CSS: .ax-logo / .ax-brand-text)
  aside.innerHTML = `
    <div class="ax-brand">
      <span class="ax-logo" aria-hidden="true"></span>
      <span class="ax-brand-text">ACRES-ERP</span>
    </div>
    <nav class="ax-nav"></nav>
  `;
  const nav = aside.querySelector(".ax-nav");

  function setSubState(parentElem, subElem, open){
    subElem.style.display = open ? "block" : "none";
    const caret = parentElem.querySelector(".ax-caret");
    if(caret) caret.textContent = open ? "▾" : "▸";
  }

  // Build nav with submenus
  const groupRecords = []; // [{parent, sub, parentLink}]
  for (const l of links){
    if(l.submenu){
      const parentHref = l.href || l.submenu[0].href;
      const p=document.createElement("div"); p.className="ax-parent";
      p.innerHTML=`<a href="${parentHref}" data-parent>${l.text}</a><span class="ax-caret" style="font-size:12px;color:#9aa3b2;margin-left:6px;cursor:pointer">▸</span>`;
      nav.appendChild(p);

      const sub=document.createElement("div");
      sub.className="ax-sub";
      sub.style.cssText="margin:6px 0 8px 8px;border-left:1px solid #2a2a2a;padding-left:8px;display:none";

      for(const s of l.submenu){
        const a=document.createElement("a");
        a.href=s.href; a.textContent=s.text;
        a.style.display="block"; a.style.padding="6px 10px";
        sub.appendChild(a);
      }
      nav.appendChild(sub);

      const parentLink = p.querySelector('a[data-parent]');
      const caret = p.querySelector(".ax-caret");
      groupRecords.push({ parent:p, sub, parentLink });

      // Caret toggles submenu
      caret.addEventListener("click",(e)=>{
        e.preventDefault(); e.stopPropagation();
        const isOpen = sub.style.display !== "none";
        setSubState(p, sub, !isOpen);
      });

      // Parent link opens dashboard and keeps submenu open
      parentLink.addEventListener("click",(e)=>{
        const url = parentLink.getAttribute("href") || "";
        if(parentLink.origin===location.origin && url.startsWith("/ui/") && url.endsWith(".html")){
          e.preventDefault(); e.stopPropagation();
          setSubState(p, sub, true);
          loadPage(url,true);
        }
      });

    }else{
      const a=document.createElement("a"); a.href=l.href; a.textContent=l.text; nav.appendChild(a);
    }
  }

  const main    = document.createElement("main"); main.className="ax-main";
  const content = document.createElement("div");  content.id="ax-content";
  while(document.body.firstChild){ content.appendChild(document.body.firstChild); }
  main.appendChild(content); wrap.appendChild(aside); wrap.appendChild(main); document.body.appendChild(wrap);

  // Apply en-US to initial DOM as well
  enforceUS(document);
  applyUSNumericUI(document);

  // ==== SPA loader ==========================================================
  function markActive(url){
    // highlight active by pathname
    nav.querySelectorAll("a").forEach(a=>a.classList.toggle("active", same(a.href, url)));

    // open submenus if: there is an active child OR the parent matches active URL
    for(const rec of groupRecords){
      const hasActiveChild = !!rec.sub.querySelector("a.active");
      // Mantener abierto si estamos en el dashboard principal de la sección
      const isParentActive = same(rec.parentLink.href, url);
      // Si estamos en el dashboard de Sales, mantener abierto el submenú
      const isSalesDashboard = rec.parentLink.href.endsWith("/sales.html") && (url.endsWith("/sales.html") || url.endsWith("/sales_dashboard.html"));
      const shouldOpen = hasActiveChild || isParentActive || isSalesDashboard;
      setSubState(rec.parent, rec.sub, shouldOpen);
      if(isParentActive || isSalesDashboard) rec.parentLink.classList.add("active");
    }
  }

  async function loadPage(url,push=true){
    try{
      const r=await fetch(url,{cache:"no-store"});
      if(!r.ok) throw new Error(r.status+" "+r.statusText);
      const html=await r.text();
      const tmp=document.implementation.createHTMLDocument("");
      tmp.documentElement.innerHTML=html;

      document.title = tmp.querySelector("title")?.textContent || "acres-erp";
      content.innerHTML = tmp.body.innerHTML;

      // Re-run inline scripts but DO NOT re-run nav.js itself
      Array.from(content.querySelectorAll("script")).forEach(old=>{
        const src = old.getAttribute("src") || "";
        if (src.endsWith("/ui/assets/nav.js")) { old.remove(); return; } // avoid double-mount
        const s=document.createElement("script");
        for (const a of old.attributes){ s.setAttribute(a.name,a.value); }
        if(!old.src) s.textContent=old.textContent;
        old.replaceWith(s);
      });

      // enforce en-US on the newly injected page
      enforceUS(content);
      applyUSNumericUI(content);

      if(push) history.pushState({url}, "", url);
      markActive(url);
      main.scrollTop=0;
    }catch(e){
      content.innerHTML = `<div class="card"><b>Error</b> loading ${url}: ${String(e)}</div>`;
    }
  }

  // Internal navigation for /ui/*.html
  nav.addEventListener("click",(e)=>{
    const a=e.target.closest("a"); if(!a) return;
    const url=a.getAttribute("href")||"";
    if(a.origin===location.origin && url.startsWith("/ui/") && url.endsWith(".html")){
      e.preventDefault(); loadPage(url,true);
    }
  });

  // Initial active mark + popstate
  markActive(location.pathname);
  window.addEventListener("popstate",(ev)=>{
    const url=(ev.state && ev.state.url) ? ev.state.url : location.pathname;
    if(url.startsWith("/ui/") && url.endsWith(".html")) loadPage(url,false);
  });
})();
