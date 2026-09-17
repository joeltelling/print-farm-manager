from typing import List, Optional
from pydantic import BaseModel, condecimal

class BOMUpsert(BaseModel):
    item_id: int
    name: Optional[str] = None
    labor_hours_per_unit: condecimal(max_digits=10, decimal_places=3) = 0

class BOMHeaderOut(BaseModel):
    id: int
    item_id: int
    item_sku: str
    item_name: str
    name: Optional[str] = None
    labor_hours_per_unit: float
    class Config:
        from_attributes = True

class BOMLineIn(BaseModel):
    component_item_id: int
    qty: condecimal(max_digits=18, decimal_places=6)

class BOMLineOut(BaseModel):
    id: int
    component_item_id: int
    sku: str
    name: str
    qty: float
    class Config:
        from_attributes = True

class BOMWithLinesOut(BOMHeaderOut):
    lines: List[BOMLineOut] = []
