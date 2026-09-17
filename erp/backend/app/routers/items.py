from typing import List, Optional
from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.orm import Session
from sqlalchemy import func
from ..db import get_db
from ..models.item import Item
from ..schemas.item import ItemCreate, ItemOut

router = APIRouter(prefix="/items", tags=["items"])


@router.get("", response_model=List[ItemOut])
def list_items(
    search: Optional[str] = Query(None, alias="search"),
    q: Optional[str] = Query(None, alias="q"),
    limit: int = Query(50, ge=1, le=200),
    offset: int = Query(0, ge=0),
    db: Session = Depends(get_db),
):
    """Listar items con filtro opcional por sku o nombre"""
    qry = db.query(Item)
    term = search or q
    if term:
        s = f"%{term.lower()}%"
        qry = qry.filter(
            (func.lower(Item.sku).like(s)) | (func.lower(Item.name).like(s))
        )
    return qry.order_by(Item.sku).limit(limit).offset(offset).all()


@router.post("", response_model=ItemOut, status_code=201)
def create_item(payload: ItemCreate, db: Session = Depends(get_db)):
    """Create a new item ensuring SKU uniqueness"""
    if db.query(Item).filter(Item.sku == payload.sku).first():
        raise HTTPException(status_code=409, detail="SKU already exists")

    data = payload.model_dump()
    try:
        item = Item(**data)
        db.add(item)
        db.commit()
        db.refresh(item)
        return item
    except Exception as e:
        db.rollback()
        raise HTTPException(status_code=500, detail=f"DB error: {e}")
