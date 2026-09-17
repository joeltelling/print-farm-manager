from typing import Optional, List, Dict, Any
from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.orm import Session
from sqlalchemy import func
from ..db import get_db
from ..models.item import Item
from ..models.warehouse import Warehouse
from ..models.location import Location
from ..models.stock import StockMove
from ..services.inventory import receive as svc_receive

router = APIRouter(prefix="/inventory", tags=["inventory"])


def _safe_float(x) -> float:
    try:
        return float(x or 0)
    except Exception:
        return 0.0


@router.get("/stock")
def stock_snapshot(
    warehouse_id: Optional[int] = None, db: Session = Depends(get_db)
) -> List[Dict[str, Any]]:
    """
    Snapshot calculado desde stock_move + item_cost para items sin stock.
    - qty_on_hand y wac desde StockMove si qty != 0
    - wac desde ItemCost si item no tiene stock pero tiene cost registrada
    Asegura que todos los items con costo disponible aparezcan en el resultado.
    """
    from ..models.stock import ItemCost
    
    qty_sum = func.sum(StockMove.qty).label("qty")
    cost_sum = func.sum(StockMove.qty * StockMove.unit_cost).label("tcost")
    base = (
        db.query(
            StockMove.item_id,
            StockMove.warehouse_id,
            qty_sum,
            cost_sum,
        )
        .group_by(StockMove.item_id, StockMove.warehouse_id)
    )

    if warehouse_id:
        base = base.filter(StockMove.warehouse_id == warehouse_id)

    rows = []
    processed_keys = set()  # Para evitar duplicados
    
    # Procesar resultados de StockMove (items con qty != 0)
    for r in base.all():
        qty = _safe_float(r.qty)
        if abs(qty) < 1e-12:
            continue
        tcost = _safe_float(r.tcost)
        wac = (tcost / qty) if qty else 0.0
        it: Item = db.get(Item, r.item_id)
        wh: Warehouse = db.get(Warehouse, r.warehouse_id)
        rows.append(
            {
                "sku": it.sku if it else str(r.item_id),
                "name": it.name if it else None,
                "warehouse": (wh.code + (" — " + wh.name if wh and wh.name else ""))
                if wh
                else str(r.warehouse_id),
                "qty_on_hand": qty,
                "wac": round(wac, 4),
                "value": round(qty * wac, 4),
            }
        )
        processed_keys.add((r.item_id, r.warehouse_id))
    
    # Procesar ItemCost para items sin stock pero con costo registrado
    if not warehouse_id:
        # Sin filtro warehouse: retornar todos los ItemCost
        item_costs = db.query(ItemCost).all()
    else:
        # Con filtro: solo ItemCost del warehouse especificado
        item_costs = db.query(ItemCost).filter(ItemCost.warehouse_id == warehouse_id).all()
    
    for ic in item_costs:
        # Si ya procesamos este (item_id, warehouse_id), saltarlo
        if (ic.item_id, ic.warehouse_id) in processed_keys:
            continue
        
        # Si qty_on_hand=0, incluir para que bom.html tenga el WAC disponible
        it: Item = db.get(Item, ic.item_id)
        wh: Warehouse = db.get(Warehouse, ic.warehouse_id)
        rows.append(
            {
                "sku": it.sku if it else str(ic.item_id),
                "name": it.name if it else None,
                "warehouse": (wh.code + (" — " + wh.name if wh and wh.name else ""))
                if wh
                else str(ic.warehouse_id),
                "qty_on_hand": 0,
                "wac": round(_safe_float(ic.wac), 4),
                "value": 0,
            }
        )
    
    rows.sort(key=lambda x: (x["sku"], x["warehouse"]))
    return rows


@router.post("/receive_by_sku")
def receive_by_sku(payload: dict, db: Session = Depends(get_db)):
    # SKU
    sku = str(payload.get("sku", "")).strip()
    if not sku:
        raise HTTPException(status_code=400, detail="sku is required")
    it = db.query(Item).filter(Item.sku == sku).first()
    if not it:
        raise HTTPException(status_code=404, detail="SKU not found")

    # Warehouse (required, integer)
    try:
        wh_id = int(payload.get("warehouse_id", 0))
    except Exception:
        raise HTTPException(status_code=400, detail="invalid warehouse_id")
    if wh_id <= 0:
        raise HTTPException(status_code=400, detail="warehouse_id is required")

    # Location (optional, only existence is checked)
    loc_id = payload.get("location_id", None)
    if loc_id is not None:
        try:
            loc_id = int(loc_id)
        except Exception:
            raise HTTPException(status_code=400, detail="invalid location_id")
        loc = db.get(Location, loc_id)
        if not loc:
            raise HTTPException(status_code=400, detail="location_id not found")

    # Quantity and cost
    try:
        qty = float(payload.get("qty", 0))
        unit_cost = float(payload.get("unit_cost", 0))
    except Exception:
        raise HTTPException(status_code=400, detail="invalid qty / unit_cost")
    if qty <= 0:
        raise HTTPException(status_code=400, detail="qty must be > 0")

    # Delegate to service (uses UOM factors and sets date if missing)
    mv = svc_receive(
        db,
        item_id=it.id,
        warehouse_id=wh_id,
        location_id=loc_id,
        qty=qty,                # Qty en Purchasing UOM
        unit_cost=unit_cost,    # Coste en Purchasing UOM
        note=payload.get("note"),
        trans_date=payload.get("trans_date"),
        idem_key=payload.get("idem_key"),
    )
    return {"status": "ok", "move_id": mv.id}
