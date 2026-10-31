# Terra — Netlify deployment and catalog pack hosting report

Date: 2026-10-31

## Delivered

- `netlify.toml`: root build configuration, Node 22, mobile-only build command, `apps/mobile/dist` publish directory, and explicit production/deploy-preview contexts.
- `apps/mobile/public/_headers`: immutable caching for hashed Vite JS/CSS/font assets; no-cache app shell/service-worker/manifest; explicit `application/wasm`; commented COOP/COEP block with the VFS rule.
- `apps/mobile/public/_redirects`: `/* /index.html 200` SPA fallback.
- `.github/workflows/catalog-packs.yml`: builds manifest URLs for a dedicated Netlify packs origin, retains GitHub Releases as immutable archives, stages a packs-only directory, deploys it with `NETLIFY_AUTH_TOKEN` and `NETLIFY_PACKS_SITE_ID`, then byte-compares the deployed stable manifest to the generated one.
- `scripts/netlify/prepare-pack-site.sh`: constructs the packs-only deploy directory and its CORS/MIME/cache headers. `.zst` has `Content-Type: application/zstd` and intentionally no `Content-Encoding`.
- `docs/DEPLOY-NETLIFY.md` and `README.md`: owner setup, exact values, previews, rollback, CLI and PWA install instructions.

No `.github/workflows/ios-*.yml` files existed, so there was nothing to constrain to `workflow_dispatch`.

## Hosting decision

Chosen: dedicated Netlify static packs site, `https://flashydex-catalog-packs.netlify.app`.

Production value (exact):

```text
FLASHYDEX_MANIFEST_URL=https://flashydex-catalog-packs.netlify.app/catalog-manifest.json
```

GitHub Releases were tested as a browser asset host with:

```text
curl -L -I -H 'Origin: https://example.netlify.app' https://github.com/cli/cli/releases/download/v2.83.2/gh_2.83.2_checksums.txt
```

Observed chain: GitHub returned `302` to `release-assets.githubusercontent.com`; the final Azure Blob response was `200`, `Content-Type: application/octet-stream`, and did not return `Access-Control-Allow-Origin`. That fails the CORS requirement for a PWA fetch, so GitHub Releases are kept only as the immutable archive.

Netlify free-tier planning input requested: 100 GB/month ÷ 12.3 MB per EN install = 8,130.08 decimal installs/month, or 8,130 whole EN-pack installs/month before any other bandwidth. This excludes app-shell traffic, retries, preview bandwidth, JA packs, and CDN overhead; production monitoring must reserve headroom. Netlify Blobs/R2 remain later options once observed usage justifies object storage.

The pack deploy uses the root fixed URL as the stable manifest URL. Each deploy contains that manifest and the versioned pack URLs named inside it, so the manifest and assets roll forward/back together. GitHub Release artifacts preserve independent immutable historical copies.

## Core trusted-origin request

The mobile/core manifest URL and full-pack URL validators must allow exactly:

```text
https://flashydex-catalog-packs.netlify.app
```

Do not add GitHub release or redirect origins to the runtime allowlist for this deployed PWA path. The workflow now emits Netlify pack URLs. If the owner changes the packs subdomain/custom domain, update `PACKS_ORIGIN`, `FLASHYDEX_MANIFEST_URL`, and this allowlist together before publishing packs.

## Verification completed

- Read binding BRIEF, architecture, catalog-pack, device-storage, and compression/storage documents.
- Read current Netlify docs and GitHub Actions workflow-syntax docs; references are cited in `docs/DEPLOY-NETLIFY.md`.
- `bash -n scripts/netlify/prepare-pack-site.sh` passed.
- `npx --yes yaml-lint@1.7.0 .github/workflows/catalog-packs.yml` passed.
- `npx --yes prettier@3.5.3 --parser yaml --check .github/workflows/catalog-packs.yml` passed.
- `bash scripts/netlify/prepare-pack-site.sh apps/mobile/public/dev-packs .netlify-packs-validation` produced the manifest, EN/JA packs, indexes, metrics, and `_headers` with the expected `application/zstd` rule.
- `FLASHYDEX_MANIFEST_URL=https://flashydex-catalog-packs.netlify.app/catalog-manifest.json npm run build --workspace=@flashydex/mobile` passed. Vite built 2,582 modules; it emitted `dist/_headers`, `dist/_redirects`, `index.html`, `sw.js`, and `manifest.webmanifest`.
- Served `apps/mobile/dist` with `npx serve -s ... -l 3212`. `/cards/en/swsh3-136` returned the index shell with HTTP 200, confirming the SPA fallback. `/assets/sql-wasm.wasm` returned `Content-Type: application/wasm` from the local server.

Local server limits: `serve` verified static output, SPA fallback, and its own WASM MIME behavior. It does not apply Netlify `_headers`, so Netlify cache directives, final CORS response headers, and the packs site's forced `.zst` MIME/no-Content-Encoding behavior remain deploy-time checks.

## Owner actions / unverified until first deploy

1. Create/import the application site from `Flashyvevo/Flashydex`; set the exact `FLASHYDEX_MANIFEST_URL` value for Production and Deploy Previews.
2. Create the separate blank Netlify site named `flashydex-catalog-packs`; record its site ID.
3. Add Actions secrets `NETLIFY_AUTH_TOKEN` and `NETLIFY_PACKS_SITE_ID`.
4. Run the Catalog packs workflow, then verify with browser/curl that the packs site returns the manifest, an EN `.db.zst` with `Content-Type: application/zstd`, no `Content-Encoding`, `Access-Control-Allow-Origin: *`, and a byte-identical manifest.
5. Confirm the app's production and PR-preview Netlify builds receive the public env value; verify PWA install/service worker on actual iOS Safari and Android Chrome.

Unverified because no Netlify account/site/secrets were available: Netlify build/deploy execution, final Netlify header behavior, deploy-preview runtime environment, pack workflow deploy, production CORS/MIME/cache responses, bandwidth metering, and mobile PWA installation.

Cleanup note: the local `serve` child is still listening on port 3212 (PID 21996). Its tracked parent exited and this unattended environment blocked the forceful Windows process termination required to stop the orphan. It serves only the built local `apps/mobile/dist`; terminate PID 21996 with an approved `taskkill /PID 21996 /F` if immediate cleanup is required.
