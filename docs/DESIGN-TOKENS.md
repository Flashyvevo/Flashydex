# FlashyDex design tokens

Owner: Opus (UX lead). Implementation file: `apps/mobile/src/styles/tokens.css`. It contains CSS custom properties only, every name prefixed `--ps-`, plus the selectors that switch them: theme, platform, text size, sync pill, contrast and motion.
Consumers: Tailwind v4 via `@theme inline` (mapping in §9) and, rarely, raw `var(--ps-…)` in component CSS.
Rule for implementers: **no hex values, px font sizes or ad-hoc durations in components.** If a value is missing, request it in `.agent/reports/<role>-requests.md`; do not invent one.

Stage A2 (2026-10-30): amended for the native Capacitor shell (iOS first, Android buildable, web for development/PWA). New in this revision:
- safe-area, keyboard and chrome tokens (§5.2)
- platform overrides (§5.3)
- text-size scaling and its buckets (§4.2)
- haptics mapping (§7.3)
- page/sheet motion (§7.1–7.2)
- increased-contrast overrides (§3.4)
- a light `--ps-warning` fix (§3.2)
- app icon and splash colours (§10.3)

Next.js wording is gone: no `next/font` and no `app/layout.tsx`.

**Prefix decision:** the prefix stays `--ps-`. It is internal and never user-visible, and about 200 names plus the Tailwind mapping already use it. Renaming it would buy nothing and risk misses.

Contents:
1. Principles
2. Theming
3. Color
4. Type and text size
5. Space, layout, safe areas, platforms
6. Radii, shadows, layers
7. Motion and haptics
8. Domain badges
9. Tailwind v4 mapping
10. Fonts, icon and splash
11. Verification

---

## 1. Principles

1. **Card art is the hero.** Chrome is near-black and neutral so printed card colours read true. The accent yellow is the only saturated UI colour. It is used for the primary action, focus and the quantity badge.
2. **Dark by default.** Collectors look at a phone in a living room at night, and a white UI next to holo art glares. A light theme exists and is fully specified.
3. **Never colour alone.** Rarity, condition and gain/loss always pair colour with text or a sign (`+$4.20`, `NM`, `● Rare`).
4. **Elevation by surface, not shadow** in dark mode, because shadows are invisible on near-black. Light mode uses soft shadows.
5. **Motion confirms, it never decorates.** Movement is removed under `prefers-reduced-motion`. Fades and colour feedback stay so taps still feel acknowledged. Haptics confirm the few moments that matter (§7.3).
6. **Feels native on each platform.** iOS gets SF Pro, translucent bars, a 44 pt nav bar, tint-only active tabs, UIKit push/sheet curves and the edge back-swipe. Android gets Material 3 bar heights, the pill indicator and the 28 dp sheet radius. Colour, type ramp and components stay identical, so the product is one brand.

## 2. Theming

- Attribute: `<html data-theme="dark" | "light">`. Dark also applies when the attribute is missing (`:root` carries the dark values), so the first paint before JS is dark.
- User setting `theme` ∈ `dark` (default) | `light` | `system`. It is stored in AppSettings (API.md `SettingsRepo`) and mirrored to `localStorage["ps-theme"]`, so the pre-React inline script can apply it with no flash. It is a device preference and is not part of collection exports.
- No-flash inline script in `apps/mobile/index.html` `<head>` (implementer, about 10 lines):
  - Read `ps-theme`.
  - If the value is `system`, resolve it with `matchMedia('(prefers-color-scheme: light)')`. WKWebView and Android WebView follow the OS appearance.
  - Set `document.documentElement.dataset.theme`.
  - When the value is `system`, also subscribe to changes.
- Native status bar (`@capacitor/status-bar`):
  - On every theme change, call `StatusBar.setStyle({ style: Style.Dark })` for the dark theme (light glyphs) and `Style.Light` for light.
  - iOS overlays the web view by default, which the tokens expect.
  - Android: see §5.3. The bar colour can't be set on Android 15+, so the window background must equal dark `--ps-bg`.
- `<meta name="theme-color">` (web/PWA only) is rewritten to the active `--ps-bg`. Native ignores it.
- `color-scheme` is a real property, so it lives in globals.css and not in tokens.css: `html{color-scheme:dark}` and `html[data-theme=light]{color-scheme:light}`. It gives native dark scrollbars, the date-picker wheel and autofill styling.

## 3. Color

All pairs below were measured with WCAG 2.x relative luminance. Text pairs are ≥ 4.5:1 and UI boundaries/graphics ≥ 3:1. Stage A results are in `.agent/reports/opus-ux-report.md`; the A2 pairs are in `.agent/reports/opus-ux-v2-report.md` (50 pairs, 0 fail).

### 3.1 Neutrals and surfaces

| Token | Dark (default) | Light | Use |
|---|---|---|---|
| `--ps-bg` | `#0b0d12` | `#f6f7f9` | page background; dark value is also the **splash and native window background** |
| `--ps-surface` | `#12151c` | `#ffffff` | panels, list groups, solid top bar / tab bar |
| `--ps-surface-2` | `#1a1e27` | `#eef0f4` | inputs, unselected chips, onboarding option cards |
| `--ps-surface-3` | `#232835` | `#e3e6ec` | pressed rows, segmented track, **sync pill** |
| `--ps-overlay` | `rgb(5 6 10/.72)` | `rgb(14 17 22/.45)` | sheet/dialog scrim |
| `--ps-border` | `#262c3a` | `#d9dde5` | decorative hairlines |
| `--ps-border-strong` | `#3a4256` | `#b9bfcc` | decorative dividers |
| `--ps-border-input` | `#687186` | `#848c9e` | form controls (≥ 3:1) |
| `--ps-fg` | `#f2f4f8` 17.6:1 | `#0e1116` 18.9:1 | primary text |
| `--ps-fg-muted` | `#a3abbd` 8.4:1 | `#4a5263` 7.8:1 | secondary text |
| `--ps-fg-subtle` | `#7d8699` 5.3:1 | `#646c7d` 5.3:1 | tertiary text, placeholders, timestamps |
| `--ps-fg-disabled` | `#4f5668` | `#a6acb8` | disabled labels only (exempt) |

### 3.2 Accent and status

| Token | Dark | Light | Use |
|---|---|---|---|
| `--ps-accent` | `#ffcb05` | `#ffcb05` | primary button fill, selected chip fill |
| `--ps-accent-hover` / `-pressed` | `#ffd83d` / `#e6b600` | same | button states |
| `--ps-on-accent` | `#1a1400` (12.1:1) | same | text/icons on accent |
| `--ps-accent-fg` | `#ffcb05` (12.8:1) | `#8a6a00` (5.1:1) | accent as text on bg/surface (links) |
| `--ps-accent-soft` | 14 % yellow | 22 % yellow | selected-row tint |
| `--ps-focus-ring` | `#ffcb05` | `#1d4ed8` | 2 px ring + 2 px offset |
| `--ps-positive` | `#34d399` | `#047857` | gain, success, "Up to date" |
| `--ps-negative` | `#f87171` | `#b91c1c` | loss, errors, danger-zone text |
| `--ps-warning` | `#fbbf24` | **`#9a4806`** | "Catalog incomplete", offline/paused chips |
| `--ps-info` | `#60a5fa` | `#1d4ed8` | neutral notices, sync running |
| `*-soft` | 14 % alpha | 8–10 % alpha | banner/chip backgrounds behind the solid text colour |
| `--ps-danger-solid` / `--ps-on-danger` | `#dc2626` / white | `#b91c1c` / white | destructive button fill |

A2 fix: the light `--ps-warning` used to be `#b45309`, which measured only 4.10:1 on its own soft tint over `--ps-bg`. The new `#9a4806` measures 5.13:1 on that tint and 5.93:1 on plain bg; `--ps-warning-soft` follows the new hue.

Why yellow: it reads instantly on near-black with no glow, and it is absent from most card frames' chrome positions, so the primary action never blends into the art. **Compliance note:** the UI accent is a plain colour, not a mark. Pairing this yellow with the Pokémon logo blue in a wordmark or icon would be trade dress, so the icon never does that (§10.3).

### 3.3 Chrome colours (A2)

| Token | Dark | Light | Notes |
|---|---|---|---|
| `--ps-chrome-bg` | `var(--ps-surface)` | `var(--ps-surface)` | solid bars (Android, web) |
| `--ps-chrome-bg-translucent` | `rgb(18 21 28/.86)` | `rgb(255 255 255/.90)` | iOS bars, with `--ps-chrome-backdrop: saturate(180%) blur(20px)` |
| `--ps-chrome-accent-fg` | `#ffcb05` | **`#6b5100`** | active tab label/icon, top-bar text buttons ("Done", "Back") |
| `--ps-chrome-border` | `var(--ps-border)` | `var(--ps-border)` | 1 px hairline between bar and content |
| `--ps-tab-indicator-bg` | accent (web) / accent-soft (Android) | same | iOS has no indicator |
| `--ps-sheet-handle` | `--ps-fg-subtle` (4.99:1) | `--ps-border-input` (3.37:1) | drag handle |

Only three foreground tokens may sit on chrome: `--ps-fg`, `--ps-fg-muted` and `--ps-chrome-accent-fg`. Each was checked over the translucent bar composited on worst-case **white and black** content scrolling underneath:
- Dark theme: fg 11.0 / 17.0, muted 5.27 / 8.13, accent 7.98 / 12.3.
- Light theme: fg 18.9 / 15.1, muted 7.84 / 6.25, chrome-accent 7.49 / 5.98.
- `--ps-accent-fg` (light `#8a6a00`) drops to 4.04:1 over black art, which is why chrome uses its own token. `--ps-fg-subtle` is not allowed on chrome.

### 3.4 Increased contrast (A2)

`@media (prefers-contrast: more)` follows iOS "Increase Contrast" in WKWebView, and macOS/Windows on web. Under it:
- `--ps-fg-subtle` becomes the muted value: dark `#a3abbd` (7.24:1 on surface-2), light `#3b4252` (8.82:1).
- The decorative borders become ≥ 3:1: dark `#687186`, light `#848c9e`.
- iOS bars turn solid.

Android WebView has no equivalent media feature; its high-contrast-text setting is handled by the OS.

## 4. Typography and text size

### 4.1 Fonts and ramp

- **iOS: the system font** (`-apple-system` = SF Pro Text/Display, Hiragino Sans for Japanese). It is the native look, ships zero bytes, has the metrics Dynamic Type was tuned for, and SF has tabular figures.
- **Android and web: Inter Variable**, bundled with the app via `@fontsource-variable/inter` (OFL-1.1, latin subset, about 45–50 KB woff2, weights 400–800). It loads from the app bundle and never from a CDN, so it works offline and makes no third-party request. The fallback chain hands Japanese names to Noto Sans JP / Noto Sans CJK JP (Android) or Hiragino / Yu Gothic (desktop). No CJK webfont is shipped.
- Numerals: use `font-variant-numeric: tabular-nums` everywhere a number can change or align: prices, counts, collector numbers, progress.

| Role | Token | Size at 1× / line | Weight | Tracking | Cap | Where |
|---|---|---|---|---|---|---|
| Display | `--ps-text-display` | 32 / 1.1875 | 700 | −0.02em | 48 px | Dashboard value only |
| H1 | `--ps-text-h1` | 28 / 1.214 (32 at ≥1024) | 700 | −0.015em | 40 px (44 at ≥1024) | page title, card name |
| H2 | `--ps-text-h2` | 20 / 1.4 | 650 | −0.01em | — | section headings |
| H3 | `--ps-text-h3` | 17 / 1.41 | 600 | 0 | — | sheet titles, onboarding step titles |
| Body | `--ps-text-body` | 16 / 1.5 | 400 | 0 | — | default, **all inputs** (≥ 16 px stops iOS focus zoom) |
| Small | `--ps-text-small` | 14 / 1.43 | 400–500 | 0 | — | secondary lines |
| Caption | `--ps-text-caption` | 13 / 1.38 | 400–500 | 0 | — | tile meta, helper text |
| Micro | `--ps-text-micro` | 12 / 1.33 | 650 | +0.01em | — | badges/chips only |
| Tab label | `--ps-tab-label-size` | 12 | 600 | 0 | 15 px | tab bar |
| Top-bar title | `--ps-topbar-title-size` | 17 | 600 | 0 | 22 px | inline title in bars |

Line heights are now unitless ratios, so they scale with the text.

Rules:
- Names truncate on one line in tiles; the full name is in the accessible name.
- Long JA names wrap in Card Details.
- Body copy max width is 65ch.

### 4.2 Large text (Dynamic Type / Android font size): how it works

Goal: honour the user's text size everywhere, without the chrome or the 3-column grid breaking at 390 px.

1. **The source of the scale.** The platform layer calls `TextZoom.getPreferred()` from `@capacitor/text-zoom` at startup and on every `App` `resume`. On iOS this returns `UIFont.preferredFont(.body).pointSize / 17`, the Dynamic Type category; we checked the plugin source. On Android it returns `Configuration.fontScale`. On web the scale is `1`, because `100%` already carries the browser's default font size.
2. **Android double-scaling guard.** Android WebView applies the system font scale on its own through `textZoom`. Call `TextZoom.set({ value: 1 })` once at startup so the scale is applied exactly once, through our tokens. **Never call `TextZoom.set` with any other value.** WebView text zoom inflates text without growing its boxes, so fixed-height chrome would clip.
3. **Apply it.** Clamp the scale to `0.875…2`. Write it as an inline style `--ps-text-scale` on `<html>`. globals.css sets `html { font-size: var(--ps-root-font-size) }`, which is `calc(100% * scale)`, plus `-webkit-text-size-adjust: 100%` so iOS landscape never auto-inflates.
4. **Buckets.** Also set `data-text-size` on `<html>`: `default` (< 1.12), `large` (1.12–1.39, Dynamic Type xL–xxxL) or `ax` (≥ 1.4, Accessibility sizes). Tokens react to the bucket:
   - `ax`: 2-column grid (`--ps-tile-min: 150px`), taller sync pill, taller top bar.
   - `large`: taller sync pill.
5. **What scales and what doesn't:**
   - Scales (rem): every text token, `--ps-tap` (`clamp(44px, 2.75rem, 56px)`) and `--ps-tap-lg`.
   - Fixed (px): spacing (Tailwind `--spacing: 4px` in §9), bar heights, tile minimum (except in `ax`), radii.
   - Capped: Display (48 px), H1 (40 px), tab labels (15 px) and the top-bar title (22 px). Native bars don't grow with Dynamic Type either.
6. **Layout behaviour at large sizes** (UX.md §13 lists the checks):
   - Buttons use `min-height`, never `height`, and labels may wrap to 2 lines.
   - Chip groups wrap.
   - At `ax`, the stat grid goes from 2×2 to 1 column.
   - At `ax`, form rows stack the label above the control.
   - Tile captions stay 1 line with ellipsis.
   - No horizontal scrolling appears except the intentional scrollers (Recently added, active-filter chips).

Reason for px spacing: with rem spacing, a 2× text setting would double every gutter and push 390 px layouts into horizontal scroll. Users who raise text size want bigger words, not wider margins.

## 5. Space, layout, safe areas and platforms

### 5.1 Grid and gutters
- 4 px grid, in px (`--ps-space-*`). Tailwind's spacing base is overridden to `4px` (§9), so `p-4` = 16 px at every text size.
- `--ps-page-x`: 16 (<640) · 24 (≥640) · 32 (≥1024). Pages pad with `--ps-page-left` / `--ps-page-right` = `max(page-x, safe-area-inset-left/right)`. That only matters in landscape on notched phones; phones are portrait-locked in Phase 1, but iPad and web are not.
- Card grid: `repeat(auto-fill, minmax(var(--ps-tile-min), 1fr))`, gap `--ps-grid-gap`. At 390 px, (390 − 32 − 16)/3 = 114 px tiles, which gives **3 columns**; the `ax` bucket gives 2. At ≥ 640 the minimum is 136 px; at ≥ 1024 with the sidebar it is 160 px.
- Targets: `--ps-tap` is ≥ 44 px (HIG 44 pt) for anything tappable. `--ps-tap-lg` is ≥ 48 px (Material 48 dp) for tab items and primary buttons. Small visuals (the 24 px stepper glyph, the 20 px badge) get their hit area from padding or a pseudo-element.

### 5.2 Safe areas, chrome and keyboard (A2)

| Token | Value | Use |
|---|---|---|
| `--ps-safe-top/-bottom/-left/-right` | `max(env(safe-area-inset-*), var(--safe-area-inset-*, 0px))` | every edge-touching element |
| `--ps-topbar-h` | 56 (web) · 44 (iOS) · 64 (Android) · ax +8 | top bar content height |
| `--ps-topbar-total` | `topbar-h + safe-top` | top bar block size; sticky offset for sub-headers |
| `--ps-tabbar-h` | 64 (web) · 50 (iOS) · 64 (Android) | tab bar content height |
| `--ps-tabbar-total` | `tabbar-h + safe-bottom` | tab bar block size |
| `--ps-scan-fab` / `--ps-scan-raise` | 60 / 12 px | center Scan circle and how far it rises |
| `--ps-syncpill-h` | 32 · large 36 · ax 40 | sync pill height |
| `--ps-syncpill-space` | 0, or `pill + 8` when `<html class="has-sync-pill">` | extra bottom clearance |
| `--ps-content-pad-bottom` | `tabbar-total + syncpill-space + 16` | `padding-bottom` of every scrolling page |
| `--ps-toast-bottom` | `max(tabbar-total, keyboard-inset) + syncpill-space + 8` | toast offset |
| `--ps-keyboard-inset` | 0, set at runtime | on-screen keyboard height overlapping the WebView |
| `--ps-sheet-max-h` | `100dvh − safe-top − 8px` | tallest sheet detent |
| `--ps-sheet-pad-bottom` | `max(safe-bottom, keyboard-inset) + 16` | sheet footer clearance |
| `--ps-sheet-radius` | 20 (web) · 14 (iOS) · 28 (Android) | sheet top corners |
| `--ps-sheet-handle-w/-h` | 36×5 (web/iOS) · 32×4 (Android) | drag handle |
| `--ps-sheet-dismiss-distance` | 120 px | drag distance that dismisses (or a velocity > 0.5 px/ms) |
| `--ps-pull-threshold` / `--ps-pull-max` | 64 / 96 px | pull-to-refresh trigger / rubber-band limit |

Requirements that make these tokens true (requested from Terra in `.agent/reports/opus-ux-v2-requests.md`):
- **iOS:**
  - `viewport-fit=cover` in the viewport meta. It is already in `index.html`.
  - `ios.contentInset: 'never'`, the Capacitor default. The current `'always'` makes UIKit inset the scroll view itself, so `env()` padding would double or vanish.
  - StatusBar overlays the web view (the default).
- **Android (Capacitor 7):**
  - `android.adjustMarginsForEdgeToEdge: 'force'` (Capacitor 7.1+). The WebView then sits between the system bars, `env()` returns 0, and the tokens resolve to 0. This is correct.
  - The strips behind the status and navigation bars show the native window background, so set the app theme's `windowBackground` and `android.backgroundColor` to `#0b0d12`.
  - Known Phase 1 limitation: in the light theme those strips stay dark. Capacitor 8's SystemBars `insetsHandling: 'css'` injects `--safe-area-inset-*`, which these tokens already read, so the later fix is config only.
- **Keyboard:**
  - Use `@capacitor/keyboard` with iOS `resize: 'none'`.
  - The platform layer sets `--ps-keyboard-inset` from `keyboardWillShow` (`info.keyboardHeight`) and resets it to 0 on `keyboardWillHide`.
  - Android keeps `adjustResize`: the WebView shrinks and the inset stays 0.
  - Web derives the inset from `visualViewport`: `innerHeight − visualViewport.height − visualViewport.offsetTop`, never negative.

### 5.3 Platform overrides (A2)

`apps/mobile/src/platform/platform.ts` already sets `.platform-ios | .platform-android | .platform-web` on `<html>`. Components never branch on the platform for sizes or colours; the tokens do that. Components may branch only for behaviour (back-button rendering, transition direction). The values below are what tokens.css §6 sets.

| Aspect | Web (dev, PWA) | iOS | Android |
|---|---|---|---|
| Font | Inter Variable | SF Pro (system) | Inter Variable |
| Top bar | 56 px, solid, title left | 44 px, translucent + blur, **title centred**; large title in content on root screens | 64 px, solid, title left |
| Back affordance | `‹` + previous title | `‹` chevron + previous screen title in `--ps-chrome-accent-fg`; edge swipe | arrow-left icon only (24 px in a 48 px target); system back |
| Tab bar | 64 px, 32×4 bar above icon | 50 px + home indicator, translucent, **tint only** (active = `--ps-chrome-accent-fg`, inactive = `--ps-fg-muted`), no indicator | 64 px, solid, **56×32 accent-soft pill behind the icon** |
| Sheet | radius 20, handle 36×5 | radius 14, grabber 36×5, page behind scales to 0.94 with radius 10 (skip under reduced motion) | radius 28, handle 32×4, no page scale |
| Push transition | 24 px slide + fade, 300 ms | new page from 100 %, old page to −30 %, 350 ms `cubic-bezier(.32,.72,0,1)` | 30 px shared-axis + fade, 300 ms |
| Press feedback | darken + scale 0.97 | darken + scale 0.97 | darken + scale 0.97 (no ripple; one look) |
| Pull-to-refresh | spinner | spinner under the large title, rubber band | spinner in a 40 px circle on surface-3 |
| Selects/date | native controls | native wheel/menu (`<select>`, `<input type=date>`) | native dialog |

## 6. Radii, shadows, layers

| Token | Value | Use |
|---|---|---|
| `--ps-radius-xs` | 4 px | badges |
| `--ps-radius-sm` | 6 px | chips |
| `--ps-radius-md` | 10 px | buttons, inputs |
| `--ps-radius-lg` | 14 px | panels, list groups, stat tiles |
| `--ps-radius-xl` | 20 px | dialogs (≥1024) |
| `--ps-sheet-radius` | 20 / 14 iOS / 28 Android | sheet top corners |
| `--ps-radius-full` | pill | qty badge, sync pill, Scan button |
| `--ps-radius-card` | `4.8% / 3.4%` | **every card-art frame**: the elliptical percentages reproduce the real ~3 mm corner of a 63×88 mm card at any size |

Shadows:
- `--ps-shadow-1/2/3`: rest, raised, sheet.
- `--ps-shadow-card`: the printed-card lift on art tiles.
- `--ps-shadow-scan`: the ring that cuts the Scan circle out of the bar.
- `--ps-hairline-top`: the inner top highlight on dark surfaces.

Layers: `--ps-z-sticky` 10 · `--ps-z-nav` 30 · `--ps-z-syncpill` 35 · `--ps-z-sheet` 40 · `--ps-z-toast` 50 · `--ps-z-blocking` 60 (restore/erase overlay).

## 7. Motion and haptics

### 7.1 Durations and easings

| Token | Value | Reduced motion | Use |
|---|---|---|---|
| `--ps-dur-instant` | 80 ms | kept | pressed colour |
| `--ps-dur-fade-fast` | 120 ms | kept | hover/focus/selected colour, tab-switch crossfade |
| `--ps-dur-fade` | 200 ms | kept | image fade-in, toast in/out |
| `--ps-dur-fade-slow` | 320 ms | kept | skeleton → content crossfade |
| `--ps-dur-move-fast` | 160 ms | 1 ms | press scale, chip check |
| `--ps-dur-move` | 240 ms | 1 ms | tile enter, list reorder, pull settle |
| `--ps-dur-move-slow` | 360 ms | 1 ms | bottom sheet open/close, modal route |
| `--ps-dur-page` | 300 / 350 iOS / 300 Android | 200 ms **crossfade** | push/pop transition |
| `--ps-page-enter-x` / `--ps-page-exit-x` | 24/−12 · iOS 100%/−30% · Android 30/−30 px | 0 | push offsets (mirror for pop) |
| `--ps-dur-shimmer` | 1400 ms | 0 (static) | skeleton sweep |
| `--ps-move-y-sm/-md` | 4 / 12 px | 0 | enter offsets |
| `--ps-press-scale` / `--ps-pop-scale` | 0.97 / 1.12 | 1 / 1 | press / qty badge pop |

Easings:
- `--ps-ease-standard`: most motion.
- `--ps-ease-decelerate`: entering.
- `--ps-ease-accelerate`: leaving.
- `--ps-ease-spring`: qty pop and success check; it becomes standard under reduced motion.
- `--ps-ease-page`: platform push curve.
- `--ps-ease-sheet` `cubic-bezier(.32,.72,0,1)`: sheet open and settle after a drag, matching the UIKit sheet curve.

### 7.2 Page transitions
- Use the View Transitions API through TanStack Router's `viewTransition` navigate option. WKWebView (iOS 18+) and Android WebView (Chromium 111+) support same-document view transitions. Where they are unsupported, navigate instantly with no fallback animation.
- Push, pop, tab switch and modal each have a defined motion:
  - Push: offsets as in the table.
  - Pop: mirrored.
  - **Tab switch: no movement**, a 120 ms crossfade, because native tab switches are instant.
  - Modal routes (`/add`, `/welcome/*`, `/custom-cards/new`): slide up from the bottom over `--ps-dur-move-slow` with `--ps-ease-sheet`.
- **iOS back-swipe:** when the pop comes from the native edge-swipe gesture (WKWebView `allowsBackForwardNavigationGestures`, UX.md §1.5), the gesture has already animated the page. Skip the JS transition so nothing animates twice. Rule: on iOS, a `popstate` navigation never starts a view transition. Android back and the in-app back button do animate.
- Never animate `width/height/top/left`; animate only `transform` and `opacity`. No parallax. The only loops are the skeleton shimmer, the indeterminate sync bar and the sync-pill spinner; under reduced motion the bar becomes static stripes and the spinner a static ring at its progress.

### 7.3 Haptics (Capacitor Haptics): the only allowed calls

Haptics are implemented once in `apps/mobile/src/platform/haptics.ts` as `haptic(event)`; components never call the plugin directly.
- On web the function is a no-op. It does not call `navigator.vibrate`.
- It respects the app setting **Haptics** (on by default, Settings → Preferences).
- The OS-level "System Haptics" switch is honoured by iOS itself.
- **Reduced motion does not disable haptics**, because they are a separate channel.
- Never fire a haptic inside a DB transaction; fire after the commit resolves (ARCHITECTURE rule).

| Event (`haptic(...)`) | When | Capacitor call |
|---|---|---|
| `added` | after an add (bulk add) commits | `notification({ type: NotificationType.Success })` |
| `undo` | after Undo removes the just-added copies | `impact({ style: ImpactStyle.Light })` |
| `deleted` | after a confirmed delete commits (copy, location, custom card, bulk delete, erase) | `notification({ type: NotificationType.Warning })` |
| `saved` | copy editor Save commits | `impact({ style: ImpactStyle.Light })` |
| `error` | a mutation, import commit or export fails | `notification({ type: NotificationType.Error })` |
| `select` | stepper −/+, segmented control change, chip select in the add sheet | `selectionChanged()` (bracketed by `selectionStart/End` per gesture); iOS only, skipped on Android (too buzzy) |
| `threshold` | pull-to-refresh passes `--ps-pull-threshold`; sheet drag crosses the dismiss distance | `impact({ style: ImpactStyle.Light })`, once per gesture |
| `longpress` | context menu opens on a tile | `impact({ style: ImpactStyle.Medium })` |
| `synced` | a catalog download the user started completes while the app is in the foreground | `notification({ type: NotificationType.Success })` |

Nothing else vibrates: no haptics on plain navigation, tab taps, scrolling or toasts.

## 8. Domain badges

### 8.1 Rarity (dot + label, never colour alone)

TCGdex rarity strings map to a **tier** through a pure function `rarityTier(rarity: string | null)`. The implementer writes it and unit-tests it with this table as the fixture. Matching is exact after trimming and case-insensitive. Unknown strings map to `unknown` and still show the raw text. JA cards use English rarity strings on TCGdex. The lists below are the complete `GET /v2/en/rarities` (42 values) and `GET /v2/ja/rarities` (22 values) responses, fetched 2026-10-30.

| Tier | Token | TCGdex strings |
|---|---|---|
| common | `--ps-rarity-common` | Common, One Diamond |
| uncommon | `--ps-rarity-uncommon` | Uncommon, Two Diamond |
| rare | `--ps-rarity-rare` | Rare, Three Diamond, Classic Collection |
| holo | `--ps-rarity-holo` | Rare Holo, Holo Rare, Holo Rare V, Holo Rare VMAX, Holo Rare VSTAR, Rare Holo LV.X, Rare PRIME, LEGEND, Double rare, Four Diamond, Radiant Rare, Amazing Rare, ACE SPEC Rare |
| ultra | `--ps-rarity-ultra` | Ultra Rare, Triple Rare, Full Art Trainer, Shiny rare, Shiny rare V, Shiny rare VMAX, Shiny Ultra Rare, One Shiny, Two Shiny, One Star |
| illustration | `--ps-rarity-illustration` | Illustration rare, Special illustration rare, Character Rare, Character Super Rare, Two Star, Three Star |
| secret | gradient `--ps-rarity-secret` → `--ps-rarity-secret-2` | Secret Rare, Hyper rare, Mega Hyper Rare, Crown, Black White Rare, Futuristic Rare, Pikachu Rare |
| promo | `--ps-rarity-promo` | Promo |
| unknown | `--ps-rarity-unknown` | None, null, anything not listed |

The Diamond, Star, Shiny and Crown strings are TCG Pocket rarities. They appear in the EN list even though Pocket cards are not physical; the mapping is harmless if they never occur in owned data.

Render: an 8 px dot (for secret, an 8 px dot with the 2-stop gradient) plus the label in `--ps-fg-muted` caption. If TCGdex adds a string later, it falls to `unknown` until the fixture is extended. Never guess.

### 8.2 Condition badge

Pill, 20 px tall, `--ps-radius-xs`, micro text, solid fill with a paired foreground token:

| Value | Fill / text tokens | Label | Accessible name |
|---|---|---|---|
| NM | `--ps-cond-nm` / `--ps-on-cond-nm` | NM | "Near Mint" |
| LP | `--ps-cond-lp` / `--ps-on-cond-lp` | LP | "Lightly Played" |
| MP | `--ps-cond-mp` / `--ps-on-cond-mp` | MP | "Moderately Played" |
| HP | `--ps-cond-hp` / `--ps-on-cond-hp` | HP | "Heavily Played" |
| DMG | `--ps-cond-dmg` / `--ps-on-cond-dmg` | DMG | "Damaged" |
| null | `--ps-cond-unknown` / `--ps-on-cond-unknown` | ? | "Condition not recorded" |

Put `aria-label` with the long name on the badge; `<abbr title>` is unreliable on touch and with VoiceOver.

### 8.3 Grade badge (a graded copy replaces the condition badge)

- Style: "slab label", an inverted pill (`--ps-grade-bg` / `--ps-grade-fg`), 20 px tall.
- Two text runs:
  - company (micro, 650, uppercase, 70 % opacity);
  - grade (micro, 800, tabular).
- Examples: `PSA 10`, `BGS 9.5`, `CGC Authentic`. Company `other` shows its `companyLabel`.
- A grade of exactly `10` (any company), or the labels `Pristine` / `Black Label`, gets a 1.5 px `--ps-grade-gem-ring` outline.
- Accessible name: "Graded PSA 10".
- No company logos: they are trademarks.

### 8.4 Variant chip

A text chip over the art's top-right corner: dark-glass `--ps-variant-bg` with `--ps-variant-fg`, 18 px tall, micro text. Labels map 1:1 to the DATA-MODEL enum:

| Enum | Chip | Shown on tile? |
|---|---|---|
| normal | (none) | no — Card Details says "Normal" |
| holo | Holo | yes, 1 px border gradient `--ps-variant-foil-a → -foil-b` |
| reverse_holo | Rev | yes, same foil border |
| first_edition | 1st | yes (+ `variantDetail` holo → "1st Holo") |
| promo_stamped | Stamp | yes |
| shadowless | Shdwl | yes |
| other | `variantDetail` truncated to 10 chars | yes |

The accessible name uses the full words ("Reverse holo", "First edition holo").

### 8.5 Quantity badge

- Placement: top-left of the art.
- Style: pill `--ps-qty-bg` / `--ps-qty-fg`, micro 700 tabular, text `×3`.
- Rendered **only when the group's copy count is > 1**. This follows the owner ruling: one tile per card + variant, with ×N.
- It pops (`--ps-pop-scale`, spring) when it increments after an add.

### 8.6 Price text

- Format integer cents with `Intl.NumberFormat(locale, {style:'currency', currency})`, which gives `$1.23` or `€0,45` in the device locale. The currency symbol is always visible.
- `null`:
  - tiles and rows render **nothing**;
  - Card Details renders "No price data" in `--ps-fg-subtle`.
- Never show `$0.00` as a stand-in. A real stored `0` renders `$0.00`.
- Gain/loss always prints its sign:
  - `+$4.20` in `--ps-positive`;
  - `−$1.10` (U+2212 minus) in `--ps-negative`;
  - `$0.00` in `--ps-fg-muted`.
- Captions: "Your price" for a manual override; otherwise the source, "TCGplayer market" or "Cardmarket trend".
- **Staleness (A2):** prices on device can be old. Wherever a price total is shown, the caption "Prices as of 30 Oct 2026" (the latest source `updated`) is visible (UX.md §3).

### 8.7 Card art frame, "no image" and "image unavailable"

Frame:
- `aspect-ratio: var(--ps-card-aspect)`, `border-radius: var(--ps-radius-card)`, `overflow:hidden`.
- `background: var(--ps-skeleton-base)`, `box-shadow: var(--ps-shadow-card)`.
- `<img>` fills the frame with `object-fit: cover`. Give it `width/height` attributes, 245×337 (low) or 600×825 (high).
- Set `-webkit-touch-callout: none` on art so the iOS long-press image menu never appears.

Two placeholder states, the same look with different meaning:
- **No catalog image** (`imageUrl` null). This is common: in our 2026-10-30 survey only 3,882 of 12,781 JA entries and 21,987 of 23,736 EN entries carry an `image`.
  - Fill `--ps-art-empty-bg` with a 1 px dashed `--ps-art-empty-border`.
  - Centred card name (caption 600, max 3 lines), then set name + `#localId` (micro, muted).
  - A 2 px top stripe in the rarity tier colour.
  - SR text: "No catalog image".
- **Image unavailable** (A2: a URL exists but the load failed, offline or not in the WebView cache).
  - Same placeholder, plus a 16 px `CloudOff` glyph in `--ps-fg-subtle` in the bottom-right corner.
  - SR text: "Image not loaded".
  - When the network comes back online, retry once by remounting the `<img>`. Never retry in a loop.

## 9. Tailwind v4 mapping

`apps/mobile/src/styles/globals.css` is implementer-owned. Paste this verbatim and extend it only through new tokens:

```css
@import "tailwindcss";
@import "./tokens.css";
@import "@fontsource-variable/inter";   /* bundled; iOS ignores it (system font) */

/* dark: variant follows our attribute, not the OS */
@custom-variant dark (&:where([data-theme="dark"], [data-theme="dark"] *, :root:not([data-theme]) *));
/* platform variants for BEHAVIOUR tweaks only (sizes/colours come from tokens) */
@custom-variant ios (&:where(.platform-ios, .platform-ios *));
@custom-variant android (&:where(.platform-android, .platform-android *));

@theme inline {
  /* spacing stays px so large text doesn't widen gutters (DESIGN-TOKENS §4.2) */
  --spacing: 4px;

  --font-sans: var(--ps-font-sans);
  --font-mono: var(--ps-font-mono);

  --color-bg: var(--ps-bg);
  --color-surface: var(--ps-surface);
  --color-surface-2: var(--ps-surface-2);
  --color-surface-3: var(--ps-surface-3);
  --color-overlay: var(--ps-overlay);
  --color-border: var(--ps-border);
  --color-border-strong: var(--ps-border-strong);
  --color-border-input: var(--ps-border-input);
  --color-fg: var(--ps-fg);
  --color-fg-muted: var(--ps-fg-muted);
  --color-fg-subtle: var(--ps-fg-subtle);
  --color-fg-disabled: var(--ps-fg-disabled);
  --color-accent: var(--ps-accent);
  --color-accent-hover: var(--ps-accent-hover);
  --color-accent-pressed: var(--ps-accent-pressed);
  --color-on-accent: var(--ps-on-accent);
  --color-accent-fg: var(--ps-accent-fg);
  --color-accent-soft: var(--ps-accent-soft);
  --color-focus: var(--ps-focus-ring);
  --color-positive: var(--ps-positive);
  --color-positive-soft: var(--ps-positive-soft);
  --color-negative: var(--ps-negative);
  --color-negative-soft: var(--ps-negative-soft);
  --color-warning: var(--ps-warning);
  --color-warning-soft: var(--ps-warning-soft);
  --color-info: var(--ps-info);
  --color-info-soft: var(--ps-info-soft);
  --color-danger: var(--ps-danger-solid);
  --color-on-danger: var(--ps-on-danger);
  --color-chrome: var(--ps-chrome-bg);
  --color-chrome-border: var(--ps-chrome-border);
  --color-chrome-accent: var(--ps-chrome-accent-fg);
  --color-tab-indicator: var(--ps-tab-indicator-bg);
  --color-sheet-handle: var(--ps-sheet-handle);
  --color-rarity-common: var(--ps-rarity-common);
  --color-rarity-uncommon: var(--ps-rarity-uncommon);
  --color-rarity-rare: var(--ps-rarity-rare);
  --color-rarity-holo: var(--ps-rarity-holo);
  --color-rarity-ultra: var(--ps-rarity-ultra);
  --color-rarity-illustration: var(--ps-rarity-illustration);
  --color-rarity-secret: var(--ps-rarity-secret);
  --color-rarity-secret-2: var(--ps-rarity-secret-2);
  --color-rarity-promo: var(--ps-rarity-promo);
  --color-rarity-unknown: var(--ps-rarity-unknown);
  --color-cond-nm: var(--ps-cond-nm);       --color-on-cond-nm: var(--ps-on-cond-nm);
  --color-cond-lp: var(--ps-cond-lp);       --color-on-cond-lp: var(--ps-on-cond-lp);
  --color-cond-mp: var(--ps-cond-mp);       --color-on-cond-mp: var(--ps-on-cond-mp);
  --color-cond-hp: var(--ps-cond-hp);       --color-on-cond-hp: var(--ps-on-cond-hp);
  --color-cond-dmg: var(--ps-cond-dmg);     --color-on-cond-dmg: var(--ps-on-cond-dmg);
  --color-cond-unknown: var(--ps-cond-unknown); --color-on-cond-unknown: var(--ps-on-cond-unknown);
  --color-grade-bg: var(--ps-grade-bg);
  --color-grade-fg: var(--ps-grade-fg);
  --color-grade-gem: var(--ps-grade-gem-ring);
  --color-variant-bg: var(--ps-variant-bg);
  --color-variant-fg: var(--ps-variant-fg);
  --color-qty-bg: var(--ps-qty-bg);
  --color-qty-fg: var(--ps-qty-fg);
  --color-art-empty: var(--ps-art-empty-bg);
  --color-art-empty-border: var(--ps-art-empty-border);
  --color-skeleton: var(--ps-skeleton-base);
  --color-skeleton-hi: var(--ps-skeleton-highlight);

  --text-display: var(--ps-text-display);
  --text-display--line-height: var(--ps-text-display-lh);
  --text-display--font-weight: var(--ps-text-display-weight);
  --text-display--letter-spacing: var(--ps-text-display-tracking);
  --text-h1: var(--ps-text-h1);
  --text-h1--line-height: var(--ps-text-h1-lh);
  --text-h1--font-weight: var(--ps-text-h1-weight);
  --text-h1--letter-spacing: var(--ps-text-h1-tracking);
  --text-h2: var(--ps-text-h2);
  --text-h2--line-height: var(--ps-text-h2-lh);
  --text-h2--font-weight: var(--ps-text-h2-weight);
  --text-h2--letter-spacing: var(--ps-text-h2-tracking);
  --text-h3: var(--ps-text-h3);
  --text-h3--line-height: var(--ps-text-h3-lh);
  --text-h3--font-weight: var(--ps-text-h3-weight);
  --text-body: var(--ps-text-body);
  --text-body--line-height: var(--ps-text-body-lh);
  --text-small: var(--ps-text-small);
  --text-small--line-height: var(--ps-text-small-lh);
  --text-caption: var(--ps-text-caption);
  --text-caption--line-height: var(--ps-text-caption-lh);
  --text-micro: var(--ps-text-micro);
  --text-micro--line-height: var(--ps-text-micro-lh);
  --text-micro--font-weight: var(--ps-text-micro-weight);
  --text-micro--letter-spacing: var(--ps-text-micro-tracking);
  --text-tab: var(--ps-tab-label-size);
  --text-bar-title: var(--ps-topbar-title-size);

  --radius-xs: var(--ps-radius-xs);
  --radius-sm: var(--ps-radius-sm);
  --radius-md: var(--ps-radius-md);
  --radius-lg: var(--ps-radius-lg);
  --radius-xl: var(--ps-radius-xl);
  --radius-sheet: var(--ps-sheet-radius);
  --radius-card: var(--ps-radius-card);

  --shadow-1: var(--ps-shadow-1);
  --shadow-2: var(--ps-shadow-2);
  --shadow-3: var(--ps-shadow-3);
  --shadow-card: var(--ps-shadow-card);
  --shadow-scan: var(--ps-shadow-scan);

  --ease-standard: var(--ps-ease-standard);
  --ease-decelerate: var(--ps-ease-decelerate);
  --ease-accelerate: var(--ps-ease-accelerate);
  --ease-spring: var(--ps-ease-spring);
  --ease-page: var(--ps-ease-page);
  --ease-sheet: var(--ps-ease-sheet);

  --aspect-card: var(--ps-card-aspect);

  --animate-shimmer: ps-shimmer var(--ps-dur-shimmer) linear infinite;
  @keyframes ps-shimmer { from { background-position: 200% 0; } to { background-position: -200% 0; } }
}

html {
  color-scheme: dark;
  font-size: var(--ps-root-font-size);           /* Dynamic Type / font scale, §4.2 */
  -webkit-text-size-adjust: 100%;
  text-size-adjust: 100%;
  background: var(--ps-bg);                      /* overscroll / rubber band shows bg, never white */
}
html[data-theme="light"] { color-scheme: light; }
body {
  background: var(--ps-bg); color: var(--ps-fg); font-family: var(--ps-font-sans);
  -webkit-tap-highlight-color: transparent;
}
button, a, [role="button"], nav, .no-select { -webkit-user-select: none; user-select: none; touch-action: manipulation; }
img { -webkit-touch-callout: none; }
:focus-visible { outline: 2px solid var(--ps-focus-ring); outline-offset: 2px; }
@media (prefers-reduced-motion: reduce) { .animate-shimmer { animation: none; } }
```

Notes:
- Durations have no Tailwind theme namespace. Use the v4 CSS-variable shorthand: `duration-(--ps-dur-fade-fast)`, `duration-(--ps-dur-move)`.
- Safe areas use the arbitrary-value form: `pt-(--ps-safe-top)`, `pb-(--ps-content-pad-bottom)`, `h-(--ps-tabbar-total)`.
- Example tile: `aspect-card rounded-card shadow-card bg-skeleton overflow-hidden transition-[transform,opacity] duration-(--ps-dur-move-fast) ease-standard active:scale-(--ps-press-scale)`.
- `@theme inline` is required, not plain `@theme`. The values reference runtime variables that change with theme, platform and text size; `inline` makes utilities emit `var(--ps-…)` instead of freezing the value at build time.
- Text selection stays enabled in notes, card info and the privacy and license texts. Only chrome and controls are unselectable.
- The document is the scroll container; do not put the page in a scrolling `div`. That keeps the iOS status-bar tap to scroll to top and the native rubber band.

## 10. Fonts, app icon and splash

### 10.1 Font decision
- **iOS: system font (SF Pro).** The owner judges the app on an iPhone, where SF is what "native" looks like. It costs 0 bytes and follows Dynamic Type metrics. Card-name truncation is designed with ellipsis, so the small width difference from Inter doesn't matter.
- **Android and web: Inter Variable, bundled** (`@fontsource-variable/inter`, OFL-1.1, listed in Licenses). Roboto and Segoe UI differ in width; Inter gives the dev browser and Android the same tabular figures and a clear `1/l/I` distinction for `136/189` and `SV1a-011`.
- **Japanese:** no CJK webfont. iOS uses Hiragino, Android uses Noto Sans CJK and Windows uses Yu Gothic/Meiryo.

### 10.2 Colour of native surfaces
Use `#0b0d12` (dark `--ps-bg`) for:
- the iOS LaunchScreen background;
- Android `windowBackground` / `android:windowSplashScreenBackground`;
- Capacitor `backgroundColor` (iOS and Android), so no white flash ever shows before or between WebView paints.

### 10.3 App icon and splash (App Store compliance; asset production is Terra's)

**Mark concept: "foil glint".**
- Two overlapping, slightly rotated card silhouettes at 63:88 with the `--ps-radius-card` corner ratio, in off-white `#f2f4f8`.
- A single diagonal **specular streak** in a yellow → amber gradient (`#ffcb05 → #f59e0b`) across the front card. The streak is the "flash" of a holo card catching light, which is where the name FlashyDex comes from.
- Flat shapes, no text, no outline glow.

Hard exclusions, so App Review (guideline 5.2.1) and trademark law have nothing to hold on to:
- No Poké Ball: no red/white split circle, no horizontal band with a centre button, no circle-in-band motif at all.
- No Pokémon characters or silhouettes, no ears or tails, and **no lightning bolt**. A yellow bolt on a dark tile reads as the electric mouse.
- No Pokémon logo yellow+blue pairing, the logotype outline style or the word "Pokémon"/"Poké". No "Dex" device that mimics the Pokédex hardware (red handheld, hinge, round lens).
- No real card art, card backs or energy symbols.

**iOS 18 appearance variants.** Use an Xcode asset catalog `AppIcon` with "Single Size" 1024×1024 per appearance. Do not use alpha in the light icon.

| Variant | Background | Foreground |
|---|---|---|
| Light (default) | `#0b0d12` full bleed, a subtle top-left lift to `#12151c` | cards `#f2f4f8`, glint `#ffcb05→#f59e0b` |
| Dark | transparent (iOS supplies its dark backdrop) | same foreground; glint unchanged; cards `#e3e6ec` |
| Tinted | transparent | one grayscale layer: cards at 100 % white, glint at 60 % white. iOS applies the tint; it must read in silhouette alone |

The design must hold at 29 pt: the glint must not be thinner than 1/24 of the icon. Keep all content inside the central ~80 % (corner mask).

Later iOS versions (Liquid Glass): the current HIG lists Default, Dark, Clear light, Clear dark, Tinted light and Tinted dark appearances, and the system generates any you don't supply (see `docs/APP-STORE-COMPLIANCE.md` → Icons). Preferred: an Icon Composer `.icon` file with the two layers (cards, glint) as separate groups, so the system can apply glass and specular effects and the generated clear/tinted variants stay crisp. Minimum: the three asset-catalog wells above. Check every appearance on a device before submitting, because auto-generation can muddy a thin glint.

**Android.**
- Adaptive icon: background layer `#0b0d12`; foreground = the mark inside the 66 dp safe zone of the 108 dp canvas.
- **Monochrome layer** (Android 13+ themed icons) = the tinted-variant artwork.
- Legacy round/square PNGs are generated from the same source.

**Splash.**
- The mark alone (no wordmark) centred on `#0b0d12`.
- iOS: LaunchScreen storyboard image at 120×120 pt.
- Android 12+ SplashScreen API: the icon fills the 240 dp circle area, kept inside its 160 dp inner circle.
- Hide it with `@capacitor/splash-screen`: `launchAutoHide: false`, then `SplashScreen.hide({ fadeOutDuration: 200 })` once the DB is open, migrations have run and the first route has rendered, with a 3 s safety timeout. The splash stays dark in the light theme on purpose; the 200 ms fade covers the switch.

**PWA icons** (192/512 + maskable) use the same artwork on `#0b0d12`.

**Store screenshots.** No card art and no Pokémon names. Use:
- empty states, onboarding, settings and the privacy screen;
- screens populated with **custom cards** that use the app's own abstract placeholder art, with generic names (e.g. "Sample card 001").

Store screenshots are owner/marketing work; this rule is here so nobody screenshots a real Charizard.

## 11. Verification

- **Contrast:** every text pair in §3 was measured with a WCAG luminance script.
  - The A2 script and output are summarised in `.agent/reports/opus-ux-v2-report.md`: 50 pairs, 0 fail. It covers translucent chrome over white and black, the Android indicator, the sync pill, warning/info chips, the high-contrast overrides, the sheet handle and the splash mark.
  - `--ps-fg-disabled` and the decorative `--ps-border`/`--ps-border-strong` are intentionally < 3:1. Never use them for meaningful boundaries or text.
- **tokens.css** contains only custom properties: `grep -nE '^\s*[a-z][a-z-]*\s*:'` returns 0 matches, and braces balance (20/20).
- **Parse check:** the file was parsed by Chromium (13 rules). These computed values were verified:
  - base 56/64 bars and 44 px tap;
  - `.platform-ios` 44/50 bars, translucent chrome and the system font;
  - `.platform-ios[data-text-size=ax]` 52 px bar and 150 px tile;
  - `.platform-android` 64 px bar, 56 px indicator and 28 px sheet radius;
  - `.has-sync-pill` content padding 120 px (64 + 32 + 8 + 16);
  - light `--ps-warning` `#9a4806`;
  - at `--ps-text-scale: 1.5`: root 24 px, tap clamped to 56 px, display capped at 48 px;
  - under reduced motion `--ps-page-enter-x` is `0px`, even with `.platform-ios`.
- **Implementer acceptance:** no raw hex in components. `grep -rnE "#[0-9a-fA-F]{3,8}\b" apps/mobile/src --include=*.tsx` should return nothing outside comments.
