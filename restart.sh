#!/usr/bin/env bash

set -Eeuo pipefail

PROJECT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
SIMULATOR_MARKER="$PROJECT_DIR/.run/klipper-simulator.enabled"

fail() {
  printf 'ERROR: %s\n' "$*" >&2
  exit 1
}

usage() {
  cat <<'EOF'
Usage: ./restart.sh [--with-simulator|--without-simulator]

  --with-simulator     Restart Print Farm Manager and Virtual Klipper Printer.
  --without-simulator  Restart only Print Farm Manager and leave the simulator unchanged.

Without an option, an interactive terminal asks whether to restart the simulator.
Non-interactive runs restart it when it was previously managed by start.sh. The
environment variable WITH_KLIPPER_SIMULATOR=true|false overrides that behavior.
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
    *) fail "Unknown option: $1. Run ./restart.sh --help for usage." ;;
  esac
  shift
done

if [[ "$simulator_choice" == "auto" ]]; then
  if [[ -t 0 && -t 1 ]]; then
    if [[ -f "$SIMULATOR_MARKER" ]]; then
      read -r -p "Restart the managed Virtual Klipper Printer simulator too? [Y/n] " reply
      case "$reply" in
        n|N|no|NO|No) simulator_choice="no" ;;
        *) simulator_choice="yes" ;;
      esac
    else
      read -r -p "Restart the Virtual Klipper Printer simulator too? [y/N] " reply
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

if [[ "$simulator_choice" == "yes" ]]; then
  "$PROJECT_DIR/stop.sh" --with-simulator
  "$PROJECT_DIR/start.sh" --with-simulator
else
  "$PROJECT_DIR/stop.sh" --without-simulator
  "$PROJECT_DIR/start.sh" --without-simulator
fi
