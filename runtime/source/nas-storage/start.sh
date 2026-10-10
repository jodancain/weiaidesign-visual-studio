#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT_DIR"

set -a
if [[ -f .env ]]; then
  . ./.env
fi
set +a

mkdir -p data logs

if [[ -f video-storage.pid ]] && kill -0 "$(cat video-storage.pid)" 2>/dev/null; then
  echo "already running pid=$(cat video-storage.pid)"
  exit 0
fi

nohup python3 server.py >> logs/server.log 2>&1 &
echo $! > video-storage.pid
echo "started pid=$(cat video-storage.pid)"
