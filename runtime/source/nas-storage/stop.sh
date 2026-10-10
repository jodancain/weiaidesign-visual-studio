#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT_DIR"

if [[ ! -f video-storage.pid ]]; then
  echo "not running"
  exit 0
fi

pid="$(cat video-storage.pid)"
if kill -0 "$pid" 2>/dev/null; then
  kill "$pid"
  echo "stopped pid=$pid"
else
  echo "stale pid=$pid"
fi
rm -f video-storage.pid
