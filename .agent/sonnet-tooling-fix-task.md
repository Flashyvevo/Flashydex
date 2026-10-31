Project root: C:/Projects/flashydex (cd there first). Product name FlashyDex / `flashydex`. Read `BRIEF.md` (Agent rules), `docs/CATALOG-PACKS.md` (builder pipeline, publish step 7, Director notes at the end), `.agent/DIRECTOR-DECISIONS.md` (D18, D20, D27), `.agent/reports/sonnet-tooling-report.md` (the previous run's report — it ran out of budget before these items), `.agent/research/compression-libs.md`, `tools/catalog-builder/package.json` + `src/cli.ts` (the real CLI flags).

## Your role: Claude Sonnet — `sonnet-tooling-fix` (small, ~15 min). Two other builders are editing `packages/**` and `apps/mobile/**` right now — do NOT touch those.

## Your files (ownership) — nothing else
- `.github/workflows/catalog-packs.yml` (new), `.github/workflows/ci.yml`
- `scripts/ios-notes.md`
- `README.md`
- `.agent/reports/sonnet-tooling-fix-report.md`

## Do
1. `.github/workflows/catalog-packs.yml`: `workflow_dispatch` (inputs: languages default `en,ja`, optional sets) + weekly `schedule` cron; Node 22 + `npm ci`; build EN and JA packs with the real CLI flags (`npm run catalog:build -- --lang <l> --version <YYYY.MM.DD.NNN computed from date + run number>` — check `cli.ts` for flags), cache `tools/catalog-builder/.cache` with actions/cache; upload metrics JSON as an artifact (always); create a GitHub Release tagged `catalog-vYYYY.MM.DD` (draft first, upload `.db.zst`, `set-index-*.json`, `catalog-manifest.json` with https `fullPackUrl`/`setIndexUrl` pointing at the release asset URLs, then publish) using `gh release` with `GITHUB_TOKEN` and `permissions: contents: write`. Don't run it. Validate: parse both YAML files with node (`node --input-type=module -e "import('yaml')..."` is fine if `yaml` is installed; else `npx --yes js-yaml <file>`), and paste the output.
2. `ci.yml`: on push/PR run `npm ci`, `npm run typecheck`, `npm run lint`, `npm test` (Python step for `services/recognition` only if it already exists in the file), `npm run build`. Keep it valid YAML.
3. `scripts/ios-notes.md`: rewrite as the Mac verification checklist: `npm run build && npx cap sync ios && npx cap open ios`; signing; `pod install`; SQLCipher is linked by `@capacitor-community/sqlite` (export-compliance note: answer the encryption question accordingly, ITSAppUsesNonExemptEncryption=false currently set — flag for owner review); verify catalog DBs land in `Library/NoCloud` (or Caches) with `isExcludedFromBackup=true` and `flashydex-user.db` is NOT excluded (how: Xcode → Devices → Download Container, or `xattr`/`FileManager` resourceValues in a debug log); verify `createNCConnection` opens an externally written catalog; atomic same-volume rename; force-kill during install leaves the previous catalog usable; free-space preflight is skipped on native (needs a plugin). Android equivalents (`noBackupFilesDir`, `data_extraction_rules.xml`).
4. README: short accurate dev quick-start (npm install, `npm run dev` → http://<lan-ip>:3200, `npm run catalog:build -- --lang en --sets swsh3`, `npm run catalog:dev-pack`, tests, e2e), no stale product names.

## Don't
NEVER call capture_screenshot or view images. No browser needed. Don't start any server, don't run `npm run build`/e2e (a dev server is in use by other agents). Don't commit. Don't edit anything outside your ownership.

## Report
`.agent/reports/sonnet-tooling-fix-report.md` (files changed, YAML validation output, open questions). Print it as your final answer.
