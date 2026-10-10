#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PID_FILE="${LOCAL_I2V_PID:-$ROOT_DIR/local-i2v.pid}"

if [[ ! -f "$PID_FILE" ]]; then
  echo "local-i2v worker is not running"
  exit 0
fi

PID="$(cat "$PID_FILE")"
if kill -0 "$PID" 2>/dev/null; then
  kill "$PID"
  echo "stopped local-i2v worker: pid=$PID"
fi
rm -f "$PID_FILE"
