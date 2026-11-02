#!/usr/bin/env bash
# Run a Cloudflare quick tunnel to the local recognizer, record its URL, publish it (M2-D4).
# Single run: exits when cloudflared exits (the logon supervisor restarts it).
# Env: FLASHYDEX_RECOG_PORT (8900), CLOUDFLARED (path), FLASHYDEX_TUNNEL_PROTOCOL (default http2)
set -uo pipefail
cd "$(dirname "$0")/../.."
ROOT="$PWD"
LOGS="$ROOT/services/recognition/data/logs"
mkdir -p "$LOGS"
PORT="${FLASHYDEX_RECOG_PORT:-8900}"
CF="${CLOUDFLARED:-}"
if [[ -z "$CF" ]]; then
  for c in "/c/Program Files (x86)/cloudflared/cloudflared.exe" "/c/Program Files/cloudflared/cloudflared.exe" "$LOCALAPPDATA/cloudflared/cloudflared.exe"; do
    [[ -x "$c" ]] && CF="$c" && break
  done
  [[ -z "$CF" ]] && CF="$(command -v cloudflared || true)"
fi
[[ -z "$CF" ]] && { echo "$(date -Is) cloudflared not found" >> "$LOGS/tunnel.log"; exit 2; }

CFLOG="$LOGS/cloudflared.log"
: > "$CFLOG"
echo "$(date -Is) starting tunnel -> 127.0.0.1:$PORT ($CF)" >> "$LOGS/tunnel.log"
"$CF" tunnel --url "http://127.0.0.1:$PORT" --no-autoupdate --protocol "${FLASHYDEX_TUNNEL_PROTOCOL:-http2}" >> "$CFLOG" 2>&1 &
CFPID=$!
trap 'kill $CFPID 2>/dev/null; taskkill //PID $CFPID //F >/dev/null 2>&1' EXIT INT TERM

URL=""
for _ in $(seq 1 90); do
  URL="$(grep -o 'https://[a-z0-9-]*\.trycloudflare\.com' "$CFLOG" | head -1 || true)"
  [[ -n "$URL" ]] && break
  kill -0 $CFPID 2>/dev/null || { echo "$(date -Is) cloudflared exited early" >> "$LOGS/tunnel.log"; exit 1; }
  sleep 1
done
[[ -z "$URL" ]] && { echo "$(date -Is) no URL after 90s" >> "$LOGS/tunnel.log"; exit 1; }

echo "$URL" > "$LOGS/tunnel-url.txt"
echo "$(date -Is) tunnel url $URL" >> "$LOGS/tunnel.log"
for attempt in 1 2 3 4 5; do
  if "$ROOT/scripts/recognition/publish-url.sh" "$URL" >> "$LOGS/tunnel.log" 2>&1; then break; fi
  echo "$(date -Is) publish attempt $attempt failed" >> "$LOGS/tunnel.log"; sleep $((attempt*10))
done
wait $CFPID
echo "$(date -Is) cloudflared exited ($?)" >> "$LOGS/tunnel.log"
exit 1
