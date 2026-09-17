from sqlalchemy import Column, Integer, String, Numeric, DateTime, func, UniqueConstraint, ForeignKey
from ..db import Base


class PricingConfig(Base):
    __tablename__ = "pricing_config"
    __table_args__ = (UniqueConstraint("code", name="uq_pricing_config_code"),)

    id = Column(Integer, primary_key=True)
    name = Column(String(200), nullable=False)
    code = Column(String(50), nullable=False, unique=True, index=True)
    value = Column(Numeric(18, 4), nullable=False, default=0)
    last_update_date = Column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now())


class SalesOrderRecord(Base):
    __tablename__ = "sales_order"

    id = Column(Integer, primary_key=True)
    item_id = Column(Integer, ForeignKey("item.id", ondelete="SET NULL"), nullable=True, index=True)
    sku = Column(String(120), nullable=False, index=True)
    item_name = Column(String(255), nullable=True)
    qty = Column(Numeric(18, 6), nullable=False)
    unit_price = Column(Numeric(18, 4), nullable=False)
    total_price = Column(Numeric(18, 4), nullable=False)
    unit_margin = Column(Numeric(18, 4), nullable=False, default=0)  # selling price - unit cost
    unit_cost = Column(Numeric(18, 4), nullable=False, default=0)
    sale_date = Column(DateTime(timezone=True), nullable=False, server_default=func.now(), index=True)
    created_at = Column(DateTime(timezone=True), server_default=func.now(), nullable=True)


