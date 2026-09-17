from decimal import Decimal, ROUND_HALF_UP
from sqlalchemy.orm import Session
from sqlalchemy import select
from ..models.bom import BOM, BOMLine
from ..models.stock import ItemCost

D = lambda x: Decimal(str(x))

def rollup_cost(db: Session, *, bom_id: int, warehouse_id: int) -> Decimal:
    # sum qty*(1+scrap)*WAC(component) for all BOM lines
    lines = db.execute(select(BOMLine).where(BOMLine.bom_id == bom_id)).scalars().all()
    total = D("0")
    for ln in lines:
        ic = db.get(ItemCost, {"item_id": ln.component_item_id, "warehouse_id": warehouse_id})
        wac = D(ic.wac) if ic else D("0")
        qty_req = D(ln.qty) * (D("1") + D(ln.scrap_pct or 0))
        total += qty_req * wac
    return total.quantize(D("0.0001"), rounding=ROUND_HALF_UP)
