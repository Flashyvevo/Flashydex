# Opus UX v2 report (Stage A2: native + local-first)

## Produced (all within my ownership)
- **`docs/UX.md`**, rewritten in place (123 KB). Sections §0–14 keep their old numbers so links from other docs still work. New sections:
  - §15 First run, with a startup gate and steps welcome → disclaimer → languages (size/time estimate) → sets you collect → start download. The app is usable at once, with a progress pill.
  - §16 Offline matrix for every screen, plus download pause/resume and app lifecycle.
  - §17 iOS/Android native-conventions checklist.
  - §18 Icon and splash.

  Shell and routes:
  - Routes are now a TanStack file-route table, with `_tabs` and `_modal` layouts.
  - Back gestures, Android back order and per-tab stacks are defined (§1.5).
  - The sync pill is new (§1.6).
  - Bottom sheet and pull-to-refresh specs are in §2.3–2.4.

  Settings: Catalog & prices (packs plus a TCGdex fallback), Data (share sheet, document picker, `.fdx`), About, Privacy, Licenses, and a Danger zone.

  Removed: all Next.js, server, PC and LAN wording.

  Kept: grouped grid (now API.md `groupBy:'card'`), the "No price" filter, the hide-TCG-Pocket setting, and the 5-tab nav with Scan disabled.
- **`docs/DESIGN-TOKENS.md`**, amended in place:
  - safe-area, keyboard and chrome tokens
  - `.platform-ios` / `.platform-android` overrides
  - large-text system: TextZoom → `--ps-text-scale`; type in rem, spacing in px; ax bucket
  - haptics mapping table
  - page and sheet motion
  - increased-contrast overrides
  - icon/splash spec: "foil glint" mark with exclusions, iOS Light/Dark/Tinted/Clear, Android adaptive + monochrome, store-screenshot rule
  - SF Pro on iOS, bundled Inter elsewhere
- **`apps/mobile/src/styles/tokens.css`** (new, copied from `.agent/tokens.css.keep` and extended): 206 unique `--ps-*` custom properties. The `--ps-` prefix stays: it is internal and a rename buys nothing.
- **`.agent/reports/opus-ux-v2-requests.md`**: S1–S9 plus route additions for Sol; T1–T8 for Terra.

## Verified
- **Contrast:** script `$TMPDIR/contrast_v2.py` checked 50 new or changed pairs, 0 fail.
  - The pairs cover:
    - translucent iOS chrome over worst-case white and black art
    - Android M3 indicator
    - sync pill
    - warning/info chips
    - high-contrast overrides
    - sheet handle
    - splash mark
  - Fixes that came out of it:
    - Light `--ps-warning` was `#b45309`, only 4.10:1 on its own soft tint. It is now `#9a4806` (5.13:1).
    - New `--ps-chrome-accent-fg`, light `#6b5100`. The old `#8a6a00` measured 4.04:1 over black content; the new value gives 5.98.
    - The high-contrast subtle light colour is `#3b4252` (8.82:1).
- **tokens.css hygiene:** no non-custom declarations (grep returns 0); braces balance 20/20; no "pokescan".
- **Chromium parse** (browser session `opus-ux`): 13 rules. Computed values checked:
  - base bars 56/64 px
  - iOS bars 44/50 px, translucent chrome, system font
  - iOS ax: 52 px bar, 150 px tile
  - Android: 64 px bar, 56 px indicator, 28 px sheet radius
  - pill padding 120 px
  - at `--ps-text-scale: 1.5`: root 24 px, tap clamped to 56, display capped at 48
  - reduced motion zeroes page offsets even with `.platform-ios`
- **Native capabilities checked against the plugin source:**
  - iOS `TextZoom.getPreferred` = Dynamic Type body pointSize / 17.
  - Android `getPreferred` = fontScale.
  - Capacitor 7 has `android.adjustMarginsForEdgeToEdge` (7.1+).
  - TCGdex cards-database is MIT; Inter is OFL-1.1.
- **TCGdex payload sizes:** card-detail JSON averages 2,054 B (12-card sample) and is served uncompressed. These numbers feed the fallback estimates.
- **Docs:** no stale wording left in UX.md or tokens (grep). Markdown fences balance.
- **Not done:** no dev server started, no screenshots taken, no code written besides tokens.css.

## Incomplete / depends on others
- Catalog-pack UI uses the proposed `CatalogPackService` (S1), which Sol defines in Stage A3.
- `.fdx` backup falls back to the JSON backup until A3.
- These need APIs before they ship: owned-only price update (S2), card/set refresh (S3), and the Danger-zone operations (S8; rows stay hidden until then).
- Nothing was checked on a device. VoiceOver, Dynamic Type at AX3, edge-swipe and haptics are listed as M checks in UX §14.

## Open questions for the director/owner
1. **Variant preselection.** The add form preselects a variant by catalog priority; condition now defaults to unset, per API.md. Is this acceptable, or must variant also start unselected (one more tap per add)?
2. **iPhone-only vs universal.** If universal, iPad screenshots are required.
3. **Privacy URL host** (`FLASHYDEX_PRIVACY_URL`) and the owner brackets in PRIVACY-POLICY.md.
4. **iCloud backup exclusion of catalog DBs** (S7). This is an App Review 2.23 risk.
5. **Accent yellow `#ffcb05`.** It is the Pokémon logo yellow. It is fine as a UI colour, and the icon avoids the yellow+blue pairing, but the owner may want legal sign-off.

## Phase 2 note (on-device ORT vs endpoint; RECOGNITION-DESIGN left untouched)
- **Default should be on-device** (ONNX Runtime, via Mobile in a native plugin or Web in the WebView). Reasons:
  - App Review can't reach the owner's server.
  - Offline-first is a stated value.
- The FastAPI endpoint should be an opt-in "advanced" setting.
- **UX consequences:**
  - The recognition model and embeddings index are an optional download with its own size, progress and pause, reusing the catalog-pack ProgressCard (BRIEF: recognition packs are versioned separately and zstd-compressed).
  - The scanner states "Recognition isn't ready" and offline must cover a missing pack.
  - Each model must be benchmarked on iPhone as f32 vs f16 vs int8 before the size can be shown.
