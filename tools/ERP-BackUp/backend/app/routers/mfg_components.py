# backend/app/routers/mfg_components.py
from typing import List, Optional
from decimal import Decimal
from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.orm import Session
from sqlalchemy import select, func
from ..db import get_db
from ..models.mfg_component import MfgComponent
from ..models.item import Item
from ..models.warehouse import Warehouse
from ..models.uom import UOM
from ..schemas.mfg_component import MfgComponentIn, MfgComponentOut

router = APIRouter(prefix="/mfg/components", tags=["Manufacturing"])

# ---- helpers flexibles ------------------------------------------------------

PIECE_CANDIDATES = ("EA","EACH","UN","UNIT","PCS","PC","PZA")

def _pick_piece_uom(db: Session) -> str:
    # intenta candidatos conocidos
    for code in PIECE_CANDIDATES:
        u = db.execute(select(UOM).where(UOM.code == code)).scalar_one_or_none()
        if u:
            return u.code
    # si no hay, toma una base
    base = db.execute(select(UOM).where(UOM.is_base == True)).scalar_one_or_none()  # noqa: E712
    if base:
        return base.code
    # last resort, pick any
    anyu = db.execute(select(UOM)).scalar_one_or_none()
    if not anyu:
        raise HTTPException(400, "No UOM defined; create at least one (e.g. EA).")
    return anyu.code

def _find_comp_warehouse(db: Session) -> Warehouse:
    # case-insensitive match
    w = db.execute(
        select(Warehouse).where(func.lower(Warehouse.code) == "comp")
    ).scalar_one_or_none()
    if not w:
        raise HTTPException(400, "Warehouse 'comp' does not exist. Create it first.")
    return w

def _set_if_has(obj, **kwargs):
    """Assign only attributes that exist on the model (avoid 500 by wrong names)."""
    for k, v in kwargs.items():
        if hasattr(obj, k):
            setattr(obj, k, v)

def _ensure_comp_item(db: Session, sku: str, name_hint: Optional[str]) -> Item:
    # already exists?
    it = db.execute(select(Item).where(Item.sku == sku)).scalar_one_or_none()
    comp_wh = _find_comp_warehouse(db)
    if it:
        # if it exists but is not in comp, move it
        if hasattr(it, "warehouse_id") and int(getattr(it, "warehouse_id") or 0) != int(comp_wh.id):
            it.warehouse_id = int(comp_wh.id)
            db.commit(); db.refresh(it)
        elif hasattr(it, "warehouse_code") and (getattr(it, "warehouse_code") or "").lower() != "comp":
            it.warehouse_code = "comp"
            db.commit(); db.refresh(it)
        return it

    # Create minimal item in COMP with a piece UOM and correct dimension
    piece_code = _pick_piece_uom(db)
    piece_uom = db.execute(select(UOM).where(UOM.code == piece_code)).scalar_one_or_none()
    dim = (piece_uom.dimension if piece_uom else "COUNT").upper()

    it = Item(sku=sku.strip(), name=(name_hint or sku).strip())
    # warehouse
    _set_if_has(it, warehouse_id=int(comp_wh.id), warehouse_code="comp")
    # dimension (NOT NULL in the model)
    _set_if_has(it, dimension=dim)
    # UOMs (assign the same piece UOM)
    _set_if_has(
        it,
        display_uom_code=piece_code,
        consumption_uom_code=piece_code,  # nombres alternativos por robustez
        consume_uom_code=piece_code,
        purchase_uom_code=piece_code,
        purchasing_uom_code=piece_code,
    )
    db.add(it); db.commit(); db.refresh(it)
    return it

# ---- endpoints --------------------------------------------------------------

@router.get("", response_model=List[MfgComponentOut])
def list_components(
    q: Optional[str] = Query(None, description="Filtra por SKU o Nombre"),
    active: Optional[bool] = Query(None),
    limit: int = Query(200, ge=1, le=1000),
    offset: int = Query(0, ge=0),
    db: Session = Depends(get_db),
):
    stmt = select(MfgComponent)
    if q:
        from sqlalchemy import or_
        like = f"%{q}%"
        stmt = stmt.where(or_(MfgComponent.sku.ilike(like), MfgComponent.name.ilike(like)))
    if active is not None:
        stmt = stmt.where(MfgComponent.is_active == active)

    rows = db.execute(stmt.order_by(MfgComponent.sku).limit(limit).offset(offset)).scalars().all()

    # mapear raw_item_id -> raw_sku
    ids = {r.raw_item_id for r in rows}
    sku_by_id = {}
    if ids:
        for it in db.execute(select(Item).where(Item.id.in_(ids))).scalars():
            sku_by_id[it.id] = it.sku

    out: List[MfgComponentOut] = []
    for r in rows:
        out.append(MfgComponentOut(
            id=r.id,
            sku=r.sku,
            name=r.name,
            machine=r.machine,
            std_minutes=float(r.std_minutes or 0),
            raw_item_id=r.raw_item_id,
            raw_qty_per_unit=str(r.raw_qty_per_unit or "0"),
            scrap_pct=str(r.scrap_pct or "0"),
            is_active=bool(r.is_active),
            raw_sku=sku_by_id.get(r.raw_item_id),
        ))
    return out

@router.post("", response_model=MfgComponentOut)
def upsert_component(payload: MfgComponentIn, db: Session = Depends(get_db)):
    # validate RAW
    raw_it = db.execute(select(Item).where(Item.id == payload.raw_item_id)).scalar_one_or_none()
    if not raw_it:
        raise HTTPException(status_code=404, detail=f"raw_item_id {payload.raw_item_id} not found")

    ex = db.execute(select(MfgComponent).where(MfgComponent.sku == payload.sku)).scalar_one_or_none()
    if ex:
        ex.name = payload.name
        ex.machine = payload.machine
        ex.std_minutes = float(payload.std_minutes or 0)
        ex.raw_item_id = int(payload.raw_item_id)
        ex.raw_qty_per_unit = Decimal(str(payload.raw_qty_per_unit or 0))
        ex.scrap_pct = Decimal(str(payload.scrap_pct or 0))
        ex.is_active = bool(payload.is_active)
        db.commit(); db.refresh(ex)
        # asegurar Item en COMP
        _ensure_comp_item(db, ex.sku, ex.name)
        return MfgComponentOut(
            id=ex.id, sku=ex.sku, name=ex.name, machine=ex.machine,
            std_minutes=float(ex.std_minutes or 0),
            raw_item_id=ex.raw_item_id, raw_qty_per_unit=str(ex.raw_qty_per_unit or "0"),
            scrap_pct=str(ex.scrap_pct or "0"), is_active=bool(ex.is_active),
            raw_sku=raw_it.sku,
        )

    rec = MfgComponent(
        sku=payload.sku.strip(),
        name=payload.name.strip(),
        machine=payload.machine or None,
        std_minutes=float(payload.std_minutes or 0),
        raw_item_id=int(payload.raw_item_id),
        raw_qty_per_unit=Decimal(str(payload.raw_qty_per_unit or 0)),
        scrap_pct=Decimal(str(payload.scrap_pct or 0)),
        is_active=bool(payload.is_active),
    )
    db.add(rec); db.commit(); db.refresh(rec)
    # asegurar Item en COMP
    _ensure_comp_item(db, rec.sku, rec.name)

    return MfgComponentOut(
        id=rec.id, sku=rec.sku, name=rec.name, machine=rec.machine,
        std_minutes=float(rec.std_minutes or 0),
        raw_item_id=rec.raw_item_id, raw_qty_per_unit=str(rec.raw_qty_per_unit or "0"),
        scrap_pct=str(rec.scrap_pct or "0"), is_active=bool(rec.is_active),
        raw_sku=raw_it.sku,
    )
