#!/usr/bin/env bash

set -Eeuo pipefail

PROJECT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
RUNTIME_DIR="$PROJECT_DIR/.run"
PID_FILE="$RUNTIME_DIR/dev.pid"
DATASET_FILE="$RUNTIME_DIR/dev.dataset"
LOG_FILE="$RUNTIME_DIR/dev.log"
DEPENDENCY_STAMP="$RUNTIME_DIR/dependencies.sha256"
SIMULATOR_DIR="$PROJECT_DIR/tools/virtual-klipper-printer"
SIMULATOR_MARKER="$RUNTIME_DIR/klipper-simulator.enabled"

fail() {
  printf 'ERROR: %s\n' "$*" >&2
  exit 1
}

usage() {
  cat <<'EOF'
Usage: ./start.sh [--with-simulator|--without-simulator] [--organic-data|--seed-data]

  --with-simulator     Start the local Virtual Klipper Printer too.
  --without-simulator  Start only Print Farm Manager.
  --organic-data       Use organic-data.db (default).
  --seed-data          Use seed-data.db and default to DEMO_MODE=true.

Without an option, an interactive terminal asks whether to start the simulator.
Non-interactive runs default to Print Farm Manager only. The environment variable
WITH_KLIPPER_SIMULATOR=true|false provides the same non-interactive control.
PFM_DATASET=organic|seed provides the same database selection.
EOF
}

simulator_choice="auto"
database_choice="${PFM_DATASET:-organic}"
case "$database_choice" in
  organic|seed) ;;
  *) fail "PFM_DATASET must be organic or seed." ;;
esac

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
    --organic-data) database_choice="organic" ;;
    --seed-data) database_choice="seed" ;;
    -h|--help) usage; exit 0 ;;
    *) fail "Unknown option: $1. Run ./start.sh --help for usage." ;;
  esac
  shift
done

export PFM_DATASET="$database_choice"
if [[ "$database_choice" == "seed" && -z "${DEMO_MODE+x}" ]]; then
  export DEMO_MODE=true
fi

if [[ "$simulator_choice" == "auto" ]]; then
  simulator_choice="no"
  if [[ -t 0 && -t 1 ]]; then
    read -r -p "Start the Virtual Klipper Printer simulator too? [y/N] " reply
    case "$reply" in
      y|Y|yes|YES|Yes) simulator_choice="yes" ;;
    esac
  fi
fi

if [[ "$(uname -s)" != "Linux" ]]; then
  fail "start.sh is intended for Linux. Use the npm commands documented for your platform."
fi

for command_name in node npm python3 sha256sum; do
  command -v "$command_name" >/dev/null 2>&1 || fail "Required command not found: $command_name"
done

node_major="$(node -p 'Number(process.versions.node.split(".")[0])')"
if (( node_major < 22 || node_major >= 24 )); then
  fail "Node.js 22 or 23 is required. Found $(node --version)."
fi

mkdir -p "$RUNTIME_DIR"

start_simulator() {
  command -v docker >/dev/null 2>&1 || fail "Docker is required to start the Virtual Klipper Printer."
  docker compose version >/dev/null 2>&1 || fail "Docker Compose is required to start the Virtual Klipper Printer."
  if [[ ! -f "$SIMULATOR_DIR/docker-compose.yml" ]]; then
    fail "Virtual Klipper Printer is missing. Clone https://github.com/mainsail-crew/virtual-klipper-printer.git into $SIMULATOR_DIR"
  fi

  printf 'Starting Virtual Klipper Printer...\n'
  (cd "$SIMULATOR_DIR" && docker compose up -d)

  local ready=false
  for _ in {1..60}; do
    if node -e "fetch('http://127.0.0.1:7125/server/info', { signal: AbortSignal.timeout(2000) }).then(async r => { const body = await r.json(); if (!r.ok || body.result?.klippy_state !== 'ready') process.exit(1) }).catch(() => process.exit(1))"; then
      ready=true
      break
    fi
    sleep 1
  done
  if [[ "$ready" != true ]]; then
    (cd "$SIMULATOR_DIR" && docker compose logs --tail=40) >&2 || true
    fail "Virtual Klipper Printer did not become ready on port 7125."
  fi

  : > "$SIMULATOR_MARKER"
  printf 'Virtual Klipper Printer is ready at http://localhost:7125\n'
}

if [[ "$simulator_choice" == "yes" ]]; then
  start_simulator
fi

api_port="${PORT:-3000}"
vite_port="${VITE_PORT:-5173}"
if [[ ! "$api_port" =~ ^[0-9]+$ || ! "$vite_port" =~ ^[0-9]+$ ]]; then
  fail "PORT and VITE_PORT must be numeric."
fi
if (( api_port < 1 || api_port > 65535 || vite_port < 1 || vite_port > 65535 )); then
  fail "PORT and VITE_PORT must be between 1 and 65535."
fi
if [[ "$api_port" == "$vite_port" ]]; then
  fail "PORT and VITE_PORT must be different."
fi

if [[ -f "$PID_FILE" ]]; then
  existing_pid="$(<"$PID_FILE")"
  if [[ "$existing_pid" =~ ^[0-9]+$ ]] && kill -0 -- "-$existing_pid" 2>/dev/null; then
    running_dataset="unknown"
    [[ -f "$DATASET_FILE" ]] && running_dataset="$(<"$DATASET_FILE")"
    if [[ "$running_dataset" != "unknown" && "$running_dataset" != "$database_choice" ]]; then
      fail "Print Farm Manager is already using $running_dataset data. Run ./restart.sh --$database_choice-data to switch."
    fi
    printf 'Print Farm Manager is already running (process group %s).\n' "$existing_pid"
    printf 'Dataset: %s data\n' "$running_dataset"
    printf 'Log: %s\n' "$LOG_FILE"
    [[ "$simulator_choice" == "yes" ]] && printf 'Virtual printer: http://localhost:7125\n'
    exit 0
  fi
  rm -f "$PID_FILE"
  rm -f "$DATASET_FILE"
fi

node - "$api_port" "$vite_port" <<'NODE' || fail "PORT $api_port or VITE_PORT $vite_port is already in use. Stop the conflicting service or choose alternate ports."
const net = require('net');
const ports = process.argv.slice(2).map(Number);

function checkPort(index) {
  if (index === ports.length) process.exit(0);
  const server = net.createServer();
  server.once('error', () => process.exit(1));
  server.listen({ host: '127.0.0.1', port: ports[index], exclusive: true }, () => {
    server.close(() => checkPort(index + 1));
  });
}

checkPort(0);
NODE

current_stamp="$({
  sha256sum "$PROJECT_DIR/package-lock.json" "$PROJECT_DIR/client/package-lock.json"
  node --version
  npm --version
} | sha256sum | cut -d ' ' -f 1)"

installed_stamp=""
if [[ -f "$DEPENDENCY_STAMP" ]]; then
  installed_stamp="$(<"$DEPENDENCY_STAMP")"
fi

if [[ ! -d "$PROJECT_DIR/node_modules" || ! -d "$PROJECT_DIR/client/node_modules" || "$current_stamp" != "$installed_stamp" ]]; then
  printf 'Installing locked server dependencies...\n'
  (cd "$PROJECT_DIR" && npm ci)
  printf 'Installing locked client dependencies...\n'
  (cd "$PROJECT_DIR" && npm ci --prefix client)
  printf '%s\n' "$current_stamp" > "$DEPENDENCY_STAMP"
fi

if [[ ! -f "$PROJECT_DIR/client/dist/index.html" ]]; then
  printf 'Building the initial client bundle required by the API server...\n'
  (cd "$PROJECT_DIR" && npm run build)
fi

{
  printf '\n[%s] Starting Linux development services\n' "$(date --iso-8601=seconds)"
} >> "$LOG_FILE"

cd "$PROJECT_DIR"
python3 -c 'import os; os.setsid(); os.execvp("npm", ["npm", "run", "dev"])' >> "$LOG_FILE" 2>&1 < /dev/null &
dev_pid=$!
printf '%s\n' "$dev_pid" > "$PID_FILE"
printf '%s\n' "$database_choice" > "$DATASET_FILE"

cleanup_interrupted_start() {
  kill -TERM -- "-$dev_pid" 2>/dev/null || kill -TERM "$dev_pid" 2>/dev/null || true
  rm -f "$PID_FILE" "$DATASET_FILE"
  exit 130
}
trap cleanup_interrupted_start INT TERM

ready=false
for _ in {1..60}; do
  if ! kill -0 "$dev_pid" 2>/dev/null; then
    break
  fi
  if node -e "Promise.all([fetch('http://127.0.0.1:$api_port/api/health'), fetch('http://127.0.0.1:$vite_port')]).then(rs => { if (rs.some(r => !r.ok)) process.exit(1) }).catch(() => process.exit(1))"; then
    ready=true
    break
  fi
  sleep 1
done

if [[ "$ready" != true ]]; then
  kill -TERM -- "-$dev_pid" 2>/dev/null || kill -TERM "$dev_pid" 2>/dev/null || true
  rm -f "$PID_FILE" "$DATASET_FILE"
  printf 'Development services did not become ready. Recent log output:\n' >&2
  tail -n 40 "$LOG_FILE" >&2 || true
  exit 1
fi

trap - INT TERM

printf 'Print Farm Manager development services are running.\n'
printf 'Dataset: %s data (%s-data.db)\n' "$database_choice" "$database_choice"
printf 'UI:  http://localhost:%s\nAPI: http://localhost:%s\nLog: %s\n' "$vite_port" "$api_port" "$LOG_FILE"
[[ "$simulator_choice" == "yes" ]] && printf 'Virtual printer: http://localhost:7125\nVirtual webcam: http://localhost:8110\n'
printf 'Stop them with: %s/stop.sh\n' "$PROJECT_DIR"
