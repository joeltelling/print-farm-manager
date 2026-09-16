#!/usr/bin/env bash

set -Eeuo pipefail

PROJECT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
PID_FILE="$PROJECT_DIR/.run/dev.pid"
SIMULATOR_DIR="$PROJECT_DIR/tools/virtual-klipper-printer"
SIMULATOR_MARKER="$PROJECT_DIR/.run/klipper-simulator.enabled"

fail() {
  printf 'ERROR: %s\n' "$*" >&2
  exit 1
}

usage() {
  cat <<'EOF'
Usage: ./stop.sh [--with-simulator|--without-simulator]

  --with-simulator     Stop Print Farm Manager and Virtual Klipper Printer.
  --without-simulator  Stop only Print Farm Manager.

Without an option, an interactive terminal asks whether to stop the simulator.
Non-interactive runs stop it when it was started by start.sh. The environment
variable WITH_KLIPPER_SIMULATOR=true|false overrides that behavior.
EOF
}

simulator_choice="auto"
case "${WITH_KLIPPER_SIMULATOR:-}" in
  true|1|yes) simulator_choice="yes" ;;
  false|0|no) simulator_choice="no" ;;
  "") ;;
  *) fail "WITH_KLIPPER_SIMULATOR must be true or false." ;;
esac

while (( $# > 0 )); do
  case "$1" in
    --with-simulator) simulator_choice="yes" ;;
    --without-simulator) simulator_choice="no" ;;
    -h|--help) usage; exit 0 ;;
    *) fail "Unknown option: $1. Run ./stop.sh --help for usage." ;;
  esac
  shift
done

if [[ "$simulator_choice" == "auto" ]]; then
  if [[ -t 0 && -t 1 ]]; then
    if [[ -f "$SIMULATOR_MARKER" ]]; then
      read -r -p "Stop the managed Virtual Klipper Printer simulator too? [Y/n] " reply
      case "$reply" in
        n|N|no|NO|No) simulator_choice="no" ;;
        *) simulator_choice="yes" ;;
      esac
    else
      read -r -p "Stop the Virtual Klipper Printer simulator too? [y/N] " reply
      case "$reply" in
        y|Y|yes|YES|Yes) simulator_choice="yes" ;;
        *) simulator_choice="no" ;;
      esac
    fi
  elif [[ -f "$SIMULATOR_MARKER" ]]; then
    simulator_choice="yes"
  else
    simulator_choice="no"
  fi
fi

stop_application() {
  if [[ ! -f "$PID_FILE" ]]; then
    printf 'Print Farm Manager is not running through start.sh.\n'
    return
  fi

  local dev_pid
  dev_pid="$(<"$PID_FILE")"
  if [[ ! "$dev_pid" =~ ^[0-9]+$ ]]; then
    rm -f "$PID_FILE"
    printf 'Removed an invalid PID file. No process was stopped.\n'
    return
  fi

  if ! kill -0 -- "-$dev_pid" 2>/dev/null; then
    rm -f "$PID_FILE"
    printf 'Removed a stale PID file. Print Farm Manager was already stopped.\n'
    return
  fi

  printf 'Stopping Print Farm Manager development services...\n'
  kill -TERM -- "-$dev_pid"

  for _ in {1..20}; do
    if ! kill -0 -- "-$dev_pid" 2>/dev/null; then
      rm -f "$PID_FILE"
      printf 'Print Farm Manager stopped.\n'
      return
    fi
    sleep 1
  done

  printf 'Graceful shutdown timed out. Forcing the managed process group to stop...\n' >&2
  kill -KILL -- "-$dev_pid" 2>/dev/null || true
  rm -f "$PID_FILE"
  printf 'Print Farm Manager stopped.\n'
}

stop_simulator() {
  command -v docker >/dev/null 2>&1 || fail "Docker is required to stop the Virtual Klipper Printer."
  docker compose version >/dev/null 2>&1 || fail "Docker Compose is required to stop the Virtual Klipper Printer."
  [[ -f "$SIMULATOR_DIR/docker-compose.yml" ]] || fail "Virtual Klipper Printer is missing from $SIMULATOR_DIR"

  printf 'Stopping Virtual Klipper Printer...\n'
  (cd "$SIMULATOR_DIR" && docker compose stop printer)
  rm -f "$SIMULATOR_MARKER"
  printf 'Virtual Klipper Printer stopped.\n'
}

stop_application
if [[ "$simulator_choice" == "yes" ]]; then
  stop_simulator
fi
