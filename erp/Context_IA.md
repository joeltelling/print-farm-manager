# Contexto IA – ERP Acres

Fecha: 2026-01-04 (18:45 UTC)

## Estado actual
- Backend FastAPI + SQLAlchemy sobre PostgreSQL. Código/comentarios en inglés; sólo `.md` en español.
- `DATABASE_URL` en `.env` (no versionado): `postgresql+psycopg2://acres:miniacres@localhost:5432/acres`.
- Routers clave: `/items`, `/uom`, `/warehouses`, `/locations`, `/inventory`, `/mfg/machines`, `/mfg/components`, `/mfg/calculate-component-cost`, `/bom`, `/wo`, `/sales`.
- Cálculos de costos de manufactura centralizados en backend (`backend/app/routers/mfg.py`); `ui/manufacturingcomps.html` consume el endpoint, muestra qty RAW sin redondeo. `receive.html` usa UOM de inventario (purchase) para mostrar qty/costo.
- Módulo Sales: endpoints `/sales/config`, `/sales/pricing`, `/sales/reports` operacionales. UI en `ui/sales.html` con tabs Config/Pricing/Reports.
- WO complete: soporta LABOR en BOM, consume componentes, registra horas y costos sin error 500 (fix 2026-01-04).
- Pick list con QR: generación de pick list mejorada con columnas "Qty per Unit" y "Qty Planned"; QR code imprimible que lleva a `qr-scan.html` para completar WO desde dispositivo móvil.
- **Costo en Pricing/Reports**: calculado en tiempo real desde BOM (material + labor), sin guardar en BD. Endpoint `/bom/{bom_id}/calculate-cost` disponible. Valores idénticos a bom.html.
- Dependencias en `requirements.txt`; entorno `.venv` ignorado.

## Datos en la base `acres` (localhost:5432, usuario acres/miniacres)
- Tras limpieza/seed:
  - `item`: múltiples registros incluyendo `PowerMig` (id=64) con BOM y LABOR (0.1 h/unit).
  - `uom`: KG, G, EA, SQIN, SQFT.
  - `warehouse`: múltiples (comp, fin_good, etc.).
  - `location`: múltiples por warehouse (01A01, 01A02, etc.).
  - `machine`: registro LABOR con hourly_rate=$20.00.
  - Tablas operativas validadas; pruebas end-to-end ejecutadas (ver abajo).

## Flujo de datos
- `/items` → tabla `item` en `acres`.
- `ui/manufacturingcomps.html` → `/mfg/calculate-component-cost` (WAC, conversión UOM, costo tiempo en backend).
- `receive.html` recibe stock en UOM de inventario.
- WO complete con LABOR: BOM con labor_hours_per_unit → busca tasa en `machine` (LABOR) → registra en `wo_labor` con horas y rate → acumula en costo.
- Prueba WO con LABOR: WO id=5, item PowerMig (BOM 0.1 h), complete exitoso → `wo_labor` registra 0.1 h @ $20.00/h.
- Endpoints activos: `/health`, `/items`, `/uom`, `/warehouses`, `/locations`, `/inventory`, `/mfg/machines`, `/mfg/components`, `/mfg/calculate-component-cost`, `/bom`, `/wo`, `/sales/*`.

## Checklist
- Conexión Frontend-Backend operativa; dashboards sales (Config/Pricing/Reports) funcionales.
- Cálculos de manufactura en backend; validada conversión UOM, LABOR en WO.
- WO complete: soporta LABOR en BOM, consume componentes, registra horas y costos.
- Seguridad/entorno: `DATABASE_URL` obligatorio; `.env` no versionado; CORS configurado.
- Deuda técnica: seed real de negocio pendiente; dashboards manufacturing/sales aún placeholders.


