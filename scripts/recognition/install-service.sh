#!/usr/bin/env bash
# Install (default) or remove (--uninstall) logon auto-start for recognizer + tunnel.
set -euo pipefail
cd "$(dirname "$0")"
d="$(pwd -W)"
if [[ "${1:-}" == "--uninstall" ]]; then f=uninstall-service.ps1; else f=install-service.ps1; fi
[[ "${1:-}" == "--install" || "${1:-}" == "--uninstall" ]] && shift
exec powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$d/$f" "$@"
