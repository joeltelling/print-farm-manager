from typing import Optional
from pydantic import BaseModel, Field
class ReceiveIn(BaseModel):
    item_id: int; warehouse_id: int; location_id: int
    qty: float = Field(gt=0); unit_cost: float = Field(ge=0)
    idem_key: Optional[str] = None; note: Optional[str] = None
class CostOut(BaseModel):
    item_id: int; warehouse_id: int; wac: float; qty_on_hand: float
