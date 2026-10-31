# FlashyDex — Next Milestone: Production Web Storage + Photo Card Recognition

Project repository:

https://github.com/Flashyvevo/Flashydex

The live FlashyDex PWA is currently deployed and working at:

https://flashydex.netlify.app

The production catalog-pack site is working at:

https://flashydex-catalog-packs.netlify.app

The live application successfully downloads and installs the real production catalog.

Do NOT redesign or replace the current Netlify/catalog-pack architecture unless you find an actual reproducible defect.

## CURRENT VERIFIED STATE

The production catalog pipeline is working.

Production catalog version:

2026.10.31.002

English:
- approximately 23,736 cards
- 220 sets
- compressed production pack working

Japanese:
- approximately 12,781 cards
- 184 sets
- compressed production pack working

GitHub repository secrets are now configured:

- NETLIFY_AUTH_TOKEN
- NETLIFY_PACKS_SITE_ID

The live PWA can install the catalog successfully.

Treat this infrastructure as stable.

## PRIMARY GOAL

The next user-visible milestone is:

Take a photo of a Pokémon card on an iPhone
→ FlashyDex uploads/processes the image
→ recognition returns the exact card or top candidates
→ user confirms the result
→ user selects variant/condition if necessary
→ card is added to their collection
→ user can immediately scan/add another card

This workflow is now the highest priority.

Do not spend time polishing unrelated functionality until this works reliably.

---

# STAGE 1 — FINISH PRODUCTION WEB STORAGE

Finish the production browser-storage migration already designed in:

docs/WEB-STORAGE.md

The web/PWA version must use the current SQLite WASM + OPFS architecture rather than relying on the old memory-heavy jeep-sqlite path.

Requirements:

- @sqlite.org/sqlite-wasm
- Web Worker database access
- OPFS / opfs-sahpool where supported
- user DB remains separate from catalog DBs
- EN and JA catalogs can coexist
- catalog data is file-backed rather than loaded entirely into JS heap
- catalog install is streamed
- atomic activation remains intact
- corrupted/interrupted installs never destroy an existing catalog
- existing jeep-sqlite user collections migrate once to OPFS
- user collection survives reload/browser restart
- storage.persist() requested where supported
- meaningful UI if persistent storage is unavailable
- service-worker image cache remains bounded
- no entire catalog pack is buffered in JS memory

Do not regress the working production catalog flow.

Test using the real EN and JA production-size packs.

Measure:

- EN install time
- JA install time
- EN+JA installed storage usage
- JS heap before/after install where measurable
- startup time
- search p50/p95
- reload persistence

Safari/iPhone-specific checks that cannot be automated should be listed clearly for the owner.

---

# STAGE 2 — COMPLETE RECOGNITION SERVICE

A Phase 2 recognition service has already been started.

Inspect existing work before changing it.

Read:

- docs/RECOGNITION-DESIGN.md
- services/recognition/**
- .agent/reports/sonnet-recog-service-report.md
- .agent/research/pokeum-notes.md
- relevant Sol reviews
- THIRD_PARTY_NOTICES.md

Do not rebuild the recognition architecture from scratch if the current implementation is sound.

Expected pipeline:

photo
→ card detection
→ perspective correction
→ normalized crop
→ perceptual hash
→ DINOv2 embedding
→ OCR collector number
→ optional symbol/variant signals
→ weighted candidate fusion
→ confidence
→ exact match OR top candidates

Current intended model:

onnx-community/dinov2-small

CPU-only ONNX inference.

Expected identify contract:

POST /v1/identify

Input:
- multipart image
- language hint: en | ja | any
- max candidates

Output equivalent to:

{
  status,
  confidence,
  candidates,
  timingMs,
  indexVersion
}

Candidate includes:

- language
- cardId
- localId
- name
- setId
- setName
- imageUrl
- score
- individual signal scores
- variant hints

Never automatically select a low-confidence result.

---

# STAGE 3 — FINISH THE FULL RECOGNITION INDEX

Inspect the current EN index-build state.

Resume rather than restarting when possible.

Target:

English recognition index:
- all eligible cards with reference images
- TCG Pocket excluded unless architecture says otherwise
- float16 embeddings
- pHash index
- card ID mapping
- manifest with hashes/counts/model/index version

Then build Japanese.

Index building must remain resumable.

Do not redownload/recompute finished cards unnecessarily.

Record:

- total cards indexed
- cards skipped because no reference image
- build duration
- index size
- model size
- disk usage
- peak memory
- average indexing throughput

After building, test against reference images and transformed/degraded images.

---

# STAGE 4 — RUN RECOGNITION SERVICE ON THE OWNER'S PC

For initial production testing, the recognition service runs on the Windows development PC.

Use port:

8900

The service must:

- bind locally by default
- use configured CORS origins
- enforce request-size limits
- enforce rate limiting
- avoid logging uploaded image contents
- support JPEG/PNG/WebP
- provide a useful error for unsupported HEIC until HEIC support exists
- expose health/index status
- load indexes once at startup

Do not expose port 8900 directly to the internet.

---

# STAGE 5 — CLOUDFLARE TUNNEL

Expose the recognition service using a Cloudflare Tunnel.

Goal:

FlashyDex Netlify PWA
→ HTTPS recognition endpoint
→ Cloudflare Tunnel
→ owner's PC :8900

Prefer a stable named tunnel rather than a temporary random trycloudflare URL if feasible without requiring additional paid infrastructure.

Document setup.

The recognizer must only accept requests from allowed FlashyDex origins.

IMPORTANT SECURITY CHANGE:

Do NOT put a permanent shared bearer secret inside the public Vite bundle.

Anything shipped to the browser is public.

If the current design expects FLASHYDEX_RECOG_TOKEN to be bundled client-side, replace that approach.

For the initial testing architecture, use an appropriate combination of:

- strict CORS
- Cloudflare rate limiting / access controls where practical
- short-lived server-issued authorization if a backend/auth layer becomes available
- abuse limits in the recognition service

Do not pretend a static Vite environment variable is secret.

Keep the architecture upgradeable for authenticated FlashyDex accounts later.

---

# STAGE 6 — PHOTO UI IN FLASHYDEX

Add photo recognition as a first-class part of Add.

The Add screen should prominently show:

[ Take Photo ]

[ Choose Photo ]

[ Search Manually ]

[ Browse by Set ]

On iPhone/PWA:

Take Photo should invoke the camera naturally through supported browser capabilities.

Choose Photo should use the normal file/photo picker.

Compress/resize unnecessarily huge photos client-side before upload while preserving enough detail for recognition.

Do not upload an 8–15 MB original iPhone photo when a much smaller normalized image gives equivalent recognition accuracy.

Respect EXIF orientation.

If HEIC is returned by an iPhone and the recognition service cannot yet accept it:

- convert HEIC client-side if reliable
OR
- add HEIC support server-side

Do not leave iPhone users with a cryptic unsupported-file error.

---

# STAGE 7 — RECOGNITION UX

After a photo is submitted:

Show:

Analyzing card…

Then one of three flows.

## High confidence

Show the likely card prominently.

Example:

Charizard ex

Obsidian Flames
223/197

[ Confirm & Add ]

[ Wrong card ]

Do not silently add without confirmation during initial release.

## Medium confidence

Show up to three candidates with large card artwork.

Example:

We found a few possibilities

1. Charizard ex — 223/197 — 92%
2. Charizard ex — 125/197 — 81%
3. Charizard — 215/197 — 68%

Tap a card to continue.

## Low/no confidence

Show:

We couldn't confidently identify this card.

Actions:

[ Try another photo ]

[ Search manually ]

[ Browse by set ]

Never trap the user.

---

# STAGE 8 — CONFIRMATION SHEET

After identification, reuse the existing Add/Confirm collection flow rather than creating a second collection mutation path.

User can confirm:

- exact card
- language
- variant
- condition
- quantity
- purchase price if desired
- storage location if desired
- grade if relevant

Recognition may suggest variant hints but must not confidently invent foil/stamp/edition state.

Then:

Add to Collection

After adding:

Added <card name>

Actions:

[ Scan Another ]

[ View Card ]

The default action should make rapid repeated scanning easy.

---

# STAGE 9 — REAL-PHOTO CALIBRATION SUPPORT

Create a calibration/evaluation folder structure for owner-provided card photos.

Suggested:

services/recognition/data/eval/

Naming convention when known:

en__swsh3-136__01.jpg

ja__<card-id>__01.jpg

But support an accompanying manifest so filenames do not have to encode everything.

Evaluation manifest should support:

- expected language
- expected card ID
- lighting category
- sleeve yes/no
- holo/reverse
- angle
- notes

Build a command such as:

python -m app.cli eval services/recognition/data/eval

Report:

- top-1 accuracy
- top-3 accuracy
- false confident matches
- no-match rate
- average latency
- p95 latency
- confidence distribution

Thresholds must be calibrated using real phone photos rather than reference images alone.

Especially minimize FALSE HIGH-CONFIDENCE matches.

It is better to show three candidates than confidently identify the wrong card.

---

# STAGE 10 — PERFORMANCE TARGETS

Initial targets, not excuses to fake results:

Photo upload/prepare:
preferably < 1 second on ordinary Wi-Fi

Recognition:
target < 1 second on the owner's PC at idle if realistically achievable

Total user-perceived result:
target roughly 1–2 seconds

If slower, measure and report actual timings.

Do not claim numbers that weren't measured.

Recognition requests must not block the FlashyDex UI.

Show clear progress state.

Allow cancellation where practical.

---

# STAGE 11 — FAILURE MODES

Handle explicitly:

- recognition PC offline
- Cloudflare Tunnel offline
- recognizer model unavailable
- index unavailable
- timeout
- upload too large
- unsupported image
- no card detected
- no confident match
- catalog not installed
- recognized card missing from installed local catalog
- rate limit exceeded

The user should always still be able to:

Search manually

or

Browse by set

Recognition being unavailable must never make collection management unusable.

---

# STAGE 12 — PRIVACY

Default policy:

Uploaded recognition images are ephemeral.

Do not permanently store photos on the recognition server unless the user explicitly opts into a feature requiring storage.

After recognition finishes:

- process image
- return result
- release/delete temporary upload

Do not build a permanent library of user card photographs by accident.

Do not log:
- image contents
- exact local file paths
- unnecessary personal information

Document actual behavior in the privacy policy later.

---

# AGENT ORCHESTRATION

Use agents intentionally.

Recommended:

## Opus
Director.

Responsibilities:
- break work into disjoint tasks
- write Sonnet briefs
- resolve conflicts
- verify integrated UX
- manage fix loops

## Sonnet
Primary builders.

Suggested parallel ownership where safe:

sonnet-web-storage
→ OPFS/web SQLite completion

sonnet-recognition
→ recognition/index/service

sonnet-tunnel
→ Cloudflare tunnel/service tooling

sonnet-scanner-ui
→ camera/photo/candidate UX

Do not run children concurrently against overlapping files.

## Sol
Independent reviewer.

Review after integration:

- recognition architecture
- security
- confidence logic
- false-match risk
- memory use
- OPFS correctness
- index integrity
- scanner API contract
- photo privacy
- production failure modes

Sol should NOT simply rubber-stamp builder output.

Create reproducible defects and bounce them back through Sonnet fixes.

## Grok
Use for targeted research only if needed:
- iOS PWA camera/HEIC behavior
- browser quirks
- Cloudflare Tunnel operational specifics

Do not let research stall implementation.

---

# TESTING REQUIREMENTS

Keep all existing tests green.

Add tests for:

## Recognition service

- reference-image exact match
- perspective distortion
- rotation
- glare
- JPEG compression
- partial crop
- blank image
- non-card photo
- wrong language hint
- index missing
- oversized request
- rate limit

## App

- choose photo
- take-photo capability/fallback
- loading state
- high-confidence result
- candidate result
- no-match state
- service-offline state
- confirm and add
- scan another
- manual fallback

## Production web storage

- EN + JA coexist
- reload persistence
- migration from previous web DB
- catalog rollback
- interrupted install
- quota handling
- multi-tab protection

---

# IMPORTANT NON-GOALS

Do NOT spend this milestone implementing:

- Auth0
- friends
- social profiles
- paid subscriptions
- price alerts
- marketplace selling
- TCG Live linking
- Pokémon GO linking
- HOME linking
- Pocket importing
- grading AI
- continuous live video scanning

Those are later.

This milestone is about making the core scanner genuinely useful.

---

# DEFINITION OF DONE

This milestone is complete when, from the LIVE FlashyDex PWA on the owner's iPhone:

1. User opens Add.
2. User taps Take Photo or Choose Photo.
3. User photographs a real Pokémon card.
4. FlashyDex sends the optimized photo to the recognition service.
5. Recognition returns either:
   - a confident card, or
   - up to three sensible candidates.
6. User confirms the card.
7. Existing confirmation sheet opens.
8. User adds it.
9. Card appears in the collection.
10. User can immediately scan another card.
11. Reloading FlashyDex preserves the collection.
12. Manual search/browse still works if recognition is offline.

Also prove:

- EN+JA catalogs coexist using the production web-storage path.
- recognition photos are not permanently retained.
- recognition latency is measured.
- false-confidence behavior has been tested.
- live Netlify PWA works, not only localhost.

---

# FINAL REPORT

Return a concise but complete report containing:

## Production Web Storage
- implementation status
- EN+JA coexistence
- storage usage
- install times
- search latency
- remaining Safari-specific concerns

## Recognition
- EN indexed count
- JA indexed count
- index sizes
- skipped reference cards
- model/version
- top-1/top-3 test accuracy
- real-photo accuracy if owner samples exist
- average/p95 latency
- confidence thresholds

## Service
- recognition URL
- tunnel status
- health result
- security controls
- offline behavior

## PWA
- Take Photo result
- Choose Photo result
- candidate UX
- confirm/add result
- scan-another flow
- iPhone test status

## Tests
- test totals
- failing/skipped tests
- independent Sol findings and resolution

## Owner Actions
List ONLY things that genuinely require the owner.

Do not call the milestone complete because the recognition API works from curl.

The success condition is a real card photographed from the live FlashyDex PWA being correctly identified and added to the user's collection.