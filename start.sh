#!/usr/bin/env bash

set -Eeuo pipefail

PROJECT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
RUNTIME_DIR="$PROJECT_DIR/.run"
PID_FILE="$RUNTIME_DIR/dev.pid"
LOG_FILE="$RUNTIME_DIR/dev.log"
DEPENDENCY_STAMP="$RUNTIME_DIR/dependencies.sha256"

fail() {
  printf 'ERROR: %s\n' "$*" >&2
  exit 1
}

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
    printf 'Print Farm Manager is already running (process group %s).\n' "$existing_pid"
    printf 'Log: %s\n' "$LOG_FILE"
    exit 0
  fi
  rm -f "$PID_FILE"
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

cleanup_interrupted_start() {
  kill -TERM -- "-$dev_pid" 2>/dev/null || kill -TERM "$dev_pid" 2>/dev/null || true
  rm -f "$PID_FILE"
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
  rm -f "$PID_FILE"
  printf 'Development services did not become ready. Recent log output:\n' >&2
  tail -n 40 "$LOG_FILE" >&2 || true
  exit 1
fi

trap - INT TERM

printf 'Print Farm Manager development services are running.\n'
printf 'UI:  http://localhost:%s\nAPI: http://localhost:%s\nLog: %s\n' "$vite_port" "$api_port" "$LOG_FILE"
printf 'Stop them with: %s/stop.sh\n' "$PROJECT_DIR"
