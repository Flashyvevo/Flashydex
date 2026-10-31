#!/usr/bin/env bash
# Verify a deployed catalog-pack site from the outside, the way the PWA sees it.
# Usage: bash scripts/netlify/verify-pack-site.sh <packs-origin> <local-catalog-manifest.json> [app-origin]
#
# Checks: manifest 200 + JSON + no-cache + CORS; every fullPackUrl/setIndexUrl in the manifest
# returns 200 with Access-Control-Allow-Origin, no Content-Encoding (packs are already zstd),
# application/zstd MIME, immutable caching, Content-Length == compressedBytes, and the downloaded
# bytes hash to compressedSha256. Exit 1 on the first failure.
set -euo pipefail

origin="${1:?packs origin is required, e.g. https://flashydex-catalog-packs.netlify.app}"
manifest="${2:?local catalog-manifest.json is required}"
app_origin="${3:-https://flashydex.netlify.app}"
origin="${origin%/}"

# Native-path temp dir: on git-bash/MSYS a bare /tmp/... from mktemp is not openable by native curl/node.
work="${LOCALAPPDATA:+$LOCALAPPDATA/Temp/}verify-pack-site.$$"
[ -n "${LOCALAPPDATA:-}" ] || work="$(mktemp -d)"
mkdir -p "$work"
trap 'rm -rf "$work"' EXIT

fail() { echo "FAIL: $*" >&2; exit 1; }
header() { tr -d '\r' < "$1" | awk -v k="$2" 'BEGIN{IGNORECASE=1} tolower($1)==tolower(k)":" {sub(/^[^:]*:[ \t]*/, ""); v=$0} END{print v}'; }

echo "== manifest"
curl --fail --show-error --silent --location -H "Origin: $app_origin" -D "$work/m.h" "$origin/catalog-manifest.json" -o "$work/m.json"
node -e 'JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"))' "$work/m.json" || fail "manifest is not JSON"
[ "$(header "$work/m.h" access-control-allow-origin)" = "*" ] || fail "manifest ACAO is not *"
case "$(header "$work/m.h" cache-control)" in *no-cache*) ;; *) fail "manifest Cache-Control is not no-cache" ;; esac
cmp "$manifest" "$work/m.json" || fail "deployed manifest differs from local manifest"
echo "manifest OK: $(header "$work/m.h" content-type); $(header "$work/m.h" cache-control)"

# CORS preflight (Fetch does not preflight a plain GET, but be explicit).
curl --silent --show-error -X OPTIONS -H "Origin: $app_origin" -H "Access-Control-Request-Method: GET" -D "$work/o.h" -o /dev/null "$origin/catalog-manifest.json" || true
echo "preflight: $(tr -d '\r' < "$work/o.h" | head -1); ACAO=$(header "$work/o.h" access-control-allow-origin)"

node -e '
  const m = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
  for (const [lang, e] of Object.entries(m.languages)) {
    console.log([lang, "pack", e.fullPackUrl, e.compressedBytes, e.compressedSha256 ?? ""].join("\t"));
    if (e.setIndexUrl) console.log([lang, "index", e.setIndexUrl, "", ""].join("\t"));
  }
' "$manifest" | while IFS=$'\t' read -r lang kind url bytes sha; do
  echo "== $lang $kind $url"
  case "$url" in "$origin"/*) ;; *) fail "$url is not on $origin" ;; esac
  if [ "$kind" = pack ]; then
    # Packs are fetched with an explicit Accept-Encoding so a misconfigured host that re-encodes them is caught.
    curl --fail --show-error --silent -H "Origin: $app_origin" -H "Accept-Encoding: gzip, br, zstd" -D "$work/a.h" "$url" -o "$work/a.bin"
  else
    curl --fail --show-error --silent --compressed -H "Origin: $app_origin" -D "$work/a.h" "$url" -o "$work/a.bin"
  fi
  [ "$(header "$work/a.h" access-control-allow-origin)" = "*" ] || fail "$url ACAO is not *"
  case "$(header "$work/a.h" cache-control)" in *immutable*) ;; *) fail "$url Cache-Control is not immutable" ;; esac
  if [ "$kind" = pack ]; then
    [ -z "$(header "$work/a.h" content-encoding)" ] || fail "$url has Content-Encoding $(header "$work/a.h" content-encoding) (must be served raw)"
    case "$(header "$work/a.h" content-type)" in application/zstd*) ;; *) fail "$url Content-Type is $(header "$work/a.h" content-type), expected application/zstd" ;; esac
    actual="$(stat -c %s "$work/a.bin")"
    [ "$actual" = "$bytes" ] || fail "$url downloaded $actual bytes, manifest says $bytes"
    cl="$(header "$work/a.h" content-length)"
    [ -z "$cl" ] || [ "$cl" = "$bytes" ] || fail "$url Content-Length $cl != $bytes"
    actual_sha="$(sha256sum "$work/a.bin" | cut -d' ' -f1 | tr -d '\\')"
    [ -z "$sha" ] || [ "$actual_sha" = "$sha" ] || fail "$url sha256 $actual_sha != manifest compressedSha256 $sha"
    echo "pack OK: $actual bytes, sha256 $actual_sha, $(header "$work/a.h" content-type), $(header "$work/a.h" cache-control)"
  else
    node -e 'JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"))' "$work/a.bin" || fail "$url is not JSON"
    echo "index OK: $(stat -c %s "$work/a.bin") bytes, $(header "$work/a.h" cache-control)"
  fi
done

echo "PACK SITE VERIFIED: $origin"
