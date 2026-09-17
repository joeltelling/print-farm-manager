# Estado Técnico Actual – ERP Acres

Fecha: 2026-01-04 (18:45 UTC)

## 1. Arquitectura y configuración
- Backend: FastAPI + SQLAlchemy sobre PostgreSQL. Routers en `backend/app/routers/*`, modelos en `backend/app/models/*`, sesión vía `get_db` (`backend/app/db.py`). Routers: `mfg.py` (manufactura/cálculos), `sales.py` (pricing/reports), `wo.py` (work orders con LABOR). Mensajes en inglés; solo `.md` en español.
- Frontend: HTML estático con módulos ES en `ui/`. Consumo REST via `ui/js/api.js`. `ui/manufacturingcomps.html` delega cálculos al backend. `ui/sales.html` con tabs Config/Pricing/Reports. `ui/wo.html` para crear/completar WO con pick list mejorada. `ui/qr-scan.html` para completar WO desde QR scanner (móvil/tablet).
- Dependencias: `requirements.txt` incluye fastapi, uvicorn[standard], sqlalchemy, psycopg2-binary, pydantic, httpx. Entorno `.venv` (ignorado).
- Config: `.env` (no versionado) con `DATABASE_URL=postgresql+psycopg2://acres:miniacres@localhost:5432/acres`, CORS, PORT, HOST.

## 2. Base de datos en uso
- Instancia: PostgreSQL en `localhost:5432`, base `acres`, usuario `acres`/`miniacres`.
- Esquema actual:
  - `item`: múltiples registros (PowerMig id=64 con BOM y LABOR 0.1 h/unit, etc.). Campos: sku, name, dimension, base_uom_code, display_uom_code, purchase_uom_code, standard_cost, item_type, custom_margin, custom_ads, custom_fee.
  - `uom`: KG, G, EA, SQIN, SQFT con conversiones.
  - `warehouse`: comp, fin_good, etc.
  - `location`: 01A01, 01A02, 02A01, 02B01 por warehouse.
  - `bom`: BOM por item con labor_hours_per_unit (ej. PowerMig 0.1 h).
  - `bom_line`: líneas de BOM (qty por componente).
  - `machine`: LABOR con hourly_rate=$20.00.
  - `work_order`: WO con qty, qty_planned, qty_completed, status (draft/open/closed), warehouse_to, location_to.
  - `wo_issue`: registro de consumo de componentes por WO.
  - `wo_labor`: registro de horas y costo laboral (wo_id, hours, hourly_rate).
  - `stock_move`: movimientos de stock con unit_cost y qty.
  - `pricing_config`: MARGIN_DEF, ADDS_PCT, EBAY_FEE.

## 3. Flujo de datos y cálculos
- `/items` → tabla `item` en `acres`.
- `/mfg/calculate-component-cost`: calcula costo de componente (WAC, UOM conversion, time cost).
- `/sales/config`: gestiona MARGIN_DEF, ADDS_PCT, EBAY_FEE.
- `/sales/pricing`: pagina items, aplica custom overrides o defaults, **calcula cost en tiempo real desde BOM** (material + labor), calcula selling_price.
- `/sales/reports`: rentabilidad por item con margin_pct, margin_usd, fees_usd, selling_price, **cost desde BOM en tiempo real**.
- `GET /bom/{bom_id}/calculate-cost`: nuevo endpoint que devuelve material_cost, labor_cost, total_cost en tiempo real (sin guardar).
- `POST /wo/{wo_id}/complete`: consume componentes (via mfg_component.raw_item_id o fallback a componente), calcula labor_hours*rate, registra en wo_labor, recibe FG en fin_good warehouse con costo total.
- Prueba WO/LABOR: WO id=5 (PowerMig), complete → busca LABOR rate en machine table → registra 0.1 h @ $20/h en wo_labor → status=closed. ✅ Sin error 500.

## 4. Checklist rápido
- Conexión Frontend-Backend: ✅ operativa.
- Sales module: ✅ Config, Pricing, Reports funcionales.
- WO complete: ✅ soporta LABOR en BOM, sin error 500.
- Cálculos manufacturero: ✅ backend, validados UOM, LABOR.
- Seguridad: ✅ DATABASE_URL obligatorio; `.env` no versionado; CORS configurado.
- Deuda técnica: seed real pendiente; dashboards manufacturing/sales aún placeholders.

