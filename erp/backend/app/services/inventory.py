from sqlalchemy.orm import Session
from ..models.stock import StockMove

def receive(db: Session, *, item_id: int, warehouse_id: int, location_id: int | None,
            qty: float, unit_cost: float, note: str | None = None,
            trans_date = None, idem_key: str | None = None):
    if qty <= 0:
        raise ValueError("qty debe ser > 0")

    # Idempotencia por idem_key
    from sqlalchemy import select
    from ..models.stock import StockMove, ItemCost

    if idem_key:
        ex = db.execute(select(StockMove).where(StockMove.idem_key == idem_key)).scalars().first()
        if ex:
            return ex

    mv = StockMove(
        item_id=item_id,
        warehouse_id=warehouse_id,
        location_id=location_id,
        qty=qty,
        unit_cost=unit_cost or 0,
        note=note,
        trans_date=trans_date,
        idem_key=idem_key
    )
    db.add(mv)

    # Upsert ItemCost
    ic = db.execute(
        select(ItemCost).where(ItemCost.item_id == item_id, ItemCost.warehouse_id == warehouse_id)
    ).scalars().first()
    if not ic:
        ic = ItemCost(item_id=item_id, warehouse_id=warehouse_id, wac=unit_cost or 0, qty_on_hand=0)
        db.add(ic)
        db.flush()

    qty_old = float(ic.qty_on_hand or 0)
    wac_old = float(ic.wac or 0)
    total_old = qty_old * wac_old
    total_in = qty * (unit_cost or 0)
    qty_new = qty_old + qty
    wac_new = (total_old + total_in) / qty_new if qty_new > 0 else 0

    ic.qty_on_hand = qty_new
    ic.wac = wac_new

    db.commit()
    db.refresh(mv)
    return mv
