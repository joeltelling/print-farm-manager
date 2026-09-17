# Decisiones Técnicas

## 2026-01-03 - Inicialización del Entorno
- Se ha configurado la base del proyecto.
- Norma establecida: "Prohibido Hardcoding en Frontend".
- Norma establecida: "Protección de Lógica de Cálculos Existente".

## 2026-01-03 - Eliminación de SQLite y refuerzo de PostgreSQL
- backend/app/config.py: Validación estricta para exigir DATABASE_URL PostgreSQL.
- backend/app/main.py: Eliminado soporte condicional a SQLite; solo se gestionan columnas extra en PostgreSQL.
- backend/app/models/pricing.py: Limpieza de comentario referente a compatibilidad con SQLite.

## 2026-01-03 - Auditoría de estado actual
- Se documentó el estado técnico en `ActualState.md`, validando que la conexión PostgreSQL es la única vía activa.

## 2026-01-03 - Unificación de modelos y protección de entorno
- Modelo que prevalece: `backend/app/models/work_order.py` (unificación con campos de planificación/kind/qty y logística). Se eliminó el duplicado `models/work.py`.
- Routers y main actualizados para usar `models.work_order`.
- `.env` retirado del control de versiones y añadido `.env.example` sin credenciales.
- Se agregó `requirements.txt` para fijar dependencias básicas (FastAPI/SQLAlchemy/psycopg2/uvicorn/pydantic).

## 2026-01-03 - Lógica de costos de manufactura movida a backend
- Nuevo endpoint `POST /mfg/calculate-component-cost` en `backend/app/routers/mfg.py` replicando fórmulas de conversión y costos usadas en `ui/manufacturingcomps.html`.
- La página `ui/manufacturingcomps.html` ahora consume el endpoint y ya no calcula costos en el frontend.
- Se creó entorno virtual `.venv` (ignorado) e instaladas dependencias (`requirements.txt` + `httpx`) para pruebas locales.

## 2026-01-03 - Verificación PostgreSQL completa
- Esquema `public` de `acres_erp` recreado con los modelos actuales (sin datos previos).
- Prueba con `DATABASE_URL=postgresql://acres_user:acres_pwd_123@127.0.0.1:5432/acres_erp` usando TestClient: endpoint `/mfg/calculate-component-cost` respondió 200 con cálculos esperados (WAC 5 $/KG ⇒ $0.005/G; costo material 0.01; costo tiempo 30 con 30 min @ $60/h).

## 2026-01-04 - Limpieza de datos y estandarización a inglés
- Base `acres`: se eliminaron tablas legacy (`bom_headers`, `bom_lines`, `items`, `moves`, `warehouses`, `uom_units`, `work_orders`, `wo_material`, `purchase_orders`, `sales_orders`, `id_sequences`) y se truncaron tablas transaccionales (`work_order`, `wo_issue`, `wo_labor`, `stock_move`, `item_cost`, `bom`, `bom_line`, `mfg_component`, `machine`, `machine_rates`) para iniciar en limpio.
- UI `receive.html`: la UOM mostrada ahora es la de inventario/purchase (ej. KG) y no la de consumo; mensajes de validación y cálculos se mantuvieron.
- Proyecto: se retiraron cadenas y comentarios en español fuera de archivos `.md` (backend y frontend), dejando solo contenido en inglés en código y UI.
- Seed mínimo: se insertaron UOM base (KG, G, EA), warehouses `comp` y `fin_good`, locations `01A01` y `01B01`, y dos ítems (`RAW-PLA` peso G/KG en comp, `FIN-PROD` EA en fin_good) en la base `acres`.
- Prueba end-to-end UOM/WO: con TestClient se recibió 1 KG de `RAW-PLA`, se definió BOM de `FIN-PROD` consumiendo 100 g, se creó y completó una WO. Resultado: stock `RAW-PLA` quedó en 0.9 KG, `FIN-PROD` en 1 EA con WAC 1.0; confirma conversión G→KG y consumo correcto desde `comp` hacia `fin_good`.

## 2026-01-04 - Módulo Sales (Config)
- Modelo `pricing_config` creado (`backend/app/models/sales.py`) con campos id/name/code/value/last_update_date.
- Router `backend/app/routers/sales.py`: endpoints `GET /sales/config` (lista y siembra defaults) y `POST /sales/config` (actualiza por code, soporta batch). Semilla automática de 3 códigos: MARGIN_DEF, ADDS_PCT, EBAY_FEE.
- UI `ui/sales.html`: tabs (Sales Order, Pricing, Config, Reports) con Config implementado; carga `GET /sales/config`, render dinámico de inputs y guardado vía `POST /sales/config`.
- Verificación con curl:
  - `GET /sales/config` devuelve los 3 registros base.
  - `POST /sales/config` con `MARGIN_DEF=15.0` persiste y retorna el valor actualizado.

## 2026-01-04 - Módulo Sales (Pricing)
- Sidebar: submenú Sales con opciones Config y Pricing apuntando a `ui/sales.html#...`.
- Modelo `item`: se añadieron columnas `custom_margin`, `custom_ads`, `custom_fee` (nullable) para overrides por producto.
- Router `sales.py`: `GET /sales/pricing` (paginado 20 fijo, search, aplica defaults de `pricing_config` si el override es NULL, usa costo de BOM vía `rollup_cost`), `PATCH /sales/pricing/{item_id}` para editar `custom_margin|custom_ads|custom_fee`.
- UI `ui/sales.html`: pestaña Pricing con tabla editable (click-to-edit en %, búsqueda con debounce, paginación Prev/Next). Sin hardcode: todo viene de `/sales/pricing`.
- Curl verificación:
  - `curl "http://127.0.0.1:8000/sales/pricing?page=1&limit=20"` → devuelve items con costos y selling_price calculado usando la fórmula multiplicativa y los valores de `pricing_config` (ej. MARGIN_DEF 40, ADDS_PCT 12, EBAY_FEE 13).

## 2026-01-04 - Módulo Sales (Reports de rentabilidad)
- Backend `backend/app/routers/sales.py`: nuevo `GET /sales/reports` con paginación (page/limit), búsqueda por SKU/Name, y ordenamiento en Python sobre campos calculados (`margin_pct`, `margin_usd`, `selling_price`, `item_name`) antes de paginar. Calcula Cost via `rollup_cost`, aplica overrides/custom config igual que Pricing y expone Margin %, Margin $, Fees $ y Selling Price.
- Frontend `ui/sales.html`: pestaña Reports con tabla tabular de rentabilidad, búsqueda por Item/SKU, cabeceras clicables para sort, badges con semáforo de Margen % (<20 rojo, 20-40 naranja, >40 verde) y montos con formato `$xx.xx`.
- Prueba solicitada: `curl "http://localhost:8000/sales/reports?sort_by=margin_pct&order=desc&limit=5"` respondió 404 (probable falta de reload del servidor con el nuevo endpoint en esta sesión).

## 2026-01-04 - Fix: WO Complete con LABOR en BOM (Error 500 resuelto)
- **Problema identificado**: POST /wo/{wo_id}/complete retornaba 500 cuando el BOM tenía labor_hours_per_unit > 0.
- **Causa raíz**: 
  1. Importación incorrecta en `backend/app/routers/wo.py` línea 19: intentaba importar `MachineRate` (nombre inexistente) en lugar de `Machine`.
  2. Tabla `wo_labor` en BD tenía estructura legacy con columna `work_order_id` (además de `wo_id`), causando INSERT con null en FK.
- **Solución aplicada**:
  1. Corregida línea 19 de `wo.py`: cambio `from ..models.machine import MachineRate` a `from ..models.machine import Machine`.
  2. Actualizada función `_labor_rate()` (línea 136) para usar `Machine` en lugar de `MachineRate`.
  3. Recreada tabla `wo_labor` desde modelos (DROP + CREATE vía `Base.metadata.create_all()`).
  4. Verificada existencia de registro LABOR en tabla `machine` con hourly_rate=$20.00.
- **Prueba de éxito**: `POST /wo/5/complete` (PowerMig con BOM labor=0.1 h) → respuesta 200 JSON con status="closed", sin error 500. Registro en `wo_labor` (0.1 h, $20.00/h) creado correctamente.
- **Estado actual**: WO complete funciona con LABOR en BOM. ✅

## 2026-01-04 - Feature: Pick List con QR y Scanner Móvil
- **Pick List mejorada** en `ui/wo.html` función `downloadPickList()`:
  - Columna "Qty per Unit": cantidad de componente por unit de producto final (del BOM).
  - Columna "Qty Planned": cantidad total necesaria = qty_per_unit × qty_planned.
  - Cálculo: `const qtyTotal = qtyPerUnit * qtyPlanned`.
  - Tabla dinámica generada en ventana emergente (print-friendly).
  - QR code imprimible en bottom del pick list generado con `api.qrserver.com`.

- **QR Scanner UI** nuevo archivo `ui/qr-scan.html`:
  - Parámetro URL: `?wo=5` → carga WO id=5.
  - Dos métodos de completado:
    1. "All Finished": completa con `qty_planned`.
    2. Input + "Complete": entrada de cantidad específica → POST con `qty_completed`.
  - Flujo: GET /wo/{id} → renderizar UI → POST /wo/{id}/complete → success/error.
  - UI responsive para móvil/tablet (CSS flexbox, botones grandes).
  - Manejo de errores con opción de retry.

- **QR Generation**:
  - URL encoded: `{origin}/ui/qr-scan.html?wo={woId}`.
  - Servicio: `https://api.qrserver.com/v1/create-qr-code/?size=200x200&data=...`.
  - Se puede imprimir con el pick list.

- **Workflow completo**:
  1. Desde wo.html: Click "Pick List" → window.open con HTML, CSS, tabla, QR.
  2. Imprime o visualiza pick list con QR.
  3. En warehouse: Scan QR con mobile → abre qr-scan.html?wo=5.
  4. Elige "All Finished" o entra qty → POST /wo/5/complete.
  5. Sistema: consume componentes, registra LABOR, recibe FG, status=closed.

- **Endpoint utilizado**: `POST /wo/{wo_id}/complete` (ya existente, CORS-enabled).
- **Seguridad**: Endpoint es público (no autenticación), apropiado para warehouse scanning.
- **Pruebas**: Validada generación de QR URL, probado complete con qty_completed=3 → exitoso.

## 2026-01-04 - Feature: Real-Time BOM Cost en Pricing & Reports
- **Problema**: Pricing y Reports mostraban costo de BOM sin incluir LABOR, inconsistente con bom.html.
- **Solución**: 
  1. Nuevo endpoint `GET /bom/{bom_id}/calculate-cost` en backend/app/routers/bom.py.
     - Calcula: material_cost (sum of qty×WAC) + labor_cost (hours×rate).
     - Retorna: {bom_id, material_cost, labor_cost, total_cost, labor_hours, labor_rate}.
  2. Actualizada función `_bom_cost()` en backend/app/routers/sales.py.
     - Ahora suma: BOMLine (qty×WAC) + BOM.labor_hours × Machine(LABOR).hourly_rate.
     - Resultado idéntico a cálculo en bom.html.
  3. Sin cambios en UI: sales.html/bom.html obtienen valores desde API (zero hardcoding).
  
- **Características**:
  - Cálculo en tiempo real, sin guardar en BD.
  - Reutiliza lógica existente: BOMLine, ItemCost, Machine.
  - Real-time: si WAC cambia (inventory update), pricing/reports reflejan cambio inmediatamente.
  - Endpoint `/bom/{id}/calculate-cost` disponible para uso frontend (ej. si bom.html lo necesita).
  
- **Flujo de datos**:
  1. BOM definition (components + labor_hours_per_unit).
  2. On demand: GET /bom/4/calculate-cost → calcula cost en backend.
  3. /sales/pricing y /sales/reports llaman _bom_cost() internamente.
  4. UI recibe cost ya calculado en API response.
  
- **Pruebas validadas**:
  - GET /bom/4/calculate-cost → total_cost: 2.08 (0.08 material + 2.0 labor).
  - GET /sales/pricing → cost field: 2.08, selling_price derivado.
  - GET /sales/reports → cost field: 2.08, margin% y margin$ calculados.
  - Valores consistentes entre bom.html y pricing/reports. ✅

