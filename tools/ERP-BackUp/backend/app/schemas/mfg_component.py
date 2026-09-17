from typing import Optional
from decimal import Decimal
from pydantic import BaseModel, ConfigDict

class MfgComponentIn(BaseModel):
    sku: str
    name: str
    machine: Optional[str] = None
    std_minutes: float = 0.0
    raw_item_id: int
    raw_qty_per_unit: Decimal
    scrap_pct: Decimal = Decimal("0")
    is_active: bool = True

class MfgComponentOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: int
    sku: str
    name: str
    machine: Optional[str] = None
    std_minutes: float
    raw_item_id: int
    raw_qty_per_unit: Decimal
    scrap_pct: Decimal
    is_active: bool
    raw_sku: Optional[str] = None  # se rellena en el router para comodidad de la UI
