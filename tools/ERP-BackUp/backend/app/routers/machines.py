from typing import List, Optional
from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy.orm import Session
from sqlalchemy import select
from ..db import get_db
from ..models.machine import Machine
from ..schemas.machine import MachineIn, MachineOut

router = APIRouter(prefix="/mfg/machines", tags=["Manufacturing"])

@router.get("", response_model=List[MachineOut])
@router.get("/", response_model=List[MachineOut])
def list_machines(
    q: Optional[str] = Query(None, description="Filter by machine name"),
    limit: int = Query(200, ge=1, le=1000),
    offset: int = Query(0, ge=0),
    db: Session = Depends(get_db),
):
    stmt = select(Machine)
    if q:
        like = f"%{q}%"
        stmt = stmt.where(Machine.machine.ilike(like))
    rows = db.execute(stmt.order_by(Machine.machine.asc()).limit(limit).offset(offset)).scalars().all()
    return [MachineOut.model_validate(r) for r in rows]

@router.post("", response_model=MachineOut, status_code=status.HTTP_201_CREATED)
@router.post("/", response_model=MachineOut, status_code=status.HTTP_201_CREATED)
def upsert_machine(payload: MachineIn, db: Session = Depends(get_db)):
    name = (payload.machine or "").strip()
    if not name:
        raise HTTPException(status_code=400, detail="machine es obligatorio")
    if payload.hourly_rate < 0:
        raise HTTPException(status_code=400, detail="hourly_rate debe ser ≥ 0")

    ex = db.execute(select(Machine).where(Machine.machine == name)).scalar_one_or_none()
    if ex:
        ex.hourly_rate = float(payload.hourly_rate or 0)
        ex.is_active = True  # siempre activo
        db.commit(); db.refresh(ex)
        return MachineOut.model_validate(ex)

    rec = Machine(machine=name, hourly_rate=float(payload.hourly_rate or 0), is_active=True)
    db.add(rec); db.commit(); db.refresh(rec)
    return MachineOut.model_validate(rec)
