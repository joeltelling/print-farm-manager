# Guia de uso de CoMa (CoreManufacturing)

Esta guia explica como operar CoMa dia a dia: shopfloor (impresoras y trabajos), ERP embebido (inventario, costes, ventas), telemetria real, timelapses y analitica.

Para instalar o actualizar el servidor, usa [installation.md](installation.md). Para el indice tecnico, [README.md](README.md).

---

## 1. Que es CoMa

CoMa une en una sola app y una sola base SQLite:

| Modulo | Para que sirve |
|---|---|
| **Shopfloor** | Flota de impresoras, proyectos, piezas, G-code, despacho automatico, confirmacion de calidad |
| **ERP** | Productos, componentes, materia prima, tarifas de maquina, BOM, ordenes de trabajo, ventas, postings |
| **Cruce** | Tiempo real de impresion, coste real vs estandar, OEE, rentabilidad, timelapse |

Al abrir CoMa por primera vez pide crear una cuenta de operador (usuario y contrasena) y luego muestra una guia de configuracion inicial una unica vez; esa guia solo vuelve a aparecer si se borra la cuenta desde Settings > Account (pide la contrasena actual). Esta autenticacion es basica (una sola cuenta compartida, sin roles). Usa CoMa solo en red local de confianza. No publiques el puerto 3000 a internet.

### Abrir la app

- Desarrollo: UI en `http://localhost:5173` (API en `:3000`)
- Produccion: todo en `http://localhost:3000` (o la IP LAN del servidor)

La barra lateral tiene tres bloques:

1. **ERP** (Resumen, Inventario, Fabricacion, Ventas)
2. **Shopfloor** (Dashboard, Fleet, Printers, Projects, Jobs, Calendar, Timelapses)
3. **Workspace** (Tablero, Bloc)

Settings queda debajo. En movil (< 600 px) los enlaces salen en la barra superior.

---

## 2. Primer arranque (checklist)

1. Arranca con `./start.sh` (o Docker / `npm start` segun [installation.md](installation.md)).
2. Abre **Settings**:
   - **Site name**: nombre que ves en la barra.
   - **Printer Models**: registra cada modelo (connector: prusa, bambu, klipper, etc.).
   - **Groups**: grupos de maquinas (ej. `MK4S Farm`) si usas restricciones por grupo.
   - **Filament Library**: tipos y colores (luego se sincronizan como materia prima ERP).
   - **Camera / Timelapse**: modo de camara e intervalo de frames (opcional).
3. Anade impresoras (una a una o CSV).
4. En **ERP → Dashboard**, pulsa **Sync from shopfloor**. Asi se crean stubs de productos, componentes, maquinas y filamentos.
5. Completa lo que marque **Needs ERP data** (tarifas de maquina > 0, recepciones de raw, etc.).

---

## 3. Shopfloor: flujo diario de impresion

### 3.1 Impresoras

| Pantalla | Uso |
|---|---|
| **Fleet** | Vista viva cada 15 s. Confirmacion Good / Bad en impresoras en hold |
| **Printers** | Directorio, busqueda, filtros |
| **Printer detail** | Camara, timelapse manual, notas, historial de eventos, historial de jobs |
| **Decommissioned** | Maquinas fuera de servicio y recommission |

Estados tipicos: IDLE, PRINTING, FINISHED, PAUSED, ERROR, OFFLINE, STOPPED.

Cuando un trabajo termina, la impresora queda **held** (`is_held = 1`). El operador debe confirmar calidad antes de que se despache el siguiente trabajo. Eso evita fallos en cadena.

### 3.2 Proyectos, piezas y G-code

1. **Projects**: crea un proyecto (prioridad, material/color/grupos opcionales).
2. Anade **parts** (piezas) con cantidad objetivo (`target_qty`).
3. Sube **G-code** por modelo de impresora (`parts_per_plate`, material, AMS slot en Bambu, etc.).
4. Activa el proyecto. El scheduler despacha a impresoras idle compatibles.

Reglas utiles:

- El G-code puede restringir grupo, material y color; si no, manda el proyecto.
- `completed_qty` solo cambia por eventos reales de impresion o acciones de operador (Set Ready, Bad Print, ajuste manual). El ERP **nunca** lo toca.

### 3.3 Confirmacion de calidad (Set Ready)

En Fleet, en una impresora held:

- **Good / Set Ready**: confirma piezas buenas (puedes ajustar cantidad de placa parcial). Credita inventario de piezas si aplica y libera el hold. Encola un **ERP posting** pendiente.
- **Bad Print**: marca el job como fallo y puede restar credito si ya se habia contado.

### 3.4 Jobs

Cola e historial: `queued`, `uploading`, `printing`, `finished`, `failed`, `cancelled`.

Solo puedes cancelar jobs en `queued`. Si ves "Awaiting Sign-off", la impresora esta held aunque el job siga marcado `printing` en la fila.

### 3.5 Calendar

Pagina Shopfloor `/calendar`: rejilla mensual de eventos planificados (llegada de stock, envios, fechas limite, notas) y un cierre de produccion.

- Crea un evento con **New event** o doble clic en un dia.
- Un **production closure** bloquea el despacho de trabajos nuevos mientras dure la ventana (hay que poner fecha de fin). Las impresiones ya en marcha siguen.
- El Dashboard muestra un aviso rojo si hay un cierre activo.
- Las fichas de historial (ventas, recepciones, jobs) son solo lectura; vienen del ERP y del shopfloor.

Detalle tecnico: [docs/calendar.md](calendar.md).

### 3.6 Workspace (tablero y bloc)

Modulo **Workspace** aparte del shopfloor y del ERP:

| Pantalla | Uso |
|---|---|
| **Tablero** (`/workspace`) | Un solo kanban compartido (Pendiente, En curso, A revisar, Hecho por defecto). Columnas y tarjetas editables, arrastre entre columnas, apuntes en cada tarjeta |
| **Bloc** (`/workspace/bloc`) | Bloc de notas tecnico con papel cuadriculado oscuro CoMa, autosave, papelera, export `.txt` e imprimir |

No despacha impresoras ni toca `completed_qty`. Detalle: [docs/workspace.md](workspace.md).

### 3.7 CSV de flota

En Settings, importa CSV con columnas: `name`, `ip`, `type`, `api_key` (si aplica), `serial_number` (Bambu / CC2), `group`, `model`. Detalle en el [README raiz](../README.md#csv-import-format).

---

## 4. ERP: maestros e inventario

Todo vive en la misma SQLite que el shopfloor. Mapeo:

| Shopfloor | ERP |
|---|---|
| Project | Product (`item_role=product`) |
| Part | Component (`item_role=component`) |
| Printer | Machine (`machine.printer_id`) |
| Filament type/color | Raw (`item_role=raw`) |

### 4.1 Dashboard ERP (`/erp`)

- Sync shopfloor
- Contadores (productos, componentes, raw, maquinas, WO abiertas, postings pendientes)
- Lista **Needs ERP data**

### 4.2 Products and Components (`/erp/items`)

Crea o filtra por rol. Marca sourcing: **manufactured** u **outsource**.

### 4.3 Locations (`/erp/locations`)

Almacenes tipicos sembrados: `raw`, `comp`, `fin_good`. Ubicaciones con formato `##A##` (ej. `01A01`).

### 4.4 Inventory (`/erp/inventory`)

- **Receive by SKU**: entra materia prima con coste unitario. Asi se construye el WAC (coste medio ponderado).
- Graficos de valor / cantidad por almacen.

Sin recepciones, el costeo de componentes manufacturados no tiene material realista.

### 4.5 Machines (`/erp/machines`)

Tras el sync, cada impresora tiene una fila machine. Elige modo:

- **manual**: escribes USD/h
- **calculated**: `maintenance_rate + power_kw * ELEC_KWH`

Tambien hay recurso **LABOR** (mano de obra BOM). Hasta que `hourly_rate > 0`, la maquina sigue en Needs ERP data.

### 4.6 Manufacturing components (`/erp/components`)

Receta por pieza: raw + qty + scrap % + minutos estandar + maquina. Sirve para estimar coste y para consumir raw al confirmar un posting.

### 4.7 BOM y Work Orders

- **BOM**: lista de materiales del producto terminado + horas de labor por unidad.
- **WO**: crea desde un producto con BOM, completa (issues de componentes + labor + receive FG). Hay pick list con QR local (`/erp/qr`).

### 4.8 Sales

Hay dos flujos (ambos siempre visibles en la barra; Settings > General elige el aterrizaje por defecto):

**Sales Order (legacy)**
- Config: margenes / ads / fees por defecto
- Pricing: precio de venta = f(coste BOM, margenes)
- Sales order: vende FG y baja stock
- Reports: historial CSV/PDF

**Documentos (Presupuesto / Albaran / Factura)**
- **Clientes** (`/erp/customers`): ficha con NIF/CIF, direccion, contacto
- **Presupuestos** → confirmar → convertir a **Albaran** → convertir a **Factura**
- Numeracion secuencial interna (`PRE-`, `ALB-`, `FAC-`), IVA por linea (defecto 21%), PDF descargable
- Desde Postings, en una fila ya confirmada: **Crear albaran** (copia qty/descripcion; no toca `completed_qty` ni re-ejecuta el movimiento de stock)
- No hay VeriFactu/SII ni garantia legal de correlacion; es papeleo interno/simple

Detalle: [docs/erp/README.md](erp/README.md#sales-documents-presupuesto--albaran--factura).

---

## 5. Postings: de la impresora al inventario ERP

Flujo seguro (no toca `completed_qty`):

1. Set Ready en shopfloor.
2. Aparece fila pendiente en **ERP → Postings**.
3. Confirm: consume raw (si hay receta `mfg_component`) y recibe el componente en `comp`.
4. Si falta stock: 409 con opcion de **acknowledge shortage** (el plastico ya se uso en maquina).
5. Dismiss: abandona sin movimientos.

### Coste estandar vs real

Al confirmar, CoMa muestra:

- **std**: minutos de la receta × tarifa + material con scrap
- **actual**: tiempo / gramos / energia medidos del job, si `telemetry_quality = measured`
- Si la telemetria no es fiable → se usa estandar automaticamente (`cost_basis`)

La telemetria se acumula mientras la impresora esta PRINTING/PAUSED (con tope de hueco entre samples para no inventar horas tras un reinicio del servidor).

---

## 6. Timelapses

| Donde | Que hace |
|---|---|
| Settings → Timelapse | On/off, intervalo (s), FPS del MP4, retencion (dias) |
| Printer detail | Start / Stop captura manual |
| **/timelapses** | Galeria, preview video o ultimo frame, borrar, re-render |

Comportamiento:

- Con timelapse enabled, al entrar en PRINTING con job activo empieza la captura.
- Al salir de PRINTING se para y se intenta render con `ffmpeg` (binario del host Linux). Si no hay ffmpeg, los JPEG siguen disponibles.
- Camara: Klipper via Moonraker, o URL override en la impresora (`camera_snapshot_url` / `camera_stream_url`).

Estado honestidad hardware: probado en el camino del simulador Klipper; no validado aun en flota fisica.

---

## 7. Analytics (`/erp/analytics`)

Ventana 7 / 30 / 90 dias:

- **OEE por maquina**: disponibilidad, rendimiento, calidad, USD/h configurado vs coste absorbido
- **Rentabilidad por proyecto**: piezas, horas, fallos, coste unitario, precio, margen
- **Cost variance**: std vs actual por SKU, sugerencia de `std_minutes` y scrap %

Los datos salen de `printer_status_history`, jobs telemetrizados y postings confirmados.

---

## 8. Backup y restauracion

En **Settings → Backup**:

- Export: un JSON con shopfloor + G-codes + settings + ERP + historial de estados + timelapses (metadatos; los frames en disco estan bajo `server/data/timelapse/`)
- Restore: sustituye el dominio del backup. Backups antiguos solo-shopfloor conservan el ERP actual.

Haz backup antes de actualizar o de experimentos con seed data.

---

## 9. Datos organic vs seed (desarrollo)

| Modo | Uso |
|---|---|
| `./start.sh --organic-data` (default) | Tu flota real: `organic-data.db` |
| `npm run seed:data` luego `./start.sh --seed-data --with-simulator` | Demo + Virtual Klipper en `seed-data.db` |

No mezcles bases. Ambas viven en `server/data/` (gitignored).

Flujo E2E recomendado con seed (detalle tambien en [erp/README.md](erp/README.md)):

1. Sync ERP
2. Receive raw
3. Tarifa maquina + componente MFG
4. Producto + BOM
5. WO complete
6. Sales order
7. Set Ready en Virtual Klipper → confirmar posting
8. Mirar Analytics y Timelapses

---

## 10. Atajos de pantallas

### Shopfloor

| Ruta | Pantalla |
|---|---|
| `/` | Dashboard TV / resumen flota |
| `/fleet` | Fleet vivo + confirmaciones |
| `/printers`, `/printers/:id` | Directorio e incidente |
| `/projects` | Proyectos / parts / G-code |
| `/jobs` | Cola e historial |
| `/timelapses` | Galeria de capturas |
| `/settings` | Modelos, CSV, camara, timelapse, backup |
| `/decommissioned` | Fuera de servicio |

### ERP

| Ruta | Pantalla |
|---|---|
| `/erp` | Dashboard + sync |
| `/erp/postings` | Cola shopfloor → stock |
| `/erp/analytics` | OEE, margen, desviacion de coste |
| `/erp/inventory`, `/erp/items`, `/erp/locations` | Inventario y maestros |
| `/erp/manufacturing`, `/erp/machines`, `/erp/components`, `/erp/bom`, `/erp/wo` | Fabricacion |
| `/erp/sales`, `/erp/sales/*` | Ventas (legacy Sales Order / pricing) |
| `/erp/customers`, `/erp/quotes`, `/erp/delivery-notes`, `/erp/invoices` | Clientes y documentos Presupuesto / Albaran / Factura |

---

## 11. Problemas frecuentes

| Sintoma | Que mirar |
|---|---|
| Impresora no despacha | Hold activo, material/color/grupo, falta G-code del modelo, proyecto no active, `is_active` |
| Posting sin SKU | Part sin `erp_sku` / sync / item component |
| Coste siempre estandar | Job sin muestras suficientes (`telemetry_quality` no `measured`), o sin `power_kw`/tarifas |
| Timelapse failed | `ffmpeg` no en PATH; o camara no disponible (solo Klipper auto, u override URL) |
| Sync deja Needs ERP data | Tarifa maquina 0, o raw sin stock recibido |
| Doble credito de piezas | No inventes recuperaciones por ventana de tiempo; el sistema ya protege reinicios |

Logs de desarrollo: `.run/dev.log`.

---

## 12. Donde profundizar

| Documento | Contenido |
|---|---|
| [installation.md](installation.md) | Instalar, systemd, Docker, simulador |
| [erp/README.md](erp/README.md) | Paridad Acres, postings, sync |
| [web-app.md](web-app.md) | Paginas React y convenciones UI |
| [api.md](api.md) | Contratos REST |
| [database.md](database.md) | Tablas y columnas |
| [filaments.md](filaments.md) | Libreria de filamentos |
| [CHANGELOG.md](CHANGELOG.md) | Historial de cambios |
