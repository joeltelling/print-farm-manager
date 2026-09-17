from sqlalchemy import (
    Column, Integer, String, Numeric, Boolean,
    DateTime, func, UniqueConstraint
)
from ..db import Base

class Machine(Base):
    __tablename__ = "machine"
    __table_args__ = (UniqueConstraint("machine", name="uq_machine_machine"),)

    id = Column(Integer, primary_key=True)
    machine = Column(String(100), nullable=False, unique=True, index=True)  # machine name
    hourly_rate = Column(Numeric(18, 4), nullable=False, default=0)         # USD/hora
    is_active = Column(Boolean, nullable=False, default=True)

    created_at = Column(DateTime(timezone=True), server_default=func.now())
    updated_at = Column(DateTime(timezone=True), onupdate=func.now())
