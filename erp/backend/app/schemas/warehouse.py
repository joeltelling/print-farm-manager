from typing import Optional
from pydantic import BaseModel, constr

class WarehouseBase(BaseModel):
    code: constr(strip_whitespace=True, min_length=1, max_length=50)
    name: Optional[str] = None

class WarehouseCreate(WarehouseBase):
    pass

class WarehouseOut(WarehouseBase):
    id: int
    class Config:
        from_attributes = True
