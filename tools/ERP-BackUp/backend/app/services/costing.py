from decimal import Decimal, ROUND_HALF_UP
from sqlalchemy.orm import Session
from ..models.stock import ItemCost

def D(x): return Decimal(str(x))

def _get_or_create(db: Session, item_id: int, warehouse_id: int) -> ItemCost:
    row = db.get(ItemCost, {"item_id": item_id, "warehouse_id": warehouse_id})
    if row is None:
        row = ItemCost(item_id=item_id, warehouse_id=warehouse_id, wac=D("0"), qty_on_hand=D("0"))
        db.add(row); db.flush()
    return row

def apply_receive(db: Session, *, item_id: int, warehouse_id: int, qty: float, unit_cost: float):
    if qty <= 0 or unit_cost < 0: raise ValueError("qty > 0 y unit_cost >= 0")
    row = _get_or_create(db, item_id, warehouse_id)
    old_qty, old_wac = D(row.qty_on_hand), D(row.wac)
    add_qty, add_cost = D(qty), D(unit_cost)
    new_qty = old_qty + add_qty
    new_wac = D("0") if new_qty == 0 else (old_qty*old_wac + add_qty*add_cost) / new_qty
    row.qty_on_hand = new_qty.quantize(D("0.000001"))
    row.wac = new_wac.quantize(D("0.0001"), rounding=ROUND_HALF_UP)
    db.flush()
    return row
