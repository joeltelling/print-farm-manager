from sqlalchemy import Column, Integer, String, ForeignKey, Numeric
from ..db import Base

class BOM(Base):
    __tablename__ = "bom"
    id = Column(Integer, primary_key=True)
    item_id = Column(Integer, ForeignKey("item.id", ondelete="RESTRICT"), nullable=False, index=True)
    name = Column(String(100), nullable=True)
    # Standard labor hours per finished unit
    labor_hours_per_unit = Column(Numeric(10,3), nullable=False, default=0)

class BOMLine(Base):
    __tablename__ = "bom_line"
    id = Column(Integer, primary_key=True)
    bom_id = Column(Integer, ForeignKey("bom.id", ondelete="CASCADE"), nullable=False, index=True)
    component_item_id = Column(Integer, ForeignKey("item.id", ondelete="RESTRICT"), nullable=False, index=True)
    qty = Column(Numeric(18,6), nullable=False, default=0)
    scrap_pct = Column(Numeric(6,3), nullable=False, default=0)
