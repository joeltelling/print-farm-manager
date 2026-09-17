#!/usr/bin/env bash
set -euo pipefail

# Backup Postgres database defined by $DATABASE_URL into data/backups/<YYYYMMDD>-acres-erp.dump
# Usage: ./scripts/backup_db.sh [backup_dir]
#   backup_dir (optional): target directory, defaults to data/backups
# Requirements: pg_dump available and DATABASE_URL exported (postgres://...)

BACKUP_DIR=${1:-data/backups}
DB_URL=${DATABASE_URL:-}

if [[ -z "$DB_URL" ]]; then
  echo "DATABASE_URL is required" >&2
  exit 1
fi

mkdir -p "$BACKUP_DIR"
STAMP=$(date +%Y%m%d)
TARGET="$BACKUP_DIR/${STAMP}-acres-erp.dump"

pg_dump --format=custom --file="$TARGET" "$DB_URL"

echo "Backup written to $TARGET"
