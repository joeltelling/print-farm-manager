import os
from pathlib import Path

DB_URL = os.getenv("DATABASE_URL")
if not DB_URL:
    raise ValueError("DATABASE_URL is not set.")

_backend = DB_URL.split(":", 1)[0].lower()
if not (_backend.startswith("postgres") or _backend.startswith("sqlite")):
    raise ValueError("DATABASE_URL must be PostgreSQL or SQLite (single CoMa DB).")

PAGE_SIZE = int(os.getenv("PAGE_SIZE", "50"))
CORS_ORIGINS = [
    o.strip()
    for o in os.getenv(
        "CORS_ORIGINS",
        "http://127.0.0.1:3000,http://localhost:3000,http://127.0.0.1:5173,http://localhost:5173,http://127.0.0.1:8000,http://localhost:8000",
    ).split(",")
    if o.strip()
]

DISPLAY_DECIMALS = int(os.getenv("DISPLAY_DECIMALS", "2"))

# True when CoMa shopfloor and ERP share one SQLite file
SHARED_SQLITE = _backend.startswith("sqlite")
