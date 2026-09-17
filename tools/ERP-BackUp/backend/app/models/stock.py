from sqlalchemy import Column, Integer, ForeignKey, Numeric, String, DateTime, func, UniqueConstraint
from ..db import Base

class StockMove(Base):
    __tablename__ = "stock_move"
    id = Column(Integer, primary_key=True)
    item_id = Column(Integer, ForeignKey("item.id", ondelete="RESTRICT"), nullable=False, index=True)
    warehouse_id = Column(Integer, ForeignKey("warehouse.id", ondelete="RESTRICT"), nullable=False, index=True)
    location_id = Column(Integer, ForeignKey("location.id", ondelete="RESTRICT"), nullable=True, index=True)
    wo_id = Column(Integer, ForeignKey("work_order.id", ondelete="SET NULL"), nullable=True, index=True)
    qty = Column(Numeric(18,6), nullable=False)
    unit_cost = Column(Numeric(18,4), nullable=False, default=0)
    note = Column(String(200), nullable=True)
    created_at = Column(DateTime(timezone=True), server_default=func.now(), nullable=True)

    trans_date = Column(DateTime(timezone=True), server_default=func.now(), nullable=True)
    idem_key = Column(String(64), nullable=True, unique=True)

class ItemCost(Base):
    __tablename__ = "item_cost"
    item_id = Column(Integer, ForeignKey("item.id", ondelete="CASCADE"), primary_key=True)
    warehouse_id = Column(Integer, ForeignKey("warehouse.id", ondelete="CASCADE"), primary_key=True)
    wac = Column(Numeric(18,4), nullable=False, default=0)
    qty_on_hand = Column(Numeric(18,6), nullable=False, default=0)
    created_at = Column(DateTime(timezone=True), server_default=func.now(), nullable=True)
    updated_at = Column(DateTime(timezone=True), onupdate=func.now(), nullable=True)
    __table_args__ = (UniqueConstraint('item_id','warehouse_id', name='uq_item_cost_i_w'),)
