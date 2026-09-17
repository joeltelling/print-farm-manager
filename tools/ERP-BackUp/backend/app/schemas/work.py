# backend/app/schemas/work.py
from typing import Optional, List
from pydantic import BaseModel, condecimal

class WOCreate(BaseModel):
    kind: str                   # 'COMP' | 'FG'
    target_item_id: Optional[int] = None
    target_sku: Optional[str] = None
    target_qty: condecimal(max_digits=18, decimal_places=6)

class WOOut(BaseModel):
    id: int
    kind: str
    status: str
    target_item_id: int
    target_sku: str
    target_name: str
    target_qty: float
    parent_wo_id: Optional[int] = None
    class Config:
        from_attributes = True

class WOPlanLine(BaseModel):
    sku: str
    name: str
    per_unit_qty: float
    req_qty: float
    onhand_qty: float
    short_qty: float

class WOPlanOut(BaseModel):
    id: int
    kind: str
    target_sku: str
    target_name: str
    target_qty: float
    lines: List[WOPlanLine] = []

class WOCompleteResult(BaseModel):
    id: int
    status: str
