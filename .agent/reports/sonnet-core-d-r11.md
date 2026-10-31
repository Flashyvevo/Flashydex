# R11 report: catalog builder frozen runs, immutable artifacts, workflow read-back

Gates (tools/catalog-builder): `npm test` -> 3 files, 24 tests passed; `npm run typecheck` -> clean (tsc --noEmit, no output).
Workflow YAML parses (PyYAML, 9 steps; read-back step present).

## Files changed
- NEW `src/run-guard.ts`: `RunBinding`, `hashSetIds`, `cacheConfigHash`, `assertResumeCompatible`, `commitImmutableArtifact`.
- NEW `src/verify-checks.ts`: `failedChecks()`.
- EDIT `src/cli.ts`, `src/http.ts`, `src/crawl.ts`, `src/verify-pack.ts`.
- EDIT `.github/workflows/catalog-packs.yml`.
- NEW `test/run-guard.test.ts`.

## Items
1. Frozen run binding: `run.json` stores set-selection hash, schema version, migration fingerprint, node version, builder package version, zstd lib id and API base. `--resume` throws (exit 1) listing each mismatched field. It also refuses legacy run.json with no binding. After the crawl, the resolved selected-set-id hash is stored, and resume refuses if it changed.
   Tests: "refuses resume when the set selection changed", "schema or toolchain mismatch", "legacy run metadata".
2. Immutable artifacts: `commitImmutableArtifact` no longer deletes the existing raw/zstd file first. No file -> rename (new version). Same sha256 and length -> no-op. Different bytes -> throws and leaves the existing file intact. Used for both the `.db` and the `.db.zst`. The sidecar check now looks at the `.part` file.
   Tests: new-version writes, identical rerun no-op, same-version drift throws and keeps the original.
3. verify-pack: `failedChecks()` flags any false `shaMatches`/`bytesMatch`/`countsMatch`, non-"ok" integrity, empty `liveChecks` or a failed live check. The script sets exit code 1 and prints the failing fields to stderr.
   Test: "verify-pack check gate".
4. Workflow: after upload and the name check, `gh release download` fetches the draft assets. Each file's length and sha256 is compared to the local build. The downloaded packs are cross-checked against the manifest `compressedBytes`/`compressedSha256`. Any mismatch fails the job before `gh release edit --draft=false`.
5. Cache and discovery:
   - Cache envelopes are keyed by URL plus a language+API-base config hash. A mismatch causes a refetch.
   - A new (non-resume) run always revalidates the set list and set shells (`discoveryMaxAgeMs: 0`). Card details still use the 24h cache. Resume keeps infinite age, but the run is now frozen and bound.
   Test: "does not reuse cache written under another config or url; maxAge 0 revalidates".

## Not done / limits (listed, not done)
- No end-to-end CLI test. It needs live TCGdex, so tests cover the guard functions, Fetcher and verify-checks, not `main()`.
- verify-pack still runs only in manual/CI-adjacent use; the workflow does not call it (it needs network to TCGdex). I did not wire it in.
- Card details are not revalidated on a new run (only the 24h age and URL/config checks apply). A conditional request or ETag would be needed, and the TCGdex ETag behavior is untested.
- Raw `.db` bytes embed `builtAt`. A fresh (non-resume) rebuild of the same version will therefore fail the drift check by design. Only `--resume` (frozen cutoff) can reproduce identical bytes.
- Read-back checks the local build against the draft assets. It does not independently verify the GitHub-reported asset digest.
- Cached card JSON from pre-R11 runs lacks the `config` field, so it is refetched once.
