from sqlalchemy import Column, Integer, String, ForeignKey, Enum, Numeric, DateTime, func
from ..db import Base
import enum

class PriceKind(enum.Enum):
    MARKUP = "MARKUP"
    FIXED = "FIXED"

class PriceRule(Base):
    __tablename__ = "price_rule"
    id = Column(Integer, primary_key=True)
    item_id = Column(Integer, ForeignKey("item.id", ondelete="CASCADE"), nullable=False, index=True)
    kind = Column(Enum(PriceKind), nullable=False)
    value = Column(Numeric(12,4), nullable=False)
    currency = Column(String(3), nullable=False, default="USD")
    active = Column(Integer, nullable=False, default=1)  # 1=true, 0=false
    starts_at = Column(DateTime, nullable=True)
    ends_at = Column(DateTime, nullable=True)
    created_at = Column(DateTime, nullable=False, server_default=func.now())
