#!/usr/bin/env bash
# Build/resume the recognition index. Usage: scripts/recognition/index-build.sh --lang en[,ja] [--limit N]
# Resumable: per-card image + feature cache under services/recognition/data/cache.
set -euo pipefail
cd "$(dirname "$0")/../.."
if [[ -x services/recognition/.venv/Scripts/python.exe ]]; then
  PY=services/recognition/.venv/Scripts/python.exe
else
  PY=services/recognition/.venv/bin/python
fi
cd services/recognition
exec "../../$PY" -m app.cli index build "$@"
