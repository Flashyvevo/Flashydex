#!/usr/bin/env bash
# Serve the recognition API (default http://127.0.0.1:8900). Leave stopped when not in use.
#
# Env (all optional):
#   FLASHYDEX_RECOG_HOST             default 127.0.0.1 (non-loopback requires a token)
#   FLASHYDEX_RECOG_PORT             default 8900
#   FLASHYDEX_RECOG_TOKEN            shared bearer token; REQUIRED when exposed via a tunnel
#   FLASHYDEX_RECOG_ALLOWED_ORIGINS  comma list; default https://localhost:3200,https://127.0.0.1:3200,https://10.0.0.4:3200
#   FLASHYDEX_RECOG_DATA_DIR         default services/recognition/data (models/, index/<lang>/)
#   FLASHYDEX_RECOG_CATALOG_DIR      default .agent/metrics/packs (index build only)
#   FLASHYDEX_RECOG_ORT_THREADS      default 0 = all cores
#   FLASHYDEX_RECOG_LOG_LEVEL        default INFO
set -euo pipefail
cd "$(dirname "$0")/../.."
if [[ -x services/recognition/.venv/Scripts/python.exe ]]; then
  PY=services/recognition/.venv/Scripts/python.exe
else
  PY=services/recognition/.venv/bin/python
fi
cd services/recognition
exec "../../$PY" -m app.cli serve "$@"
