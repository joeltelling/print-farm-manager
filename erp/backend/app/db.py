from sqlalchemy import create_engine, event
from sqlalchemy.orm import sessionmaker, DeclarativeBase
from .config import DB_URL, SHARED_SQLITE

class Base(DeclarativeBase):
    pass

_connect_args = {}
_engine_kwargs = {"future": True}
if SHARED_SQLITE:
    # Same file as CoMa better-sqlite3: allow cross-thread + busy timeout under WAL.
    _connect_args = {"check_same_thread": False, "timeout": 30}
    _engine_kwargs["connect_args"] = _connect_args
else:
    _engine_kwargs["pool_pre_ping"] = True

engine = create_engine(DB_URL, **_engine_kwargs)

if SHARED_SQLITE:
    @event.listens_for(engine, "connect")
    def _sqlite_on_connect(dbapi_conn, _connection_record):
        cursor = dbapi_conn.cursor()
        cursor.execute("PRAGMA journal_mode=WAL")
        cursor.execute("PRAGMA foreign_keys=ON")
        cursor.close()

SessionLocal = sessionmaker(bind=engine, autoflush=False, autocommit=False)

def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()
