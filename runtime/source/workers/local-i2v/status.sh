#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PORT="${LOCAL_I2V_PORT:-18085}"
PID_FILE="${LOCAL_I2V_PID:-$ROOT_DIR/local-i2v.pid}"

if [[ -f "$PID_FILE" ]] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
  echo "pid=$(cat "$PID_FILE")"
else
  echo "pid=stopped"
fi

curl -fsS "http://127.0.0.1:$PORT/health" || true
echo
