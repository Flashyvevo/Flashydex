# Catalog-pack distribution site — publish report (2026-10-31)

## Live
- Packs site: https://flashydex-catalog-packs.netlify.app (Netlify site id `b27dae26-5757-46dd-98fa-6da97ce50a0d`, team ElevatedPeak, created via CLI — it did not previously exist in either Netlify team).
- Manifest: https://flashydex-catalog-packs.netlify.app/catalog-manifest.json — version `2026.10.31.002`.
- EN `catalog-en-2026.10.31.002.db.zst`: 12,343,102 B zstd → 138,002,432 B raw; 220 sets / 23,736 cards / 36,693 variants / 48,805 prices (4 unpublished shells); sha256 raw `702fe2de…f41c1`, zstd `07e48def…8a914`.
- JA `catalog-ja-2026.10.31.002.db.zst`: 3,118,626 B zstd → 45,592,576 B raw; 184 sets / 12,781 cards / 15,781 variants / 10,127 prices (68 unpublished); sha256 raw `faf680a2…f44c50`, zstd `fd892f78…40cd3`.
- App env (site `flashydex`, Production + Deploy Preview, build scope): `FLASHYDEX_MANIFEST_URL`, `FLASHYDEX_TRUSTED_ORIGINS`. Rebuilt; live bundle resolves `manifestUrl()` to the packs manifest.

## Verified
- Local: schema validation, `verify-pack.ts` (raw+compressed sha/bytes, integrity_check ok, foreign_key_check 0, catalog_meta language/version/schema match, counts, 20 live TCGdex spot checks) — all pass.
- External (`scripts/netlify/verify-pack-site.sh`): manifest 200 JSON `no-cache` ACAO `*`; both packs 200 `application/zstd`, no Content-Encoding, `public,max-age=31536000,immutable`, Content-Length and sha256 == manifest; set indexes 200 immutable.
- Live PWA (headless Chromium, fresh profile, no interception): onboarding → EN install from the real packs site in ~10 s → 30 Umbreon rows → reload → Settings shows `Downloaded · v2026.10.31.002` → Charizard search OK. JA-only onboarding install + ピカチュウ search also OK.

## Known limitation (app side, pre-existing)
Installing JA *after* EN on the committed (jeep-sqlite / in-memory) web path fails at preflight with "couldn't be installed, current catalog unchanged" — no pack request is made, EN stays intact. This is the D24 web limited-mode behaviour that the in-progress Stage F (sqlite-wasm opfs-sahpool) work replaces; not a packs-site or manifest issue.

## Not configured
GitHub Actions secrets `NETLIFY_AUTH_TOKEN` / `NETLIFY_PACKS_SITE_ID` are still absent (no `gh` on this machine; cannot be set without the owner). The workflow is ready; add the secrets and run "Catalog packs" for CI-driven releases. Until then, the one-off local path in docs/DEPLOY-NETLIFY.md is what produced this deploy. `C:/Projects/flashydex-catalog-packs` is the generated deploy directory only.
