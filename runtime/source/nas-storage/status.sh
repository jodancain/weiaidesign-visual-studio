#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT_DIR"

if [[ -f video-storage.pid ]] && kill -0 "$(cat video-storage.pid)" 2>/dev/null; then
  echo "running pid=$(cat video-storage.pid)"
else
  echo "not running"
fi

du -sh data data/media 2>/dev/null || true
tail -20 logs/server.log 2>/dev/null || true
