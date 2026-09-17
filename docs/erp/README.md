# ERP inside CoMa

Acres ERP functionality runs entirely inside CoMa: Express (`/api/erp`) + React CoMa UI (`/erp/*`) + the same SQLite file as shopfloor. There is no Python/uvicorn process and no Acres HTML skin in the operator app.

Python sources under `erp/` are reference only (formulas / history). Runtime is Node: `server/erp/`.

## Two processes only

| Process | Role |
|---|---|
| Express (`PORT`, default 3000) | Shopfloor APIs + full `/api/erp/*` + production SPA |
| Vite (`VITE_PORT`, default 5173, dev only) | React hot reload; proxies `/api` to Express |

Production: one process (`node server/index.js` serving `client/dist`).

## Modules (API + UI)

| Module | API | React route |
|---|---|---|
| Dashboard (KPIs + sync + needs data + pending postings) | `/api/erp/dashboard`, `POST /sync` | `/erp` |
| Shopfloor postings queue | `/postings`, `/postings/:id/confirm`, `/postings/:id/dismiss` | `/erp/postings` |
| Analytics (profitability, OEE, cost variance) | `/reports/profitability`, `/reports/machine-oee`, `/reports/cost-variance` | `/erp/analytics` |
| Products & components | `/items` (`item_role`, `sourcing`) | `/erp/items` |
| Warehouses + locations | `/warehouses`, `/locations` | `/erp/locations` |
| Inventory receive + stock + charts | `/inventory/*` | `/erp/inventory` |
| Manufacturing dashboard | dashboard + shared machines + open WOs | `/erp/manufacturing` |
| Machine rates (printer-linked) | `/mfg/machines` | `/erp/machines` (manual USD/h or calculated: maintenance + kW × USD/kWh; linked printer fields) |
| Manufacturing components + cost estimate | `/mfg/components`, `/mfg/calculate-component-cost` | `/erp/components` |
| BOM (lines, cost with WAC/MFG fallback, delete) | `/bom/*` | `/erp/bom` |
| Work orders + complete (UOM-aware issues) | `/wo/*` | `/erp/wo`, `/erp/qr` |
| Sales dashboard | reports + stock summary | `/erp/sales` |
| Sales config / pricing / reset | `/sales/config`, `/sales/pricing`, `/sales/pricing/:id/reset` | `/erp/sales/*` |
| Sales orders + history CSV/PDF | `/sales/order/items`, `/sales/orders`, `/sales/orders/report` | `/erp/sales/order`, `/erp/sales/reports` |

Navigation lives in the CoMa sidebar only (Dashboard, Inventory, Manufacturing, Sales modules). ERP pages use `ErpShell` for the page title; there is no second in-page module nav.

## Acres parity audit

Audit source: `erp/backend/app` and every `erp/ui/*.html` file. The Python and HTML trees remain reference-only and are not served.

| Reference capability | Status | CoMa implementation |
|---|---|---|
| Health and UI config | IMPLEMENTED | `/api/erp/health`, `/api/erp/config/ui` (decimals_display drives Mfg Components qty format) |
| Item, UOM, warehouse, and location masters | IMPLEMENTED | Express CRUD/list routes plus `/erp/items` and `/erp/locations` (warehouse + consumption/purchase UOM columns) |
| Inventory receipt, WAC, snapshot, warehouse charts | IMPLEMENTED | `/inventory/*`; value-by-warehouse donut/bars and per-warehouse dual qty/value charts; on-hand total footer |
| Machine rates and component cost estimate | IMPLEMENTED | `/mfg/machines`, `/mfg/components`, `/mfg/calculate-component-cost` (Mat $/unit and Time $/unit columns; scrap applied in CoMa cost estimate) |
| BOM create/update, inline qty, cost footer, estimate* | IMPLEMENTED | `/bom/*`; React supports product+BOM creation, inline qty edit, three-line cost footer, `*` when unit cost falls back to MFG recipe |
| WO create/list/get, shortage check, UOM issue, labor, destination receipt | IMPLEMENTED | `/wo/*`; warehouse + name columns; `q` filtered in SQL before LIMIT |
| Pick list and QR completion | IMPLEMENTED | Local QR for `/erp/qr?wo=ID` |
| Sales config / pricing / reports / orders | IMPLEMENTED | Margin badges, header-click sort, Enter/Escape pricing edits, live sales-order totals |
| Manufacturing and sales dashboards | IMPLEMENTED | Native CoMa dashboards at `/erp/manufacturing` and `/erp/sales` (Acres left these unfinished) |
| Shopfloor to ERP stock bridge | IMPLEMENTED | Operator-confirmed posting queue (see below) |

Deliberate CoMa improvement vs Acres: `POST /mfg/calculate-component-cost` multiplies material by `(1 + scrap_pct/100)`. Acres ignored scrap on that estimate endpoint.

## Shopfloor compatibility

| Shopfloor | ERP |
|---|---|
| Project | Product (`item_role=product`) |
| Part (pieza) | Component (`item_role=component`) |
| Printer | Machine (`machine.printer_id`) |
| Filament type/color | Raw material (`item_role=raw`, sourcing outsource) |

Every product/component has sourcing: **manufactured** or **outsource**. Sync creates stubs; operators complete ERP-only fields (rates, sourcing confirmation, receive costs). Creating a project or part from shopfloor also syncs and accepts optional `sourcing`.

Machine rows created from printers stay in Dashboard `Needs ERP data` until their hourly rate is greater than zero. Filament raw-material reminders survive later syncs until stock is received, then remain resolved. Both historical `filament_colors.hex` and current `hex_color` databases are supported.

## Shopfloor posting queue (operator-confirmed)

Set Ready (and `POST /api/bridge/units-completed`) create a pending row in `erp_posting` keyed by `job_id` (unique, survives restarts). **No path in this queue changes `parts.completed_qty`.**

1. Operator confirms quality on the printer (Set Ready) as today.
2. CoMa enqueues `erp_posting` with qty, linked `erp_sku`, and a snapshot of job telemetry (`actual_minutes`, `actual_grams`, `actual_energy_kwh`, `telemetry_quality`).
3. Operator opens `/erp/postings` and confirms. That consumes raw (via `mfg_component` recipe when present) and receives the component into the `comp` warehouse inside a transaction. When `telemetry_quality` is `measured`, receive `unit_cost` uses actual machine time / material / energy; otherwise the standard recipe cost is used. Preview shows both.
4. If stock is short, the API returns 409 with `acknowledge_required`. The plastic was already used on the printer, so the operator may confirm with `acknowledge_shortage: true` (qty_on_hand may go negative). Dismiss abandons the posting without stock moves.

Double confirm of a posted row returns 409. Stock moves use `idem_key` values derived from the posting id.

Analytics at `/erp/analytics` (and `GET /api/erp/reports/*`) cross telemetried jobs with costing and sales: cost variance vs standards, project profitability including failed-job waste, and machine OEE from `printer_status_history`.

Gap left from the legacy Acres SQL (not in either runtime): purchase orders / vendors. Raw material WAC still enters via Inventory receive.

## Single database

Shopfloor and ERP tables share `server/data/{organic|seed}-data.db`. Schema is additive only.

The Settings JSON backup includes the complete shared domain: shopfloor, uploaded G-code, ERP masters, inventory, costing, BOMs, work orders, pricing, sales, and `erp_posting`. Restore validates that the ERP section is complete before changing data. Legacy shopfloor-only backups preserve the ERP records already in the target database.

## Shared masters

- Machines: `machine` + `printers` via `GET /api/shared/machines`
- Materials: `item` via `GET /api/shared/materials`
- Parts link with nullable `parts.erp_sku`

## Ops

```bash
./start.sh    # Express + Vite only (ERP included)
./stop.sh
```

Development runtime is Node only. `start.sh` uses Linux `setsid` to manage the Express+Vite process group. Python can be installed as a build tool for native npm modules, but no Python process runs CoMa or the ERP.

## Verified E2E flow

Use the seed dataset so organic operator data is untouched:

```bash
./start.sh --seed-data --with-simulator
```

Open `/erp`, then run this workflow:

1. Sync shopfloor from Dashboard.
2. Receive a raw SKU in Inventory (charts update).
3. Define a machine rate and manufacturing component.
4. Create a product+BOM and add the component line.
5. Create and complete a WO. Confirm the inventory warning because completion issues raw/component stock and receives finished stock.
6. Place a sales order. Confirm the warning because the sale depletes finished stock.
7. Open Sales Reports, filter the history, and download CSV/PDF.
8. After Set Ready on the Virtual Klipper (or any held printer), open `/erp/postings` and confirm the pending row.

Automated coverage: `server/tests/erp-embedded.test.js` and `server/tests/erp-postings.test.js`.
