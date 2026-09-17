from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.responses import RedirectResponse
from pathlib import Path
import importlib, sys, traceback

from .db import Base, engine
from .config import CORS_ORIGINS

# ---------------------------------------------------------------------------
# Modelos (para que Base.metadata conozca todas las tablas)
# ---------------------------------------------------------------------------
from .models.uom import UOM  # noqa
from .models.item import Item  # noqa
from .models.warehouse import Warehouse  # noqa
from .models.location import Location  # noqa
from .models.bom import BOM, BOMLine  # noqa
from .models.stock import StockMove, ItemCost  # noqa
from .models.mfg_component import MfgComponent  # noqa
from .models.sales import PricingConfig, SalesOrderRecord  # noqa

# Machine: depending on repo it can be MachineRate or Machine
try:
    from .models.machine import MachineRate  # noqa
except Exception:
    try:
        from .models.machine import Machine  # noqa
    except Exception:
        pass

# Modelos de WO (si existen)
try:
    from .models.work_order import WorkOrder, WorkIssue, WorkLabor  # type: ignore # noqa
except Exception:
    pass

# ---------------------------------------------------------------------------
# App + CORS
# ---------------------------------------------------------------------------
app = FastAPI(title="acres-erp", version="0.3.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=CORS_ORIGINS,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ---------------------------------------------------------------------------
# Helper para incluir routers con logs (sin romper el arranque)
# ---------------------------------------------------------------------------
def _include_router(module_name: str, attr: str = "router"):
    """
    Importa backend.app.routers.<module_name> y hace app.include_router(module.router).
    On failure, log traceback to stderr and continue.
    """
    try:
        mod = importlib.import_module(f".routers.{module_name}", package=__package__)
        router = getattr(mod, attr)
        app.include_router(router)
        print(f"[routers] Mounted '/{module_name}'", file=sys.stderr)
        return True
    except Exception as e:
        print(f"[routers][WARN] Could not mount '{module_name}': {e}", file=sys.stderr)
        traceback.print_exc()
        return False

# ---------------------------------------------------------------------------
# Routers (los “core” primero)
# ---------------------------------------------------------------------------
_include_router("health")
_include_router("config_ui")
_include_router("uom")
_include_router("items")
_include_router("warehouses")
_include_router("locations")
_include_router("inventory")

# Manufacturing
_include_router("mfg_components")  # /mfg/components
_include_router("machines")        # /mfg/machines (si existe)
_include_router("mfg")             # /mfg (calculations and utilities)
_include_router("sales")           # /sales (Sales module)

# BOM y WO (importantes para tu flujo)
_include_router("bom")             # /bom
_include_router("wo")              # /wo

# ---------------------------------------------------------------------------
# Crear tablas
# ---------------------------------------------------------------------------
Base.metadata.create_all(bind=engine)

# ---------------------------------------------------------------------------
# Asegurar columnas nuevas en stock_move (SQLite/Postgres)
# ---------------------------------------------------------------------------
def _ensure_stock_extras():
    dialect = engine.url.get_backend_name()
    if not dialect.startswith("postgres"):
        raise RuntimeError("Solo se admite PostgreSQL; revisa DATABASE_URL.")

    with engine.begin() as conn:
        have_cols = set()
        q = (
            "SELECT column_name "
            "FROM information_schema.columns "
            "WHERE table_name='stock_move'"
        )
        for r in conn.exec_driver_sql(q):
            have_cols.add(str(r[0]))

        if "trans_date" not in have_cols:
                conn.exec_driver_sql(
                    "ALTER TABLE stock_move ADD COLUMN trans_date TIMESTAMPTZ"
                )
        if "idem_key" not in have_cols:
                conn.exec_driver_sql(
                    "ALTER TABLE stock_move ADD COLUMN idem_key VARCHAR(64) UNIQUE"
                )

_ensure_stock_extras()

# ---------------------------------------------------------------------------
# Static UI /ui
# ---------------------------------------------------------------------------
ROOT = Path(__file__).resolve().parents[2]
UI_DIR = ROOT / "ui"
if UI_DIR.exists():
    app.mount("/ui", StaticFiles(directory=str(UI_DIR), html=True), name="ui")

@app.get("/")
def root():
    return RedirectResponse(url="/ui/")

# Fallback simple para config UI (por si falla la carga del router dedicado)
@app.get("/config/ui")
def ui_config_fallback():
    from .config import DISPLAY_DECIMALS
    return {"decimals_display": DISPLAY_DECIMALS}
