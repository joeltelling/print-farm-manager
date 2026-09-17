from typing import Optional
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import func
from sqlalchemy.orm import Session

from ..db import get_db
from ..models.item import Item
from ..models.uom import UOM
from ..models.warehouse import Warehouse
from ..models.stock import StockMove
from ..models.machine import Machine


router = APIRouter(prefix="/mfg", tags=["Manufacturing"])


# --- helpers -----------------------------------------------------------------

def _looks_like_raw(code: str) -> bool:
    c = (code or "").lower()
    if not c:
        return False
    import re

    return bool(
        re.match(r"^(raw(_?mat)?|rm|raw[-\s]?materials?|materia\s*prima|mp)", c)
    )


def _convert_unit_cost(cost: float, from_factor: Optional[float], to_factor: Optional[float]) -> float:
    """Exact replica of JS: cost_to = cost_from * (f_to / f_from); returns cost if factors are missing."""
    if not from_factor or not to_factor:
        return float(cost or 0)
    try:
        return float(cost or 0) * (float(to_factor) / float(from_factor))
    except Exception:
        return float(cost or 0)


def _avg_wac_for_raw(db: Session, item_id: int) -> float:
    """Weighted average WAC across RAW warehouses, replicating the frontend aggregation."""
    raw_codes = {
        (w.code or "").lower()
        for w in db.query(Warehouse).all()
        if _looks_like_raw(w.code)
    }

    qty_sum = func.sum(StockMove.qty).label("qty")
    cost_sum = func.sum(StockMove.qty * StockMove.unit_cost).label("tcost")

    rows = (
        db.query(StockMove.warehouse_id, qty_sum, cost_sum)
        .filter(StockMove.item_id == item_id)
        .group_by(StockMove.warehouse_id)
        .all()
    )

    total_qty = 0.0
    total_unit_x_qty = 0.0

    for r in rows:
        wh: Warehouse = db.get(Warehouse, r.warehouse_id)
        code = (wh.code or "").lower() if wh else ""

        if raw_codes:
            if code not in raw_codes:
                continue
        else:
            if not _looks_like_raw(code):
                continue

        qty = float(r.qty or 0)
        if qty <= 0:
            continue
        tcost = float(r.tcost or 0)
        wac_row = tcost / qty if qty else 0
        total_qty += qty
        total_unit_x_qty += wac_row * qty

    if total_qty > 0:
        return total_unit_x_qty / total_qty
    return 0.0


# --- schema ------------------------------------------------------------------

class ComponentCostIn(BaseModel):
    raw_sku: str = Field(..., description="Raw material SKU")
    raw_qty_per_unit: float = Field(..., description="Raw quantity per finished unit")
    std_minutes: float = Field(0, description="Standard minutes per unit")
    machine: Optional[str] = Field(None, description="Machine/resource name")


class ComponentCostOut(BaseModel):
    raw_sku: str
    raw_qty_per_unit: float
    std_minutes: float
    machine: Optional[str]
    unit_cost_source: float
    unit_cost_display: float
    material_cost_per_unit: float
    time_cost_per_unit: float


# --- endpoint ----------------------------------------------------------------

@router.post("/calculate-component-cost", response_model=ComponentCostOut)
def calculate_component_cost(payload: ComponentCostIn, db: Session = Depends(get_db)):
    # RAW item
    raw_sku = payload.raw_sku.strip()
    if not raw_sku:
        raise HTTPException(status_code=400, detail="raw_sku is required")
    item: Item = db.query(Item).filter(Item.sku == raw_sku).first()
    if not item:
        raise HTTPException(status_code=404, detail=f"SKU {raw_sku} not found")

    # UOMs
    display_uom = db.get(UOM, item.display_uom_code)
    purchase_uom = db.get(UOM, item.purchase_uom_code)
    display_factor = float(display_uom.factor_to_base) if display_uom else None
    purchase_factor = float(purchase_uom.factor_to_base) if purchase_uom else None

    # WAC base (en purchase/base UOM)
    unit_cost_source = _avg_wac_for_raw(db, item.id)

    # Convertir costo unitario a display UOM
    unit_cost_display = _convert_unit_cost(unit_cost_source, purchase_factor, display_factor)

    material_cost_per_unit = unit_cost_display * float(payload.raw_qty_per_unit or 0)

    # Costo de tiempo
    rate = 0.0
    if payload.machine:
        m = (
            db.query(Machine)
            .filter(func.lower(Machine.machine) == payload.machine.lower())
            .first()
        )
        if m and m.hourly_rate is not None:
            rate = float(m.hourly_rate or 0)
    time_cost_per_unit = (float(payload.std_minutes or 0) / 60.0) * rate

    return ComponentCostOut(
        raw_sku=raw_sku,
        raw_qty_per_unit=float(payload.raw_qty_per_unit or 0),
        std_minutes=float(payload.std_minutes or 0),
        machine=payload.machine,
        unit_cost_source=unit_cost_source,
        unit_cost_display=unit_cost_display,
        material_cost_per_unit=material_cost_per_unit,
        time_cost_per_unit=time_cost_per_unit,
    )

