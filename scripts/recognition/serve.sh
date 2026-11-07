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
# The ignored local .env is the persistent source of tunnel credentials.  Do
# not echo it: the recognition service intentionally never logs the token.
if [[ -f services/recognition/.env ]]; then
  # New installs keep the token as a single raw hex line so it can be generated
  # without ever echoing a secret into a shell transcript.  Key/value .env files
  # remain supported for backwards compatibility.
  if grep -q '=' services/recognition/.env; then
    set -a
    # shellcheck disable=SC1091
    source services/recognition/.env
    set +a
  else
    export FLASHYDEX_RECOG_TOKEN="$(tr -d '\r\n' < services/recognition/.env)"
  fi
fi
export FLASHYDEX_RECOG_ALLOWED_ORIGINS="${FLASHYDEX_RECOG_ALLOWED_ORIGINS:-https://flashydex.netlify.app}"
if [[ -x services/recognition/.venv/Scripts/python.exe ]]; then
  PY=services/recognition/.venv/Scripts/python.exe
else
  PY=services/recognition/.venv/bin/python
fi
cd services/recognition
exec "../../$PY" -m app.cli serve "$@"
