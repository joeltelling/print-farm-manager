from typing import List, Optional
from datetime import datetime
from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session
from sqlalchemy import select, func

from ..db import get_db
from ..models.item import Item
from ..models.warehouse import Warehouse
from ..models.bom import BOM, BOMLine
from ..models.stock import StockMove, ItemCost
from ..models.mfg_component import MfgComponent
from ..models.uom import UOM

# machine rates (archivo: models/machine.py en tu proyecto)
try:
    from ..models.machine import Machine  # machine:str, hourly_rate:Numeric
except Exception:
    Machine = None  # type: ignore

# modelos de trabajo (requeridos)
try:
    from ..models.work_order import WorkOrder, WorkIssue, WorkLabor  # type: ignore
except Exception as e:
    raise RuntimeError("Missing models.work_order.* (WorkOrder/WorkIssue/WorkLabor).") from e

router = APIRouter(prefix="/wo", tags=["Work Orders"])


# ---------- Pydantic ----------
class WOCreate(BaseModel):
    # Ahora soporta id o sku (uno de los dos obligatorio)
    item_id: Optional[int] = None
    item_sku: Optional[str] = None
    qty_planned: int = Field(..., ge=1)
    warehouse_code: str
    location_code: Optional[str] = None


class WOOut(BaseModel):
    id: int
    kind: str
    item_id: int
    qty: float
    qty_planned: Optional[float] = None
    qty_completed: Optional[float] = None
    warehouse_code: Optional[str] = None
    location_code: Optional[str] = None
    status: str
    created_at: Optional[datetime] = None
    completed_at: Optional[datetime] = None

class WOCompleteIn(BaseModel):
    qty_completed: Optional[int] = Field(None, ge=0)


# ---------- helpers ----------
def _wh_id_by_code(db: Session, code: str) -> int:
    w = db.execute(
        select(Warehouse).where(func.lower(Warehouse.code) == code.lower())
    ).scalar_one_or_none()
    if not w:
        raise HTTPException(status_code=400, detail=f"Warehouse '{code}' not found")
    return int(w.id)


def _loc_id_by_code(db: Session, code: str) -> int:
    from ..models.location import Location

    loc = db.execute(
        select(Location).where(
            func.upper(Location.code) == func.upper(code),
        )
    ).scalar_one_or_none()
    if not loc:
        raise HTTPException(
            status_code=400,
            detail=f"Location code '{code}' not found",
        )
    return int(loc.id)

def _stock_available(db: Session, item_id: int, warehouse_id: int) -> float:
    res = db.execute(
        select(func.coalesce(func.sum(StockMove.qty), 0)).where(
            StockMove.item_id == item_id,
            StockMove.warehouse_id == warehouse_id,
        )
    ).scalar_one()
    return float(res or 0)


def _wac_for_item(db: Session, item_id: int) -> float:
    # last recorded WAC (fallback to 0)
    row = db.execute(
        select(ItemCost)
        .where(ItemCost.item_id == item_id)
    ).scalars().first()
    try:
        return float(row.wac) if row and getattr(row, "wac", None) is not None else 0.0  # type: ignore
    except Exception:
        # compat: some projects store avg_cost/last_cost
        for attr in ("avg_cost", "unit_cost", "cost"):
            if row is not None and getattr(row, attr, None) is not None:
                return float(getattr(row, attr))
        return 0.0


def _qty_convert(db: Session, qty: float, from_uom: Optional[str], to_uom: Optional[str]) -> float:
    """Convert quantities using factor_to_base; if data is missing, return qty unchanged."""
    if not from_uom or not to_uom or from_uom == to_uom:
        return qty
    from_rec = db.get(UOM, from_uom)
    to_rec = db.get(UOM, to_uom)
    if not from_rec or not to_rec:
        return qty
    try:
        f_from = float(from_rec.factor_to_base or 0)
        f_to = float(to_rec.factor_to_base or 0)
        if f_from <= 0 or f_to <= 0:
            return qty
        # qty_to = qty_from * (f_from / f_to)  (same physical magnitude)
        return float(qty) * (f_from / f_to)
    except Exception:
        return qty


def _bom_for_item(db: Session, item_id: int) -> BOM:
    bom = db.execute(select(BOM).where(BOM.item_id == item_id)).scalar_one_or_none()
    if not bom:
        raise HTTPException(status_code=404, detail=f"No BOM for finished item_id={item_id}")
    return bom


def _labor_rate(db: Session) -> float:
    if not Machine:
        return 0.0
    rec = db.execute(
        select(Machine).where(Machine.machine == "LABOR")
    ).scalar_one_or_none()
    return float(rec.hourly_rate or 0) if rec else 0.0


def _get_item_by_id_or_sku(db: Session, item_id: Optional[int], item_sku: Optional[str]) -> Item:
    it = None
    if item_id:
        it = db.get(Item, int(item_id))
    if not it and item_sku:
        it = db.execute(select(Item).where(Item.sku == item_sku)).scalar_one_or_none()
    if not it:
        raise HTTPException(
            status_code=404,
            detail=f"Finished good not found (id={item_id}, sku={item_sku})",
        )
    return it


# ---------- endpoints ----------
@router.post("", response_model=WOOut)
def create_wo(payload: WOCreate, db: Session = Depends(get_db)):
    if not (payload.item_id or payload.item_sku):
        raise HTTPException(status_code=422, detail="item_id or item_sku is required")

    if not (payload.qty_planned and payload.qty_planned > 0):
        raise HTTPException(status_code=422, detail="qty_planned must be > 0")

    it = _get_item_by_id_or_sku(db, payload.item_id, payload.item_sku)
    wh_id = _wh_id_by_code(db, payload.warehouse_code)
    loc_id = None
    if payload.location_code:
        loc_id = _loc_id_by_code(db, payload.location_code)

    # Verifica que exista una BOM para ese FG (detallando el SKU en el error)
    try:
        _ = _bom_for_item(db, it.id)
    except HTTPException as e:
        if e.status_code == 404:
            raise HTTPException(
                status_code=404,
                detail=f"No BOM for finished item (sku={it.sku}, id={it.id})",
            )
        raise

    wo = WorkOrder(
        kind=payload.warehouse_code,  # se usa el code de warehouse como tipo
        item_id=int(it.id),
        qty=0,
        qty_planned=float(payload.qty_planned or 0),
        status="open",
        warehouse_to=wh_id,
        location_to=loc_id,
        created_at=datetime.utcnow(),
    )
    db.add(wo)
    db.commit()
    db.refresh(wo)
    return WOOut(
        id=wo.id,
        kind=wo.kind,
        item_id=wo.item_id,
        qty=float(wo.qty or 0),
        qty_planned=float(wo.qty_planned or 0),
        status=wo.status,
        created_at=getattr(wo, "created_at", None),
        completed_at=getattr(wo, "completed_at", None),
    )


@router.get("", response_model=List[WOOut])
def list_wos(
    q: Optional[str] = Query(None, description="Filter by FG SKU/Name"),
    limit: int = Query(500, ge=1, le=1000),
    offset: int = Query(0, ge=0),
    db: Session = Depends(get_db),
):
    stmt = select(WorkOrder).order_by(WorkOrder.id.desc()).limit(limit).offset(offset)
    rows = db.execute(stmt).scalars().all()

    # filtro textual por SKU/Name del FG
    if q:
        like = f"%{q}%".lower()
        rows = [
            r
            for r in rows
            if ((it := db.get(Item, r.item_id)) and (like in (it.sku or "").lower() or like in (it.name or "").lower()))
        ]

    out: List[WOOut] = []
    for r in rows:
        out.append(
            WOOut(
                id=r.id,
                kind=r.kind,
                item_id=r.item_id,
                qty=float(r.qty or 0),
                qty_planned=float(r.qty_planned or 0) if hasattr(r, "qty_planned") else None,
                status=r.status,
                created_at=getattr(r, "created_at", None),
                completed_at=getattr(r, "completed_at", None),
            )
        )
    return out


@router.get("/{wo_id}", response_model=WOOut)
def get_wo(wo_id: int, db: Session = Depends(get_db)):
    wo = db.get(WorkOrder, wo_id)
    if not wo:
        raise HTTPException(status_code=404, detail="WO not found")
    return WOOut(
        id=wo.id,
        kind=wo.kind,
        item_id=wo.item_id,
        qty=float(wo.qty or 0),
        qty_planned=float(wo.qty_planned or 0),
        qty_completed=float(wo.qty_completed or 0) if hasattr(wo, "qty_completed") else None,
        status=wo.status,
        created_at=getattr(wo, "created_at", None),
        completed_at=getattr(wo, "completed_at", None),
    )


@router.post("/{wo_id}/complete", response_model=WOOut)
def complete_wo(wo_id: int, payload: WOCompleteIn = None, db: Session = Depends(get_db)):
    wo = db.get(WorkOrder, wo_id)
    if not wo:
        raise HTTPException(status_code=404, detail="WO not found")
    if wo.status in ("completed", "closed"):
        return WOOut(
            id=wo.id,
            kind=wo.kind,
            item_id=wo.item_id,
            qty=float(wo.qty or 0),
            qty_planned=float(wo.qty_planned or 0),
            qty_completed=float(wo.qty_completed or 0) if hasattr(wo, "qty_completed") else None,
            status=wo.status,
            created_at=getattr(wo, "created_at", None),
            completed_at=getattr(wo, "completed_at", None),
        )

    qty_completed_val = None
    if payload and payload.qty_completed is not None:
        qty_completed_val = float(payload.qty_completed)
    qty_plan = float(qty_completed_val or wo.qty_planned or 0)
    if qty_plan <= 0:
        raise HTTPException(status_code=422, detail="WO qty_planned must be > 0")

    # warehouses
    comp_wh_id = _wh_id_by_code(db, "comp")
    fin_wh_id = _wh_id_by_code(db, "fin_good")

    # BOM
    bom = _bom_for_item(db, wo.item_id)
    lines = db.execute(
        select(BOMLine).where(BOMLine.bom_id == bom.id).order_by(BOMLine.id)
    ).scalars().all()

    # Stock validation before issuing (uses RAW if the component declares it)
    issue_plan = []  # entries: {"item_id":..., "warehouse_id":..., "qty":..., "component_sku":...}
    missing = []
    for ln in lines:
        comp_item = db.get(Item, ln.component_item_id)
        if not comp_item:
            raise HTTPException(
                status_code=404, detail=f"Component item_id {ln.component_item_id} not found"
            )
        components_needed = float(ln.qty or 0) * qty_plan
        if components_needed <= 0:
            continue

        # Does the component have a RAW mapping in mfg_component?
        mfg_comp = db.execute(
            select(MfgComponent).where(MfgComponent.sku == comp_item.sku)
        ).scalar_one_or_none()

        if mfg_comp:
            raw_item = db.get(Item, mfg_comp.raw_item_id)
            if not raw_item:
                raise HTTPException(
                    status_code=404,
                    detail=f"Raw item id {mfg_comp.raw_item_id} for component {comp_item.sku} not found",
                )
            raw_wh_id = int(getattr(raw_item, "warehouse_id", None) or comp_wh_id)
            req_raw_display = components_needed * float(mfg_comp.raw_qty_per_unit or 0)
            scrap_pct = float(mfg_comp.scrap_pct or 0)
            if scrap_pct:
                req_raw_display *= (1 + scrap_pct / 100.0)
            # Convert to inventory UOM (purchase_uom as stock base)
            req_raw_stock = _qty_convert(
                db,
                req_raw_display,
                getattr(raw_item, "display_uom_code", None),
                getattr(raw_item, "purchase_uom_code", None),
            )
            avail = _stock_available(db, raw_item.id, raw_wh_id)
            if avail + 1e-9 < req_raw_stock:
                missing.append({
                    "item_id": raw_item.id,
                    "sku": raw_item.sku,
                    "name": raw_item.name,
                    "required": req_raw_stock,
                    "available": avail,
                    "component_sku": comp_item.sku,
                })
            issue_plan.append({
                "item_id": raw_item.id,
                "warehouse_id": raw_wh_id,
                "qty": req_raw_stock,
                "component_sku": comp_item.sku,
            })
        else:
            # Fallback: consume the component itself
            req_comp_display = components_needed
            req_comp_stock = _qty_convert(
                db,
                req_comp_display,
                getattr(comp_item, "display_uom_code", None),
                getattr(comp_item, "purchase_uom_code", None),
            )
            avail = _stock_available(db, comp_item.id, comp_wh_id)
            if avail + 1e-9 < req_comp_stock:
                missing.append({
                    "item_id": comp_item.id,
                    "sku": comp_item.sku,
                    "name": comp_item.name,
                    "required": req_comp_stock,
                    "available": avail,
                    "component_sku": comp_item.sku,
                })
            issue_plan.append({
                "item_id": comp_item.id,
                "warehouse_id": comp_wh_id,
                "qty": req_comp_stock,
                "component_sku": comp_item.sku,
            })

    if missing:
        raise HTTPException(
            status_code=409,
            detail={"missing": missing, "message": "Insufficient material stock"},
        )

    # Issue components/RAW according to the calculated plan
    total_mat_value = 0.0
    for plan in issue_plan:
        unit_wac = _wac_for_item(db, plan["item_id"])  # $ en UOM de stock (purchase/base)
        value = unit_wac * plan["qty"]
        total_mat_value += value

        db.add(
            StockMove(
                item_id=plan["item_id"],
                warehouse_id=plan["warehouse_id"],
                qty=-plan["qty"],
                unit_cost=unit_wac,
                trans_date=datetime.utcnow(),
            )
        )
        try:
            db.add(
                WorkIssue(
                    wo_id=wo.id, item_id=plan["item_id"], qty=plan["qty"], unit_cost=unit_wac
                )  # type: ignore
            )
        except Exception:
            pass

    # Labor (opcional) = horas BOM * qty * rate(LABOR)
    rate = _labor_rate(db)
    labor_hours = float(bom.labor_hours_per_unit or 0) * qty_plan
    labor_value = rate * labor_hours
    try:
        if labor_hours > 0:
            db.add(WorkLabor(wo_id=wo.id, hours=labor_hours, hourly_rate=rate))  # type: ignore
    except Exception:
        pass

    # Recibo de FG en FIN_GOOD
    total_value = total_mat_value + labor_value
    unit_fg_cost = total_value / qty_plan

    db.add(
        StockMove(
            item_id=int(wo.item_id),
            warehouse_id=fin_wh_id,
            qty=qty_plan,
            unit_cost=unit_fg_cost,
            trans_date=datetime.utcnow(),
        )
    )

    wo.qty = qty_plan
    wo.qty_completed = qty_plan
    wo.status = "closed"
    wo.completed_at = datetime.utcnow()
    db.commit()
    db.refresh(wo)

    return WOOut(
        id=wo.id,
        kind=wo.kind,
        item_id=wo.item_id,
        qty=float(wo.qty or 0),
        qty_planned=float(wo.qty_planned or 0),
        status=wo.status,
        created_at=getattr(wo, "created_at", None),
        completed_at=getattr(wo, "completed_at", None),
    )
