# backend/app/models/location.py
from sqlalchemy import Column, Integer, String, CheckConstraint
from ..db import Base


class Location(Base):
    __tablename__ = "location"

    id = Column(Integer, primary_key=True)
    warehouse_id = Column(Integer, nullable=False, index=True)
    # Code format: 2 digits + 1 uppercase letter + 2 digits (e.g., 01A01)
    code = Column(String(5), unique=True, nullable=False, index=True)

    __table_args__ = (
        CheckConstraint("code ~ '^[0-9]{2}[A-Z][0-9]{2}$'", name="ck_location_code_format"),
    )
