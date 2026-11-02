#!/usr/bin/env bash
# Publish recognizer.json (PWA runtime discovery, M2-D4) to the flashydex-recognizer Netlify site.
# Usage: publish-url.sh [url]   (default: tunnel-url.txt). Skips deploy when the URL is unchanged.
# Runs netlify from OUTSIDE the monorepo (workspace prompt crash).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
CONF="${FLASHYDEX_RECOG_CONFIG_DIR:-C:/Projects/flashydex-recognizer-config}"
URL="${1:-$(cat "$ROOT/services/recognition/data/logs/tunnel-url.txt")}"
SITE="$(tr -d '\r\n ' < "$CONF/site-id.txt")"
export PATH="$PATH:$APPDATA/npm:/c/Program Files/nodejs"
cd "$CONF"
if [[ -f .published ]] && [[ "$(tr -d '\r\n' < .published)" == "$URL" ]]; then
  echo "publish-url: unchanged ($URL), skipping"; exit 0
fi
printf '{"version":1,"url":"%s","updatedAt":"%s","kind":"quick-tunnel"}\n' "$URL" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > recognizer.json
netlify deploy --prod --dir . --site "$SITE" --message "tunnel url"
echo "$URL" > .published
echo "publish-url: published $URL"
