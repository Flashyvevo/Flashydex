#!/usr/bin/env bash
# Stage the current immutable catalog release for the dedicated Netlify packs site.
# Usage: bash scripts/netlify/prepare-pack-site.sh <catalog-builder-dist> <site-dir>
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

# Netlify serves the PWA separately. This small static site deliberately permits
# that origin to fetch the manifest and binary packs. Do not set Content-Encoding
# for .zst: it is already compressed and must not be double-compressed.
cat > "$site_dir/_headers" <<'HEADERS'
/catalog-manifest.json
  Access-Control-Allow-Origin: *
  Cache-Control: no-cache

/set-index-*.json
  Access-Control-Allow-Origin: *
  Cache-Control: public, max-age=31536000, immutable

/*.db.zst
  Access-Control-Allow-Origin: *
  Content-Type: application/zstd
  Cache-Control: public, max-age=31536000, immutable

/*.metrics.json
  Access-Control-Allow-Origin: *
  Cache-Control: public, max-age=31536000, immutable
HEADERS

test -f "$site_dir/_headers"
find "$site_dir" -maxdepth 1 -type f -printf '%f\n' | sort
