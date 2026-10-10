#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PORT="${LOCAL_I2V_PORT:-18085}"
HOST="${LOCAL_I2V_HOST:-0.0.0.0}"
PYTHON_BIN="${LOCAL_I2V_PYTHON:-}"
VENV="${LOCAL_I2V_VENV:-$ROOT_DIR/.venv}"
LOG_FILE="${LOCAL_I2V_LOG:-$ROOT_DIR/local-i2v.log}"
PID_FILE="${LOCAL_I2V_PID:-$ROOT_DIR/local-i2v.pid}"

if [[ -f "$PID_FILE" ]] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
  echo "local-i2v worker already running: pid=$(cat "$PID_FILE")"
  exit 0
fi

if [[ -z "$PYTHON_BIN" ]]; then
  if [[ -x "/home/studio-user/micromamba/envs/local-i2v/bin/python" ]]; then
    PYTHON_BIN="/home/studio-user/micromamba/envs/local-i2v/bin/python"
  else
    python3 -m venv "$VENV"
    "$VENV/bin/pip" install -r "$ROOT_DIR/requirements.txt"
    PYTHON_BIN="$VENV/bin/python"
  fi
fi

set -a
if [[ -f "$ROOT_DIR/.env" ]]; then
  source "$ROOT_DIR/.env"
fi
set +a

setsid nohup "$PYTHON_BIN" -m uvicorn app:app --host "$HOST" --port "$PORT" > "$LOG_FILE" 2>&1 < /dev/null &
echo $! > "$PID_FILE"
echo "local-i2v worker started: pid=$(cat "$PID_FILE") port=$PORT log=$LOG_FILE"
