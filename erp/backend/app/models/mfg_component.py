from sqlalchemy import (
    Column, Integer, String, Numeric, Boolean, ForeignKey,
    DateTime, func, UniqueConstraint
)
from ..db import Base

class MfgComponent(Base):
    __tablename__ = "mfg_component"
    __table_args__ = (UniqueConstraint("sku", name="uq_mfg_component_sku"),)

    id = Column(Integer, primary_key=True)
    sku = Column(String(64), nullable=False, unique=True, index=True)
    name = Column(String(255), nullable=False)
    machine = Column(String(100), nullable=True)
    std_minutes = Column(Numeric(10, 3), nullable=False, default=0)

    raw_item_id = Column(Integer, ForeignKey("item.id", ondelete="RESTRICT"), nullable=False, index=True)
    raw_qty_per_unit = Column(Numeric(24, 12), nullable=False)

    scrap_pct = Column(Numeric(9, 3), nullable=False, default=0)
    is_active = Column(Boolean, nullable=False, default=True)

    created_at = Column(DateTime(timezone=True), server_default=func.now())
    updated_at = Column(DateTime(timezone=True), onupdate=func.now())
