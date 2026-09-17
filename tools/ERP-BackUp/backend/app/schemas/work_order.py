from typing import Optional, List
from pydantic import BaseModel, condecimal

class WOCreate(BaseModel):
    item_id: int
    qty_planned: condecimal(max_digits=18, decimal_places=6)
    warehouse_to: int
    location_to: Optional[int] = None
    bom_id: Optional[int] = None
    due_date: Optional[str] = None
    notes: Optional[str] = None

class WOOut(BaseModel):
    id: int
    code: Optional[str] = None
    status: str
    item_id: int
    qty_planned: float
    qty_completed: float
    warehouse_to: int
    location_to: Optional[int] = None
    bom_id: Optional[int] = None
    class Config:
        from_attributes = True

class WOIssueLine(BaseModel):
    component_item_id: int
    qty: condecimal(max_digits=18, decimal_places=6)
    warehouse_from: int
    location_from: Optional[int] = None

class WOIssue(BaseModel):
    lines: List[WOIssueLine]

class WOLaborIn(BaseModel):
    hours: condecimal(max_digits=10, decimal_places=3)
    rate: condecimal(max_digits=10, decimal_places=2)
    cost: Optional[condecimal(max_digits=12, decimal_places=4)] = None
    resource: Optional[str] = None
    notes: Optional[str] = None

class WOComplete(BaseModel):
    qty_good: condecimal(max_digits=18, decimal_places=6)
    qty_scrap: Optional[condecimal(max_digits=18, decimal_places=6)] = 0
