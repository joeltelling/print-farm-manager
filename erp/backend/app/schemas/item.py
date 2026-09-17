from typing import Optional
from pydantic import BaseModel

class ItemCreate(BaseModel):
    sku: str
    name: str
    warehouse_id: Optional[int] = None
    dimension: str
    display_uom_code: str
    purchase_uom_code: str
    is_active: Optional[bool] = True

class ItemOut(BaseModel):
    id: int
    sku: str
    name: str
    warehouse_id: Optional[int] = None
    dimension: str
    display_uom_code: str
    purchase_uom_code: str
    is_active: bool

    class Config:
        from_attributes = True
