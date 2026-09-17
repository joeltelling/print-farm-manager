from sqlalchemy import Column, Integer, String, DateTime, func
from ..db import Base

class Warehouse(Base):
    __tablename__ = "warehouse"
    id = Column(Integer, primary_key=True)
    code = Column(String(50), nullable=False, unique=True, index=True)
    name = Column(String(200), nullable=True)
    created_at = Column(DateTime(timezone=True), server_default=func.now(), nullable=True)
    updated_at = Column(DateTime(timezone=True), onupdate=func.now(), nullable=True)
