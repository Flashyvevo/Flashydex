#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

npm ci

venv_dir="services/recognition/.venv"
if command -v py >/dev/null 2>&1; then
  py -3.12 -m venv "$venv_dir"
elif command -v python3.12 >/dev/null 2>&1; then
  python3.12 -m venv "$venv_dir"
else
  echo "Python 3.12 was not found. Install it, then rerun this script." >&2
  exit 1
fi

if [[ -x "$venv_dir/Scripts/python.exe" ]]; then
  python_bin="$venv_dir/Scripts/python.exe"
else
  python_bin="$venv_dir/bin/python"
fi
"$python_bin" -m pip install --upgrade pip
"$python_bin" -m pip install -e "services/recognition[dev]"

echo
printf 'Phone URL(s):\n'
bash scripts/lan-url.sh
