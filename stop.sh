#!/usr/bin/env bash

set -Eeuo pipefail

PROJECT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
PID_FILE="$PROJECT_DIR/.run/dev.pid"

if [[ ! -f "$PID_FILE" ]]; then
  printf 'Print Farm Manager is not running through start.sh.\n'
  exit 0
fi

dev_pid="$(<"$PID_FILE")"
if [[ ! "$dev_pid" =~ ^[0-9]+$ ]]; then
  rm -f "$PID_FILE"
  printf 'Removed an invalid PID file. No process was stopped.\n'
  exit 0
fi

if ! kill -0 -- "-$dev_pid" 2>/dev/null; then
  rm -f "$PID_FILE"
  printf 'Removed a stale PID file. Print Farm Manager was already stopped.\n'
  exit 0
fi

printf 'Stopping Print Farm Manager development services...\n'
kill -TERM -- "-$dev_pid"

for _ in {1..20}; do
  if ! kill -0 -- "-$dev_pid" 2>/dev/null; then
    rm -f "$PID_FILE"
    printf 'Stopped.\n'
    exit 0
  fi
  sleep 1
done

printf 'Graceful shutdown timed out. Forcing the managed process group to stop...\n' >&2
kill -KILL -- "-$dev_pid" 2>/dev/null || true
rm -f "$PID_FILE"
printf 'Stopped.\n'
