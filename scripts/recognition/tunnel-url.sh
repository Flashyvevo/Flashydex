#!/usr/bin/env bash
# Print the current quick-tunnel URL.
f="$(dirname "$0")/../../services/recognition/data/logs/tunnel-url.txt"
[[ -s "$f" ]] && cat "$f" || { echo "no tunnel url yet (is the tunnel running?)" >&2; exit 1; }
