from sqlalchemy import Column, Integer, String, DateTime, ForeignKey, Numeric, func
from ..db import Base


class WorkOrder(Base):
    """
    Unified WorkOrder model.
    Keeps planning fields (qty, status, kind) and logistics (warehouse/location/bom)
    without altering existing calculation rules in routers/services.
    """

    __tablename__ = "work_order"

    id = Column(Integer, primary_key=True)
    code = Column(String(50), nullable=True, index=True)

    # Planning / status
    kind = Column(String(8), nullable=False, default="FG")  # FG por defecto
    status = Column(String(20), nullable=False, default="draft")
    qty = Column(Numeric(18, 6), nullable=False, default=0)  # qty solicitada/planificada
    qty_planned = Column(Numeric(18, 6), nullable=False, default=0)
    qty_completed = Column(Numeric(18, 6), nullable=False, default=0)

    # Finished good relation (and legacy target_item_id compatibility)
    item_id = Column(Integer, ForeignKey("item.id", ondelete="RESTRICT"), nullable=False, index=True)
    target_item_id = Column(Integer, ForeignKey("item.id"), nullable=True)

    # Structure and logistics
    warehouse_to = Column(Integer, ForeignKey("warehouse.id", ondelete="RESTRICT"), nullable=True)
    location_to = Column(Integer, ForeignKey("location.id", ondelete="RESTRICT"), nullable=True)
    bom_id = Column(Integer, ForeignKey("bom.id", ondelete="SET NULL"), nullable=True)
    parent_wo_id = Column(Integer, nullable=True)

    # Tiempos
    created_at = Column(DateTime(timezone=True), server_default=func.now(), nullable=True)
    started_at = Column(DateTime(timezone=True), nullable=True)
    due_date = Column(DateTime(timezone=True), nullable=True)
    completed_at = Column(DateTime(timezone=True), nullable=True)

    notes = Column(String(500), nullable=True)


class WorkIssue(Base):
    """
    Records component issues to the WO.
    """

    __tablename__ = "wo_issue"

    id = Column(Integer, primary_key=True)
    wo_id = Column(Integer, ForeignKey("work_order.id", ondelete="CASCADE"), nullable=False, index=True)
    item_id = Column(Integer, ForeignKey("item.id", ondelete="RESTRICT"), nullable=False, index=True)
    qty = Column(Numeric(18, 6), nullable=False, default=0)
    unit_cost = Column(Numeric(12, 4), nullable=False, default=0)
    trans_date = Column(DateTime(timezone=True), server_default=func.now(), nullable=True)


class WorkLabor(Base):
    """
    Records labor hours/costs associated to the WO.
    """

    __tablename__ = "wo_labor"

    id = Column(Integer, primary_key=True)
    wo_id = Column(Integer, ForeignKey("work_order.id", ondelete="CASCADE"), nullable=False, index=True)
    hours = Column(Numeric(10, 3), nullable=False, default=0)
    hourly_rate = Column(Numeric(10, 2), nullable=False, default=0)
    cost = Column(Numeric(12, 4), nullable=False, default=0)
    resource = Column(String(100), nullable=True)
    notes = Column(String(200), nullable=True)
