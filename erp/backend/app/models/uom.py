from sqlalchemy import Column, String, Boolean, Numeric
from ..db import Base
class UOM(Base):
    __tablename__ = "uom"
    code = Column(String(10), primary_key=True)
    name = Column(String(100), nullable=False)
    dimension = Column(String(20), nullable=False)
    is_base = Column(Boolean, nullable=False, default=False)
    factor_to_base = Column(Numeric(18,6), nullable=False, default=1.0)
