from typing import List, Optional
from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session
from ..db import get_db
from ..models.uom import UOM
from ..schemas.uom import UOMOut
router = APIRouter(prefix="/uom", tags=["uom"])
@router.get("", response_model=List[UOMOut])
def list_uom(dimension: Optional[str] = None, db: Session = Depends(get_db)):
    q = db.query(UOM)
    if dimension: q = q.filter(UOM.dimension == dimension)
    return q.order_by(UOM.code).all()
