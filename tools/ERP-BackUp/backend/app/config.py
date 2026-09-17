import os

DB_URL = os.getenv("DATABASE_URL")
if not DB_URL:
    raise ValueError("DATABASE_URL is not set; PostgreSQL is required.")
if not DB_URL.startswith("postgres"):
    raise ValueError("Only PostgreSQL is allowed. Set a postgres DATABASE_URL.")

PAGE_SIZE = int(os.getenv("PAGE_SIZE", "50"))
CORS_ORIGINS = [
    o.strip()
    for o in os.getenv(
    "CORS_ORIGINS",
        "http://127.0.0.1:8000,http://localhost:8000",
    ).split(",")
    if o.strip()
]

# UI / formato
DISPLAY_DECIMALS = int(os.getenv("DISPLAY_DECIMALS", "2"))
