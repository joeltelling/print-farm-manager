#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

if [ -f .env ]; then
  set -a
  source .env
  set +a
fi

PORT="${PORT:-8000}"
HOST="${HOST:-0.0.0.0}"

# detener uvicorn previo
pkill -f "uvicorn backend.app.main:app --host $HOST --port $PORT" || true

echo "Starting uvicorn on ${HOST}:${PORT} with DATABASE_URL=${DATABASE_URL:-not-set}"
.venv/bin/uvicorn backend.app.main:app --host "$HOST" --port "$PORT"

