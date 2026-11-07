# FlashyDex — Phase 1 UX specification

Owner: Opus (UX lead). Implementer: Sonnet. Build this pixel-faithfully. Tokens: `docs/DESIGN-TOKENS.md` + `apps/mobile/src/styles/tokens.css`.

**Stage A2 (2026-10-30/31): native iOS/Android, local-first.** FlashyDex is a Capacitor 7 app (iOS first, Android buildable). Its web build runs in a desktop browser for development and as a PWA. All data lives on the device. There is no FlashyDex server, and the app works with no network at all.

Contract alignment:
- **Screen data** comes from the `packages/core` interfaces in `docs/API.md`: `CatalogRepo`, `CollectionRepo`, `PortfolioService`, `SyncService`, `SettingsRepo`, `TransferService`, `BackupService` and `Platform`. The UI calls them through TanStack Query hooks in `apps/mobile/src/data/`.
- **Catalog install** follows `docs/COMPRESSION-STORAGE.md`: versioned zstd catalog packs per language, `.fdx` backups.
- Where an interface is still missing, this doc names it and lists it in `.agent/reports/opus-ux-v2-requests.md` together with a working fallback.
- Precedence: if API.md names differ, API.md wins for names; this doc wins for what the screen shows and says.

Real example data used throughout: **Furret · Darkness Ablaze · 136/189** (`en` / `swsh3-136`, rarity Uncommon, variants normal + reverse, set official 189 / total 201).
- Prices in wireframes are shown as `$—`/`€—`. The UI renders whatever the latest PriceSnapshot holds, and nothing when it is null.
- Personal values (copy counts, "Binder A", dates, "412 cards") are layout filler for the owner's own data. They are never seed data; the app starts empty.

What changed in A2:
- New: §15 first run, §16 offline behaviour, §17 native conventions, §18 icon and splash.
- Shell: safe areas, sheets, back gestures and the sync pill (§1–2).
- Routes are TanStack Router file routes (§1.1).
- Every "your PC / server / LAN" state is gone.
- Settings gained Catalog, About, Privacy, Licenses and a Danger zone (§10).
- The collection grid now uses API.md's binding `groupBy:'card'`.
- The add form leaves condition unset by default (API.md "UX mapping").

Section numbers 0–14 are unchanged from Stage A because other docs link to them (RECOGNITION-DESIGN links to §7.3 and §11.2).

Contents
0. Global rules
1. App shell and navigation
2. Shared components
3. Dashboard
4. Collection
5. Card Details (+ copy editor)
6. Sets and Set detail
7. Add flow
8. Storage locations
9. Custom cards
10. Settings, Catalog, Data, About
11. Scanner (Phase 3 design; disabled in Phase 1)
12. Global states and copy
13. Accessibility checklist
14. Acceptance hooks
15. First run / onboarding
16. Offline and network behaviour; download pause/resume
17. iOS/Android native conventions
18. App icon and splash

---

## 0. Global rules (apply to every screen)

1. **390 px first.** No horizontal scroll at 390 × 844 (Playwright asserts `document.documentElement.scrollWidth <= 390`). Then 768 and ≥ 1024 (web, PWA, iPad).
2. **Card art is always 63:88** (`aspect-card rounded-card`). Space is reserved before the image loads.
   - `…/low.webp` in grids, lists, search and sets; `…/high.webp` only on Card Details hero and zoom (COMPRESSION-STORAGE image policy).
   - Missing image → "No catalog image" placeholder. Failed load (offline, not cached) → "Image not loaded" placeholder (DESIGN-TOKENS §8.7). Never a stock or fake image.
3. **No fabricated data.**
   - Null price → hidden (tiles, rows) or "No price data" (details).
   - Unknown condition → `?` badge.
   - Incomplete catalog → "Catalog incomplete", never a fake %.
   - Old prices carry their date ("Prices as of 30 Oct").
4. **Nothing saves without an explicit button press.**
   - Closing a sheet discards it; edits are buffered until Save.
   - Destructive actions confirm and state counts.
   - Preferences (theme, currency, haptics) are view settings and apply instantly.
5. **Every tappable thing is ≥ 44 × 44 pt** (`--ps-tap`). Tab items and primary buttons are ≥ 48 (`--ps-tap-lg`).
6. **Every list has five states.**
   - Loading: skeleton with the same geometry as the content.
   - Empty: real copy + one CTA.
   - Error: what failed + Try again.
   - No results.
   - Offline-aware: works from local data; only network-bound parts degrade (§16).
7. **Language is visible** on catalog rows and tiles when the collection contains both languages: an `EN`/`JP` micro badge (surface-3 fill, fg-muted text). If the user owns only one language, hide the badge in the collection but keep it in search results.
8. **Numbers.**
   - Use `tabular-nums` and `Intl.NumberFormat` (device locale).
   - Collector numbers render as `136/189` when the set's official count is > 0, else `#136`. JA `001` stays `001`.
9. **URL is state.** Filters, sort, view mode, search query, tabs and open sheets live in the route search params. Back (iOS edge swipe, Android back, in-app back) therefore closes sheets and restores filters (§1.5).
10. **Local reads are instant.** Data comes from on-device SQLite.
    - Skeletons appear only after 150 ms.
    - Never show a spinner for a local read under 300 ms.
    - Never block a screen on the network.

## 1. App shell and navigation

### 1.1 Routes: TanStack Router file routes (`apps/mobile/src/routes/`)

URLs are unchanged from Stage A and ARCHITECTURE.md (TanStack writes params as `$param`). Two pathless layout routes give native structure:
- **`_tabs`**: top bar + tab bar + sync pill. Pushed screens keep the tab bar, as on iOS and Android.
- **`_modal`**: full-screen modal presentation that slides up. It has no tab bar and a close button in the top-left.

| File | URL | Screen | Search params (zod `validateSearch`) |
|---|---|---|---|
| `__root.tsx` | — | providers, startup gate (§15.1), toast host, sheet host, platform listeners | — |
| `_tabs.tsx` | — | tab shell (§1.2) | — |
| `_tabs/index.tsx` | `/` | Dashboard | — |
| `_tabs/collection/index.tsx` | `/collection` | Collection | `q, view=grid\|list, sort, set, rarity, lang, cond, graded, dupes, loc, group, variant, priced=none\|some, num` (localId), `sheet=filters\|sort` |
| `_tabs/collection/$ownedId.tsx` | `/collection/$ownedId` | one copy (deep link): Card Details with that copy's editor open; snapshot-safe | — |
| `_tabs/cards/$language/$cardId.tsx` | `/cards/$language/$cardId` | Card Details (catalog) | `variant, copy` (copy editor open), `zoom=1` |
| `_tabs/custom-cards/$customId.tsx` | `/custom-cards/$customId` | Card Details (custom) | `edit=1` |
| `_tabs/sets/index.tsx` | `/sets` | Sets | `lang, show=collecting\|all, sort` |
| `_tabs/sets/$language/$setId.tsx` | `/sets/$language/$setId` | Set detail | `tab=all\|owned\|missing\|dupes` |
| `_tabs/settings/index.tsx` | `/settings` | Settings home | — |
| `_tabs/settings/catalog.tsx` | `/settings/catalog` | **new**: card catalog (languages, packs, updates, prices, sets I collect) | `sheet=sets` |
| `_tabs/settings/data.tsx` | `/settings/data` | import, export, backup, restore | `sheet=import\|restore` |
| `_tabs/settings/locations.tsx` | `/settings/locations` | Storage locations | `sheet=new\|<id>` |
| `_tabs/settings/about.tsx` | `/settings/about` | **new**: About, disclaimer, attribution, version | — |
| `_tabs/settings/privacy.tsx` | `/settings/privacy` | **new**: privacy policy (in-app text) | — |
| `_tabs/settings/licenses.tsx` | `/settings/licenses` | **new**: licenses | — |
| `_modal.tsx` | — | modal shell | — |
| `_modal/add.tsx` | `/add` | Add flow (search → confirm) | `q, lang, set` (`<language>:<setId>`), `card` (`<language>:<cardId>` or `custom:<uuid>`; confirm sheet open) |
| `_modal/custom-cards/new.tsx` | `/custom-cards/new` | Create custom card | `name` (prefill from search) |
| `_modal/welcome/index.tsx` | `/welcome` | First run: welcome | — |
| `_modal/welcome/notice.tsx` | `/welcome/notice` | First run: disclaimer + privacy | — |
| `_modal/welcome/languages.tsx` | `/welcome/languages` | First run: languages + download | — |
| `_modal/welcome/sets.tsx` | `/welcome/sets` | First run: sets you collect | `q` |
| — | `/scan` | **does not exist in Phase 1** (ARCHITECTURE: no scanner route; Phase 3 adds `_modal/scan.tsx`) | — |

Rules:
- `beforeLoad` in `__root` runs the startup gate (§15.1). It never blocks `/settings/about`, `/settings/privacy` or `/settings/licenses`; these are readable before onboarding and offline (API.md SettingsRepo note).
- Every navigation is client-side. There is no `window.location` assignment and no reload. `<a href>` is only for external links, and those open in the in-app browser (§17.9).
- Route-level code splitting: tab routes are in the main chunk so the first tap is instant. Only `/settings/licenses` and the zoom viewer are lazy.
- The new routes (`/settings/catalog`, `/settings/about`, `/settings/privacy`, `/settings/licenses`, `/welcome/*`) are listed for Sol in the requests file.

### 1.2 Mobile shell (< 1024 px)

```
390 px (iPhone; Android identical except bar heights/indicator, DESIGN-TOKENS §5.3)
┌──────────────────────────────────────┐
│ ░ status bar  (--ps-safe-top)         │  translucent chrome continues under it (iOS)
├──────────────────────────────────────┤
│        Collection         [⌕] [+]    │  top bar --ps-topbar-h (44 iOS / 64 Android / 56 web)
├──────────────────────────────────────┤
│ Collection                           │  large title (H1) in content on tab roots
│ page content (document scrolls)      │  padding-bottom: --ps-content-pad-bottom
│                                      │
│        ( ◔ Downloading English 42% ) │  sync pill (§1.6), only while catalog work runs
├──────────────────────────────────────┤
│  ⌂        ▦        ◉        ▤     ⚙  │  tab bar --ps-tabbar-h + --ps-safe-bottom
│ Home  Collection  Soon    Sets  Settings
│ ▔▔▔▔▔ home indicator (--ps-safe-bottom)│
└──────────────────────────────────────┘
```

**Top bar** (`<header>`):
- `position: fixed`, height `--ps-topbar-total`, `padding-top: --ps-safe-top`.
- Background `--ps-chrome-bg` with `backdrop-filter: var(--ps-chrome-backdrop)`; a 1 px `--ps-chrome-border` hairline appears only once content scrolls under it.
- Title: centred on iOS, left on Android/web (`--ps-topbar-title-size`).
- Up to two 44 px icon buttons on the right. On Dashboard, Collection, Sets and Card Details the rightmost is **Add** (`Plus`, accessible name "Add a card") → `/add`.
- Pushed screens show the platform back affordance on the left (§17.3).
- **Large title:**
  - On tab roots (Dashboard, Collection, Sets, Settings) the H1 sits in the content at `--ps-text-h1`.
  - The inline bar title is `aria-hidden` and invisible until the H1 scrolls under the bar (IntersectionObserver; fade `--ps-dur-fade-fast`). This is the iOS large-title pattern; Android keeps the same behaviour, which is acceptable in M3.

**Tab bar** (`<nav aria-label="Tabs">`):
- `position: fixed` at the bottom, height `--ps-tabbar-total`, `padding-bottom: --ps-safe-bottom`.
- Chrome background. A 1 px top hairline (`--ps-chrome-border`) on iOS and web; none on Android.
- Five equal slots, each ≥ `--ps-tap-lg`. Each has an icon (`--ps-tab-icon` 24) and a label (`--ps-tab-label-size`, 600).
- Active slot:
  - iOS: icon and label in `--ps-chrome-accent-fg`.
  - Android: a 56×32 `--ps-tab-indicator-bg` pill behind the icon, label in `--ps-fg`.
  - Web: 32×4 accent bar above the icon.
  - Every platform: `aria-current="page"`.
- Inactive slots: `--ps-fg-muted`.
- **Center slot "Scan"** (Phase 1 disabled):
  - A 60 px circle (`--ps-scan-fab`) raised `--ps-scan-raise` above the bar, `--ps-surface-3` fill.
  - Icon in `--ps-fg-disabled`; the micro label reads `Soon`.
  - Element: `<button aria-disabled="true" aria-label="Scan, coming in a later update">`. It stays focusable, so VoiceOver users learn why it is disabled.
  - Tapping it opens the Scanner-coming sheet (§11.6). It never requests the camera.
  - Phase 3: accent fill and a camera icon.
- Icons are `lucide-react` (MIT; listed in Licenses): `Home`, `LayoutGrid`, `ScanLine`, `Layers`, `Settings`.
- **Hidden** while the keyboard is open (Android `adjustResize` would otherwise lift it above the keyboard) and on `_modal` routes.

### 1.3 Wide shell (≥ 1024 px: web dev, PWA, iPad landscape)

```
≥1024 px
┌───────────────┬──────────────────────────────────────────────────────┐
│ FlashyDex     │  Collection                     [search……]  [+ Add]  │
│ [+ Add card]  ├──────────────────────────────────────────────────────┤
│ ⌂ Dashboard   │                                                      │
│ ▦ Collection  │            content (max 1280, centred)               │
│ ◉ Scan  Soon  │                                                      │
│ ▤ Sets        │                                                      │
│ ⚙ Settings    │                                                      │
│ ───────────── │                                                      │
│ EN catalog ✓  │                                                      │
│ JP · 42 %     │                                                      │
└───────────────┴──────────────────────────────────────────────────────┘
```

- Sidebar is `--ps-sidebar-w` 240, surface background, sticky at full height, with `padding-left: --ps-safe-left`.
- It starts with an "Add card" primary button. Nav rows are 44 tall with radius md; the active row has `accent-soft` background and `accent-fg` text. Scan is disabled the same way as on mobile.
- Footer: catalog status per language ("EN catalog ✓ v2026.10.30", "JP · 42 %") linking to `/settings/catalog`. While catalog work runs the sync pill moves here.
- Dialogs replace bottom sheets (centred, max-width 560, radius xl). The add-confirm and copy editor become a right-side panel (480 px) over a scrim.
- iPad portrait (768–1023) uses the mobile shell.

### 1.4 Global feedback

- **Toasts**:
  - Placement: bottom-centre at `--ps-toast-bottom` (above the tab bar, sync pill and keyboard); bottom-right on wide screens.
  - At most one visible. 4 s, or 8 s if it has an action. `role="status"`.
  - Example: "Added Furret · Darkness Ablaze" [Undo].
  - Swipe down to dismiss.
- **Offline**: there is **no** permanent offline banner, because the app works offline. Network-bound features show an `Offline` chip and explain themselves in place (§16).
- **Blocking overlay** (`--ps-z-blocking`), used only for restore and erase:
  - full-screen surface;
  - spinner and "Restoring your backup… Keep FlashyDex open.";
  - cannot be dismissed;
  - Android back is swallowed.
- **Background work** (catalog download, price update): the sync pill (§1.6). Nothing else interrupts.
- **Startup failure** (DB can't open or a migration fails): a full-screen error (§12) instead of the app. It is never an empty app.

### 1.5 Native navigation model (back gestures, tab stacks)

- **History is the source of truth.** TanStack Router uses browser history (`createBrowserHistory`); on native it runs inside the Capacitor WebView origin. There is no browser chrome, so the app provides every back affordance itself.
- **iOS edge-swipe back.**
  - Enable WKWebView's native `allowsBackForwardNavigationGestures` (request to Terra: a tiny `CAPBridgeViewController` subclass). This gives the real interactive swipe with the previous page's snapshot underneath.
  - JS view transitions are skipped for these pops (DESIGN-TOKENS §7.2).
  - No horizontal-swipe UI may start within 24 px of the left edge.
- **Android back** (`@capacitor/app` `backButton`), in this precedence order:
  1. Close the topmost sheet or dialog. If it has unsaved changes, show the "Discard changes?" dialog instead.
  2. Close the keyboard.
  3. `router.history.back()` if the in-tab depth > 0.
  4. On a non-Home tab root, go to Home.
  5. On Home root, `App.minimizeApp()`.
- **Tab stacks.** Each tab is a stack; history never crosses tabs.
  - Switching tabs first collapses the current tab's pushed entries (`history.go(-depth)`, where the shell tracks depth), then `replace`s to the target tab root. Back and the edge swipe therefore never jump into another tab, onboarding or a finished modal.
  - Re-tapping the active tab pops to its root if depth > 0; at the root it scrolls to top (smooth, or instant under reduced motion).
  - Each tab root restores its scroll position and its loaded list (Query cache keyed by search params).
  - Remembering a deep per-tab stack across tab switches is Phase 7 polish.
- **Sheets are history entries** (`sheet=` or `card=`/`copy=` search params), so the edge swipe and Android back close them.
  - Sheets that aren't deep-linkable push with `state` only.
  - Closing with the ✕/Cancel button calls `history.back()`, never a push.
- **Modals** (`_modal/*`) are pushed entries.
  - Closing pops back to where they were opened.
  - On cold start straight into a modal (deep link), close goes to `/`.
  - Finishing onboarding `replace`s to `/`, so back can never return into `/welcome`.
- **Status-bar tap** scrolls to top for free, because the document is the scroll container (no inner scrolling page div).

### 1.6 Sync pill (catalog work indicator)

A compact pill shown while catalog work runs: pack download/install, price update or set fill-in. Placement:
- Centred, `--ps-syncpill-h` tall, floating `8 px` above the tab bar (`bottom: calc(var(--ps-tabbar-total) + 8px)`), `--ps-z-syncpill`.
- `<html>` gets `.has-sync-pill`, so pages and toasts clear it.
- On wide screens it lives in the sidebar footer instead.

```
 ( ◔  Downloading English · 42 %   )      surface-3 pill, radius full, shadow-2
 ( ◔  Installing English…          )      ring = determinate progress (accent), spinner if indeterminate
 ( ⏸  Download paused · Resume     )      tap → resume (no navigation)
 ( ☁̸  Waiting for connection       )      warning text, Offline glyph
 ( ✓  English catalog ready        )      positive, auto-hides after 3 s
 ( !  Download failed · Details    )      negative, tap → /settings/catalog
```

- **Tap** opens `/settings/catalog`. The Resume and Retry states act in place.
- **Content:** one line, ellipsis. The progress ring is 16 px; under reduced motion it is a static ring at its value. The percentage uses `tabular-nums`.
- **VoiceOver:**
  - A button labelled with the full state, e.g. "Catalog download, English, 42 percent. Opens catalog settings."
  - It is not a live region. One polite announcement each at start, completion ("English catalog ready") and failure.
- **Hidden** on `_modal` routes (Add shows its own inline banner, §7.1) and on `/settings/catalog`, where the full progress card is visible.
- Also mirrored on the Dashboard as a full progress card while no catalog is ready (§3.3).

## 2. Shared components (build once, reuse)

| Component | Spec |
|---|---|
| `CardArt` | props `{imageUrl, size:'low'\|'high', alt, rarityTier, name, setName, localId}`; fixed 63:88 frame; skeleton until `onLoad`, then a 200 ms fade; `loading="lazy" decoding="async"`, `fetchpriority="high"` only on the Card Details hero. `imageUrl` null → "No catalog image". `onError` → "Image not loaded" (DESIGN-TOKENS §8.7), with one retry when the network comes back. `draggable=false`, no iOS callout. |
| `CardTile` | §2.1 |
| `CardRow` | §2.2 |
| `ConditionBadge`, `GradeBadge`, `VariantChip`, `QtyBadge`, `RarityLabel`, `LangBadge`, `Price` | DESIGN-TOKENS §8; `Price` takes `{cents: number\|null, currency}` and returns `null` for null cents. |
| `StatTile` | label (caption, muted), value (h2, tabular), optional sub-line (caption). Radius lg, surface bg, padding 16. |
| `BottomSheet` | §2.3 |
| `Dialog` | centred alert-style (≤ 1024: 320 wide, radius xl). Title, body, up to 2 buttons stacked at large text. Destructive button in `--ps-danger-solid`. Used for confirmations instead of a sheet. |
| `SegmentedControl` | track surface-3, thumb surface/white with shadow-1, 36 visual / 44 hit. `haptic('select')` on change (iOS). |
| `ChipGroup` | single/multi-select chips, 36 visual / 44 hit via padding; selected = accent fill + on-accent text + check glyph; `flex-wrap`. |
| `Stepper` | − [ 1 ] + ; 44×44 buttons; `inputmode="numeric"` field (16 px); range 1–100 (BulkAdd max); `haptic('select')` per step (iOS). |
| `Switch` | `role="switch"`, 51×31 visual (iOS look) on all platforms, 44 hit; on = accent. |
| `NativeSelect` | a real `<select>` styled as a row (label left, value + chevron right): iOS shows its native menu/wheel, Android its native dialog. Used for Location, Group, Currency and Set scope. No custom dropdowns. |
| `DateField` | `<input type="date">` (native picker) + a "Today" chip; empty = unknown. |
| `Skeleton` | surface blocks with `animate-shimmer`; static under reduced motion. |
| `EmptyState` | 64 px muted icon, H3 title, body (muted, max 34ch), one primary button, optional text button. |
| `ErrorState` | same layout, `negative` icon, friendly message (§12), Try again, a "Details" disclosure with the `DomainError.code`. |
| `FilterSheet` | §4.4 |
| `SearchField` | 44 px, surface-2, radius md, leading search icon, trailing clear (×, 44 hit) when non-empty, `type="search" enterkeyhint="search" autocapitalize="off" autocorrect="off" spellcheck="false"`. 16 px text (no iOS zoom). Debounce 150 ms (local search). |
| `PullToRefresh` | §2.4 |
| `OfflineChip` | `warning-soft` pill with a `CloudOff` glyph and the text "Offline". It appears only where the network matters (§16). |
| `SyncPill` | §1.6 |
| `ProgressCard` | catalog work card: title, determinate bar (4 px, accent) or striped indeterminate, primary line ("8.4 of 14.2 MB" / "34 of 220 sets"), secondary line (stage), actions (Pause/Resume/Cancel/Retry). `role="progressbar"` with `aria-valuenow`/`aria-valuetext`. |

### 2.1 Card tile (grid)

```
 ┌───────────────┐   tile 114 px wide at 390 (3 cols); 2 cols at Accessibility text sizes
 │×3        Rev  │   ← QtyBadge (only when qty>1) · VariantChip (not for normal)
 │               │
 │   card art    │   63:88, rounded-card, shadow-card
 │   (low.webp)  │
 │               │
 │NM+            │   ← ConditionBadge or GradeBadge (bottom-left, 6 px inset)
 └───────────────┘
 Furret              ← caption 13/600, 1 line, ellipsis
 136/189 · DAA   $—  ← micro/caption muted; price right-aligned, tabular; omitted when null
```

- **One tile = one group** in the Collection grid. This is the owner ruling and is binding (API.md `groupBy:'card'`): one row per (language, cardId, variant), with source catalog or custom. `variantDetail` sub-prints (e.g. pokéball/masterball foil) do **not** split tiles; they appear as rows in Card Details.
- **Badge rules for a group** (`CollectionCardGroup`):
  - Qty = `qty` (the copies matching the filters). When filters hide some copies, `totalQty` shows in the accessible name: "3 of 5 copies match".
  - Condition: if one condition covers all `conditions`, show it. Otherwise show the best condition followed by `+` (`NM+`; aria "Mixed conditions, best Near Mint").
  - Graded: if `grading.graded = qty`, show the representative's grade. If the group is mixed raw/graded, show the condition badge plus a 6 px dark dot ("includes graded copies").
- **Meta line:** `localId/officialCount` (or `#localId`), then a set abbreviation if the catalog has one, else the set name truncated. Set-code search itself is request R4, not in Phase 1.
- **Price:** the per-copy value in the display currency (`defaultCurrency`), from the representative's `valuations`. It is hidden when null. The group total appears on Card Details.
- **Interaction:**
  - Press: darken + scale `--ps-press-scale`.
  - Tap → `/cards/$language/$cardId?variant=<v>` (or `/custom-cards/$id`).
  - **Long-press** (500 ms) → `haptic('longpress')` and a context menu sheet: Add another copy · Move to location… · View set. Every action is also reachable from Card Details; nothing is long-press-only.
- **Accessible name** (one string on the link): "Furret, Darkness Ablaze 136 of 189, Reverse holo, 3 copies, Near Mint, $X".

### 2.2 Compact row (list view, search results)

```
┌────────────────────────────────────────────────┐
│ ┌──┐ Furret                       ×3     $—   │  row 64 px min (grows with text); thumb 40×56
│ │  │ Darkness Ablaze · 136/189 · Rev  NM  EN  │
│ └──┘                                          │
└────────────────────────────────────────────────┘
```
- Line 1: name (body 16/500, ellipsis); on the right, qty `×3` (only when > 1) and the price (small, tabular).
- Line 2 (caption, muted): set name · number · variant short label; on the right, the condition/grade badge and the lang badge (rule 0.7).
- Divider: 1 px `border`, inset 64 px.
- At the `ax` text bucket the right-hand items move under line 2.

### 2.3 Bottom sheet (mobile) — native behaviour

```
┌──────────────────────────────────────┐
│               ▬▬▬                    │  drag handle --ps-sheet-handle-w/h, 6 px from top
│ Cancel        Filters          Reset │  sheet header 44 px: leading Cancel/Close, title, trailing action
├──────────────────────────────────────┤
│ … content (scrolls inside sheet,     │  overscroll-behavior: contain
│   keyboard-aware) …                  │
├──────────────────────────────────────┤
│ [          Show 37 cards          ]  │  sticky footer; padding-bottom --ps-sheet-pad-bottom
└──────────────────────────────────────┘
```

- **Detents.** `medium` is about 55 % of the viewport. `large` is `--ps-sheet-max-h`, leaving a sliver of the page and status bar visible, like iOS. Content-sized sheets (menus, short forms) use one detent fitted to their content, capped at large.
  - Focusing an input moves the sheet to large.
- **Drag.** The handle and the whole header are the drag area (≥ 44 tall).
  - Dragging down past `--ps-sheet-dismiss-distance`, or with velocity > 0.5 px/ms, dismisses the sheet. `haptic('threshold')` fires once when the drag crosses the distance.
  - Content scroll hands off to sheet drag only when the content is scrolled to top.
  - Settle uses `--ps-ease-sheet`.
- **Unsaved changes** (add confirm, copy editor, forms): drag, scrim tap and Android back don't dismiss. The sheet springs back and the "Discard changes?" dialog appears ([Keep editing] [Discard]). This mirrors iOS `isModalInPresentation`.
- **Scrim** `--ps-overlay`; tapping it dismisses under the same rule.
- **iOS** scales the page behind to 0.94 with radius 10 (not under reduced motion). **Android** has no page scale and uses a 28 radius.
- **Safe area and keyboard.** The footer pads by `--ps-sheet-pad-bottom` (home indicator or keyboard, whichever is larger). The focused field scrolls into view (`scrollIntoView({block:'center'})`) after `keyboardDidShow`.
- **Accessibility.**
  - `role="dialog" aria-modal="true" aria-labelledby=<title>`; the handle is `aria-hidden`.
  - On open, focus moves to the title. On close it returns to the invoker.
  - There is **always a visible Cancel/Close button**: VoiceOver's escape gesture and Switch Control can't drag.
  - Everything behind the sheet is `inert`.
- **Wide screens** use a centred dialog or a side panel instead.

### 2.4 Pull-to-refresh (only where there is something to fetch)

Where it is used, and what it fetches:
- Dashboard: update prices of owned cards.
- Card Details: refresh this card.
- Sets list: check for new sets / a catalog update.
- Set detail: refresh this set.

It is **not used** on Collection, Add or Settings, which read local data only and have nothing to refresh. A pull that does nothing teaches the user nothing.

Behaviour:
- Pull on the document at `scrollY = 0`. Rubber-band up to `--ps-pull-max`; past `--ps-pull-threshold`, `haptic('threshold')` fires and the spinner arms. Release → refresh.
- iOS: spinner under the large title. Android: 40 px circle on surface-3.
- While refreshing: spinner. Then 240 ms settle and a toast with the result ("Prices updated for 128 cards" / "Already up to date").
- **Offline:** the spinner springs back immediately and a toast says "You're offline. Prices update when you're connected." No haptic.
- If a long job starts (e.g. a price update for many cards), the pull ends at once and the job continues in the sync pill.
- Reduced motion: no stretch, just the spinner.
- **Accessibility:** every pull action has a visible button equivalent (the "Update prices" link on the Dashboard, "Refresh card" in Card Details `⋯`, "Check for a newer catalog" in Settings → Catalog).

## 3. Dashboard (`/`)

Data: `PortfolioService.dashboard({currency})` → `DashboardDto`:
- `totalCards`, `totalCopies`, `uniqueCards`, `duplicates`, `displayCurrency`, `pricedCopies`;
- `currencies[USD, EUR]` → `CurrencyStats`;
- `recent` (10).

Catalog/download state comes from the catalog pack service (§10.2) and `SyncService`.

### 3.1 Layout 390 px

```
┌──────────────────────────────────────┐
│ (status bar)                     [+] │
│ Dashboard                            │  large title (visually: value block leads)
├──────────────────────────────────────┤
│ Estimated value                      │  caption muted
│ $1,234.56                            │  display, tabular (displayCurrency bucket)
│ ▲ +$210.40 on 128 cards with a       │  small; positive/negative + sign
│   known cost                         │
│ 380 of 412 copies priced ›           │  caption → /collection?priced=none (unpriced)
│ €87.20 from Cardmarket prices        │  small muted — other bucket, only if non-null
│ TCGplayer prices as of 30 Oct · Update│ caption subtle; "Update" = text button (pull equivalent)
├──────────────────────────────────────┤
│ ┌───────────────┐ ┌───────────────┐  │  2×2 StatTile grid, gap 8 (1 col at ax)
│ │ Total copies  │ │ Unique cards  │  │
│ │ 412           │ │ 301           │  │
│ └───────────────┘ └───────────────┘  │
│ ┌───────────────┐ ┌───────────────┐  │
│ │ Duplicates ›  │ │ Total paid    │  │
│ │ 111           │ │ $980.00       │  │
│ │               │ │ 128 of 412    │  │  "known cost on 128 of 412 cards"
│ └───────────────┘ └───────────────┘  │
├──────────────────────────────────────┤
│ Recently added               See all›│  H2 + link → /collection?sort=recent
│ ┌────┐ ┌────┐ ┌────┐ ┌────┐ ┌──      │  horizontal scroller, tiles 104 px,
│ │art │ │art │ │art │ │art │ │        │  scroll-snap, 16 px edge padding,
│ └────┘ └────┘ └────┘ └────┘ └──      │  shows 3.5 tiles to signal scroll
└──────────────────────────────────────┘
```

- **Value block (the hero).**
  - Currency buckets are **never summed or converted**.
  - The primary bucket is `displayCurrency` (Settings → Currency, default USD). The other bucket appears as a secondary line only when its value is non-null.
  - Each money figure names its source in words (TCGplayer / Cardmarket).
- **Coverage line:** "`pricedCopies` of `totalCopies` copies priced" (API.md wording). It links to `/collection?priced=none` (R7, accepted).
- **Price date:** "TCGplayer prices as of 30 Oct" comes from the newest `sourceUpdatedAt` among the owned cards' snapshots. When the date is older than 14 days it renders in `warning`: "Prices are 3 weeks old · Update".
- **Gain/loss** appears only when `gainLossCents` is non-null, and always states the subset: "on N cards with a known cost". When null: "Add what you paid to see gain/loss" (link to Collection sorted by recent).
- **Stat tiles:**
  - Duplicates → `/collection?dupes=1`.
  - Total → `/collection`.
  - Total paid shows each non-null currency stacked, plus coverage.
- **Pull-to-refresh / "Update"** runs a price update for owned cards (§10.2, request S2). It needs the network (§16).

### 3.2 Layout ≥ 1024 px
The value panel spans 6/12 columns and the stat tiles 2×2 in the other 6. Recently added becomes a 10-tile grid.

### 3.3 States
- **Loading:** skeleton for the value block (180×38 + two 240×16 lines), 4 stat tiles, 4 scroller tiles.
- **No catalog yet, download running** (first run): a `ProgressCard` sits at the top:
  - Title "Downloading the English card catalog". Line "8.4 of 14.2 MB · about 1 min left". [Pause] or [Cancel].
  - Body: "You can add custom cards or import a collection while you wait."
  - Stats render real zeros; Recently added shows its empty state.
- **No catalog, nothing running** (onboarding skipped, offline, or the catalog was removed): `EmptyState`.
  - Icon `DatabaseZap`. Title "Download the card catalog".
  - Body: "FlashyDex needs the catalog before you can search. It downloads once, then search works offline."
  - Button "Choose languages" → `/settings/catalog`. Text button "Import a collection" → `/settings/data`.
  - When offline, the body adds: "Connect to the internet to download it."
- **Catalog ready, no cards:**
  - Stats render real zeros.
  - The value line reads "No cards yet" (not $0.00).
  - Recently added → EmptyState "Your collection is empty" / "Search the catalog to add your first card." / "Add a card" → `/add`.
- **Error** (local read failed, rare): ErrorState "Couldn't load your dashboard" / "Something went wrong reading your collection. Your data hasn't changed." / Try again.

### 3.4 Accessibility
- The H1 "Dashboard" is the large title.
- Gain/loss text includes the words "gain"/"loss" for screen readers ("Gain of $210.40 on 128 cards with a known cost").
- The scroller is a `<ul aria-label="Recently added">`; each tile is a link.
- The text button next to the price caption is labelled "Update prices" (money); "Refresh this set" is the one-set action.

## 4. Collection (`/collection`)

Data: `CollectionRepo.list({groupBy:'card', …filters, sort, offset, limit:50})` → `Page<CollectionCardGroup>`. This is all local, so filtering is instant.

Search params map to typed input in the route's `validateSearch`:
- `lang`→`language`
- `cond`→`condition` (`?`→`unknown`)
- `graded`→`grading`
- `dupes`→`duplicates`
- `loc`→`storageLocationId` (`none`)
- `set`→`setId`
- `num`→`localId`
- `priced`
- `group`→`groupId`
- `variant`
- `hideTcgPocket` from Settings

Infinite scroll:
- The next page loads when a sentinel 600 px before the end becomes visible. A "Load more" button is the fallback for keyboard and VoiceOver.
- Reset to offset 0 after any filter change or mutation (API.md).

### 4.1 Layout 390 px

```
┌──────────────────────────────────────┐
│                                 [+]  │
│ Collection                           │  large title
│ [⌕ Search by name or number     ×]   │  SearchField, sticky under the top bar (top: --ps-topbar-total)
│ [Filters •3] [Sort: Recent ▾] [▦|☰]  │  44 px row; fits at 390
│ ( Darkness Ablaze ×)( NM ×)(Duplicates ×)│  active-filter chips, horizontal scroller
├──────────────────────────────────────┤
│ 412 copies · 301 unique               │  caption muted, aria-live polite
│ ┌────┐ ┌────┐ ┌────┐                 │
│ │    │ │    │ │    │                 │  3-col grid of CardTile (2 at ax)
│ └────┘ └────┘ └────┘                 │
└──────────────────────────────────────┘
```
- **Search:**
  - Text goes to `q` (normalized name contains).
  - A query that is only a collector number (`136`, `136/189`, `SV-P 001`-style letters and digits without spaces after trimming) goes to `localId` instead (R2, accepted). The `/189` part narrows client-side to sets whose official count is 189.
  - Searching keeps the filters.
- **Sort** (sheet with radio rows):
  - Recently added (`created_desc`, default)
  - Name A–Z (`name_asc`)
  - Set & number (`set_asc`)
  - Value high→low (`value_desc`)
  - Value low→high (`value_asc`)
  - Most copies (`count_desc`)

  Value sorts put unpriced groups last in both directions, and say so in a caption under the sort row ("Cards without a price are listed last").
- **View toggle:** a segmented control with Grid/List icons and accessible names. The choice persists in the URL and in a device preference.

### 4.2 Layout ≥ 1024 px
- Filters become an always-visible left rail (260 px) inside the content, with the same controls as the sheet, applied instantly.
- The grid uses `--ps-tile-min` 160.
- List view becomes a table: Art · Name · Set · No. · Variant · Condition/Grade · Qty · Location · Paid · Value. Column headers are sortable (`aria-sort`) where the API supports the sort.

### 4.3 States
- **Loading** (rare, local): 12 tile skeletons or 10 row skeletons, after 150 ms only.
- **Empty collection:** EmptyState "No cards yet" / "Add cards by searching the catalog. They'll show up here with quantities, conditions and value." / "Add a card".
  - If no catalog is installed, add the text button "Import a collection".
- **No results:** "No cards match" / "Nothing in your collection matches “furet” with 3 filters." / "Clear filters", plus the text button "Search the whole catalog" → `/add?q=furet`.
- **Error:** ErrorState (§12). A failure while loading the next page shows the inline row "Couldn't load more cards. [Try again]"; tiles already shown stay.
- **Offline:** fully functional. Tiles whose art isn't in the WebView cache show the "Image not loaded" placeholder.

### 4.4 Filter sheet (mobile) / filter rail (wide)

```
┌──────────────────────────────────────┐
│               ▬▬▬                    │
│ Cancel        Filters          Reset │
├──────────────────────────────────────┤
│ Language     (All)(EN)(JP)           │  single-select chips
│ Set          [Any set            ›]  │  pushes a searchable set list (sets you own first)
│ Rarity       [Any rarity         ›]  │  rarity strings present in the collection
│ Condition    (Any)(NM)(LP)(MP)(HP)(DMG)(?)   single-select; ? = unknown
│ Variant      [Any variant        ▾]  │  NativeSelect, enum labels
│ Raw/graded   (All)(Raw)(Graded)      │
│ Price        (Any)(Has price)(No price)   priced=some|none in display currency (R7)
│ Duplicates   Only cards I have       [  ○]   Switch
│              more than one of        │
│ Location     [Any location       ▾]  │  NativeSelect incl. "No location"
│ Group        [Any group          ▾]  │  only if groups exist
├──────────────────────────────────────┤
│ [        Show 37 cards         ]     │  primary; live count (limit=1 query, debounced 150 ms)
└──────────────────────────────────────┘
```
- **Mobile:** changes are staged and applied with "Show N cards". Cancel (or the edge swipe / Android back) discards staged changes without a confirm, because they are only view state.
- **Wide:** the rail applies changes instantly.
- **Filter button:** shows a count dot ("Filters, 3 active").
- **Duplicates semantics:** precise duplicates are computed across the whole collection first (API.md).
- **"No price" semantics:** a copy with only an EUR price counts as "No price" when the display currency is USD. A caption under the chips says so: "Prices in USD (TCGplayer). Change in Settings."
- **TCG Pocket:** not a filter here. It follows Settings → "Include TCG Pocket (digital) cards"; owned Pocket copies are hidden when the setting is off. When anything is hidden this way, a caption under the count line reads "2 TCG Pocket cards hidden · Show".

### 4.5 Interactions
- No pull-to-refresh (§2.4).
- Scroll position and loaded pages are restored when returning from Card Details (Query cache keyed by search params, `history.scrollRestoration = 'manual'` plus a saved offset).
- Keyboard (wide): `/` focuses search. Tab order is row-major.

## 5. Card Details (`/cards/$language/$cardId`, `/custom-cards/$customId`, `/collection/$ownedId`)

Data: `CatalogRepo.getCard({language, cardId})` → `CardDetail` (metadata, `latestPrices`, `ownedCopies` page, `purchaseHistory`, `syncedAt`, `detailSyncedAt`). Custom cards use `CollectionRepo.getCustom` and the copies list. The copy deep link uses `CollectionRepo.getCopy`, which is snapshot-safe.

### 5.1 Layout 390 px

```
┌──────────────────────────────────────┐
│ ‹ Collection                [⋯] [+]  │  translucent top bar over the hero; title appears after scroll
├──────────────────────────────────────┤
│          ┌──────────────┐            │
│          │              │            │  hero CardArt high.webp, width min(78vw, 320px)
│          │   Furret     │            │  centred, shadow-3; tap → zoom viewer
│          │   art        │            │
│          └──────────────┘            │
│ Furret                               │  H1
│ Darkness Ablaze · 136/189 · EN       │  body muted; set name links → set detail
│ ● Uncommon   Illus. tetsuya koizumi  │  RarityLabel · illustrator (as TCGdex spells it)
├──────────────────────────────────────┤
│ You own 3                            │  H2
│ ┌──────────────────────────────────┐ │
│ │ Normal          2   NM  NM       │ │  per-variant(+detail) rows (tap scrolls to copies)
│ │ Reverse holo    1   LP           │ │
│ └──────────────────────────────────┘ │
│ [        + Add a copy         ]      │  primary → confirm sheet (§7.3) prefilled
├──────────────────────────────────────┤
│ Prices                    [USD|EUR]  │  H2 + segmented source switch
│ Normal        market $—   low $—     │  rows per variant from latestPrices
│ Reverse holo  market $—   low $—     │
│ TCGplayer · as of 30 Oct 2026        │  caption subtle (sourceUpdatedAt)
│ Your copies are worth $— (3 valued)  │
├──────────────────────────────────────┤
│ Copies (3)                    Select │  H2 + text button for bulk mode
│ ┌──────────────────────────────────┐ │
│ │ Normal · NM · Binder A           │ │  copy row ≥ 64 px → copy editor sheet (§5.4)
│ │ Paid $— · 12 Oct 2026 · LGS      │ │
│ ├──────────────────────────────────┤ │
│ │ Reverse holo · PSA 9 · Slab box  │ │
│ │ Cert 12345678 · Paid —           │ │
│ └──────────────────────────────────┘ │
├──────────────────────────────────────┤
│ Purchase history                     │  H2; newest first, unknown dates last
│ 12 Oct 2026 · Local game store · 2   │
├──────────────────────────────────────┤
│ Card info                        ▾   │  disclosure: category, HP, types, stage, regulation
│                                      │  mark, card id swsh3-136, variants available,
│                                      │  "Details downloaded 30 Oct" (detailSyncedAt)
└──────────────────────────────────────┘
```
- **Owning 0 copies:** the "You own" section is replaced by one primary "Add to collection" button. Copies and Purchase history are omitted.
- **Prices:**
  - Rows appear only for variants with at least one non-null value. Only columns with data are shown (USD: market, low, mid, high; EUR: trend, avg, low).
  - Whole section empty → "No price data from TCGdex for this card."
  - Graded copies get the note "Graded copies aren't valued automatically. Set your own price in the copy."
  - A manual override appears on the copy row ("Your price $—").
  - Offline: prices still show (local), and the caption adds `OfflineChip` when the date is older than 14 days.
- **"Your copies are worth"** follows the DATA-MODEL valuation rules and states the subset: "(2 of 3 copies valued)".
- **`⋯` menu** (sheet): "View set", "Refresh card" (needs network; pull-to-refresh equivalent; request S3), "Copy card ID" (native clipboard, toast "Copied").
- **Zoom viewer** (`?zoom=1`):
  - Full-screen black, `high.webp`.
  - Pinch and double-tap zoom are implemented on the image with transforms, because the WebView's own zoom is disabled.
  - Close button (44 px, top-left at `--ps-safe-top`). Swipe down to dismiss. Android back closes it.
  - Reduced motion: no zoom animation.
- **Pull-to-refresh** refreshes this card's details and prices (§2.4).

### 5.2 Layout ≥ 1024 px
Two columns:
- Left (380 px, sticky): the hero (art max-width 340) with the Add button under it.
- Right: title block, You own, Prices, Copies (as a table), Purchase history, Card info.

### 5.3 States
- **Loading:** hero skeleton at exact 63:88, 3 text lines, 2 section skeletons (after 150 ms).
- **Catalog metadata missing but copies exist** (the language catalog was removed or isn't installed yet):
  - Render from the owned snapshot (`catalogAvailable:false`).
  - Banner (warning-soft): "Card details aren't downloaded — showing what you saved. Download the English catalog to see prices and card info." [Download] → `/settings/catalog`.
  - The price section is hidden.
- **Not found** (no catalog card and no copies): "Card not found" / "This card isn't in the downloaded catalog. It may be in a set that's newer than your catalog." / buttons "Search the catalog" and "Create a custom card".
- **Custom card:** a "Custom" chip (surface-3) next to the title; no price section; Copies; an "Edit card details" button (opens §9 in edit mode).

### 5.4 Copy editor (sheet / side panel)

- **Opens** from a copy row, `?copy=<id>` or `/collection/$ownedId`.
- **Fields** are the same as Add confirm (§7.3) minus identity, which is fixed (changing identity = delete + re-add):
  - Variant (chips; may change — it is not identity).
  - Condition, including "Not set".
  - Raw/Graded, plus company, grade and cert.
  - Paid (amount + currency).
  - Purchase: date and source, with the shared-acquisition note "This purchase is shared by 3 copies. Changing the date or source changes it for all of them."
  - Location, Groups.
  - Your price (manual override + Clear).
  - Notes.
- **Header:** Cancel · "Edit copy" · Save (disabled until something changes).
- **Footer:** `Delete copy` (text, negative).
- **Delete** → Dialog "Delete this copy of Furret? This can't be undone." [Cancel] [Delete copy] → commit → `haptic('deleted')` → toast "Deleted".
- **Save** → commit → `haptic('saved')` → toast "Saved".
- **Bulk mode** (from "Select" on the Copies header):
  - Rows get checkboxes. A sticky footer offers "Move 2 to location…" and "Delete 2".
  - Confirm dialogs state the count.
  - Bulk delete calls `remove` per id and reports partial failure honestly: "Deleted 2 of 3. 1 couldn't be deleted. [Try again]".

### 5.5 Accessibility
- Hero alt: `alt="Furret — Darkness Ablaze 136/189 card art"`.
- The price table is a real `<table>` with `<caption class="sr-only">`.
- Copy rows are buttons whose name reads the row ("Normal, Near Mint, Binder A, paid …, edit").
- The sheet focuses its title on open and returns focus to the row on close.
- JA names are wrapped in `lang="ja"`.

## 6. Sets

### 6.1 Sets list (`/sets`), 390 px

Data: `CatalogRepo.listSets({language, owned, hideTcgPocket, sort, q})`.

```
┌──────────────────────────────────────┐
│                                 [⌕]  │
│ Sets                                 │  large title
│ (EN)(JP)        [Collecting | All]   │  language chips (default = installed languages you own)
│ Sort: Newest ▾                       │  Newest · Name · Most complete
├──────────────────────────────────────┤
│ ┌──────────────────────────────────┐ │
│ │ [logo] Darkness Ablaze      EN   │ │  row 72 px min: logo 56×32 contain (or id chip)
│ │        45 / 201 · 22%            │ │  counts tabular
│ │        ▓▓▓▓░░░░░░░░░░░░░░        │ │  4 px progress bar, accent fill
│ ├──────────────────────────────────┤ │
│ │ [logo] Base Set             EN   │ │
│ │        102 / 102 · 100% ✓        │ │  complete → positive check + "Complete"
│ └──────────────────────────────────┘ │
└──────────────────────────────────────┘
```
- **Views:**
  - "Collecting" (`owned:true`; the default when you own ≥ 1 card) lists sets with copies, **plus** the sets chosen as "Sets I collect" (`setsFollowed`) even when you own nothing from them yet. Those show "0 / 201 · Collecting".
  - "All" lists every published set in the installed catalogs.
  - "Most complete" = `completion_desc`.
- **Count format:** `ownedUnique / catalogCount · completionPercent%`. When `completionPercent` is null (catalog incomplete), show `45 / 201 loaded · Catalog incomplete` in `warning`, with no percent.
- **Logos:** TCGdex has logos for 157/220 EN sets and **0/184 JA sets**. Without a logo, render a 56×32 `surface-3` chip with the set id in micro mono (`SV1a`, `PMCG1`). Never a stretched image. Logo URL = `logoUrl` + `.webp`.
- **Extras:** duplicate extras per set appear as the caption "8 extra" when > 0.
- **TCG Pocket:** sets in series `tcgp` (15 EN sets, ~2.5k digital-only cards) are hidden while Settings → "Include TCG Pocket (digital) cards" is off (the default). A footer row reads "TCG Pocket sets hidden · Show" and links to that setting.
- **Unpublished shells** (`status:'unpublished'`) never appear in Phase 1.
- **Pull-to-refresh** checks for new sets (catalog pack update or incremental check, §10.2) when online.
- **Not installed:** a language without an installed catalog shows a row "Japanese catalog not downloaded · Download" instead of sets.
- **Wide (≥ 1024):** 2–3 column grid of set cards (logo 120×48, 48 px progress ring and counts).

### 6.2 Set detail (`/sets/$language/$setId`), 390 px

Data: `CatalogRepo.getSet` + `listSetCards({ownership, duplicates})`.

```
┌──────────────────────────────────────┐
│ ‹ Sets                         [⋯]   │
├──────────────────────────────────────┤
│ [ Darkness Ablaze logo ]             │  logo max 240×80, centred
│ Darkness Ablaze                      │  H1
│ Sword & Shield · 14 Aug 2020 · EN    │  muted
│ ┌──────┐  45 of 201 cards            │  progress ring 64 px (accent), % inside
│ │ 22%  │  156 missing · 8 duplicates │
│ └──────┘  Official set: 189 + 12 secret
├──────────────────────────────────────┤
│ [All 201|Owned 45|Missing 156|Duplicates] │  segmented tabs (counts inside), sticky
├──────────────────────────────────────┤
│ ┌────┐ ┌────┐ ┌────┐                 │  grid by localIdSort
│ │ 1  │ │ 2  │ │ 3  │                 │  owned: normal tile (+qty)
│ └────┘ └────┘ └────┘                 │  missing: art 35% opacity, grayscale, dashed border,
│                                      │  "+" button 44 px bottom-right
└──────────────────────────────────────┘
```
- **Tabs:**
  - All: missing cards dimmed.
  - Owned.
  - Missing: full-opacity art, because this is the shopping list.
  - Duplicates: groups with extras; the qty badge shows the count, with the caption "2 extra".
- **Missing tile "+"** → add-confirm sheet for that card (§7.3) without leaving the set. On add: `haptic('added')`, and the tile fades from dimmed to full over 320 ms. That fade is colour/opacity only, so it survives reduced motion.
- **Tile tap** → Card Details.
- **`⋯` menu:**
  - "Add cards from this set" → `/add?set=<language>:<setId>`, the fastest way to log a binder page.
  - "Collect this set" / "Stop collecting" (toggles `setsFollowed`).
  - "Refresh this set" (network).
- **Incomplete catalog:** banner "This set isn't fully downloaded (180 of 201 cards). Completion will show once it is." [Download] (network; request S3, single-set fill-in).
- **Complete set:** Missing tab empty state "Set complete" / "You own every card in Darkness Ablaze." (positive check).
- **Custom copies:** copies tagged with this set name are not counted. If `customOwnedCount > 0`, show the caption "+ 2 custom cards not counted".
- **Wide (≥ 1024):** the header becomes a row; the grid has 6–8 columns.

### 6.3 States
- **Loading:** skeleton rows; set detail shows a header skeleton and 12 tiles.
- **No catalog installed:** "No sets yet" / "Download the card catalog to browse sets and track completion." / "Choose languages" → `/settings/catalog`.
- **Error:** global.
- **Offline:** fully functional; logos and art may be missing.

## 7. Add flow (`/add`): the Phase 1 core loop

Goal: go from anywhere to a saved card in **3 taps + typing**: [+] → type "furret 136" → tap result → "Add to collection".
- Everything is editable before commit. Nothing is written until Add is pressed.
- `/add` is a **modal route**: it slides up, covers the tab bar, and has ✕ Close top-left. Swipe down on the header, the edge swipe or Android back also close it.

### 7.1 Search step, 390 px

```
┌──────────────────────────────────────┐
│ ✕  [⌕ furret 136                 ×]  │  SearchField autofocused, keyboard opens on enter
│ (All)(EN)(JP)          Set: Any set ▾ │  language chips (remembered), set scope NativeSelect
├──────────────────────────────────────┤
│ ┌──┐ Furret                     EN   │  CardRow (catalog): thumb, name, set · number,
│ │  │ Darkness Ablaze · 136/189 · 2020│  release year, rarity dot
│ └──┘ ● Uncommon        You own 3     │  "You own N" (accent-fg) if owned
├──────────────────────────────────────┤
│ Can't find it?  Create a custom card │  sticky footer above the keyboard (--ps-keyboard-inset)
└──────────────────────────────────────┘
```
- **Query parsing** (client → `CatalogRepo.searchCards` / `getCard`):
  - `swsh3-136` (matches `^[A-Za-z0-9.+]+-[A-Za-z0-9%]+$`) → `getCard` directly; try the selected language, then the other.
  - `136` or `136/189` → `localId=136`; the `/189` narrows to sets with official 189. JA numbers are zero-padded (`001`): if `localId=1` finds nothing, retry once with the 3-digit padded value. That is a UI retry, never core repair.
  - `furret 136` → `q=furret&localId=136`; if that is empty, retry `q=furret` alone.
  - Anything else → `q=<text>&match=prefix`. When that returns 0, retry automatically with `match=contains` and label the list "Broader matches".
  - Set abbreviations (`DAA 136`) are not supported (R4); they are treated as name text.
- **Ranking** is core's (exact, prefix, contains). Rows show the release year so reprints are distinguishable. TCG Pocket results follow the Settings toggle.
- **Empty query:** show "Recent" (the last 8 cards added). If `?set=` is present, show that set's cards in number order with a "Missing first" toggle.
- **Typing:** results update as you type (debounce 150 ms; stale results are discarded). On wide screens, Enter opens the first result.
- **Keyboard:** results scroll under it. The footer and the last row stay reachable (`padding-bottom: max(--ps-keyboard-inset, --ps-safe-bottom)`). Scrolling the results list dismisses the keyboard, as in iOS search.
- **No results:** "No cards found for “furet”" / "Check the spelling, try the collector number (like 136/189), or switch language." / buttons "Search all languages" (if filtered) and "Create a custom card".
  - If the catalog is incomplete or older than the newest sets, add: "Newer sets may not be in your catalog yet. Check for a newer catalog" → `/settings/catalog`.
- **Catalog not installed:** EmptyState "The card catalog isn't downloaded yet" / "Download it once to search every card. You can still create a custom card." → "Choose languages" + "Create a custom card".
- **Catalog downloading:** an inline info banner at the top: "Downloading the English catalog (42 %). Search works when it's done." For the API-fallback path, the banner reads "Search works for sets downloaded so far (34 of 220)".

### 7.2 Search step ≥ 1024
Two panes: results (left, 420) and the confirm panel (right). Clicking a result fills the right pane, so desktop entry is type → click → Enter.

### 7.3 Confirm sheet (`/add?card=en:swsh3-136`), 390 px

```
┌──────────────────────────────────────┐
│               ▬▬▬                    │
│ Cancel                               │
│ ┌────────┐ Furret                    │  art 112×156 (high.webp) left; title H3
│ │  art   │ Darkness Ablaze · 136/189 │
│ │        │ ● Uncommon · EN           │
│ └────────┘ Market $— (Normal)        │  latest price for SELECTED variant, if any
├──────────────────────────────────────┤
│ Variant                               │
│ (✓ Normal)( Reverse holo )           │  chips from availableVariants; "Other…" text button
│ Condition                             │
│ (✓ Not set)(NM)(LP)(MP)(HP)(DMG)     │  default "Not set" (= null, badge "?")
│ Quantity                [ − ][ 1 ][ + ]
│ Graded                         [  ○] │  Switch, off = raw
├──────────────────────────────────────┤
│ More details                      ▾  │  disclosure, collapsed by default
│   Paid per copy   [ 0.00 ] [USD ▾]   │  empty = unknown (NOT 0); inputmode=decimal
│   Purchase date   [ —        ][Today]│  DateField
│   Bought from     [ e.g. Local game store ]
│   Location        [ None          ▾ ]│  NativeSelect
│   Group           [ None          ▾ ]│  NativeSelect
│   Notes           [               ]  │  textarea, grows
├──────────────────────────────────────┤
│ [       Add to collection        ]   │  sticky footer, 48 px; above keyboard + home indicator
└──────────────────────────────────────┘
```

Defaults (the tap-tap-add path):
- **Variant:**
  - If the catalog lists exactly one available variant, it is preselected (it is the only print).
  - If it lists several, preselect by priority `normal → holo → reverse_holo → first_edition → promo_stamped` among those available (Furret → Normal). The chip row sits first under the art so the choice is visible.
  - If it lists none (`detailsComplete:false` brief records), preselect `normal` and show the caption "Variant not listed in the catalog — check it".
  - Any enum value can be picked via "Other…".
- **Condition: Not set** (null, shown as `?`). This changed in A2 to follow API.md: no assumed condition, so a fast add never records a condition nobody checked.
  - One tap sets NM etc.
  - "Keep for next card" remembers the last chosen condition for the session (see below).
- **Quantity** 1. **Raw** (Graded off). Everything else is empty or None.
- **Graded on** reveals:
  - Company chips: PSA BGS CGC SGC ACE TAG Other. Other reveals a required "Company name".
  - Grade: text, `inputmode="decimal"`; labels such as "Authentic" are allowed.
  - Cert number: optional.
  - If quantity > 1, the cert field is disabled with the helper "Add slabs with certificate numbers one at a time" (core rejects bulk adds with a cert).
  - Condition chips hide while Graded is on, and the copy saves `condition: null` unless the user had set one.
- **Session memory:**
  - When a location is chosen, a checkbox "Use for the next cards too" (default on) keeps it for later adds until the app is closed. The same applies to Group, Condition ("Keep condition for next card") and purchase details ("Keep purchase details for next card").
  - Stored in memory/sessionStorage, never in the DB. This makes binder-page logging fast.
- **Price field:** empty means unknown. It is never submitted as 0 unless typed. Currency defaults to Settings → Currency.
- **Button label** follows quantity: "Add to collection" (1), "Add 3 copies" (3). While committing it shows a spinner and "Adding…" and is disabled, which prevents double adds.
- **Keyboard:**
  - The sheet goes to the large detent when a field focuses.
  - The footer rides above the keyboard (`--ps-sheet-pad-bottom`).
  - `enterkeyhint="next"` moves between fields; on the last field it is `done`.
  - The iOS accessory bar (‹ › Done) stays enabled for this multi-field form.

Commit: `CollectionRepo.bulkAdd({quantity, copy})` (max 100, one transaction).
- **Success.** `haptic('added')` fires after the commit resolves. The sheet body is replaced by a success state (no navigation):
```
│   ✓  Added Furret × 1               │  positive check (spring pop; fade under reduced motion)
│   Darkness Ablaze · Normal · NM      │
│   You now own 4                      │
│ [ Add another ]  [ Undo ]  [ View ]  │  Add another = primary
```
  - **Add another** (primary, focused): closes the sheet and returns to search with the query text selected (the next keystroke replaces it) and the keyboard open. The results scroll position is kept.
  - **Undo:** `remove` per returned copy id, then `haptic('undo')` and toast "Removed". Partial failure is reported ("Removed 2 of 3 — 1 copy is still in your collection. [View]"). Available until the next add or 30 s.
  - **View:** Card Details.
  - The live region also announces "Added Furret · Darkness Ablaze".
- **Error.** `haptic('error')`. An inline banner appears above the button with the fields intact, using the §12 copy (e.g. STORAGE_FULL).
  - `ValidationError` issues attach to their fields (`aria-describedby`).
  - **Never auto-retry a bulk add** (API.md). On `PersistenceError`, refetch the card first, then let the user decide.
- **Dismiss without adding:** if any field differs from its default → "Discard this copy?" [Keep editing] [Discard]. Otherwise it closes silently. Nothing is ever auto-saved.

### 7.4 Accessibility
- Search results are a plain list of buttons; no `listbox`.
- The sheet title is the card name.
- Chip groups are `radiogroup`s with arrow-key support; Graded is a `switch`.
- Stepper buttons are named "Decrease quantity" / "Increase quantity", and the value is announced.
- The success state moves focus to "Add another".

## 8. Storage locations (`/settings/locations`)

```
┌──────────────────────────────────────┐
│ ‹ Settings   Storage locations   [+] │
├──────────────────────────────────────┤
│ ┌──────────────────────────────────┐ │
│ │ Binder A                    124 ›│ │  row ≥ 56 px: name, copyCount (tabular)
│ │ Red 9-pocket, SWSH era           │ │  description caption
│ ├──────────────────────────────────┤ │
│ │ Bulk box 1                  210 ›│ │
│ └──────────────────────────────────┘ │
│ Cards without a location: 72     ›   │  → /collection?loc=none
└──────────────────────────────────────┘
```
- **Row tap** → `/collection?loc=<id>`. The trailing `⋯` (44 px) offers Rename / Edit description / Delete.
- **[+]** → sheet with Name (required, 1–200, unique case-insensitively; `ConflictError` shows the inline "You already have a location called “Binder A”") and Description. Button "Create location".
- **Delete with cards** → Dialog "Delete “Binder A”? 124 cards will have no location. The cards themselves are not deleted." [Cancel] [Delete location] → `haptic('deleted')`.
- **Empty:** "No storage locations" / "Create one for each binder, box or deck so you can find any card later." / "Create a location".
- No nesting in Phase 1.

## 9. Custom card creation (`/custom-cards/new`, edit at `/custom-cards/$id?edit=1`)

Shown from:
- Add search ("Can't find it? Create a custom card", prefilled with the query);
- the Card-not-found page;
- Settings → Custom cards.

```
┌──────────────────────────────────────┐
│ ✕  New custom card                   │  modal route
├──────────────────────────────────────┤
│ For cards missing from the catalog — │  body muted
│ misprints, new releases, oddities.   │
│ Name *        [ Furret            ]  │
│ Language      (EN)(JP)               │
│ Set name      [ Darkness Ablaze    ] │  free text + suggestions from installed sets
│ Number        [ 136               ]  │
│ Rarity        [ Uncommon         ▾]  │  known strings + free text
│ Image URL     [ https://…         ]  │  optional; preview in 63:88 frame
│ Notes         [                   ]  │
├──────────────────────────────────────┤
│ [ Create and add to collection ]     │  primary → opens §7.3 for the new card
│ [ Create only ]                      │  secondary
└──────────────────────────────────────┘
```
- **Image:** a URL in Phase 1 (`imageUrl`, http/https; core never fetches it). Helper text: "Paste a link to an image. Adding your own photo comes later." Photo upload waits for the Phase 7 media store / `.fdx` user images.
- **Keyboard:** the form is keyboard-avoiding (§17.7). `enterkeyhint="next"` chains the fields.
- **Validation:** name is required; the URL must be http(s).
- **Edit mode:** button "Save changes", with the note "Changes don't alter copies you already own." Delete is allowed only when `copyCount = 0`; otherwise it is disabled with "Delete the 2 copies first" (`InUseError`).
- **Tiles:** custom tiles show a "Custom" micro chip.

## 10. Settings, Catalog, Data, About

### 10.1 Settings home (`/settings`), 390 px
```
┌──────────────────────────────────────┐
│ Settings                             │  large title
├──────────────────────────────────────┤
│ CARD CATALOG                         │  section caption (micro, muted, uppercase)
│ Catalog & prices               ›     │  → /settings/catalog ; trailing "EN ✓ · JP —"
│                                      │     or "Downloading 42 %"
├──────────────────────────────────────┤
│ YOUR DATA                            │
│ Import, export & backup        ›     │  → /settings/data
│ Storage locations              ›     │  → /settings/locations ; count
│ Custom cards                   ›     │  sheet listing CollectionRepo.listCustom + "New custom card"
├──────────────────────────────────────┤
│ PREFERENCES                          │
│ Appearance     (Dark)(Light)(System) │  default Dark
│ Currency       (USD · TCGplayer)(EUR · Cardmarket)   defaultCurrency: display + paid default
│ Search language        (All)(EN)(JP) │
│ Include TCG Pocket (digital) cards [ ○] │  hideTcgPocket=true by default (off = hidden)
│ Haptics                        [●  ] │  native only (hidden on web)
├──────────────────────────────────────┤
│ ABOUT                                │
│ About FlashyDex                ›     │  → /settings/about ; trailing "1.0.0"
│ Privacy policy                 ›     │  → /settings/privacy
│ Licenses                       ›     │  → /settings/licenses
├──────────────────────────────────────┤
│ DANGER ZONE                          │  caption in --ps-negative
│ Remove a downloaded catalog…         │  negative text rows
│ Erase all FlashyDex data…            │
├──────────────────────────────────────┤
│ FlashyDex is not affiliated with     │  caption subtle, always visible at the bottom
│ Nintendo, Creatures, GAME FREAK or   │
│ The Pokémon Company.                 │
└──────────────────────────────────────┘
```
- **Preferences apply instantly.** There is no Save button: these are settings, not collection data.
  - `hideTcgPocket` and `defaultCurrency` save through `SettingsRepo.update`.
  - Appearance, Search language and Haptics are device preferences. Request S5 asks to add them to AppSettings; meanwhile they live in Capacitor Preferences / `localStorage` with the `ps-` prefix, and theme is mirrored to `localStorage["ps-theme"]` for the no-flash script.
- **Rows:** every row is ≥ 48 tall with a chevron for navigation. Switch rows put the label on the left and the switch on the right, and the whole row toggles.
- **Large text:** at `ax`, segmented preferences become NativeSelects so they never overflow.

### 10.2 Catalog & prices (`/settings/catalog`)

The catalog is per language. The primary path is a **catalog pack**: a versioned `.db.zst` downloaded, verified and activated atomically (COMPRESSION-STORAGE). The **TCGdex direct path** (`SyncService`) handles:
- prices;
- sets newer than the pack;
- one-set fill-ins;
- a full fallback when no pack is available.

```
┌──────────────────────────────────────┐
│ ‹ Settings      Catalog & prices     │
├──────────────────────────────────────┤
│ LANGUAGES                            │
│ ┌──────────────────────────────────┐ │
│ │ English                     ✓    │ │  installed
│ │ Catalog 2026.10.30 · 23,736 cards│ │  pack version · card count
│ │ 58 MB on this device             │ │  uncompressed footprint
│ │ Update available · 3 MB   Update │ │  only when manifest has a newer version
│ ├──────────────────────────────────┤ │
│ │ Japanese                [Download]│ │  not installed
│ │ 12,781 cards · 9 MB download     │ │  from manifest; "uses 31 MB"
│ │ Many older Japanese cards have no│ │
│ │ pictures in the catalog yet.     │ │
│ └──────────────────────────────────┘ │
├──────────────────────────────────────┤
│ PRICES                               │
│ TCGplayer prices as of 30 Oct 2026   │  newest sourceUpdatedAt among owned cards
│ [ Update prices ]  For: (My cards)(Sets I collect)(Everything)
│ Prices for the cards you own.        │  no time estimate (the app doesn't measure one)
├──────────────────────────────────────┤
│ SETS I COLLECT                       │
│ All sets                       ›     │  or "12 sets" → sheet (§15.5 picker)
│ Used for the Sets tab and for price  │
│ updates. Doesn't change the download.│
├──────────────────────────────────────┤
│ Check for a newer catalog      ›     │  manifest + new-set check; also pull-to-refresh
│ Last checked today, 14:05            │
└──────────────────────────────────────┘
```

**Pack download/install, running state** (`ProgressCard` replaces the language row):
```
│ English                              │
│ ▓▓▓▓▓▓▓▓░░░░░░░░░░░░  8.4 / 14.2 MB  │  determinate (bytes) during download
│ Downloading · about 1 min left       │  stage line: Downloading → Checking → Installing → Ready
│ [ Pause ]  [ Cancel ]                │  Pause only if resumable (HTTP Range); else Cancel only
```
- Stages (they map to the request S1 states): Downloading (bytes) → Checking (size + SHA-256; indeterminate) → Installing (decompress to temp; determinate by bytes if available) → Activating (instant) → **Ready**.
- The `aria-valuetext` reads, e.g., "English catalog, downloading, 8.4 of 14.2 megabytes".
- **Space check first.** If free space < uncompressed size × 2 (temp + final): Dialog "Not enough space" / "The English catalog needs about 120 MB free. Free up space in Settings → General → iPhone Storage." [OK]. The download is never started.
- **Cellular.** On a cellular connection with a download > 50 MB: Dialog "Download on cellular?" / "The English catalog is 64 MB." [Wait for Wi-Fi] [Download now]. This needs the `@capacitor/network` connection type; on web there is no prompt.
- **Cancel** → Dialog "Stop downloading? Your current catalog stays as it is." [Keep downloading] [Stop].
- **Failure.** The working catalog is untouched (atomic activation) and the copy says so:
  - Network: "Download interrupted. [Retry]".
  - Hash or size mismatch: "The download was damaged and wasn't installed. Your current catalog is unchanged. [Retry]".
  - Schema: "This catalog needs a newer version of FlashyDex. Update the app from the App Store." with no retry.
- **Update available:** "Update · 3 MB" (or "18 MB" if a full pack). Same flow. Search keeps working on the old catalog until activation, which is instant.

**TCGdex direct jobs** (`SyncService`: prices, newer sets, one set, fallback crawl):
```
│ Updating prices · My cards           │
│ ▓▓▓▓▓▓▓▓░░░░░░░░░░░░  120 / 412 cards│  cardsDone / cardsTotal
│ 3 failed · Details                   │  cardsFailed (warning), disclosure lists warnings[]
│ [ Pause ]                            │  = SyncService.cancel (keeps progress)
```
- **Pause** = `SyncService.cancel`. It shows "Stopping…" until `cancelled`, then becomes **Resume** (= `resume`, same run). The copy says "Paused" rather than "Cancelled": nothing is lost.
- **Completed:** toast plus `haptic('synced')`: "Prices updated for 409 of 412 cards." (real counts). With warnings, the toast reads "…3 couldn't be updated" and links to the warning list.
- **Failed / interrupted:** "Stopped at 120 of 412 cards. Everything downloaded so far is kept." [Resume] [Details].
- **Another job active** (`ActiveWorkError`): the running card shows instead of a second start. A new request is queued ("Starts after the current download") — request S4.

**Fallback when no pack is available** (manifest unreachable or no pack for the language, but TCGdex is reachable):
- The language row offers "Download from TCGdex · about 23,700 cards · 50 MB · 15–25 min".
- It runs `SyncService.start({languages, selection})` for all sets, or only "Sets I collect" (the row offers both, each with its estimate).
- Estimate formula:
  - download ≈ cards × 2.1 KB (measured average of card-detail JSON, 2026-10-30);
  - time ≈ cards ÷ 40 to cards ÷ 25 seconds (concurrency 8 at the measured ~0.26 s latency);
  - shown as a rounded range.
- Search becomes available set by set as the download progresses.
- A long crawl offers "Keep screen on while downloading" (default on while this screen is open; `@capacitor-community/keep-awake`, request T5). The app pauses in the background (§16.3).

### 10.3 Import, export & backup (`/settings/data`)

**Import (dry-run first):**
```
│ IMPORT                               │
│ Bring in cards from a FlashyDex JSON export or a CSV file.   Format guide ›
│ [ Choose file ]                      │  Platform.filesystem.pick({kind:'transfer'})
```
- **The file picker is native:** iOS presents the document picker (Files, iCloud Drive, other providers) limited to JSON/CSV; Android uses the system picker; web uses `<input type=file accept=".json,.csv,application/json,text/csv">`. Picker cancel → nothing happens (`null`).
- After picking → `TransferService.dryRun` → **preview** (large sheet):
```
│ Import preview — collection.csv      │
│ 412 rows read                        │
│ ✓ 398 will be added                  │  positive
│ ↻ 6 match cards you already have     │  info — policy below decides
│ ⚠ 5 need attention                   │  warning (e.g. unknown card id → custom card)
│ ✕ 3 will be skipped (errors)         │  negative
│ If a row matches a copy you already have:
│ (Skip it)(Update my copy)            │  conflictPolicy skip|update — changing it re-runs dry-run
│ ▸ Row details (first 100)            │
│ [ Import 398 cards ]   [ Cancel ]    │  commit shows the exact count
```
- Nothing is written before "Import N cards". Commit = `TransferService.commit({id, planHash, confirm:true})`; it is safe to replay (receipt).
- On success: `haptic('added')` and the result "Imported 398 cards. 3 rows skipped." [View collection].
- Error copy is in §12: STALE_PREVIEW → "Preview again"; PREVIEW_EXPIRED (30 min); PAYLOAD_TOO_LARGE (25 MB); IMPORT_INVALID.

**Export:**
```
│ EXPORT                               │
│ [ Share JSON ]  Complete — use this to move to another device or app.
│ [ Share CSV ]   One row per card, for spreadsheets. Some details aren't included.
```
- `TransferService.exportFile` → `shareExport`. On native this opens the **iOS/Android share sheet** (Save to Files, AirDrop, Mail…); on web the browser downloads the file.
- Filenames: `flashydex-<UTC compact>.json/.csv`.
- While the file is being written, the button shows a spinner and "Preparing…".
- Outcomes are reported honestly:
  - `shared` → toast "Export ready" (no claim that it was saved);
  - `downloaded` → "Downloaded flashydex-…json";
  - `cancelled` → nothing;
  - error → `haptic('error')` + toast.
- On iPad, the share popover anchors to the pressed button.

**Backup & restore (`.fdx`, COMPRESSION-STORAGE):**
```
│ BACKUP & RESTORE                     │
│ [ Back up now ]  Saves your collection, settings and custom cards
│                  in one .fdx file. Card catalogs aren't included —
│                  they download again after a restore.
│ Last backup: 28 Oct 2026 · 412 cards │  if known (request S6)
│ [ Restore from backup… ]             │  negative-outlined secondary
│ Your collection is also included in  │  caption subtle; wording must match actual OS
│ your iPhone's iCloud/device backup.  │  backup behaviour (request S7) — omit if not true
```
- **Back up now:** create the `.fdx` → share sheet (as Export). A caption under the button suggests "Save it to Files or iCloud Drive". Until Stage A3 ships `.fdx`, this button produces the JSON backup from `BackupService.create` and is labelled "Back up (JSON)".
- **Restore:**
  1. Pick the file (`kind:'database'`; `.fdx`, or JSON while A3 is pending) → `previewRestore`.
  2. Dialog:
```
│ Restore this backup?                 │
│ Backup:  412 cards · made 28 Oct 2026│  from preview metadata
│ Now:     431 cards                   │
│ Restoring replaces your collection,  │
│ settings and custom cards. A safety  │
│ copy of your current data is kept.   │
│ Type RESTORE to confirm  [         ] │  autocapitalize=characters
│ [ Cancel ]   [ Restore backup ]      │  danger-solid, enabled only after typing
```
  3. During the restore: blocking overlay (§1.4). Success → toast "Backup restored — 412 cards". If a catalog for the backup's cards isn't installed, the Dashboard shows the download card.
  4. Failure → "Restore failed. Your data is unchanged." (core reopens the prior file).
- **Unsupported on this device** (`UnsupportedCapabilityError` for raw restore): explain "This backup can be merged with Import instead." [Go to Import].

### 10.4 About (`/settings/about`)
```
┌──────────────────────────────────────┐
│ ‹ Settings          About            │
├──────────────────────────────────────┤
│            [FlashyDex mark]          │  64 px, same artwork as the icon
│              FlashyDex               │  H2
│        Version 1.0.0 (12)            │  App.getInfo() version (build) on native;
│                                      │  web: package version + "web"
├──────────────────────────────────────┤
│ FlashyDex is not affiliated with     │  body, exact BRIEF sentence
│ Nintendo, Creatures, GAME FREAK or   │
│ The Pokémon Company.                 │
│ Card names, numbers and images are   │  body muted
│ the property of their respective     │
│ owners and are shown for collection  │
│ tracking only.                       │
├──────────────────────────────────────┤
│ DATA SOURCES                         │
│ Card catalog and images: TCGdex   ↗  │  https://tcgdex.dev (in-app browser)
│ Prices: TCGplayer (USD) and          │  caption: "Provided through TCGdex. FlashyDex
│ Cardmarket (EUR), via TCGdex         │  isn't affiliated with TCGplayer or Cardmarket.
│                                      │  Prices may be out of date."
│ Catalog versions: EN 2026.10.30 ·    │
│ JP not downloaded                    │
├──────────────────────────────────────┤
│ Privacy policy                 ›     │
│ Licenses                       ›     │
│ Database version 3                   │  schema_migrations latest (support info), caption
└──────────────────────────────────────┘
```
- Readable offline and before onboarding.
- The disclaimer text is selectable.
- The 64 px mark is decorative (`alt=""`).

### 10.5 Privacy policy (`/settings/privacy`)
- **The in-app text is bundled** (works offline). Its source is `docs/PRIVACY-POLICY.md` after the owner fills in the brackets; this doc doesn't duplicate the policy wording.
- **Layout:** H1 "Privacy policy", a "Last updated" line, then the policy text rendered as headings + paragraphs in body text, max 65ch, selectable.
- **The top of the screen is a short summary card** (surface, radius lg), written in this voice:
  - "FlashyDex doesn't collect your data. There's no account, no ads and no analytics."
  - "Your collection, notes and prices you enter stay on this device."
  - "To download card data, images and prices, the app connects directly to TCGdex (api.tcgdex.net and assets.tcgdex.net). TCGdex sees your device's IP address, like any website you visit. Price data comes from TCGplayer and Cardmarket through TCGdex."
  - "Exports and backups go only where you share them."
  - A sentence about OS backup that matches reality (request S7).
- **"View online ↗"** opens the hosted URL (`FLASHYDEX_PRIVACY_URL` build constant; the owner hosts it) in the in-app browser. The row is hidden when the constant is empty.
- No consent toggles exist, because nothing is collected.

### 10.6 Licenses (`/settings/licenses`)
- A list of entries, each with name, version, license name and a disclosure revealing the full license text (selectable, monospace caption).
- Always first:
  - **TCGdex** — card data; cards-database MIT © 2021 TCGdex. A note says the MIT licence covers TCGdex's software and data files, not the card artwork.
  - **Pokeum** — MIT © 2026 TBLgGamin. Listed if any code is adapted; RECOGNITION-DESIGN plans Phase 2 adaptations. Mirrors `THIRD_PARTY_NOTICES.md`.
  - **Inter** — SIL OFL 1.1 (Android/web).
  - **lucide** — ISC.
- Then every bundled npm dependency, from a build-generated `licenses.json` (request T6), plus Capacitor plugins and SQLCipher (via `@capacitor-community/sqlite`).
- Long lists are virtualized; a search field filters by name.

### 10.7 Danger zone
- **Remove a downloaded catalog…** → a sheet listing installed languages, each with its size.
  - Confirm Dialog: "Remove the English catalog? This frees 58 MB. Your cards stay in your collection — you'll see what you saved, without prices and card info, until you download it again." [Cancel] [Remove].
  - It deletes `catalog-en.db` only (the catalog is replaceable; personal data lives in `flashydex-user.db`). Request S8.
- **Erase all FlashyDex data…** → full-screen confirm:
  - "This deletes your collection, custom cards, locations, settings and downloaded catalogs from this device. It can't be undone. Back up first if you might want them later."
  - [Back up first] (→ backup flow), a "Type ERASE to confirm" field, and [Erase everything] (danger-solid, enabled after typing).
  - Then the blocking overlay → `haptic('deleted')` → the app restarts at `/welcome`. Request S8.
  - Until S8 exists the row is hidden. Deleting the app also removes all data, and the row's caption says so.

## 11. Scanner (`/scan`) — Phase 3 design, disabled in Phase 1

Phase 1 ships only the disabled tab slot and the "Scanner coming" sheet (§11.6). Everything else here is the Phase 3 target; the shell, tokens and add-confirm sheet are built compatible with it now.

Camera: Phase 3 uses `@capacitor/camera` or a native preview plugin. The plugin is not linked in Phase 1, so no permission strings and no prompt; the draft strings are in APP-STORE-COMPLIANCE.md.

### 11.1 Layout 390 px (Phase 3)
```
┌──────────────────────────────────────┐
│ ✕          Looking for a card…   ⚡ ↺│  translucent bar over video (safe-area top): close,
│                                      │  status pill, torch, switch camera
│    ┌────────────────────────┐        │
│    ┃                        ┃        │  framing guide: 63:88, 78% width, corner brackets
│    ┃                        ┃        │  4 px accent; outside darkened 55%
│    ┃                        ┃        │  guide turns positive when a card quad is detected
│    └────────────────────────┘        │
│        Fill the frame with the card  │
│ [🖼 Photo]      ( ◉ )      [≡ 12]    │  photo picker · shutter 72 px · session tray
│ Continuous  [●  ]   EN|JA|Auto       │  bottom controls above --ps-safe-bottom
└──────────────────────────────────────┘
```
Status pill copy sequence: "Looking for a card…" → "Hold steady" → "Identifying…" → "Match found" / "Pick the right card" / "No match — try again or search".

### 11.2 Result sheet (peeks over the bottom 55 %)
- **Confident:**
  - Shows art thumb, name, set · number, language and a confidence meter ("96% match" with a text label).
  - Variant chips: the hint is preselected only when it is confident; otherwise preselect by the §7.3 rule and label it "Looks like Reverse holo? — confirm".
  - Condition "Not set", qty stepper, **Add card** primary.
  - Still needs a tap; it never auto-saves.
  - "Quick add confident matches" (off by default) shows a 2 s ring countdown that can be cancelled.
- **Uncertain:** "Pick the right card" with up to **3** candidate tiles (art, name, set·number, % match), plus "None of these — search" → `/add?q=<best name>`. Nothing is preselected.
- **No match / no card:** "Couldn't identify this card" + [Try again] [Search manually].
- Every field is editable before Add; Add reuses the exact §7.3 component, including `haptic('added')`.
- **After Add in continuous mode:** the sheet collapses to the toast "Added Furret · ×1" [Undo], the camera resumes, and the session tray count increments with a pop.

### 11.3 ≥ 1024 (webcam)
Video on the left (max 640 px wide); the result panel on the right (420 px), always visible.

### 11.4 Error states
- **Permission denied:** "Camera access is off for FlashyDex. Turn it on in Settings → FlashyDex → Camera, or choose a photo instead." [Open Settings] (App settings deep link) [Choose photo].
- **No camera:** "No camera found on this device." [Choose photo].
- **Recognition unavailable** (model not downloaded, or the optional endpoint unreachable): "Card recognition isn't ready. Search manually or try again later." [Search manually].
- **Slow (> 4 s):** "Still working…". Timeout at 10 s → No-match state with retry.
- **Web over plain HTTP:** the live camera needs a secure context, so offer "Choose a photo" (`<input type=file accept="image/*" capture="environment">`).

### 11.5 Accessibility
- The status pill is a polite live region.
- The shutter is a "Take photo" button.
- Candidates are radio-like buttons ("Furret, Darkness Ablaze 136 of 189, 62 percent match").
- Torch and switch-camera buttons have names and a pressed state.
- Reduced motion: the guide changes colour without pulsing.

### 11.6 Phase 1: "Scanner coming" sheet (the only scanner UI that ships now)
```
│               ▬▬▬                    │
│ [ScanLine icon, muted]               │
│ Camera scanning is coming            │  H3
│ Scanning arrives in a later update.  │
│ For now, find cards by name or       │
│ number — it takes a few seconds.     │
│ [ Add a card by search ]             │  primary → /add
│ [ Close ]                            │  text button
```
Playwright: the Scan tab button has `aria-disabled="true"` and no `href`, and opening it never calls `getUserMedia` or a Camera plugin method.

## 12. Global states and copy library

Errors map a `DomainError.code` (API.md) to friendly text. Fallback: "Something went wrong. Try again." with the code under "Details". Never "Oops". Never blame the user.

| Code / condition | Title | Body (actions) |
|---|---|---|
| network unreachable (offline, `HTTP_FAILED`) | You're offline | "Your collection works offline. Downloads and price updates continue when you're connected." (Try again) |
| TCGdex 5xx / timeout | TCGdex isn't responding | "TCGdex isn't responding. The catalog source is having trouble. Your collection is fine — try again later." (Try again). Codes `SERVER_ERROR`; `RATE_LIMITED` → "TCGdex asked us to slow down. Try again in a few minutes. Your collection is fine."; `BAD_PAYLOAD` → "TCGdex sent something FlashyDex couldn't read. Your collection is fine. Try again later." `HTTP_FAILED` stays "You're offline". |
| catalog server (pack host) unreachable | Can't reach the catalog download | "Try again later, or download directly from TCGdex (slower)." (Try again · Download from TCGdex) |
| `DB_BUSY` | Busy for a moment | "FlashyDex is saving something else. Try again." (Try again) — no auto-retry for adds |
| `STORAGE_FULL` | Your device is full | "Nothing was saved. Free up space in Settings → General → iPhone Storage (Android: Settings → Storage), then try again." |
| `PERSISTENCE_FAILED` | Your last change may not have saved | "FlashyDex reloaded your data. Check the card, then try again if it's missing." (View) |
| `DB_UNAVAILABLE` / `MIGRATION_FAILED` (startup) | FlashyDex couldn't open your data | "Your collection hasn't been deleted. Close and reopen the app. If this keeps happening, update FlashyDex from the App Store." (Try again · Contact info in About) — full-screen, never an empty app |
| `MAINTENANCE` | Restoring a backup | blocking overlay copy (§1.4) |
| `ACTIVE_SYNC` / `ACTIVE_WORK` | A download is already running | show the running ProgressCard; offer "Start after it" (S4) |
| `NOT_FOUND` | Not found | "This item doesn't exist anymore. It may have been deleted." |
| `VALIDATION_ERROR` | (inline on fields) | per-field message from `issues[].path` |
| `IN_USE` | Can't delete yet | "It's still used by N cards." (N = `dependentCount`) |
| `CONFLICT` (name) | (inline) | "You already have one called “…”." |
| `STALE_PREVIEW` | Your collection changed | "Preview again to see the latest." (Preview again) |
| `PREVIEW_EXPIRED` | Preview expired | "Import previews last 30 minutes, restore previews 10. Choose the file again." |
| `IMPORT_INVALID` / `INVALID_JSON` / `INVALID_CSV` | This file can't be imported | "It isn't a FlashyDex JSON export or a CSV with the expected columns." |
| `BACKUP_INVALID` | This backup can't be used | "It isn't a FlashyDex backup, or it's damaged." |
| `PAYLOAD_TOO_LARGE` | File too large | "The limit is 25 MB for imports and 512 MB for backups." |
| `FILE_IO` / `SHARE_FAILED` | Couldn't share the file | "Try again. If it keeps failing, restart FlashyDex." |
| `UNSUPPORTED_CAPABILITY` | Not available on this device | context-specific alternative (e.g. Import instead of raw restore) |
| `CANCELLED` | — | silent (user cancelled) |
| pack hash/size mismatch | The download was damaged | "It wasn't installed. Your current catalog is unchanged." (Retry) |
| pack needs newer app | Update FlashyDex | "This catalog needs a newer version of the app." |
| web: second tab (instance lock) | FlashyDex is open in another tab | "Close the other tab to use FlashyDex here." (web only) |

**Button vocabulary** (consistent verbs): Add to collection · Add N copies · Add another · Save · Delete copy · Create location · Create and add to collection · Download · Update · Update prices · Pause · Resume · Retry · Cancel · Choose file · Import N copies · Share JSON · Share CSV · Back up now · Restore backup · Remove · Erase everything · Clear filters · Show N cards · Try again.
Never use "Submit", "OK" for destructive actions, or "Oops".

**Skeleton rule:** skeletons mirror the final geometry exactly and crossfade to content in 320 ms. Show them only after 150 ms; local reads are usually faster.

## 13. Accessibility checklist (implementer must meet; Playwright + axe + device)

- **Landmarks:** `header`, `nav[aria-label="Tabs"]`, `main`, sheets `role=dialog`. One H1 per page (the large title, or the card name).
- **Focus:** visible `:focus-visible` ring (2 px `--ps-focus-ring`, 2 px offset) on every interactive element. Sheets trap focus and restore it. Route changes move focus to the new page's H1 (`tabIndex=-1`) and announce the title.
- **Targets:** ≥ 44 × 44 pt. Playwright queries all `a,button,[role=button],input,select,[role=switch]` in the viewport at 390 px and asserts the bounding box is ≥ 44 in both dimensions (inline text links inside paragraphs excepted).
- **Labels:** every input has a visible `<label>`. Icon buttons have `aria-label`. Badges have `aria-label` with the long names.
- **Colour** is never the only signal (rarity, condition, gain/loss signs; missing tiles are also dashed and say "Missing" in the accessible name).
- **Contrast:** token pairs are verified (DESIGN-TOKENS §3, including the chrome over worst-case art).
- **Live regions:** toasts (`status`); sync start, completion and failure (not percentages); collection result count; scanner status.
- **VoiceOver (iOS) / TalkBack (Android)** device pass:
  - Tab bar items read "Home, tab, selected" style names (link + `aria-current`).
  - Scan reads "Scan, coming in a later update, dimmed".
  - The Add button, sync pill, share actions, steppers, switches and sheets all have names and states.
  - Every swipe or long-press action has a button alternative.
  - Headings are navigable with the rotor.
  - JA names are wrapped in `<span lang="ja">`.
- **Dynamic Type / font scale** (DESIGN-TOKENS §4.2):
  - Test at iOS Large (default), xxxLarge and AX3, and Android 1.3× and 2.0×.
  - No clipped controls; buttons grow (min-height) and labels may wrap.
  - The primary Add button stays visible above the keyboard and home indicator.
  - The grid goes to 2 columns at `ax`; the stat tiles go to 1 column.
  - No viewport lock (`maximum-scale`/`user-scalable=no` forbidden).
  - The web layout survives 200 % browser text at 390 px with no horizontal scroll.
- **Reduced motion:** no transform animations (page, sheet, pop, pull stretch); fades remain; haptics remain.
- **Increased contrast** (iOS): tokens switch (DESIGN-TOKENS §3.4); verify the subtle text and borders.
- **axe:** run `@axe-core/playwright` on `/`, `/collection`, `/cards/en/swsh3-136`, `/sets`, `/add`, `/settings`, `/settings/catalog`, `/settings/data`, `/settings/about`, `/settings/privacy` and `/welcome` (each step). Zero serious or critical violations.

## 14. Acceptance hooks (Playwright 390 × 844 and 1280 × 800; device checks marked M)

Stable selectors (`data-testid`):
- Shell: `tab-bar`, `tab-scan` (aria-disabled), `add-button`, `sync-pill`.
- Search and add: `search-input`, `result-row`, `confirm-sheet`, `variant-chip-<enum>`, `condition-chip-<NM…|unset>`, `qty-input`, `add-submit`, `add-another`, `undo`.
- Collection: `card-tile`, `qty-badge`, `price`, `filter-button`, `filter-sheet`, `sort-button`.
- Catalog: `catalog-language-<en|ja>`, `catalog-download-<en|ja>`, `catalog-progress`, `prices-update`.
- Data: `import-file`, `import-preview`, `import-commit`, `export-json`, `export-csv`, `backup-create`, `restore-file`.
- Onboarding: `welcome-start`, `welcome-skip`, `notice-continue`, `lang-<en|ja>`, `sets-all`, `sets-pick`, `onboarding-finish`.
- About: `about-disclaimer`.

Key flows:
1. **Tap-tap-add:** `/collection` → `add-button` → type "furret" → first `result-row` (Furret, Darkness Ablaze) → `add-submit` with no other interaction → "Added Furret" → `add-another` focuses `search-input` with its text selected. Verify one new copy: variant normal, **condition null**, raw, no price.
2. **Null price:** a card with no price snapshot renders no `price` element in its tile and no "$0.00" anywhere on the page.
3. **No horizontal overflow** on every route in §1.1, including at `--ps-text-scale: 2` (`data-text-size="ax"`).
4. **Scan slot:** `tab-scan` has `aria-disabled="true"`; activating it shows "Camera scanning is coming"; `navigator.mediaDevices.getUserMedia` is never called (spy).
5. **Discard:** open confirm, change condition to LP, press Cancel → "Discard this copy?"; Discard → no copy created. Repeat with the browser back button (stands in for the edge swipe / Android back): the same dialog appears.
6. **Theme:** default `data-theme="dark"`; switching to Light persists across reload.
7. **First run:**
   - A fresh DB opens `/welcome`.
   - The notice step shows the exact disclaimer sentence.
   - Skipping lands on `/` with the "Download the card catalog" empty state, and `/welcome` is never shown again.
   - Back from `/` does not return to `/welcome`.
8. **Offline (web: `context.setOffline(true)`):** with a catalog present, search, add, edit, delete and export all work. "Update prices" shows the offline toast. No network error dialog appears on any tab root.
9. **Safe areas:** with `--safe-area-inset-top: 47px; --safe-area-inset-bottom: 34px` injected on `<html>`, the top bar content starts ≥ 47 px from the top, the tab bar's last interactive pixel is ≥ 34 px above the bottom, and the sheet footer button clears 34 px.
10. **Back closes sheets:** open the filter sheet, `page.goBack()` → the sheet is closed and the URL has no `sheet=`.
11. **(M) iPhone:**
    - VoiceOver pass of first run → add → export share sheet.
    - AX3 Dynamic Type pass of Add confirm.
    - Edge-swipe back from Card Details to Collection keeps the scroll position.
    - Airplane-mode cold launch shows the collection.
    - Haptic on add, undo and delete (felt).

## 15. First run / onboarding (`/welcome/*`)

### 15.1 Startup gate (`__root.beforeLoad`)
1. **Splash stays up** while startup runs: the DB opens, migrations run and `SettingsRepo.get` returns. Then `SplashScreen.hide({fadeOutDuration:200})` after the first route paints (DESIGN-TOKENS §10.3). There is no in-app loading screen unless startup takes > 3 s; then a centred mark with "Opening your collection…".
2. **Startup failure** → full-screen `DB_UNAVAILABLE` / `MIGRATION_FAILED` error (§12).
3. **`onboardingCompletedAt == null`** → redirect to `/welcome`, unless the target is `/settings/about`, `/settings/privacy` or `/settings/licenses`.
4. **An interrupted catalog job from a previous session** → the sync pill shows "Download paused · Resume". Resume is user-initiated (ARCHITECTURE).

### 15.2 Shared layout of every step (modal, no tab bar)
```
┌──────────────────────────────────────┐
│ ‹                      ● ● ○ ○   Skip│  back + Skip (not on step 1), 4-dot progress
│                                      │
│ [illustration/mark area, ≤ 30% h]    │  only on step 1; other steps start with the H1
│ Title (H1)                           │
│ Body (body, muted, max 34ch)         │
│ … step content …                     │
│                                      │
│ [          Primary action         ]  │  sticky footer, above home indicator
│            secondary text button     │
└──────────────────────────────────────┘
```
- **Progress dots:** `aria-label="Step 2 of 4"`.
- **Back:** the edge swipe goes to the previous step, because each step is a pushed route.
- **Skip,** on any step, sets `onboardingCompleted:true` (and `disclaimerAcknowledged:true`, because the notice is always shown before Skip is available: step 1 has no Skip control). It then `replace`s to `/`. The app is fully usable for custom cards and import, and the Dashboard shows the download card. **The disclaimer is shown at least once before entering the app; acknowledgement never blocks local use.**
- **Large text:** the content scrolls and the footer stays pinned.
- **Reduced motion:** steps crossfade.

### 15.3 Step 1 — Welcome (`/welcome`)
```
│            [FlashyDex mark]          │  96 px mark on --ps-bg (same as splash → seamless)
│ Your card collection, in your pocket │  H1
│ • Search English and Japanese cards  │  three rows, 24 px muted icons
│   once they are downloaded           │
│ • Track copies, condition, grades    │
│   and what you paid                  │
│ • Your collection stays on this      │
│   device. No account. Search works   │
│   offline after the download.        │
│ [            Get started          ]  │  → /welcome/notice
│        Restore from a backup         │  text button → restore flow (§10.3), then step 3
```

### 15.4 Step 2 — Before you start (`/welcome/notice`)
```
│ Before you start                     │  H1
│ ┌──────────────────────────────────┐ │  surface card
│ │ FlashyDex is not affiliated with │ │  body, fg — exact BRIEF sentence
│ │ Nintendo, Creatures, GAME FREAK  │ │
│ │ or The Pokémon Company.          │ │
│ └──────────────────────────────────┘ │
│ Card data, images and prices come    │  body muted
│ from TCGdex, a community database.   │
│ Prices come from TCGplayer and       │
│ Cardmarket and may be out of date.   │
│ Your collection stays on this device.│
│ FlashyDex doesn't collect any data.  │
│ Read the privacy policy ›            │  → /settings/privacy (pushed; back returns here)
│ [             Continue            ]  │  SettingsRepo.update({disclaimerAcknowledged:true})
```

### 15.5 Step 3 — Languages (`/welcome/languages`)
```
│ Which cards do you collect?          │  H1
│ ┌──────────────────────────────────┐ │  selectable cards (checkbox role), ≥ 72 px
│ │ [✓] English                      │ │
│ │     220 sets · about 23,700 cards│ │  counts from bundled bootstrap metadata/manifest
│ │     14 MB download · 58 MB on device│  manifest compressedBytes / uncompressedBytes
│ ├──────────────────────────────────┤ │
│ │ [ ] Japanese                     │ │
│ │     184 sets · about 12,800 cards│ │
│ │     9 MB download · 31 MB on device│
│ │     Many older Japanese cards    │ │  caption, warning-free muted
│ │     have no pictures in the catalog yet.│
│ └──────────────────────────────────┘ │
│ Include TCG Pocket (digital) cards [○]│  Switch → hideTcgPocket (default off = hidden)
│ Total: 14 MB · about 1 min on Wi-Fi  │  live total; time = bytes ÷ 1–5 MB/s, rounded range
│ [            Continue             ]  │  saves languages → step 4
│      Not now — I'll add cards myself │  text button = Skip (no download)
```
- **Defaults:** English is selected; Japanese is selected too if the device language is Japanese. At least one must be selected for Continue; the "Not now" path needs none.
- **Sizes** come from the catalog manifest. If the manifest is unreachable (offline), the sizes show "—" and the caption "You're offline. Choose now — the download starts when you're connected."
- **No packs published** (manifest returns no pack for a language): the card switches to the TCGdex fallback figures ("about 50 MB · 15–25 min", §10.2).
- **Values are explicit estimates.** "about" is always shown, with real numbers and no invented precision.

### 15.6 Step 4 — Sets you collect (`/welcome/sets`)
```
│ Which sets do you collect?           │  H1
│ This helps FlashyDex show your sets  │  body muted
│ first and keep their prices fresh.   │
│ It doesn't change the download.      │
│ (● All sets)  ( Only sets I pick )   │  segmented; default All
│ ─ when "Only sets I pick" ─          │
│ [⌕ Search sets                    ×] │  SearchField (local list)
│ (EN)(JP)                             │  language chips (selected languages only)
│ ┌──────────────────────────────────┐ │
│ │ [✓] [logo] Darkness Ablaze 2020  │ │  checkbox rows ≥ 56 px, newest first,
│ │ [ ] [logo] Rebel Clash     2020  │ │  grouped by series headers (sticky)
│ └──────────────────────────────────┘ │
│ 12 sets selected                     │  caption, aria-live
│ [         Start download          ]  │  → starts pack install(s), finishes onboarding
│            Skip this step            │  = All sets
```
- **The set list** comes from bundled bootstrap metadata or the manifest set index (request S9). Offline with no index: only "All sets" is offered, with the caption "You can pick sets later in Settings."
- **Fallback path** (no packs): this step becomes the **download selection**. "All sets" shows the full estimate; "Only sets I pick" shows a live estimate for the picked sets, e.g. "12 sets · 2,140 cards · about 4.5 MB · 1–2 min" (formula in §10.2).
- **Start download:**
  - `SettingsRepo.update({languages, setsFollowed | syncAllSets, onboardingCompleted:true})`.
  - Start the pack install(s), or `SyncService.start` on the fallback path.
  - `replace` to `/`.
  - The Dashboard shows the `ProgressCard`; every other tab shows the sync pill.
  - **The app is usable immediately:** custom cards, import, settings. Search works as soon as a language activates (packs) or set by set (fallback).
- **Offline at Start:** the settings are saved and the pill shows "Waiting for connection"; the download starts automatically when the network returns (§16.2).

## 16. Offline and network behaviour; pause/resume

### 16.1 Principle
FlashyDex is local-first.
- **Works offline:** browsing, search over installed catalogs, every collection mutation, valuations from stored prices, import/export/backup/restore, settings, about, privacy and licenses.
- **Needs the network:** catalog pack download and update, TCGdex price updates and set fill-ins, and card images not yet in the WebView cache.
- Offline is never an error screen. The UI marks network-bound pieces with `OfflineChip` and keeps everything else normal.

Detection:
- Native: `@capacitor/network` `getStatus()` plus a `networkStatusChange` listener (request T1).
- Web: `navigator.onLine` with `online`/`offline` events.
- **On every platform, a failed request also counts as "offline" until the next success.**

### 16.2 Per-screen matrix

| Screen | Offline behaviour |
|---|---|
| Dashboard | All stats from local data. Price caption adds `OfflineChip` and the date. "Update"/pull → offline toast. Download card shows "Waiting for connection". |
| Collection | Fully functional. Uncached art → "Image not loaded" placeholder; retries once when online. |
| Card Details | Fully functional from local data. Prices labelled with their date; "Refresh card" disabled with "Connect to refresh". High-res art may be placeholder. |
| Sets / Set detail | Fully functional for installed catalogs. "Refresh this set" / pull → offline toast. Logos may be missing (id chip). |
| Add | Search and add work over installed catalogs. If the catalog is incomplete: banner "Some sets aren't downloaded yet. Connect to finish the download." Custom card always available. |
| Settings → Catalog | Download/Update/Update prices buttons disabled with inline reason "Connect to the internet to download" (button stays focusable, `aria-disabled`, reason in `aria-describedby`). Installed languages, versions, sizes visible. "Remove" works. |
| Settings → Data | Import, export (share sheet: Files, AirDrop work offline), backup, restore — all work. |
| About / Privacy / Licenses | Bundled; work. External links ("View online", TCGdex) show offline toast instead of opening. |
| First run | Steps 1–2 work. Step 3–4: sizes "—", set picker limited (§15.5–15.6); Start saves the choice and waits. |
| Scanner (Phase 3) | On-device recognition works offline if the model is installed; the optional endpoint does not. |

### 16.3 Pause, resume and lifecycle of catalog work

The pause behaviour per job type:
- **Pack download:**
  - Pause (user): stop the transfer. Partial bytes are kept only if the host supports HTTP Range (request S1); otherwise the button is just Cancel.
  - Network lost: auto-pause → "Waiting for connection" → auto-resume when online (same session).
- **TCGdex job** (prices, fill-in, fallback crawl):
  - Pause (user): `SyncService.cancel` → "Paused"; Resume = `SyncService.resume(id)` (same run, keeps progress).
  - Network lost: the engine stops scheduling. The pill shows "Waiting for connection" and resumes automatically when online, if the app is in the foreground and the run was interrupted by the network in this session.

What happens when the app moves between foreground and background:
- **To background** (`App` `pause`/`appStateChange`): work suspends. It is foreground-only in Phase 1; iOS gives no guaranteed background time. Nothing is shown.
- **Back to foreground** (`resume`): jobs suspended in this session continue automatically. The pill reappears.
- **Cold start after the app was killed:**
  - An interrupted job shows "Download paused · Resume" (user taps; ARCHITECTURE says resume is user-requested).
  - A pack download restarts its transfer, or continues it if Range-resumable. Verification always reruns.
- **Long fallback crawl:** "Keep screen on while downloading" (keep-awake, only while the app is in the foreground and the job runs). The copy says why: "Your phone may lock and pause the download."

### 16.4 Image cache
Phase 1 relies on the WebView HTTP cache. It can be evicted, so art can disappear offline, and the placeholder handles that.

Phase 7 adds a bounded 150–250 MB LRU cache (COMPRESSION-STORAGE). Settings → Catalog will then show "Image cache: 84 MB of 200 MB · Clear". The UI copy never promises offline art in Phase 1.

## 17. iOS/Android native conventions (consolidated; implementer checklist)

1. **Safe areas everywhere.** Top bar `padding-top: --ps-safe-top`. Tab bar `padding-bottom: --ps-safe-bottom`. Sheets and modal footers `--ps-sheet-pad-bottom`. Full-screen viewers place their close buttons inside the safe area. Page gutters use `--ps-page-left/right` (landscape notch). Toasts sit at `--ps-toast-bottom`. Config: `viewport-fit=cover`, iOS `contentInset:'never'`, Android `adjustMarginsForEdgeToEdge:'force'` (DESIGN-TOKENS §5.2).
2. **Status bar.** The style follows the theme (§2 of DESIGN-TOKENS). Content scrolls under translucent chrome on iOS. Tapping the status bar scrolls to top.
3. **Back affordances.**
   - iOS: `‹` + previous title in the top bar, plus the native edge swipe (§1.5).
   - Android: arrow icon, plus the system back/predictive back gesture via the `backButton` precedence (§1.5).
   - Never rely on browser chrome.
4. **Bottom sheets** with drag handle, detents, discard protection and a visible Close (§2.3). Confirmations use a centred Dialog, which reads as an alert.
5. **Haptics:** only the mapping in DESIGN-TOKENS §7.3: add (success), undo (light), delete (warning), save (light), error, iOS selection ticks, pull/drag threshold, long-press. Fired after the commit. Settings toggle.
6. **Share and files.**
   - Export and backup use the native share sheet (`@capacitor/share` with a Filesystem cache URI).
   - Import and restore use the native document picker.
   - Never ask for Photos or broad file access.
   - The collection DB is never exposed in Files (`UIFileSharingEnabled` off).
7. **Keyboard.**
   - iOS `Keyboard.resize = 'none'`, with `--ps-keyboard-inset` from keyboard events. Android `adjustResize`.
   - Sticky footers and sheets ride above the keyboard, and focused fields are scrolled into view.
   - The tab bar is hidden while the keyboard is open.
   - `enterkeyhint`, `inputmode` (`numeric`/`decimal`), `autocapitalize`, `autocomplete="off"` are set per field.
   - Tapping outside an input or scrolling a results list dismisses the keyboard.
8. **Pull-to-refresh** only where data can be fetched (§2.4).
9. **External links** open in `@capacitor/browser` (SFSafariViewController / Custom Tabs), never in the app's WebView and never `target=_blank` (request T2).
10. **Targets** are ≥ 44 pt (HIG) / 48 dp (primary). The spacing between adjacent targets is ≥ 8.
11. **Dynamic Type / font scale:** `TextZoom.getPreferred()` drives `--ps-text-scale`, and Android WebView text zoom is pinned to 1 (DESIGN-TOKENS §4.2). There is no viewport zoom lock, but WebView pinch-zoom of the whole UI stays off (Capacitor `zoomEnabled:false`). Only the card zoom viewer zooms.
12. **VoiceOver/TalkBack:** §13. Plus: no `title`-only labels, no hover-only affordances, and the reading order equals the visual order.
13. **Reduced motion / increased contrast** honoured through tokens. Reduce Transparency: when `prefers-reduced-transparency: reduce` is supported, iOS chrome turns solid (same as increased contrast).
14. **No web-wrapper tells:**
    - no text selection or long-press callout on chrome and art;
    - no tap highlight;
    - no 300 ms delay (`touch-action: manipulation`);
    - no white flash (`backgroundColor #0b0d12`, splash hidden after the first paint);
    - no rubber-band white (html bg);
    - no hover-only menus;
    - no browser-style focus rings on touch (`:focus-visible` only);
    - no visible URLs;
    - native selects and date pickers;
    - instant local navigation with platform transitions.
15. **Orientation:** iPhone and Android phones are portrait-only in Phase 1 (request T3). iPad (if universal) and web support every orientation, using the wide shell at ≥ 1024.
16. **Permissions:** none are requested in Phase 1 (no camera, photos, notifications or tracking).

## 18. App icon and splash

The full spec, with colours, variants and exclusions, is in DESIGN-TOKENS §10.3. In short:
- **Mark — "foil glint":** two overlapping card silhouettes (63:88, real corner ratio) in off-white, with one diagonal yellow→amber specular streak, on `--ps-bg` `#0b0d12`.
- **Never:**
  - a Poké Ball or any split-circle/band motif;
  - characters, silhouettes, ears or tails;
  - a lightning bolt (reads as the yellow electric mouse);
  - the Pokémon logo yellow+blue pairing;
  - a Pokédex-device look;
  - real card art or card backs;
  - the words Pokémon/Poké.
- **iOS 18+:** Light (default) / Dark (transparent background) / Tinted (grayscale). Preferably an Icon Composer layered file so the Clear variants generate cleanly.
- **Android:** adaptive (background `#0b0d12` + foreground in the 66 dp safe zone) plus a monochrome layer.
- **Splash:** the mark alone, centred on `#0b0d12` (iOS LaunchScreen, Android 12 SplashScreen). Hidden with a 200 ms fade after the first route paints. Welcome step 1 shows the same mark at the same place on the same background, so first launch feels like the splash "opening up".
- **Store screenshots:** no card art and no Pokémon names. Use real UI with custom cards using the app's placeholder art, onboarding, the Sets list with id chips, and settings (DESIGN-TOKENS §10.3; APP-STORE-COMPLIANCE "Screenshots").

## Stage F — web storage screens (2026-10-31)

New web-only surfaces (all plain copy, no claim the browser did not make; 390 × 844 first, 44 px targets, safe-area aware, no horizontal overflow):

- **Storage-unavailable screen** (`data-testid=storage-unavailable`): shown when Web Locks, OPFS or the worker probe is missing/failed. Explains https + supported browsers, offers only Retry (reload). Never writes, never offers a temporary copy.
- **Migration progress** (`migration-progress`): "Moving your collection to faster storage…", phase + bytes, no cancel, `beforeunload` guard. Original copy is kept.
- **Migration blocked** (`migration-blocked`): honest recovery text with the sanitized reason and code. No "start fresh" button. (No legacy-export hook is exposed by the adapters yet; the screen tells the user to export from the build that still holds the data.)
- **Settings → Import, export & backup → "Storage on this device"**: "Storage protection" row (Protected / Not protected (browser decides) / Unavailable / Couldn't check, usage of allowance) opening the protection sheet (Protect my collection = a request, last checked, seven-days-of-Safari-use and Home Screen copy, link to export); "Offline card art" row (used/limit, 150/200/250 MB, Clear with confirm; when the limit is not enforced it says so and shows no numbers).
- **Protect-your-collection sheet**: appears once per device, after the first successful personal save or before the first catalog download. Dismissible ("Not now"), never a wall.
- **Install banner** (`install-banner`): in-flow at the top of tab content (never fixed, never over the tab bar). iOS: Share → Add to Home Screen → open from the icon. Android with install event: Install button; otherwise menu steps. Hidden when standalone; dismiss snoozes 14 days (controller).
- **Update toast** (`update-toast`): "Update ready" + Restart / Later, above the tab bar. Restart refuses during a catalog download/import/restore, asks before discarding a dirty form, then shows a full-screen "Restarting to update…" block (no new writes) while the SQL worker shuts down.
- **Settings → Diagnostics** (`/settings/diagnostics`, linked from Data and About): adapter/VFS/SQLite version, origin/standalone, lock, persist + quota, pool, catalog refs, last pack metrics, image cache, WASM + heap numbers, all `fdx:*` timings, last error code; Copy diagnostics (JSON). No personal data.

## Milestone 2 — Scan screen (2026-11)

**Route:** `/scan` (modal route, no tab bar). Entry points: the centre tab (`tab-scan`, lime 60 × 60 circle, label "Scan" under it, `aria-label` "Scan a card") and a sidebar entry on wide layouts. The old ScanSheet is gone.

**Capture (landing):** heading "Scan a card" and four actions, all ≥ 44 px tall: Take Photo (`scan-take`, hidden `<input type=file capture=environment>`), Choose from Library (`scan-choose`, same input without `capture`), Search Manually (→ `/add`), Browse by Set (→ `/sets`). Both inputs use `accept="image/jpeg,image/png,image/webp"` — never `image/heic` and never `image/*` — so iOS transcodes HEIC to JPEG. A one-shot health check shows a non-blocking "Scanner offline" banner; manual add is never blocked.

**Pipeline:** pick file → keep the `File` → `<img>` decode (no `createImageBitmap`, iOS bug 237895) → canvas resize to a 1600 px long edge → JPEG q0.85 → same-origin `POST /api/identify` (multipart, no Authorization, 12 s timeout, cancellable).

**States (`data-testid`):**
- preparing / analyzing (`scan-analyzing`, "Analyzing card…", Cancel `scan-cancel`)
- match (`scan-match`): art 63:88, name, number/total, set, Confirm (`scan-confirm`) opens the normal add sheet; "Wrong card" shows the other candidates. A variant hint pre-selects a variant only at ≥ 0.6 and only if the catalog lists it.
- candidates (`scan-candidates`): "We found a few possibilities", tiles labelled "Name — number/total — NN%", never auto-selected; 1 column at 375, 2 columns at ≥ 390
- no_match / no_card (`scan-no-match`): "We couldn't confidently identify this card."
- failure (`scan-failure`, `data-failure`): too_large, unsupported_image (HEIC: "Choose a JPEG, or switch Camera → Formats → Most Compatible"), busy, rate_limited ("N seconds"), offline, timeout, bad_response, unknown. Each offers Try Another Photo, Search Manually, Browse by Set, plus Try again when retryable.
- missing (`scan-missing`): language catalog not installed → "Install <language> catalog"; card not in the installed catalog → "This card isn't in your catalog yet — check for a newer catalog in Settings". Both offer Search Manually.
- added (`scan-added`): "Added to collection", Scan Another (re-opens the camera input, stays on `/scan`), View Card, Undo.

**Sheet fix:** `BottomSheet` header no longer starts a drag (pointer capture) when the pointerdown lands on a button, so Cancel/Close work with touch, mouse and Escape.

**Measurements (Playwright mobile project, mocked recognizer):**

| viewport | /scan height after add | Take Photo | match art | candidate tiles | centre tab |
| --- | --- | --- | --- | --- | --- |
| 375 × 812 | 812 (no scroll) | 343 × 48 | 260 × 363 | 3 stacked 343 × 525 | 60 × 60, label under |
| 390 × 844 | 844 | 358 × 48 | 260 × 363 | 2-up 173 × 308 | 60 × 60 |
| 430 × 932 | 932 | 398 × 48 | 260 × 363 | 2-up 193 × 336 | 60 × 60 |

`scrollWidth ≤ innerWidth` and every button/link ≥ 44 px are asserted at every state.

**iOS caveats (`.agent/research/ios-camera.md`, unverified on a device):**
- `capture=environment` should open the rear camera directly; a restricted `accept` is what makes iOS hand over JPEG rather than HEIC. Settings → Camera → Formats does not change what the page receives.
- A standalone (Home Screen) PWA can be killed while the camera is up; the page reloads and the pick is lost. Nothing is stored until the user confirms.
- Do not use `getUserMedia` in standalone (WebKit bugs 282327, 215884); not used.
- Safari tab and Home Screen app have separate storage; scanning from one does not show in the other.
- HEIC that still reaches the page and fails to decode shows the "Most Compatible" copy.
- Real-photo accuracy, camera behaviour and the tunnel path need the owner's iPhone steps (ios-camera.md "Owner test steps").
