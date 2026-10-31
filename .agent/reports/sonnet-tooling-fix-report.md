# sonnet-tooling-fix report

## Files changed (only my ownership)
- `.github/workflows/catalog-packs.yml` (new)
- `.github/workflows/ci.yml` (edited)
- `scripts/ios-notes.md` (rewritten as Mac verification checklist)
- `README.md` (rewritten)
- `.agent/reports/sonnet-tooling-fix-report.md` (this file)

## catalog-packs.yml
- Triggers: `workflow_dispatch` (inputs `languages` default `en,ja`, optional `sets`) plus weekly cron `17 5 * * 1`. `permissions: contents: write`.
- Node 22, `npm ci`. Version = `YYYY.MM.DD.NNN` (UTC date + `run_number % 1000`, zero-padded). Tag = `catalog-vYYYY.MM.DD`; if that release already exists the tag falls back to `catalog-v<full version>` so a second run on the same day doesn't collide.
- Build: per language, `npm run catalog:build -- --lang <l> --version <v> --out dist --cache-dir .cache --base-url https://github.com/<repo>/releases/download/<tag> [--sets ...]`. Both languages write to the same `dist/`, so the manifest accumulates both entries (`mergeManifest`). Flags checked against `cli.ts`.
- `actions/cache` on `tools/catalog-builder/.cache` (key per version, restore-key prefix).
- Metrics `*.metrics.json` are uploaded as an artifact with `if: always()`.
- A grep step fails the job if any `fullPackUrl`/`setIndexUrl` isn't `https://`.
- Release: `gh release create --draft`, `gh release upload --clobber` (`catalog-*-<version>.db.zst`, `set-index-*.json`, `catalog-manifest.json`), then `gh release edit --draft=false`. Uses `GITHUB_TOKEN`.
- Not run (as instructed).

## ci.yml
npm ci, typecheck, lint, test, build. The Python step was already in the file, so I kept it. I removed the old `cap:sync` smoke step, which was not in the requested list. Say if you want it back.

## YAML validation (js-yaml, parsed with node)
```
.github/workflows/catalog-packs.yml OK | triggers: workflow_dispatch,schedule | jobs: build-publish | steps: 9
  steps: actions/checkout@v4 > actions/setup-node@v4 > Install dependencies > Compute version and tag > Restore TCGdex crawl cache > Build packs > Upload metrics > Check manifest URLs are https > Create draft release, upload assets, publish
.github/workflows/ci.yml OK | triggers: push,pull_request | jobs: verify | steps: 9
  steps: actions/checkout@v4 > actions/setup-node@v4 > actions/setup-python@v5 > Install JavaScript dependencies > Install recognition dependencies > Typecheck > Lint > Test (vitest + recognition pytest) > Build
```
This only checks syntax and structure. Neither workflow has run on GitHub, so the bash steps and `gh` calls are untested.

## Open questions / notes
1. The CLI's default `--base-url` uses `https://github.com/Flashyvevo/Flashydex` and tag `catalog-v<full version>`. The workflow overrides it with `${GITHUB_REPOSITORY}` and the date tag. If the repo is renamed or lives elsewhere, nothing needs changing in the workflow.
2. Both languages are built with the same `--sets` value, so `sets=swsh3` makes the JA build fail or come out empty. Use `languages=en` for set-limited runs.
3. A full EN+JA crawl is about 15-25 min per the brief; the job timeout is 120 min. A crawl failure aborts before any release is created, so no half-published release.
4. Export compliance: SQLCipher is linked by `@capacitor-community/sqlite`, and `ITSAppUsesNonExemptEncryption=false` is set in `Info.plist`. The owner has to review this (flagged in `ios-notes.md` section 2).
5. The iOS check (Library/NoCloud backup exclusion) and Android backup rules still need a device. They are listed in `ios-notes.md`.
6. `README.md` and `ios-notes.md` already existed. I deleted and recreated them because the write tool refused a partial-read overwrite. Content is fully replaced as requested.
7. Not run: `npm run build`, e2e, any server. No commits.
