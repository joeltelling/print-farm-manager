from sqlalchemy import Column, Integer, String, Boolean, Numeric, ForeignKey
from ..db import Base


class Item(Base):
    __tablename__ = "item"

    id = Column(Integer, primary_key=True)
    sku = Column(String(64), unique=True, nullable=False, index=True)
    name = Column(String(255), nullable=False)

    # 🔹 Canonical field: item's warehouse
    warehouse_id = Column(Integer, ForeignKey("warehouse.id"), nullable=True, index=True)

    # 🔹 UI derives dimension from consumption UOM
    dimension = Column(String(20), nullable=False)

    # 🔹 UOMs
    display_uom_code = Column(String(10), ForeignKey("uom.code"), nullable=False)   # Consumption UOM
    purchase_uom_code = Column(String(10), ForeignKey("uom.code"), nullable=False)  # Purchasing UOM

    # 🔹 Pricing overrides (nullable -> fallback to global config)
    custom_margin = Column(Numeric(18, 4), nullable=True)
    custom_ads = Column(Numeric(18, 4), nullable=True)
    custom_fee = Column(Numeric(18, 4), nullable=True)

    # 🔹 Activo/inactivo
    is_active = Column(Boolean, nullable=False, default=True)

    # (Optional) If you want to keep these, uncomment and leave them:
    # standard_cost = Column(Numeric(12, 4), nullable=True)
    # default_sell_price = Column(Numeric(12, 2), nullable=True)
