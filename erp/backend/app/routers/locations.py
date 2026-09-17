from typing import List, Optional
from fastapi import APIRouter, Depends, Query
from sqlalchemy.orm import Session
from sqlalchemy import select
from ..db import get_db
from ..models.location import Location
from ..schemas.location import LocationOut

router = APIRouter(prefix="/locations", tags=["locations"])


@router.get("", response_model=List[LocationOut])
def list_locations(
    warehouse_id: Optional[int] = Query(None, description="(deprecated) Ignorado — ya no existen warehouses"),
    db: Session = Depends(get_db),
):
    """
    Lista todas las localizaciones (formato ##A##). 'warehouse_id' se ignora por compatibilidad.
    """
    stmt = select(Location).order_by(Location.code)
    return db.execute(stmt).scalars().all()
