from typing import List, Optional
from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.orm import Session
from sqlalchemy import select, and_
from decimal import Decimal, ROUND_HALF_UP
from ..db import get_db
from ..models.bom import BOM, BOMLine
from ..models.item import Item
from ..models.stock import ItemCost
from ..models.machine import Machine
from ..schemas.bom import (
    BOMUpsert, BOMHeaderOut, BOMLineIn, BOMLineOut, BOMWithLinesOut
)

router = APIRouter(prefix="/bom", tags=["BOM"])

# ---------- helpers ----------
def _item_or_404(db: Session, item_id: int) -> Item:
    it = db.get(Item, item_id)
    if not it:
        raise HTTPException(status_code=404, detail=f"item_id {item_id} not found")
    return it

def _bom_or_404(db: Session, bom_id: int) -> BOM:
    bom = db.get(BOM, bom_id)
    if not bom:
        raise HTTPException(status_code=404, detail=f"BOM {bom_id} not found")
    return bom

# ---------- List headers ----------
@router.get("", response_model=List[BOMHeaderOut])
def list_boms(
    q: Optional[str] = Query(None, description="Filter by finished SKU or Name"),
    limit: int = Query(200, ge=1, le=1000),
    offset: int = Query(0, ge=0),
    db: Session = Depends(get_db),
):
    # join to fetch finished item sku/name
    stmt = (
        select(BOM, Item.sku, Item.name)
        .join(Item, Item.id == BOM.item_id)
        .order_by(Item.sku)
        .limit(limit).offset(offset)
    )
    if q:
        like = f"%{q}%"
        stmt = stmt.where((Item.sku.ilike(like)) | (Item.name.ilike(like)))

    rows = db.execute(stmt).all()
    out: List[BOMHeaderOut] = []
    for bom, sku, name in rows:
        out.append(BOMHeaderOut(
            id=bom.id,
            item_id=bom.item_id,
            item_sku=sku,
            item_name=name,
            name=bom.name,
            labor_hours_per_unit=float(bom.labor_hours_per_unit or 0),
        ))
    return out

# ---------- Create / update header ----------
@router.post("", response_model=BOMHeaderOut)
def upsert_bom(payload: BOMUpsert, db: Session = Depends(get_db)):
    # validate finished item
    _ = _item_or_404(db, payload.item_id)

    ex = db.execute(select(BOM).where(BOM.item_id == payload.item_id)).scalar_one_or_none()
    if ex:
        ex.name = payload.name or ex.name
        ex.labor_hours_per_unit = float(payload.labor_hours_per_unit or 0)
        db.commit(); db.refresh(ex)
        it = db.get(Item, ex.item_id)
        return BOMHeaderOut(
            id=ex.id, item_id=ex.item_id, item_sku=it.sku, item_name=it.name,
            name=ex.name, labor_hours_per_unit=float(ex.labor_hours_per_unit or 0),
        )

    rec = BOM(
        item_id=int(payload.item_id),
        name=payload.name or None,
        labor_hours_per_unit=float(payload.labor_hours_per_unit or 0),
    )
    db.add(rec); db.commit(); db.refresh(rec)
    it = db.get(Item, rec.item_id)
    return BOMHeaderOut(
        id=rec.id, item_id=rec.item_id, item_sku=it.sku, item_name=it.name,
        name=rec.name, labor_hours_per_unit=float(rec.labor_hours_per_unit or 0),
    )

# ---------- Get a BOM with its lines ----------
@router.get("/{bom_id}", response_model=BOMWithLinesOut)
def get_bom(bom_id: int, db: Session = Depends(get_db)):
    bom = _bom_or_404(db, bom_id)
    it = db.get(Item, bom.item_id)
    # lines + sku/name
    lines_stmt = (
        select(BOMLine, Item.sku, Item.name)
        .join(Item, Item.id == BOMLine.component_item_id)
        .where(BOMLine.bom_id == bom.id)
        .order_by(BOMLine.id)
    )
    rows = db.execute(lines_stmt).all()
    lines: List[BOMLineOut] = []
    for ln, sku, name in rows:
        lines.append(BOMLineOut(
            id=ln.id, component_item_id=ln.component_item_id,
            qty=float(ln.qty or 0), sku=sku, name=name
        ))
    return BOMWithLinesOut(
        id=bom.id, item_id=bom.item_id, item_sku=it.sku, item_name=it.name,
        name=bom.name,
        labor_hours_per_unit=float(bom.labor_hours_per_unit or 0),
        lines=lines,
    )

# ---------- Add / update line ----------
@router.post("/{bom_id}/line", response_model=BOMLineOut)
def upsert_line(bom_id: int, payload: BOMLineIn, db: Session = Depends(get_db)):
    bom = _bom_or_404(db, bom_id)
    _item_or_404(db, payload.component_item_id)

    ex = db.execute(
        select(BOMLine).where(and_(
            BOMLine.bom_id == bom.id,
            BOMLine.component_item_id == int(payload.component_item_id)
        ))
    ).scalar_one_or_none()

    if ex:
        ex.qty = float(payload.qty or 0)
        db.commit(); db.refresh(ex)
        it = db.get(Item, ex.component_item_id)
        return BOMLineOut(id=ex.id, component_item_id=ex.component_item_id,
                          qty=float(ex.qty or 0), sku=it.sku, name=it.name)

    rec = BOMLine(
        bom_id=bom.id,
        component_item_id=int(payload.component_item_id),
        qty=float(payload.qty or 0),
        scrap_pct=0,  # scrap not used
    )
    db.add(rec); db.commit(); db.refresh(rec)
    it = db.get(Item, rec.component_item_id)
    return BOMLineOut(id=rec.id, component_item_id=rec.component_item_id,
                      qty=float(rec.qty or 0), sku=it.sku, name=it.name)

# ---------- Delete line by ID ----------
@router.delete("/{bom_id}/line/{line_id}")
def delete_bom_line_by_id(bom_id: int, line_id: int, db: Session = Depends(get_db)):
    _ = _bom_or_404(db, bom_id)
    ln = db.get(BOMLine, line_id)
    if not ln or ln.bom_id != bom_id:
        raise HTTPException(status_code=404, detail="line not found")
    db.delete(ln)
    db.commit()
    return {"status": "ok", "deleted": line_id, "bom_id": bom_id}

# ---------- Delete line by component_item_id (query) ----------
@router.delete("/{bom_id}/line")
def delete_bom_line_by_component(
    bom_id: int,
    component_item_id: int = Query(..., description="component item id"),
    db: Session = Depends(get_db),
):
    _ = _bom_or_404(db, bom_id)
    ln = db.execute(
        select(BOMLine).where(
            BOMLine.bom_id == bom_id,
            BOMLine.component_item_id == component_item_id
        )
    ).scalar_one_or_none()
    if not ln:
        raise HTTPException(status_code=404, detail="line not found")
    db.delete(ln)
    db.commit()
    return {"status": "ok", "deleted": ln.id, "bom_id": bom_id}

# ---------- Calculate total cost for BOM (material + labor) ----------
@router.get("/{bom_id}/calculate-cost")
def calculate_bom_cost(
    bom_id: int,
    warehouse_id: Optional[int] = Query(None, description="warehouse_id for WAC lookup"),
    db: Session = Depends(get_db),
):
    """
    Calcula el costo total del BOM (material + labor) en tiempo real.
    Material cost = suma de (componente_qty × unitCost_de_componente)
    donde unitCost puede ser WAC o fallback a MFG_COMP, CON CONVERSIÓN UOM
    
    Retorna:
    {
        "bom_id": int,
        "material_cost": float,   # sum of component costs
        "labor_cost": float,      # labor_hours_per_unit * hourly_rate
        "total_cost": float,      # material_cost + labor_cost
        "labor_hours": float,
        "labor_rate": float
    }
    """
    from ..models.uom import UOM
    
    bom = _bom_or_404(db, bom_id)
    
    # Obtener todas las líneas del BOM
    lines = db.execute(select(BOMLine).where(BOMLine.bom_id == bom_id)).scalars().all()
    
    # Cargar todos los UOMs para conversiones
    uom_factors = {}
    uoms = db.execute(select(UOM)).scalars().all()
    for u in uoms:
        uom_factors[u.code] = Decimal(u.factor_to_base or "0")
    
    def convert_unit_cost(cost: Decimal, from_uom: str, to_uom: str) -> Decimal:
        """Convierte costo de una unidad a otra usando factor_to_base"""
        if not from_uom or not to_uom or from_uom == to_uom:
            return cost
        f_from = uom_factors.get(from_uom, Decimal("0"))
        f_to = uom_factors.get(to_uom, Decimal("0"))
        if f_from <= 0 or f_to <= 0:
            return cost
        return cost * (f_to / f_from)
    
    # Calcular costo de materiales
    material_cost = Decimal("0")
    for ln in lines:
        component_item = db.get(Item, ln.component_item_id)
        if not component_item:
            continue
        
        # Obtener WAC del componente
        if warehouse_id:
            from sqlalchemy import and_
            ic = db.execute(
                select(ItemCost).where(
                    and_(ItemCost.item_id == ln.component_item_id, 
                         ItemCost.warehouse_id == warehouse_id)
                ).limit(1)
            ).scalar_one_or_none()
        else:
            ic = db.execute(
                select(ItemCost).where(ItemCost.item_id == ln.component_item_id).limit(1)
            ).scalar_one_or_none()
        
        unit_cost = Decimal(ic.wac) if ic else Decimal("0")
        
        # Si no tiene WAC, fallback a costo teórico de MFG_COMP
        if unit_cost == 0:
            from ..models.mfg_component import MfgComponent
            mfg_comp = db.execute(
                select(MfgComponent).where(MfgComponent.sku == component_item.sku)
            ).scalar_one_or_none()
            if mfg_comp:
                # Calcular mat: raw_wac (convertido a display_uom) × raw_qty_per_unit
                raw_item = db.get(Item, mfg_comp.raw_item_id)
                if raw_item:
                    raw_ic = db.execute(
                        select(ItemCost).where(ItemCost.item_id == raw_item.id).limit(1)
                    ).scalar_one_or_none()
                    raw_wac = Decimal(raw_ic.wac) if raw_ic else Decimal("0")
                    # IMPORTANTE: Convertir WAC de purchase_uom a display_uom (igual que bom.html)
                    raw_wac_display = convert_unit_cost(
                        raw_wac, 
                        raw_item.purchase_uom_code, 
                        raw_item.display_uom_code
                    )
                    mat = raw_wac_display * Decimal(mfg_comp.raw_qty_per_unit or "0")
                else:
                    mat = Decimal("0")
                
                # Calcular time: (std_minutes / 60) × hourly_rate
                mach = db.execute(
                    select(Machine).where(Machine.machine == mfg_comp.machine)
                ).scalar_one_or_none()
                rate = Decimal(mach.hourly_rate) if mach else Decimal("0")
                time = (Decimal(mfg_comp.std_minutes or "0") / Decimal("60")) * rate
                unit_cost = mat + time
        
        qty = Decimal(ln.qty or "0")
        material_cost += qty * unit_cost
    
    # Calcular costo de labor
    labor_hours = Decimal(bom.labor_hours_per_unit or "0")
    labor_rate = Decimal("0")
    
    if labor_hours > 0:
        labor_machine = db.execute(
            select(Machine).where(Machine.machine == "LABOR")
        ).scalar_one_or_none()
        if labor_machine:
            labor_rate = Decimal(labor_machine.hourly_rate or "0")
    
    labor_cost = labor_hours * labor_rate
    total_cost = material_cost + labor_cost
    
    return {
        "bom_id": bom_id,
        "material_cost": float(material_cost.quantize(Decimal("0.0001"), rounding=ROUND_HALF_UP)),
        "labor_cost": float(labor_cost.quantize(Decimal("0.0001"), rounding=ROUND_HALF_UP)),
        "total_cost": float(total_cost.quantize(Decimal("0.0001"), rounding=ROUND_HALF_UP)),
        "labor_hours": float(labor_hours),
        "labor_rate": float(labor_rate),
    }

# ---------- Delete entire BOM ----------
@router.delete("/{bom_id}")
def delete_bom(bom_id: int, db: Session = Depends(get_db)):
    bom = db.get(BOM, bom_id)
    if not bom:
        raise HTTPException(status_code=404, detail="BOM not found")
    # delete lines explicitly in case cascade is missing
    db.query(BOMLine).filter(BOMLine.bom_id == bom_id).delete(synchronize_session=False)
    db.delete(bom)
    db.commit()
    return {"status": "ok"}
