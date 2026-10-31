# Design tokens

Owner: Opus (UX lead). Implementation file: `apps/web/src/styles/tokens.css` (CSS custom properties only, every name prefixed `--ps-`).
Consumers: Tailwind v4 via `@theme inline` (mapping in §9) and, rarely, raw `var(--ps-…)` in component CSS.
Rule for implementers: **no hex values, px font sizes or ad-hoc durations in components.** If a value is missing, request it in `.agent/reports/<role>-requests.md`; do not invent one.

Contents: 1 Principles · 2 Theming · 3 Color · 4 Type · 5 Space & layout · 6 Radii, shadows, layers · 7 Motion · 8 Domain badges (rarity, condition, grade, variant, quantity, price) · 9 Tailwind v4 mapping · 10 Font decision · 11 Verification.

---

## 1. Principles

1. **Card art is the hero.** Chrome is near-black/neutral so printed card colors read true. The only saturated UI color is the accent yellow, used for the primary action, focus and the quantity badge.
2. **Dark by default.** Collectors look at a phone in a living room at night; a white UI next to holo art glares. Light theme exists and is fully specified.
3. **Never color alone.** Rarity, condition, gain/loss always pair color with text or a sign (`+$4.20`, `NM`, `● Rare`).
4. **Elevation by surface, not shadow** in dark mode (shadows are invisible on near-black). Light mode uses soft shadows.
5. **Motion confirms, never decorates.** Movement is removed under `prefers-reduced-motion`; fades/color feedback stay so taps still feel acknowledged.

## 2. Theming

- Attribute: `<html data-theme="dark" | "light">`. Dark applies when the attribute is missing (`:root` carries the dark values), so a no-JS render is dark.
- User setting `theme` ∈ `dark` (default) | `light` | `system`, stored in `localStorage["ps-theme"]` (client preference, not collection data — not exported).
- No-flash inline script in `app/layout.tsx` `<head>` (implementer writes it; ~10 lines): read `ps-theme`; if `system`, resolve with `matchMedia('(prefers-color-scheme: light)')`; set `document.documentElement.dataset.theme`. When `system`, also subscribe to the media query change. `suppressHydrationWarning` on `<html>`.
- `<meta name="theme-color">`: two tags with `media="(prefers-color-scheme: dark)"` → `#0b0d12` and light → `#f6f7f9`; when the user forces a theme, the script rewrites a single tag to the matching `--ps-bg`.
- `color-scheme` (a real property, so not in tokens.css) is set in globals.css: `html{color-scheme:dark}` `html[data-theme=light]{color-scheme:light}` — gives native dark scrollbars, date pickers and autofill.

## 3. Color

All pairs below were measured (WCAG 2.x relative luminance; script output in the Opus report). Text pairs ≥ 4.5:1, UI boundaries ≥ 3:1.

### 3.1 Neutrals and surfaces

| Token | Dark (default) | Light | Use |
|---|---|---|---|
| `--ps-bg` | `#0b0d12` | `#f6f7f9` | page background, behind tiles |
| `--ps-surface` | `#12151c` | `#ffffff` | panels, list groups, top bar, bottom nav |
| `--ps-surface-2` | `#1a1e27` | `#eef0f4` | inputs, chips (unselected), hovered rows |
| `--ps-surface-3` | `#232835` | `#e3e6ec` | pressed rows, segmented-control track |
| `--ps-overlay` | `rgb(5 6 10/.72)` | `rgb(14 17 22/.45)` | sheet/dialog scrim |
| `--ps-border` | `#262c3a` | `#d9dde5` | hairlines between rows/panels (decorative) |
| `--ps-border-strong` | `#3a4256` | `#b9bfcc` | dividers, hover outline (decorative) |
| `--ps-border-input` | `#687186` | `#848c9e` | text inputs, checkboxes, toggles (≥ 3:1) |
| `--ps-fg` | `#f2f4f8` 17.6:1 | `#0e1116` 18.9:1 | primary text |
| `--ps-fg-muted` | `#a3abbd` 8.4:1 | `#4a5263` 7.8:1 | secondary text (set name, meta) |
| `--ps-fg-subtle` | `#7d8699` 5.3:1 | `#646c7d` 5.3:1 | tertiary text, placeholders, timestamps |
| `--ps-fg-disabled` | `#4f5668` | `#a6acb8` | disabled labels only (exempt from contrast) |

### 3.2 Accent and status

| Token | Dark | Light | Use |
|---|---|---|---|
| `--ps-accent` | `#ffcb05` | `#ffcb05` | primary button fill, Scan button, selected chip fill |
| `--ps-accent-hover` / `-pressed` | `#ffd83d` / `#e6b600` | same | button states |
| `--ps-on-accent` | `#1a1400` (12.1:1) | same | text/icons on accent |
| `--ps-accent-fg` | `#ffcb05` (12.8:1) | `#8a6a00` (5.1:1) | accent used **as text** (links, active nav label) |
| `--ps-accent-soft` | 14 % yellow | 22 % yellow | selected-row tint, active nav pill |
| `--ps-focus-ring` | `#ffcb05` | `#1d4ed8` | 2 px focus ring + 2 px offset |
| `--ps-positive` | `#34d399` | `#047857` | gain (`+`), success toasts, "Synced" |
| `--ps-negative` | `#f87171` | `#b91c1c` | loss (`−`), errors, destructive text |
| `--ps-warning` | `#fbbf24` | `#b45309` | "Catalog incomplete", partial sync |
| `--ps-info` | `#60a5fa` | `#1d4ed8` | neutral notices, sync running |
| `*-soft` variants | 14 % alpha | 8–10 % alpha | banner/badge backgrounds behind the solid text color |
| `--ps-danger-solid` / `--ps-on-danger` | `#dc2626` / white (4.8:1) | `#b91c1c` / white | destructive button fill |

Why yellow: it is the one hue that reads as "Pokémon" without copying a logo, it has huge contrast on near-black (no glow needed), and it is absent from most card frames' UI chrome positions, so the primary action never blends into art.

## 4. Typography

Font: **Inter (variable), self-hosted by `next/font/google`**, latin subset, `display: 'swap'`, `variable: '--font-inter'`. Fallback chain in `--ps-font-sans` adds Japanese system fonts (Hiragino / Noto Sans JP / Yu Gothic / Meiryo) so JA card names render natively without shipping a CJK webfont. Decision rationale in §10.

Numerals: everywhere a number can change or align (prices, counts, collector numbers, progress) use `font-variant-numeric: tabular-nums` (Tailwind `tabular-nums`).

| Role | Token | Size / line | Weight | Tracking | Where |
|---|---|---|---|---|---|
| Display | `--ps-text-display` | 32/38 | 700 | −0.02em | Dashboard estimated value only |
| H1 | `--ps-text-h1` | 28/34 mobile, 32/40 ≥1024 | 700 | −0.015em | page title, card name on Card Details |
| H2 | `--ps-text-h2` | 20/28 | 650 | −0.01em | section headings |
| H3 | `--ps-text-h3` | 17/24 | 600 | 0 | list-group headings, sheet titles |
| Body | `--ps-text-body` | 16/24 | 400 | 0 | default, **all inputs** (16 px prevents iOS zoom) |
| Small | `--ps-text-small` | 14/20 | 400–500 | 0 | secondary lines, buttons in dense rows |
| Caption | `--ps-text-caption` | 13/18 | 400–500 | 0 | tile meta (set · number), helper text |
| Micro | `--ps-text-micro` | 12/16 | 650 | +0.01em | badges/chips only; never body copy |

Rules: H1 never exceeds 2rem. Names truncate with ellipsis on one line in tiles (`title` attr not needed — full name is in the accessible name). Long JA names wrap in Card Details. Body copy max width 65ch.

## 5. Space and layout

- 4 px grid. Tailwind's default `--spacing: 0.25rem` already equals our scale, so `p-4` = 16 px = `--ps-space-4`. The `--ps-space-*` tokens exist for raw CSS.
- `--ps-page-x`: 16 px (<640) · 24 px (≥640) · 32 px (≥1024). `--ps-page-max` 1280 px.
- Card grid: `grid-template-columns: repeat(auto-fill, minmax(var(--ps-tile-min), 1fr))`, gap `--ps-grid-gap`. At 390 px: (390 − 32 − 2×8)/3 = 114 px tiles → **3 columns**; ≥640: 136 px min (4–5 cols); ≥1024 with sidebar: 160 px min (5–7 cols).
- Chrome heights: top bar `--ps-topbar-h` 56 px (+ `--ps-safe-top`); bottom nav `--ps-bottomnav-h` 64 px + `--ps-safe-bottom`; page content gets `padding-bottom: calc(var(--ps-bottomnav-h) + var(--ps-safe-bottom) + 16px)` on mobile so nothing hides behind the nav. Requires `viewport-fit=cover` in the viewport meta.
- Targets: `--ps-tap` 44 px minimum for anything tappable (use padding or a pseudo-element hit-area for small visuals such as the 24 px stepper glyph); `--ps-tap-lg` 48 px for nav items and primary buttons; Scan button `--ps-scan-fab` 60 px.
- Breakpoints (Tailwind defaults): `sm` 640, `md` 768, `lg` 1024 (bottom nav → sidebar), `xl` 1280.

## 6. Radii, shadows, layers

| Token | Value | Use |
|---|---|---|
| `--ps-radius-xs` | 4 px | badges |
| `--ps-radius-sm` | 6 px | chips |
| `--ps-radius-md` | 10 px | buttons, inputs |
| `--ps-radius-lg` | 14 px | panels, list groups, stat tiles |
| `--ps-radius-xl` | 20 px | bottom-sheet top corners, dialogs |
| `--ps-radius-full` | pill | qty badge, nav pill, Scan button |
| `--ps-radius-card` | `4.8% / 3.4%` | **every card-art frame** — elliptical percentages reproduce the real ~3 mm corner of a 63×88 mm card at any size |

Shadows: `--ps-shadow-1/2/3` (rest/raised/sheet), `--ps-shadow-card` (art tiles; gives a printed-card lift in both themes), `--ps-shadow-scan` (ring that cuts the Scan button out of the nav bar + soft yellow glow), `--ps-hairline-top` (1 px inner top highlight on dark surfaces).
Layers: `--ps-z-sticky` 10 · `--ps-z-nav` 30 · `--ps-z-sheet` 40 · `--ps-z-toast` 50.

## 7. Motion

| Token | Value | Reduced motion | Use |
|---|---|---|---|
| `--ps-dur-instant` | 80 ms | kept | pressed color |
| `--ps-dur-fade-fast` | 120 ms | kept | hover/focus/selected color, chip select color |
| `--ps-dur-fade` | 200 ms | kept | image fade-in on load, toast in/out |
| `--ps-dur-fade-slow` | 320 ms | kept | skeleton → content crossfade |
| `--ps-dur-move-fast` | 160 ms | 1 ms | press scale, chip check-mark |
| `--ps-dur-move` | 240 ms | 1 ms | tile enter (opacity + 4 px rise), list reorder |
| `--ps-dur-move-slow` | 360 ms | 1 ms | bottom sheet slide, sidebar collapse |
| `--ps-dur-shimmer` | 1400 ms | 0 → static skeleton | skeleton highlight sweep |
| `--ps-move-y-sm` / `-md` | 4 / 12 px | 0 | enter offsets |
| `--ps-press-scale` | 0.97 | 1 | `:active` scale on tiles/buttons |
| `--ps-pop-scale` | 1.12 | 1 | qty badge "pop" after Add |

Easings: `--ps-ease-standard` (most), `--ps-ease-decelerate` (things entering: sheet open, toast in), `--ps-ease-accelerate` (leaving), `--ps-ease-spring` (qty badge pop / success check only; becomes standard under reduced motion).

Signature micro-interactions (all specified in UX.md, all survive reduced motion as color/opacity changes):
- Add success: Add button morphs to a check + "Added" (color fade), qty badge on the tile pops (scale only without reduced motion).
- Art load: 200 ms opacity fade from the skeleton; never a layout shift because the frame is fixed 63:88.
- Press: tiles/buttons darken (instant) and scale 0.97 (move-fast).
- Chip select: fill color crossfade + check glyph.
Never animate `width/height/top/left`; only `transform` and `opacity`. No parallax, no auto-playing loops except the skeleton shimmer and the sync progress bar's indeterminate state (which becomes a static striped bar under reduced motion).

## 8. Domain badges

### 8.1 Rarity (dot + label, never color alone)

TCGdex rarity strings are mapped to a **tier** by a pure function `rarityTier(rarity: string | null)` (implementer, unit-tested with this table as the fixture). Matching is exact after trimming, case-insensitive. Unknown strings → `unknown` (still show the raw text). JA cards use English rarity strings on TCGdex. The lists below are the complete `GET /v2/en/rarities` (42 values) and `GET /v2/ja/rarities` (22 values) responses fetched 2026-10-30.

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

(The Diamond/Star/Shiny/Crown strings are TCG Pocket rarities; they appear in the EN rarity list even though Pocket cards are not physical — the mapping is harmless if they never occur in owned data.)

Render: 8 px dot (secret = 8 px dot with the 2-stop linear gradient) + label in `--ps-fg-muted` caption. If TCGdex adds a string later it falls to `unknown` until the fixture is extended — never guess.

### 8.2 Condition badge

Pill, 20 px tall, `--ps-radius-xs`, micro text, solid fill + paired foreground token:

| Value | Fill / text tokens | Label | Accessible name |
|---|---|---|---|
| NM | `--ps-cond-nm` / `--ps-on-cond-nm` | NM | "Near Mint" |
| LP | `--ps-cond-lp` / `--ps-on-cond-lp` | LP | "Lightly Played" |
| MP | `--ps-cond-mp` / `--ps-on-cond-mp` | MP | "Moderately Played" |
| HP | `--ps-cond-hp` / `--ps-on-cond-hp` | HP | "Heavily Played" |
| DMG | `--ps-cond-dmg` / `--ps-on-cond-dmg` | DMG | "Damaged" |
| null | `--ps-cond-unknown` / `--ps-on-cond-unknown` | ? | "Condition not recorded" |

`<abbr title>` is not reliable on touch; use `aria-label` on the badge with the long name.

### 8.3 Grade badge (graded copy replaces the condition badge)

"Slab label" style: inverted pill (`--ps-grade-bg` / `--ps-grade-fg`), 20 px tall, two text runs: company (micro, 650, uppercase, 70 % opacity) + grade (micro, 800, tabular): `PSA 10`, `BGS 9.5`, `CGC Authentic`, `other` shows its `companyLabel`. A grade of exactly `10` (any company) or labels `Pristine` / `Black Label` get a 1.5 px `--ps-grade-gem-ring` outline. Accessible name: "Graded PSA 10". No company logos (trademarks).

### 8.4 Variant chip

Text chip over the art's top-right corner (dark-glass `--ps-variant-bg` + `--ps-variant-fg`, 18 px tall, micro text). Labels map 1:1 to the DATA-MODEL enum:

| Enum | Chip | Shown on tile? |
|---|---|---|
| normal | (none) | no — normal is the default; details screen says "Normal" |
| holo | Holo | yes, 1 px border with gradient `--ps-variant-foil-a → -foil-b` |
| reverse_holo | Rev | yes, same foil border |
| first_edition | 1st | yes (+ `variantDetail` holo → "1st Holo") |
| promo_stamped | Stamp | yes |
| shadowless | Shdwl | yes |
| other | `variantDetail` truncated to 10 chars | yes |

Accessible name uses the full word ("Reverse holo", "First edition holo").

### 8.5 Quantity badge

Top-left of the art: pill `--ps-qty-bg` / `--ps-qty-fg`, micro 700 tabular, text `×3`. Rendered **only when the group count > 1** (the duplicate signal). Pops (`--ps-pop-scale`, spring) when it increments after an add.

### 8.6 Price text

- Format with `Intl.NumberFormat(locale, {style:'currency', currency})` from integer cents: `$1.23`, `€0,45` follows the owner's locale; currency symbol always visible.
- `null` → render **nothing** in tiles/rows; in Card Details render "No price data" in `--ps-fg-subtle`. Never `$0.00` as a stand-in. A real stored `0` renders `$0.00` (DATA-MODEL: 0 means known zero).
- Gain/loss: `+$4.20` in `--ps-positive`, `−$1.10` (U+2212 minus) in `--ps-negative`, `$0.00` in `--ps-fg-muted`. Sign is always printed.
- Manual override shows a small "Your price" caption; source otherwise shown as "TCGplayer market" / "Cardmarket trend".

### 8.7 Card art frame and "no image" placeholder

Frame: `aspect-ratio: var(--ps-card-aspect)`, `border-radius: var(--ps-radius-card)`, `overflow:hidden`, `background: var(--ps-skeleton-base)`, `box-shadow: var(--ps-shadow-card)`. `<img>` fills it with `object-fit: cover`, `width/height` attributes 245×337 (low) or 600×825 (high) so the browser reserves space even before CSS.

No catalog image (common: in our 2026-10-30 survey **only 3,882 of 12,781 JA card entries and 21,987 of 23,736 EN entries carry an `image` URL**): render a real placeholder, not fake art — `--ps-art-empty-bg` fill, 1 px dashed `--ps-art-empty-border`, centered card name (caption 600, max 3 lines), set name + `#localId` (micro, muted), and a 2 px top stripe in the card's rarity tier color. Text "No catalog image" is announced only to screen readers (the visible name already identifies it).

## 9. Tailwind v4 mapping

`apps/web/src/app/globals.css` (implementer owns this file; paste verbatim, extend only via new tokens):

```css
@import "tailwindcss";
@import "../styles/tokens.css";

/* dark: variant follows our attribute, not the OS */
@custom-variant dark (&:where([data-theme="dark"], [data-theme="dark"] *, :root:not([data-theme]) *));

@theme inline {
  /* fonts */
  --font-sans: var(--ps-font-sans);
  --font-mono: var(--ps-font-mono);

  /* colors → bg-*, text-*, border-*, ring-*, fill-* */
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

  /* type → text-display, text-h1, ... (size + line-height + weight + tracking) */
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

  /* radii → rounded-* */
  --radius-xs: var(--ps-radius-xs);
  --radius-sm: var(--ps-radius-sm);
  --radius-md: var(--ps-radius-md);
  --radius-lg: var(--ps-radius-lg);
  --radius-xl: var(--ps-radius-xl);
  --radius-card: var(--ps-radius-card);

  /* shadows → shadow-* */
  --shadow-1: var(--ps-shadow-1);
  --shadow-2: var(--ps-shadow-2);
  --shadow-3: var(--ps-shadow-3);
  --shadow-card: var(--ps-shadow-card);
  --shadow-scan: var(--ps-shadow-scan);

  /* easings → ease-* */
  --ease-standard: var(--ps-ease-standard);
  --ease-decelerate: var(--ps-ease-decelerate);
  --ease-accelerate: var(--ps-ease-accelerate);
  --ease-spring: var(--ps-ease-spring);

  /* aspect → aspect-card */
  --aspect-card: var(--ps-card-aspect);

  /* skeleton shimmer → animate-shimmer */
  --animate-shimmer: ps-shimmer var(--ps-dur-shimmer) linear infinite;
  @keyframes ps-shimmer { from { background-position: 200% 0; } to { background-position: -200% 0; } }
}

html { color-scheme: dark; }
html[data-theme="light"] { color-scheme: light; }
body { background: var(--ps-bg); color: var(--ps-fg); font-family: var(--ps-font-sans); -webkit-tap-highlight-color: transparent; }
:focus-visible { outline: 2px solid var(--ps-focus-ring); outline-offset: 2px; }
@media (prefers-reduced-motion: reduce) { .animate-shimmer { animation: none; } }
```

Durations have no Tailwind theme namespace; use the v4 CSS-variable shorthand: `duration-(--ps-dur-fade-fast)`, `duration-(--ps-dur-move)`. Spacing uses Tailwind defaults (identical 4 px scale). Example tile: `aspect-card rounded-card shadow-card bg-skeleton overflow-hidden transition-[transform,opacity] duration-(--ps-dur-move-fast) ease-standard active:scale-(--ps-press-scale)`.

`@theme inline` is required (not plain `@theme`) because values reference runtime variables that change with `data-theme`; inline makes utilities emit `var(--ps-…)` rather than freezing the value at build time.

## 10. Font decision — Inter via next/font (not a raw Google Fonts link, not system-only)

- **Performance on phone:** `next/font` downloads the font at build time and serves it from our own origin (works on the LAN and offline once cached; zero third-party request). Latin subset of Inter variable ≈ 45–50 KB woff2, one file, preloaded. `adjustFontFallback` (default) generates a size-adjusted local fallback, so swap causes no layout shift (CLS ≈ 0).
- **Why not system-only:** Android (Roboto), iOS (SF) and Windows (Segoe) differ in width; card-name truncation and tabular price columns would look different on the owner's phone vs. the PC. Inter has true tabular figures and a clear `1/l/I` distinction, which matters for collector numbers like `136/189` and `SV1a-011`.
- **Japanese:** Inter has no CJK glyphs; the fallback chain hands JA names to Hiragino (iOS), Noto Sans JP (Android), Yu Gothic UI/Meiryo (Windows). No CJK webfont (multi-MB) is shipped.
- **Single weight axis**: load the variable font with weights 400–800; no italics.

## 11. Verification

- Contrast: every text pair in §3 measured with a WCAG luminance script (results in `.agent/reports/opus-ux-report.md`); `--ps-fg-disabled` and `--ps-border`/`--ps-border-strong` are intentionally below 3:1 because they are decorative or disabled-only — never use them for meaningful boundaries or text.
- `tokens.css` contains only custom properties (checked with a grep for non-`--ps-` declarations: zero matches).
- Implementer acceptance: no raw hex in `apps/web/src/**/*.tsx` (`grep -rnE "#[0-9a-fA-F]{3,8}\b" apps/web/src --include=*.tsx` should return nothing outside comments).
