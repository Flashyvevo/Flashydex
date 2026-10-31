#!/usr/bin/env bash
set -euo pipefail

if [[ -x "services/recognition/.venv/Scripts/python.exe" ]]; then
  python_bin="services/recognition/.venv/Scripts/python.exe"
elif [[ -x "services/recognition/.venv/bin/python" ]]; then
  python_bin="services/recognition/.venv/bin/python"
else
  echo "Recognition virtual environment is missing. Run bash scripts/setup.sh first." >&2
  exit 1
fi

"$python_bin" -m pytest services/recognition/tests
