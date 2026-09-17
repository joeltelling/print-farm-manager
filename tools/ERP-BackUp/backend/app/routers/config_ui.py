from fastapi import APIRouter
from ..config import DISPLAY_DECIMALS

router = APIRouter(prefix="/config", tags=["config"])


@router.get("/ui")
def ui_config():
    return {"decimals_display": DISPLAY_DECIMALS}

