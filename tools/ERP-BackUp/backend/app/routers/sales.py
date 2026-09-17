from typing import List, Literal, Optional
from decimal import Decimal, ROUND_HALF_UP
from datetime import datetime, timedelta
from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field
from sqlalchemy import select, func
from sqlalchemy.orm import Session
from io import StringIO, BytesIO
import csv
try:
    from fpdf import FPDF
except Exception:
    FPDF = None  # type: ignore

from ..db import get_db
from ..models.sales import PricingConfig, SalesOrderRecord
from ..models.item import Item
from ..models.warehouse import Warehouse
from ..models.bom import BOM, BOMLine
from ..models.stock import ItemCost, StockMove
from ..services.bom import rollup_cost

router = APIRouter(prefix="/sales", tags=["Sales"])


DEFAULT_CONFIGS = [
    ("Margin Default %", "MARGIN_DEF", Decimal("0")),
    ("Adds %", "ADDS_PCT", Decimal("0")),
    ("Ebay %", "EBAY_FEE", Decimal("0")),
]


def _fin_wh_id(db: Session) -> int:
    wh = db.execute(select(Warehouse).where(Warehouse.code == "FIN_GOOD")).scalar_one_or_none()
    if not wh:
        raise HTTPException(status_code=400, detail="FIN_GOOD warehouse not found")
    return int(wh.id)


class PricingConfigOut(BaseModel):
    id: int
    name: str
    code: str
    value: Decimal
    last_update_date: str | None = None


class PricingRowOut(BaseModel):
    item_id: int
    name: str
    sku: str
    cost: float
    margin_pct: float
    margin_value: float
    ads_pct: float
    fee_pct: float
    selling_price: float


class PricingPageOut(BaseModel):
    items: List[PricingRowOut]
    page: int
    limit: int
    total: int


class SalesReportRow(BaseModel):
    item_id: int
    item_name: str
    sku: str
    cost: float
    margin_pct: float
    margin_usd: float
    ads_pct: float
    fee_pct: float
    selling_price: float
    fees_usd: float


class SalesReportPageOut(BaseModel):
    items: List[SalesReportRow]
    page: int
    limit: int
    total: int
    sort_by: str
    order: Literal["asc", "desc"]
    search: Optional[str] = None


class SalesOrderItemOut(BaseModel):
    item_id: int
    name: str
    sku: str
    selling_price: float
    available_qty: float


class SalesOrderIn(BaseModel):
    sku: str
    qty: float


class SalesOrderOut(BaseModel):
    item_id: int
    sku: str
    qty: float
    unit_price: float
    total_price: float
    remaining_qty: float
    unit_margin: float


class SalesHistoryRow(BaseModel):
    sale_date: str
    sku: str
    item_name: str | None = None
    qty: float
    unit_price: float
    total_price: float
    unit_margin: float
    unit_cost: float


class SalesHistoryOut(BaseModel):
    items: List[SalesHistoryRow]
    total_qty: float
    total_revenue: float
    total_margin: float
    total_items: int
    page: int
    limit: int


class PricingConfigUpdate(BaseModel):
    code: str = Field(..., description="Unique code of the pricing config")
    value: Decimal = Field(..., description="New value")


def _ensure_defaults(db: Session) -> None:
    existing_codes = {c.code for c in db.execute(select(PricingConfig)).scalars().all()}
    created = False
    for name, code, value in DEFAULT_CONFIGS:
        if code not in existing_codes:
            db.add(PricingConfig(name=name, code=code, value=value))
            created = True
    if created:
        db.commit()


@router.get("/config", response_model=List[PricingConfigOut])
def list_pricing_config(db: Session = Depends(get_db)):
    _ensure_defaults(db)
    rows = db.execute(select(PricingConfig).order_by(PricingConfig.id)).scalars().all()
    # serialize datetime to isoformat
    out = []
    for r in rows:
        out.append(
            PricingConfigOut(
                id=r.id,
                name=r.name,
                code=r.code,
                value=r.value,
                last_update_date=r.last_update_date.isoformat() if r.last_update_date else None,
            )
        )
    return out


@router.post("/config", response_model=List[PricingConfigOut])
def update_pricing_config(payload: List[PricingConfigUpdate], db: Session = Depends(get_db)):
    if not payload:
        raise HTTPException(status_code=400, detail="Empty payload")
    _ensure_defaults(db)
    for item in payload:
        cfg = db.execute(select(PricingConfig).where(PricingConfig.code == item.code)).scalar_one_or_none()
        if not cfg:
            raise HTTPException(status_code=404, detail=f"Config code {item.code} not found")
        cfg.value = Decimal(item.value)
    db.commit()
    return list_pricing_config(db)


def _config_map(db: Session) -> dict[str, Decimal]:
    _ensure_defaults(db)
    rows = db.execute(select(PricingConfig)).scalars().all()
    return {r.code: Decimal(r.value or 0) for r in rows}


def _bom_cost(db: Session, item: Item) -> Decimal:
    """
    Calcula el costo total del BOM (material + labor).
    DEBE SER IDÉNTICO al cálculo en bom.html incluyendo conversión de UOM.
    """
    from ..models.uom import UOM
    
    bom = db.execute(select(BOM).where(BOM.item_id == item.id)).scalar_one_or_none()
    if not bom:
        return Decimal("0")
    
    # Obtener todas las líneas del BOM
    lines = db.execute(select(BOMLine).where(BOMLine.bom_id == bom.id)).scalars().all()
    
    # Cargar todos los UOMs para conversiones
    uom_factors = {}
    uoms = db.execute(select(UOM)).scalars().all()
    for u in uoms:
        uom_factors[u.code] = Decimal(u.factor_to_base or "0")
    
    def convert_unit_cost(cost: Decimal, from_uom: str, to_uom: str) -> Decimal:
        """Convierte costo de una unidad a otra usando factor_to_base"""
        if not from_uom or not to_uom or from_uom == to_uom:
            return cost
        f_from = uom_factors.get(from_uom, Decimal("0"))
        f_to = uom_factors.get(to_uom, Decimal("0"))
        if f_from <= 0 or f_to <= 0:
            return cost
        return cost * (f_to / f_from)
    
    # Calcular costo de materiales
    material_cost = Decimal("0")
    for ln in lines:
        component_item = db.get(Item, ln.component_item_id)
        if not component_item:
            continue
        
        # Obtener WAC del componente
        ic = db.execute(
            select(ItemCost).where(ItemCost.item_id == ln.component_item_id).limit(1)
        ).scalar_one_or_none()
        unit_cost = Decimal(ic.wac) if ic else Decimal("0")
        
        # Si no tiene WAC, fallback a costo teórico de MFG_COMP
        if unit_cost == 0:
            from ..models.mfg_component import MfgComponent
            from ..models.machine import Machine as MachineLookup
            mfg_comp = db.execute(
                select(MfgComponent).where(MfgComponent.sku == component_item.sku)
            ).scalar_one_or_none()
            if mfg_comp:
                # Calcular mat: raw_wac (convertido a display_uom) × raw_qty_per_unit
                raw_item = db.get(Item, mfg_comp.raw_item_id)
                if raw_item:
                    raw_ic = db.execute(
                        select(ItemCost).where(ItemCost.item_id == raw_item.id).limit(1)
                    ).scalar_one_or_none()
                    raw_wac = Decimal(raw_ic.wac) if raw_ic else Decimal("0")
                    # IMPORTANTE: Convertir WAC de purchase_uom a display_uom (igual que bom.html)
                    raw_wac_display = convert_unit_cost(
                        raw_wac, 
                        raw_item.purchase_uom_code, 
                        raw_item.display_uom_code
                    )
                    mat = raw_wac_display * Decimal(mfg_comp.raw_qty_per_unit or "0")
                else:
                    mat = Decimal("0")
                
                # Calcular time: (std_minutes / 60) × hourly_rate
                mach = db.execute(
                    select(MachineLookup).where(MachineLookup.machine == mfg_comp.machine)
                ).scalar_one_or_none()
                rate = Decimal(mach.hourly_rate) if mach else Decimal("0")
                time = (Decimal(mfg_comp.std_minutes or "0") / Decimal("60")) * rate
                unit_cost = mat + time
        
        qty = Decimal(ln.qty or "0")
        material_cost += qty * unit_cost
    
    # Calcular costo de labor
    from ..models.machine import Machine
    labor_hours = Decimal(bom.labor_hours_per_unit or "0")
    labor_cost = Decimal("0")
    
    if labor_hours > 0:
        labor_machine = db.execute(
            select(Machine).where(Machine.machine == "LABOR")
        ).scalar_one_or_none()
        if labor_machine:
            labor_rate = Decimal(labor_machine.hourly_rate or "0")
            labor_cost = labor_hours * labor_rate
    
    total_cost = material_cost + labor_cost
    return total_cost.quantize(Decimal("0.0001"), rounding=ROUND_HALF_UP)


def _pricing_numbers(item: Item, defval, cost: Decimal):
    margin_pct = Decimal(item.custom_margin) if item.custom_margin is not None else defval("MARGIN_DEF")
    ads_pct = Decimal(item.custom_ads) if item.custom_ads is not None else defval("ADDS_PCT")
    fee_pct = Decimal(item.custom_fee) if item.custom_fee is not None else defval("EBAY_FEE")

    margin_value = (cost * margin_pct / Decimal("100")).quantize(Decimal("0.0001"), rounding=ROUND_HALF_UP)
    price = (
        cost
        * (Decimal("1") + margin_pct / Decimal("100"))
        * (Decimal("1") + ads_pct / Decimal("100"))
        * (Decimal("1") + fee_pct / Decimal("100"))
    ).quantize(Decimal("0.0001"), rounding=ROUND_HALF_UP)
    fees_value = (price - (cost + margin_value)).quantize(Decimal("0.0001"), rounding=ROUND_HALF_UP)

    return margin_pct, ads_pct, fee_pct, margin_value, price, fees_value


def _available_qty(db: Session, item_id: int, warehouse_id: int) -> float:
    res = db.execute(
        select(func.coalesce(func.sum(StockMove.qty), 0)).where(
            StockMove.item_id == item_id,
            StockMove.warehouse_id == warehouse_id,
        )
    ).scalar_one()
    return float(res or 0)


def _wac_for_item(db: Session, item_id: int, warehouse_id: int) -> float:
    row = db.execute(
        select(ItemCost).where(
            ItemCost.item_id == item_id,
            ItemCost.warehouse_id == warehouse_id,
        )
    ).scalars().first()
    try:
        return float(row.wac) if row and getattr(row, "wac", None) is not None else 0.0  # type: ignore
    except Exception:
        for attr in ("avg_cost", "unit_cost", "cost"):
            if row is not None and getattr(row, attr, None) is not None:
                return float(getattr(row, attr))
        return 0.0


def _unit_price(db: Session, item: Item, cfg: dict[str, Decimal]) -> Decimal:
    defval = lambda code: Decimal(cfg.get(code, 0))
    cost = _bom_cost(db, item)
    _, _, _, _, price, _ = _pricing_numbers(item, defval, cost)
    return price


def _parse_dt(val: Optional[str], *, end: bool = False) -> Optional[datetime]:
    if not val:
        return None
    try:
        dt = datetime.fromisoformat(val)
    except Exception:
        try:
            dt = datetime.strptime(val, "%Y-%m-%d")
        except Exception:
            raise HTTPException(status_code=400, detail="Invalid date format, use YYYY-MM-DD")
    if end and dt.hour == 0 and dt.minute == 0 and dt.second == 0 and dt.microsecond == 0:
        dt = dt + timedelta(days=1) - timedelta(seconds=1)
    return dt


def _build_history(
    db: Session,
    start_dt: Optional[datetime],
    end_dt: Optional[datetime],
    *,
    page: int | None = None,
    limit: int | None = None,
) -> SalesHistoryOut:
    q = select(SalesOrderRecord)
    if start_dt:
        q = q.where(SalesOrderRecord.sale_date >= start_dt)
    if end_dt:
        q = q.where(SalesOrderRecord.sale_date <= end_dt)
    q = q.order_by(SalesOrderRecord.sale_date.desc())

    total_items = db.execute(select(func.count()).select_from(q.subquery())).scalar_one()

    if page and limit:
        q = q.limit(limit).offset((page - 1) * limit)

    rows = db.execute(q).scalars().all()

    items: List[SalesHistoryRow] = []
    total_qty = 0.0
    total_rev = 0.0
    total_margin = 0.0

    for r in rows:
        qty = float(r.qty or 0)
        unit_price = float(r.unit_price or 0)
        unit_margin = float(r.unit_margin or 0)
        unit_cost = float(r.unit_cost or 0)
        total_price = float(r.total_price or 0)

        total_qty += qty
        total_rev += total_price
        total_margin += unit_margin * qty

        items.append(
            SalesHistoryRow(
                sale_date=(r.sale_date.isoformat() if getattr(r, "sale_date", None) else ""),
                sku=r.sku,
                item_name=r.item_name,
                qty=qty,
                unit_price=unit_price,
                total_price=total_price,
                unit_margin=unit_margin,
                unit_cost=unit_cost,
            )
        )

    return SalesHistoryOut(
        items=items,
        total_qty=total_qty,
        total_revenue=total_rev,
        total_margin=total_margin,
        total_items=int(total_items),
        page=page or 1,
        limit=limit or (total_items or 1),
    )


def _csv_export(data: SalesHistoryOut) -> StreamingResponse:
    buf = StringIO()
    w = csv.writer(buf)
    w.writerow(["sale_date", "sku", "item_name", "qty", "unit_price", "total_price", "unit_margin", "unit_cost"])
    for r in data.items:
        w.writerow([r.sale_date, r.sku, r.item_name or "", f"{r.qty:.4f}", f"{r.unit_price:.4f}", f"{r.total_price:.4f}", f"{r.unit_margin:.4f}", f"{r.unit_cost:.4f}"])
    return StreamingResponse(iter([buf.getvalue()]), media_type="text/csv", headers={"Content-Disposition": "attachment; filename=sales_report.csv"})


def _pdf_export(data: SalesHistoryOut, start_dt: datetime, end_dt: datetime) -> StreamingResponse:
    if FPDF is None:
        raise HTTPException(status_code=500, detail="fpdf2 not installed; cannot generate PDF")
    pdf = FPDF()
    pdf.add_page()
    pdf.set_font("Arial", "B", 14)
    pdf.cell(0, 10, "Sales Report", ln=1)
    pdf.set_font("Arial", size=10)
    pdf.cell(0, 8, f"Range: {start_dt.date()} to {end_dt.date()}", ln=1)
    pdf.cell(0, 8, f"Rows: {len(data.items)}  |  Revenue: ${data.total_revenue:.2f}  |  Margin: ${data.total_margin:.2f}", ln=1)
    pdf.ln(2)

    headers = ["Date", "SKU", "Name", "Qty", "Unit $", "Total $", "Margin/U"]
    widths = [32, 24, 60, 18, 22, 22, 22]
    for h, wcell in zip(headers, widths):
        pdf.cell(wcell, 8, h, border=1)
    pdf.ln()

    for r in data.items:
        pdf.cell(widths[0], 8, r.sale_date.split("T")[0], border=1)
        pdf.cell(widths[1], 8, r.sku[:15], border=1)
        name = (r.item_name or "")[:28]
        pdf.cell(widths[2], 8, name, border=1)
        pdf.cell(widths[3], 8, f"{r.qty:.2f}", border=1, align="R")
        pdf.cell(widths[4], 8, f"{r.unit_price:.2f}", border=1, align="R")
        pdf.cell(widths[5], 8, f"{r.total_price:.2f}", border=1, align="R")
        pdf.cell(widths[6], 8, f"{r.unit_margin:.2f}", border=1, align="R")
        pdf.ln()

    out = pdf.output(dest="S").encode("latin-1")
    return StreamingResponse(BytesIO(out), media_type="application/pdf", headers={"Content-Disposition": "attachment; filename=sales_report.pdf"})


@router.get("/pricing", response_model=PricingPageOut)
def list_pricing(
    page: int = Query(1, ge=1),
    limit: int = Query(20, ge=1, le=20),
    search: Optional[str] = Query(None),
    db: Session = Depends(get_db),
):
    # enforce fixed page size 20
    limit = 20
    # Filtrar solo items de warehouse FIN_GOOD
    wh = db.execute(select(Warehouse).where(Warehouse.code == "FIN_GOOD")).scalar_one_or_none()
    if not wh:
        return PricingPageOut(items=[], page=page, limit=limit, total=0)
    q_items = select(Item).where(Item.warehouse_id == wh.id)
    if search:
        like = f"%{search}%"
        q_items = q_items.where((Item.sku.ilike(like)) | (Item.name.ilike(like)))
    total = db.execute(select(func.count()).select_from(q_items.subquery())).scalar_one()
    rows = db.execute(q_items.order_by(Item.sku).limit(limit).offset((page - 1) * limit)).scalars().all()

    cfg = _config_map(db)
    defval = lambda code: Decimal(cfg.get(code, 0))

    out_rows: List[PricingRowOut] = []
    for it in rows:
        cost = _bom_cost(db, it)
        margin_pct = Decimal(it.custom_margin) if it.custom_margin is not None else defval("MARGIN_DEF")
        ads_pct = Decimal(it.custom_ads) if it.custom_ads is not None else defval("ADDS_PCT")
        fee_pct = Decimal(it.custom_fee) if it.custom_fee is not None else defval("EBAY_FEE")

        margin_value = (cost * margin_pct / Decimal("100")).quantize(Decimal("0.0001"), rounding=ROUND_HALF_UP)
        price = (
            cost
            * (Decimal("1") + margin_pct / Decimal("100"))
            * (Decimal("1") + ads_pct / Decimal("100"))
            * (Decimal("1") + fee_pct / Decimal("100"))
        ).quantize(Decimal("0.0001"), rounding=ROUND_HALF_UP)

        out_rows.append(
            PricingRowOut(
                item_id=it.id,
                name=it.name,
                sku=it.sku,
                cost=float(cost),
                margin_pct=float(margin_pct),
                margin_value=float(margin_value),
                ads_pct=float(ads_pct),
                fee_pct=float(fee_pct),
                selling_price=float(price),
            )
        )

    return PricingPageOut(items=out_rows, page=page, limit=limit, total=int(total))


@router.get("/reports", response_model=SalesReportPageOut)
def sales_reports(
    page: int = Query(1, ge=1),
    limit: int = Query(20, ge=1, le=200),
    sort_by: Optional[str] = Query("item_name"),
    order: Literal["asc", "desc"] = Query("asc"),
    search: Optional[str] = Query(None),
    db: Session = Depends(get_db),
):
    # Filtrar solo items de warehouse FIN_GOOD
    wh = db.execute(select(Warehouse).where(Warehouse.code == "FIN_GOOD")).scalar_one_or_none()
    if not wh:
        return SalesReportPageOut(items=[], page=page, limit=limit, total=0, sort_by=sort_by, order=order, search=search)
    q_items = select(Item).where(Item.warehouse_id == wh.id)
    if search:
        like = f"%{search}%"
        q_items = q_items.where((Item.sku.ilike(like)) | (Item.name.ilike(like)))

    items = db.execute(q_items.order_by(Item.sku)).scalars().all()

    cfg = _config_map(db)
    defval = lambda code: Decimal(cfg.get(code, 0))

    rows: List[SalesReportRow] = []
    for it in items:
        cost = _bom_cost(db, it)
        margin_pct, ads_pct, fee_pct, margin_value, price, fees_value = _pricing_numbers(it, defval, cost)
        rows.append(
            SalesReportRow(
                item_id=it.id,
                item_name=it.name,
                sku=it.sku,
                cost=float(cost),
                margin_pct=float(margin_pct),
                margin_usd=float(margin_value),
                ads_pct=float(ads_pct),
                fee_pct=float(fee_pct),
                selling_price=float(price),
                fees_usd=float(fees_value),
            )
        )

    sort_field = (sort_by or "item_name").lower()
    sorters = {
        "margin_pct": lambda r: r.margin_pct,
        "margin_usd": lambda r: r.margin_usd,
        "selling_price": lambda r: r.selling_price,
        "item_name": lambda r: r.item_name.lower(),
    }
    sort_key = sorters.get(sort_field, sorters["item_name"])
    reverse = (order or "asc").lower() == "desc"
    sorted_rows = sorted(rows, key=sort_key, reverse=reverse)

    total = len(sorted_rows)
    start = (page - 1) * limit
    end = start + limit
    paginated = sorted_rows[start:end]

    return SalesReportPageOut(
        items=paginated,
        page=page,
        limit=limit,
        total=total,
        sort_by=sort_field if sort_field in sorters else "item_name",
        order="desc" if reverse else "asc",
        search=search,
    )


class PricingFieldPatch(BaseModel):
    field: Literal["custom_margin", "custom_ads", "custom_fee"]
    value: Decimal


@router.patch("/pricing/{item_id}", response_model=PricingRowOut)
def patch_pricing(item_id: int, payload: PricingFieldPatch, db: Session = Depends(get_db)):
    it = db.get(Item, item_id)
    if not it:
        raise HTTPException(status_code=404, detail="Item not found")
    setattr(it, payload.field, Decimal(payload.value))
    db.commit(); db.refresh(it)

    cfg = _config_map(db)
    defval = lambda code: Decimal(cfg.get(code, 0))
    cost = _bom_cost(db, it)
    margin_pct = Decimal(it.custom_margin) if it.custom_margin is not None else defval("MARGIN_DEF")
    ads_pct = Decimal(it.custom_ads) if it.custom_ads is not None else defval("ADDS_PCT")
    fee_pct = Decimal(it.custom_fee) if it.custom_fee is not None else defval("EBAY_FEE")
    margin_value = (cost * margin_pct / Decimal("100")).quantize(Decimal("0.0001"), rounding=ROUND_HALF_UP)
    price = (
        cost
        * (Decimal("1") + margin_pct / Decimal("100"))
        * (Decimal("1") + ads_pct / Decimal("100"))
        * (Decimal("1") + fee_pct / Decimal("100"))
    ).quantize(Decimal("0.0001"), rounding=ROUND_HALF_UP)

    return PricingRowOut(
        item_id=it.id,
        name=it.name,
        sku=it.sku,
        cost=float(cost),
        margin_pct=float(margin_pct),
        margin_value=float(margin_value),
        ads_pct=float(ads_pct),
        fee_pct=float(fee_pct),
        selling_price=float(price),
    )


@router.post("/pricing/{item_id}/reset", response_model=PricingRowOut)
def reset_pricing(item_id: int, db: Session = Depends(get_db)):
    it = db.get(Item, item_id)
    if not it:
        raise HTTPException(status_code=404, detail="Item not found")
    it.custom_margin = None
    it.custom_ads = None
    it.custom_fee = None
    db.commit(); db.refresh(it)

    cfg = _config_map(db)
    defval = lambda code: Decimal(cfg.get(code, 0))
    cost = _bom_cost(db, it)
    margin_pct = Decimal(it.custom_margin) if it.custom_margin is not None else defval("MARGIN_DEF")
    ads_pct = Decimal(it.custom_ads) if it.custom_ads is not None else defval("ADDS_PCT")
    fee_pct = Decimal(it.custom_fee) if it.custom_fee is not None else defval("EBAY_FEE")
    margin_value = (cost * margin_pct / Decimal("100")).quantize(Decimal("0.0001"), rounding=ROUND_HALF_UP)
    price = (
        cost
        * (Decimal("1") + margin_pct / Decimal("100"))
        * (Decimal("1") + ads_pct / Decimal("100"))
        * (Decimal("1") + fee_pct / Decimal("100"))
    ).quantize(Decimal("0.0001"), rounding=ROUND_HALF_UP)

    return PricingRowOut(
        item_id=it.id,
        name=it.name,
        sku=it.sku,
        cost=float(cost),
        margin_pct=float(margin_pct),
        margin_value=float(margin_value),
        ads_pct=float(ads_pct),
        fee_pct=float(fee_pct),
        selling_price=float(price),
    )


@router.get("/order/items", response_model=List[SalesOrderItemOut])
def list_order_items(
    search: Optional[str] = Query(None),
    limit: int = Query(100, ge=1, le=200),
    db: Session = Depends(get_db),
):
    wh_id = _fin_wh_id(db)
    q = select(Item).where(Item.warehouse_id == wh_id)
    if search:
        like = f"%{search}%"
        q = q.where((Item.sku.ilike(like)) | (Item.name.ilike(like)))
    items = db.execute(q.order_by(Item.sku).limit(limit)).scalars().all()
    if not items:
        return []

    ids = [it.id for it in items]
    qty_rows = db.execute(
        select(
            StockMove.item_id.label("item_id"),
            func.coalesce(func.sum(StockMove.qty), 0).label("qty"),
        )
        .where(StockMove.warehouse_id == wh_id, StockMove.item_id.in_(ids))
        .group_by(StockMove.item_id)
    ).all()
    qty_map = {row.item_id: float(row.qty or 0) for row in qty_rows}

    cfg = _config_map(db)
    out: List[SalesOrderItemOut] = []
    for it in items:
        price = _unit_price(db, it, cfg)
        out.append(
            SalesOrderItemOut(
                item_id=it.id,
                name=it.name,
                sku=it.sku,
                selling_price=float(price),
                available_qty=qty_map.get(it.id, 0.0),
            )
        )
    return out


@router.post("/orders", response_model=SalesOrderOut)
def create_sales_order(payload: SalesOrderIn, db: Session = Depends(get_db)):
    qty = float(payload.qty or 0)
    if qty <= 0:
        raise HTTPException(status_code=400, detail="qty must be > 0")

    wh_id = _fin_wh_id(db)
    item = db.execute(
        select(Item).where(Item.sku == payload.sku, Item.warehouse_id == wh_id)
    ).scalar_one_or_none()
    if not item:
        raise HTTPException(status_code=404, detail="Item not found in FIN_GOOD")

    available = _available_qty(db, item.id, wh_id)
    if available + 1e-9 < qty:
        raise HTTPException(status_code=409, detail="Insufficient stock")

    cfg = _config_map(db)
    unit_price = _unit_price(db, item, cfg)
    qty_dec = Decimal(str(qty))
    total_price = (unit_price * qty_dec).quantize(Decimal("0.0001"), rounding=ROUND_HALF_UP)

    unit_wac_dec = Decimal(str(_wac_for_item(db, item.id, wh_id)))
    margin_pct = Decimal(item.custom_margin) if item.custom_margin is not None else Decimal(cfg.get("MARGIN_DEF", 0))
    margin_unit = (unit_wac_dec * (margin_pct / Decimal("100"))).quantize(Decimal("0.0001"), rounding=ROUND_HALF_UP)

    db.add(
        StockMove(
            item_id=item.id,
            warehouse_id=wh_id,
            qty=-qty,
            unit_cost=unit_wac_dec,
            trans_date=datetime.utcnow(),
            note="Sale order",
        )
    )

    ic = db.execute(
        select(ItemCost).where(ItemCost.item_id == item.id, ItemCost.warehouse_id == wh_id)
    ).scalars().first()
    if not ic:
        ic = ItemCost(item_id=item.id, warehouse_id=wh_id, wac=unit_wac_dec, qty_on_hand=0)
        db.add(ic)
        db.flush()
    qty_new = float(ic.qty_on_hand or 0) - qty
    ic.qty_on_hand = qty_new

    db.add(
        SalesOrderRecord(
            item_id=item.id,
            sku=item.sku,
            item_name=item.name,
            qty=qty,
            unit_price=unit_price,
            total_price=total_price,
            unit_margin=margin_unit,
            unit_cost=unit_wac_dec,
            sale_date=datetime.utcnow(),
        )
    )

    db.commit(); db.refresh(item)

    return SalesOrderOut(
        item_id=item.id,
        sku=item.sku,
        qty=qty,
        unit_price=float(unit_price),
        total_price=float(total_price),
        remaining_qty=qty_new,
        unit_margin=float(margin_unit),
    )


@router.get("/orders/report", response_model=SalesHistoryOut)
def sales_history(
    start_date: Optional[str] = Query(None, description="YYYY-MM-DD"),
    end_date: Optional[str] = Query(None, description="YYYY-MM-DD"),
    format: Optional[str] = Query(None, description="csv|pdf"),
    page: int = Query(1, ge=1),
    limit: int = Query(25, ge=1, le=200),
    db: Session = Depends(get_db),
):
    end_dt = _parse_dt(end_date, end=True)
    start_dt = _parse_dt(start_date)
    if start_dt and end_dt and start_dt > end_dt:
        raise HTTPException(status_code=400, detail="start_date must be <= end_date")

    fmt = (format or "").lower()
    if fmt in {"csv", "pdf"}:
        data = _build_history(db, start_dt, end_dt, page=None, limit=None)
        if fmt == "csv":
            return _csv_export(data)
        return _pdf_export(data, start_dt or datetime.min, end_dt or datetime.utcnow())

    data = _build_history(db, start_dt, end_dt, page=page, limit=limit)
    return data

