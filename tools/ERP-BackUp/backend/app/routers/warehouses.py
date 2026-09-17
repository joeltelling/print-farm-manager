from typing import List
from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.orm import Session
from ..db import get_db
from ..models.warehouse import Warehouse
from ..schemas.warehouse import WarehouseCreate, WarehouseOut

router = APIRouter(prefix="/warehouses", tags=["warehouses"])

@router.get("", response_model=List[WarehouseOut])
def list_warehouses(db: Session = Depends(get_db)):
    return db.query(Warehouse).order_by(Warehouse.code).all()

@router.post("", response_model=WarehouseOut, status_code=status.HTTP_201_CREATED)
def create_warehouse(payload: WarehouseCreate, db: Session = Depends(get_db)):
    exists = db.query(Warehouse).filter(Warehouse.code == payload.code).first()
    if exists:
        raise HTTPException(status_code=409, detail="Warehouse code already exists")
    wh = Warehouse(code=payload.code, name=payload.name)
    db.add(wh); db.commit(); db.refresh(wh)
    return wh
