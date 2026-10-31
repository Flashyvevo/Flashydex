#!/usr/bin/env bash
# Stage the current immutable catalog release for the dedicated Netlify packs site.
# Usage: bash scripts/netlify/prepare-pack-site.sh <catalog-builder-dist> <site-dir>
#
# The site directory is a generated deploy artifact (CI, or a one-off local deploy), never
# a source repository: it holds only the stable manifest, the versioned packs it names,
# their set indexes/metrics, the Netlify `_headers` file and a tiny index page.
set -euo pipefail

source_dir="${1:?catalog-builder dist directory is required}"
site_dir="${2:?packs site directory is required}"

manifest="$source_dir/catalog-manifest.json"
test -f "$manifest"

rm -rf "$site_dir"
mkdir -p "$site_dir"
cp "$manifest" "$site_dir/catalog-manifest.json"
cp "$source_dir"/catalog-*.db.zst "$site_dir"/
cp "$source_dir"/catalog-*.metrics.json "$site_dir"/
cp "$source_dir"/set-index-*.json "$site_dir"/

# Every pack/index named in the manifest must be present in this deploy with the
# advertised compressed size (manifest + assets always roll forward/back together).
node -e '
  const fs = require("fs"), path = require("path");
  const dir = process.argv[1];
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, "catalog-manifest.json"), "utf8"));
  for (const [lang, entry] of Object.entries(manifest.languages)) {
    for (const url of [entry.fullPackUrl, entry.setIndexUrl].filter(Boolean)) {
      const name = url.split("/").pop();
      const file = path.join(dir, name);
      if (!fs.existsSync(file)) { console.error(`manifest ${lang} names ${name} but it is not staged`); process.exit(1); }
      if (name.endsWith(".db.zst") && fs.statSync(file).size !== entry.compressedBytes) { console.error(`${name}: staged size differs from manifest compressedBytes`); process.exit(1); }
    }
  }
' "$site_dir"

# Netlify serves the PWA separately. This small static site deliberately permits
# that origin to fetch the manifest and binary packs (public, unauthenticated,
# integrity is enforced client-side by SHA-256 + trusted-origin checks, so `*` is
# the correct CORS value). Do not set Content-Encoding for .zst: it is already
# compressed and must not be double-compressed. Exact per-file rules are emitted
# for every staged artifact, with wildcard rules as a fallback.
{
  cat <<'HEADERS'
/catalog-manifest.json
  Access-Control-Allow-Origin: *
  Access-Control-Allow-Methods: GET, HEAD, OPTIONS
  Content-Type: application/json; charset=utf-8
  Cache-Control: no-cache
  X-Content-Type-Options: nosniff

HEADERS
  for f in "$site_dir"/*.db.zst; do
    cat <<HEADERS
/$(basename "$f")
  Access-Control-Allow-Origin: *
  Access-Control-Allow-Methods: GET, HEAD, OPTIONS
  Content-Type: application/zstd
  Cache-Control: public, max-age=31536000, immutable
  X-Content-Type-Options: nosniff

HEADERS
  done
  for f in "$site_dir"/set-index-*.json "$site_dir"/*.metrics.json; do
    cat <<HEADERS
/$(basename "$f")
  Access-Control-Allow-Origin: *
  Access-Control-Allow-Methods: GET, HEAD, OPTIONS
  Content-Type: application/json; charset=utf-8
  Cache-Control: public, max-age=31536000, immutable
  X-Content-Type-Options: nosniff

HEADERS
  done
  cat <<'HEADERS'
/*.db.zst
  Access-Control-Allow-Origin: *
  Content-Type: application/zstd
  Cache-Control: public, max-age=31536000, immutable

/set-index-*.json
  Access-Control-Allow-Origin: *
  Cache-Control: public, max-age=31536000, immutable

/*.metrics.json
  Access-Control-Allow-Origin: *
  Cache-Control: public, max-age=31536000, immutable
HEADERS
} > "$site_dir/_headers"

cat > "$site_dir/index.html" <<'HTML'
<!doctype html>
<meta charset="utf-8">
<title>FlashyDex catalog packs</title>
<p>Static catalog pack distribution for FlashyDex. Clients start at <a href="/catalog-manifest.json">/catalog-manifest.json</a>.</p>
HTML

test -f "$site_dir/_headers"
find "$site_dir" -maxdepth 1 -type f -printf '%f\n' | sort
