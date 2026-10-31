# pokescan — Phase 1 UX specification

Owner: Opus (UX lead). Implementer: Sonnet — build this pixel-faithfully. Tokens: `docs/DESIGN-TOKENS.md` + `apps/web/src/styles/tokens.css`.
Contract alignment: routes, field names and enums follow `docs/ARCHITECTURE.md` and `docs/DATA-MODEL.md` (both present when this was written). Endpoint names refer to `docs/API.md`; where API.md was not yet written, the needed data is described by DATA-MODEL field names (camelCase) — if API.md names differ, API.md wins for the wire, this doc wins for what the screen shows.
Real example data used throughout: **Furret · Darkness Ablaze · 136/189** (`en` / `swsh3-136`, rarity Uncommon, variants normal + reverse, set official 189 / total 201, logo `https://assets.tcgdex.net/en/swsh/swsh3/logo`). Prices in wireframes are shown as `$—`/`€—` placeholders because prices change; the UI must render whatever the latest PriceSnapshot holds, and nothing when it is null. Personal values in wireframes (copy counts, "Binder A", purchase dates, totals like "412 cards") are illustrative layout filler for the owner's own data, never seed data — the app starts empty.

Contents
0. Global rules · 1. App shell & navigation · 2. Shared components · 3. Dashboard · 4. Collection · 5. Card Details (+ copy editor) · 6. Sets & Set detail · 7. Add flow · 8. Storage locations · 9. Custom cards · 10. Settings & Data · 11. Scanner (Phase 3 design; disabled in Phase 1) · 12. Global states & copy · 13. Accessibility checklist · 14. Acceptance hooks for Playwright

---

## 0. Global rules (apply to every screen)

1. **390 px first.** No horizontal scroll at 390 × 844 (Playwright asserts `document.documentElement.scrollWidth <= 390`). Then 768 and ≥ 1024.
2. **Card art is always 63:88** (`aspect-card rounded-card`), space reserved before load; low-res `…/low.webp` in grids/lists, `…/high.webp` on Card Details and in the add-confirm sheet. Missing image → the "No catalog image" placeholder (DESIGN-TOKENS §8.7). Never a stock/fake image.
3. **No fabricated data.** Null price → hidden (tiles/rows) or "No price data" (details). Unknown condition → `?` badge. Incomplete catalog → "Catalog incomplete", never a fake %.
4. **Nothing saves without an explicit button press.** Closing a sheet discards. Edits are buffered until Save. Destructive actions confirm (with counts).
5. **Every tappable thing ≥ 44 × 44 px**; nav items and primary buttons 48 px.
6. **Every list has four states**: loading skeleton (same geometry as content), empty (real copy + one CTA), error (what failed + Retry), offline (banner; reads from cache if any; mutations disabled with reason).
7. **Language is always visible** on catalog rows/tiles when the collection contains both languages: `EN`/`JA` micro badge (surface-3 fill, fg-muted text). If the user owns only one language, hide the badge in the collection but keep it in search results.
8. **Numbers**: `tabular-nums`; thousands separators via `Intl.NumberFormat`; collector numbers render as `136/189` when the set's official count is known, else `#136`.
9. **URL is state.** Filters, sort, view mode, search query and tabs live in the query string so Back works and links can be shared to the desktop.

## 1. App shell and navigation

### 1.1 Routes (aligns with ARCHITECTURE.md layout)

| Route | Screen | Notes |
|---|---|---|
| `/` | Dashboard | |
| `/collection` | Collection | query: `q, view=grid\|list, sort, set, rarity, lang, cond, graded, dupes, loc, group` |
| `/collection/[ownedId]` | Single copy (deep link) | renders Card Details for the copy's identity with that copy's editor sheet open; works when catalog cache is wiped (uses snapshot) |
| `/cards/[language]/[cardId]` | Card Details (catalog card) | e.g. `/cards/en/swsh3-136` |
| `/custom-cards/[customId]` | Card Details (custom card) | same layout, "Custom" badge, no price block |
| `/custom-cards/new` | Create custom card | **new page — requested from Sol (not in ARCHITECTURE tree)** |
| `/sets` | Sets list | query: `lang, show=collecting\|all, sort, pocket=1` |
| `/sets/[language]/[setId]` | Set detail | query: `tab=all\|owned\|missing\|dupes` |
| `/add` | Add flow (search → confirm) | query: `q, lang, card=<language>:<cardId>` (confirm step open), `set` (prefilter from a set) |
| `/settings` | Settings home | appearance, defaults, links |
| `/settings/data` | Sync, import, export, backup, restore | |
| `/settings/locations` | Storage locations | **new page — requested from Sol** |
| `/scan` | — | **does not exist in Phase 1** (ARCHITECTURE: no scanner route). Phase 3 adds it. |

### 1.2 Mobile shell (< 1024 px)

```
390 px
┌──────────────────────────────────────┐
│ ░ status bar (safe-area-top)          │
├──────────────────────────────────────┤
│ Collection                  [⌕] [+]  │  top bar 56px, surface, sticky
├──────────────────────────────────────┤
│                                      │
│              page content            │  scrolls; padding-bottom = nav + 16
│                                      │
├──────────────────────────────────────┤
│  ⌂        ▦        ◉        ▤     ⚙  │  bottom nav 64px + safe-area-bottom
│ Home  Collection  Scan    Sets  Settings
│                  Soon                 │
└──────────────────────────────────────┘
```

Bottom nav (`<nav aria-label="Primary">`, surface bg, 1 px top border, `--ps-hairline-top`):
- Five equal slots, each ≥ 48 px tall, icon 24 px + label (micro 12 px, 600). Active: icon + label `--ps-accent-fg`, a 32×4 px accent pill above the icon, `aria-current="page"`. Inactive: `--ps-fg-muted`.
- **Center slot "Scan"**: 60 px circle raised 12 px above the bar (`--ps-shadow-scan` cuts it out of the bar). Phase 3: accent fill, camera icon, `on-accent` color.
  **Phase 1 (disabled):** circle in `--ps-surface-3`, icon `--ps-fg-disabled`, a small `Soon` micro label under it instead of "Scan". Element is a `<button aria-disabled="true" aria-describedby="scan-soon">` (stays focusable so screen-reader users learn why). Tapping it opens the **Scanner-coming sheet** (§11.6) whose primary button is "Add a card by search" → `/add`. It never opens a camera and is never labelled as working (ARCHITECTURE rule).
- Icons: use `lucide-react` (tree-shaken, MIT): `Home`, `LayoutGrid`, `ScanLine`, `Layers`, `Settings`. Same set in the sidebar.

Top bar (per screen): title (H3 size on mobile, left), up to two 44 px icon buttons on the right. On every primary screen except Settings the rightmost button is **Add** (`Plus` icon, accessible name "Add a card") → `/add`. That is the Phase 1 primary entry point to adding; it stays in Phase 3 too (manual entry must always remain available — SPEC).
Large-title behavior: on Dashboard/Collection/Sets the page H1 sits in the content (28 px) and the top bar shows the title only after the H1 scrolls under it (IntersectionObserver; fade `--ps-dur-fade-fast`).

### 1.3 Desktop shell (≥ 1024 px)

```
≥1024 px
┌───────────────┬──────────────────────────────────────────────────────┐
│ pokescan      │  Collection                     [search……]  [+ Add]  │
│               ├──────────────────────────────────────────────────────┤
│ [+ Add card]  │                                                      │
│               │                                                      │
│ ⌂ Dashboard   │                 content (max 1280, centered)         │
│ ▦ Collection  │                                                      │
│ ◉ Scan  Soon  │                                                      │
│ ▤ Sets        │                                                      │
│ ⚙ Settings    │                                                      │
│               │                                                      │
│ ───────────── │                                                      │
│ Catalog: EN ✓ │                                                      │
│ JA ✓ · 2h ago │                                                      │
└───────────────┴──────────────────────────────────────────────────────┘
```

Sidebar 240 px, surface bg, sticky full height. Primary button "Add card" at the top. Nav rows 44 px, radius md, active row `accent-soft` bg + `accent-fg` text. Scan row disabled the same way as mobile (opens the same explanation as a dialog). Footer: catalog freshness per language ("EN synced 2 h ago", from latest completed sync) linking to `/settings/data`; while a sync runs it shows a 4 px progress bar and "Syncing 34 / 220 sets".
Dialogs instead of bottom sheets at ≥ 1024 (centered, max-width 560, radius xl). The add-confirm and copy editor become a right-side panel (480 px) over a scrim.

### 1.4 Global feedback

- **Toasts**: bottom-center above the nav (mobile) / bottom-right (desktop), max 1 visible, 4 s (8 s if it has an action), `role="status"` live region. Example: "Added Furret · Darkness Ablaze" [Undo].
- **Offline banner**: below the top bar, `warning-soft` bg, "You're offline. Showing saved pages — changes need a connection to your PC." Uses `navigator.onLine` + failed fetch. Mutating buttons become `aria-disabled` with the tooltip/explanation "Reconnect to make changes".
- **Maintenance (restore running, API 503 MAINTENANCE)**: full-width info banner "Restoring a backup — the app will be back in a moment." Polls `/api/health` every 2 s and reloads when healthy.
- **Sync running** (any screen): the Settings tab icon shows a 6 px info dot; nothing else interrupts.

## 2. Shared components (build once, reuse)

| Component | Spec |
|---|---|
| `CardArt` | props `{imageUrl, size: 'low'\|'high', alt, rarityTier, name, setName, localId}`; fixed 63:88 frame; skeleton bg until `onLoad`, then 200 ms opacity fade; `loading="lazy" decoding="async"`, `fetchpriority="high"` only for Card Details hero; on error or null url → placeholder (DESIGN-TOKENS §8.7). |
| `CardTile` | §2.1 |
| `CardRow` | §2.2 |
| `ConditionBadge`, `GradeBadge`, `VariantChip`, `QtyBadge`, `RarityLabel`, `LangBadge`, `Price` | DESIGN-TOKENS §8; `Price` takes `{cents: number\|null, currency}` and returns `null` for null cents. |
| `StatTile` | label (caption, muted), value (h2, tabular), optional sub-line (caption). radius lg, surface bg, padding 16. |
| `BottomSheet` / `Dialog` | Radix-free custom or `vaul`-style; role dialog, `aria-modal`, focus trap, Esc/scrim/drag-down closes (drag only when no unsaved edits; otherwise confirm "Discard changes?"). Snap points: content height up to 92 dvh. Top handle 36×4. Sheet enters with `--ps-dur-move-slow` + decelerate. |
| `SegmentedControl` | track surface-3, thumb surface (dark) / white (light) with shadow-1, 40 px tall (44 px hit area). |
| `ChipGroup` | single/multi select chips, 36 px tall visual, 44 px hit area via padding; selected = accent fill + on-accent text + check glyph. |
| `Stepper` | − [ 1 ] + ; buttons 44×44; field is `inputmode="numeric"` 16 px; range 1–100 (DATA-MODEL bulk max 100). |
| `Skeleton` | surface-colored blocks with `animate-shimmer` gradient (`skeleton` → `skeleton-hi` → `skeleton`), static under reduced motion. |
| `EmptyState` | 64 px muted icon, H3 title, body text (muted, max 34ch), one primary button, optional secondary text button. |
| `ErrorState` | same layout, `negative` icon, message from API `error.message` mapped to friendly copy (§12), Retry button, small "Details" disclosure with `error.code`. |
| `FilterSheet` | §4.4 |
| `SearchField` | 44 px, surface-2, radius md, leading search icon, trailing clear (×) button when non-empty, `type="search" enterkeyhint="search" autocapitalize="off" autocorrect="off" spellcheck="false"`. Debounce 200 ms. |

### 2.1 Card tile (grid)

```
 ┌───────────────┐   tile width 114 px at 390 (3 cols)
 │×3        Rev  │   ← QtyBadge (only when groupCount>1) · VariantChip (not for normal)
 │               │
 │   card art    │   63:88, rounded-card, shadow-card
 │   (low.webp)  │
 │               │
 │NM             │   ← ConditionBadge or GradeBadge (bottom-left, 6 px inset)
 └───────────────┘
 Furret              ← caption 13/600, 1 line, ellipsis
 136/189 · DAA   $—  ← micro/caption muted; price right-aligned, tabular; omitted when null
```

- In the Collection grid one tile = one **group** (`(identity, variant, variantDetail)`, DATA-MODEL "unique card"). Badge rules for a group: Qty = group count; condition badge = the condition shared by all copies, else the best condition followed by `+` (e.g. `NM+` means "NM and others"; aria "Mixed conditions, best Near Mint"); if any copy is graded and all are graded show the highest grade; mixed raw/graded shows the condition badge plus a 6 px dark dot ("includes graded copies").
- Meta line: `localId/officialCount` (or `#localId`) · set abbreviation when the catalog has `abbreviation.official` (e.g. `DAA`), else the set name truncated.
- Price: group value per copy = latest raw valuation for the variant in the display currency (Settings default USD/TCGplayer). Hidden when null. Shown as the per-copy price, not the group total (the group total is on Card Details).
- Press: scale 0.97 + darken; tap → `/cards/[language]/[cardId]` (or `/custom-cards/[id]`) with `?variant=` to preselect the variant section.
- Long-press (500 ms) / right-click: context menu (Add another copy, Move to location…, View set). Optional in Phase 1; if built it must also be reachable from Card Details (no long-press-only actions).
- Accessible name (one string on the link): "Furret, Darkness Ablaze 136 of 189, Reverse holo, 3 copies, Near Mint, $X".

### 2.2 Compact row (list view, search results)

```
┌────────────────────────────────────────────────┐
│ ┌──┐ Furret                       ×3     $—   │  row 64 px; thumb 40×56 (63:88)
│ │  │ Darkness Ablaze · 136/189 · Rev  NM  EN  │
│ └──┘                                          │
└────────────────────────────────────────────────┘
```
Line 1: name (body 16/500, ellipsis) — right: qty `×3` (only >1), price (small, tabular). Line 2 (caption muted): set name · number · variant short label — right: condition/grade badge, lang badge (rule 0.7). Divider 1 px `border` inset 64 px.

## 3. Dashboard (`/`)

Data: dashboard endpoint (DATA-MODEL "Definitions": totalCards, uniqueCards, duplicates, per-currency `{estimatedValueCents, valuedCopies, unvaluedCopies, totalPaidCents, knownCostCopies, comparableCopies, comparableCostCents, comparableValueCents, gainLossCents}`, recent copies ×10).

### 3.1 Layout 390 px

```
┌──────────────────────────────────────┐
│ pokescan                        [+]  │
├──────────────────────────────────────┤
│ Estimated value                      │  caption muted
│ $1,234.56                            │  display 32/700 tabular   (USD bucket)
│ ▲ +$210.40 on 128 cards with a       │  small; positive/negative color + sign
│   known cost · TCGplayer market      │
│ €87.20 from Cardmarket prices        │  small muted — only if EUR bucket non-null
│ 37 cards have no price data  ›       │  caption subtle link → /collection?priced=none*
├──────────────────────────────────────┤
│ ┌───────────────┐ ┌───────────────┐  │  2×2 StatTile grid, gap 8
│ │ Total cards   │ │ Unique cards  │  │
│ │ 412           │ │ 301           │  │
│ └───────────────┘ └───────────────┘  │
│ ┌───────────────┐ ┌───────────────┐  │
│ │ Duplicates    │ │ Total paid    │  │
│ │ 111      ›    │ │ $980.00       │  │
│ │               │ │ 128 of 412    │  │  "known cost on 128 of 412 cards"
│ └───────────────┘ └───────────────┘  │
├──────────────────────────────────────┤
│ Recently added               See all›│  H2 + link → /collection?sort=recent
│ ┌────┐ ┌────┐ ┌────┐ ┌────┐ ┌──      │  horizontal scroller, tiles 104 px,
│ │art │ │art │ │art │ │art │ │        │  scroll-snap, 16 px edge padding,
│ └────┘ └────┘ └────┘ └────┘ └──      │  shows 3.5 tiles to signal scroll
│ Furret  …                             │
└──────────────────────────────────────┘
```
(*a "no price data" collection filter is request R7 to Sol; until it exists the line is plain text, not a link. The count is `unvaluedCopies` of the display currency.)

- Value block is the hero. Currency buckets are **never summed**. The primary currency is the user's display preference (Settings → Price source, default USD); the other bucket shows as a secondary line only when non-null. Each money figure carries its source in words.
- Gain/loss line only when `gainLossCents` is non-null; wording always states the subset: "on N cards with a known cost". When null: "Add what you paid to see gain/loss" (link to Collection sorted by recent).
- Duplicates tile links to `/collection?dupes=1`. Total cards → `/collection`. Unique → `/collection?view=grid`.
- Total paid shows each currency that has a non-null total, stacked (`$980.00` / `€40.00`), plus coverage "known cost on 128 of 412 cards".

### 3.2 Layout ≥ 1024 px

```
┌ sidebar ┬──────────────────────────────────────────────────────────────┐
│         │ Dashboard                                          [+ Add]   │
│         │ ┌──────────────────────────────┐ ┌────────┐┌────────┐        │
│         │ │ Estimated value  $1,234.56   │ │ Total  ││ Unique │        │
│         │ │ ▲ +$210.40 on 128 cards…     │ │ 412    ││ 301    │        │
│         │ │ €87.20 from Cardmarket       │ ├────────┤├────────┤        │
│         │ │ 37 cards have no price data  │ │ Dupes  ││ Paid   │        │
│         │ └──────────────────────────────┘ └────────┘└────────┘        │
│         │ Recently added                                    See all ›  │
│         │ [tile][tile][tile][tile][tile][tile][tile][tile][tile][tile] │  grid, 10 max
└─────────┴──────────────────────────────────────────────────────────────┘
```
Value panel spans 6/12 columns, stat tiles 2×2 in the other 6.

### 3.3 States
- Loading: skeleton for value (180×38 block + two 240×16 lines), 4 stat tiles with 60×28 value blocks, 4 tile skeletons in the scroller.
- **Empty, no catalog** (no completed sync for any language): hero replaced by EmptyState — icon `DatabaseZap`; title "Download the card catalog"; body "pokescan needs the TCGdex card list (English and Japanese) before you can search and add cards. It runs on your PC and you can leave this page while it works."; button "Go to Data & sync" → `/settings/data`.
- **Empty, catalog ready, no cards**: stats render real zeros (Total 0, Unique 0, Duplicates 0); value line reads "No cards yet" (not $0.00); Recently added → EmptyState: "Your collection is empty" / "Search the catalog to add your first card." / button "Add a card" → `/add`.
- Error: ErrorState in place of the whole page body: "Couldn't load your dashboard" / "The server on your PC didn't answer. Check that pokescan is still running." / Retry.
- Offline: banner + last server-rendered HTML if the SW cached it; otherwise ErrorState with "You're offline".

### 3.4 Accessibility
H1 "Dashboard" visually hidden on mobile (the value block is the visual heading) but present for SR. Gain/loss text includes the word "gain"/"loss" for SR ("Gain of $210.40 on 128 cards with a known cost"). Scroller is a `<ul>` with `aria-label="Recently added"`; each tile is a link.

## 4. Collection (`/collection`)

Data: owned-cards list endpoint (`GET /api/owned-cards`, offset paging, limit ≤ 50) with filters `q, setId, language, rarity, condition (NM…DMG|unknown), grading (raw|graded), duplicates, storageLocationId (id|none), groupId, variant`, sort `created_desc | name_asc | set_asc`. UI does infinite scroll (next offset when a sentinel 600 px before the end is visible; "Load more" button fallback for keyboard/SR; reset to offset 0 after any mutation or filter change, per API.md).

**Grouping (request R1 to Sol):** API.md lists copies (one `OwnedDto` per physical copy, each with `duplicateCount`). The grid is designed to show one tile per **group** (identity + variant + variantDetail) with a qty badge. This needs a grouped list (e.g. `GET /api/owned-cards?view=groups` returning `{identity, variant, variantDetail, count, conditions[], grades[], representative OwnedDto}` with the same filters/paging). **Fallback if R1 is declined:** the grid shows one tile per copy and the qty badge shows `duplicateCount` (so three Furrets appear as three tiles each badged ×3) — acceptable but noticeably worse; build the tile so it accepts either shape.

### 4.1 Layout 390 px

```
┌──────────────────────────────────────┐
│ Collection                      [+]  │
├──────────────────────────────────────┤
│ [⌕ Search your cards…          ×]    │  SearchField, sticky under top bar
│ [Filters •3] [Sort: Recent ▾] [▦|☰]  │  44 px row; horizontally fits at 390
│ ( Darkness Ablaze ×)( NM ×)( Dupes ×)│  active-filter chips, scrolls horizontally
├──────────────────────────────────────┤
│ 412 cards · 301 unique               │  caption muted, live-updates (aria-live polite)
│ ┌────┐ ┌────┐ ┌────┐                 │
│ │    │ │    │ │    │                 │  3-col grid of CardTile
│ └────┘ └────┘ └────┘                 │
│ Furret  …      …                     │
│ ┌────┐ ┌────┐ ┌────┐                 │
└──────────────────────────────────────┘
```
- Search (`q`) matches the card name (API: name contains, normalized). Placeholder: "Search by name". Collector-number search inside the collection (`136`, `136/189`) is **request R2** (add `localId` to OwnedListQuery); when it lands, a query that is only a number goes to `localId` instead of `q` and the placeholder becomes "Search by name or number". Searching keeps filters.
- Sort options (API): Recently added (`created_desc`, default), Name A–Z (`name_asc`), Set & number (`set_asc`). Value high→low / low→high and Quantity are **request R3**; do not show them until the API supports them.
- View toggle: segmented `Grid`/`List` icons with accessible names; persisted in the URL and in `localStorage["ps-collection-view"]`.

### 4.2 Layout ≥ 1024 px
Filters become a left rail (260 px) inside the content area — always visible, same controls as the sheet, applied instantly. Grid uses `--ps-tile-min` 160 px (≈6 columns at 1440). List view becomes a table: Art · Name · Set · No. · Variant · Condition/Grade · Qty · Location · Paid · Value. Column headers sortable (`aria-sort`).

### 4.3 States
- Loading: 12 tile skeletons (3×4) / 10 row skeletons; count line skeleton 120×14.
- **Empty collection**: EmptyState "No cards yet" / "Add cards by searching the catalog. They'll show up here with quantities, conditions and value." / "Add a card".
- **No results for filters/search**: "No cards match" / "Nothing in your collection matches “furet” with 3 filters." / button "Clear filters" (+ text button "Search the whole catalog" → `/add?q=furet`).
- Error / offline: as global.
- Partial page error during infinite scroll: inline row "Couldn't load more cards. [Retry]" — already-shown tiles stay.

### 4.4 Filter sheet (mobile) / filter rail (desktop)

```
┌──────────────────────────────────────┐
│ ─────                                │
│ Filters                     Reset    │
├──────────────────────────────────────┤
│ Language     (All)(EN)(JA)           │  single-select chips
│ Set          [Any set            ›]  │  opens searchable set picker (sets with owned cards first)
│ Rarity       [Any rarity         ›]  │  single-select list of rarity strings present in the collection
│ Condition    (Any)(NM)(LP)(MP)(HP)(DMG)(?)  single-select (API `condition`; ? = `unknown`)
│ Variant      [Any variant        ›]  │  single-select enum
│ Raw/graded   (All)(Raw)(Graded)      │  API `grading`
│ Duplicates   [ ] Only cards I have   │  switch, 44 px row
│               more than one of        │
│ Location     [Any location       ›]  │  incl. "No location"
│ Group        [Any group          ›]  │  only if groups exist
├──────────────────────────────────────┤
│ [        Show 37 cards         ]     │  primary, live count (debounced 250 ms)
└──────────────────────────────────────┘
```
- Mobile: changes are staged and applied on "Show N cards" (N = `page.total` from a `limit=1` request with the staged filters, debounced 250 ms). Desktop rail applies instantly.
- Filter button shows a count dot of active filters ("Filters, 3 active").
- Duplicates filter semantic: groups with count > 1, grouped across the whole collection before other filters (DATA-MODEL).

### 4.5 Interactions
- Pull-to-refresh: not custom-built (browser default is fine).
- Scroll position and loaded pages are restored when returning from Card Details (keep the list in a client cache keyed by the URL; `history.scrollRestoration='manual'` + saved offset).
- Keyboard (desktop): `/` focuses search; arrow keys move between tiles in the grid (roving tabindex optional — at minimum Tab order is row-major).

## 5. Card Details (`/cards/[language]/[cardId]`, `/custom-cards/[customId]`, `/collection/[ownedId]`)

Data: card detail endpoint (catalog metadata or owned snapshot if catalog cache is missing, owned copies with grade/acquisition/location, latest price per source × variant with `sourceUpdatedAt`/`capturedAt`, available variants).

### 5.1 Layout 390 px

```
┌──────────────────────────────────────┐
│ ‹ Back                     [⋯]       │  top bar transparent over hero, becomes surface on scroll
├──────────────────────────────────────┤
│          ┌──────────────┐            │
│          │              │            │  hero CardArt high.webp, width min(78vw, 320px)
│          │   Furret     │            │  centered, shadow-3; tap → full-screen zoom viewer
│          │   art        │            │
│          └──────────────┘            │
│ Furret                               │  H1
│ Darkness Ablaze · 136/189 · EN       │  body muted; set name links → set detail
│ ● Uncommon   Illus. tetsuya koizumi  │  RarityLabel · illustrator (caption, as TCGdex spells it)
├──────────────────────────────────────┤
│ You own 3                            │  H2
│ ┌──────────────────────────────────┐ │
│ │ Normal          2   NM  NM       │ │  per-variant summary rows (tap scrolls to copies)
│ │ Reverse holo    1   LP           │ │
│ └──────────────────────────────────┘ │
│ [        + Add a copy         ]      │  primary, opens add-confirm sheet prefilled
├──────────────────────────────────────┤
│ Prices                    [USD|EUR]  │  H2 + segmented currency (source) switch
│ Normal        market $—   low $—     │  rows per variant from latest snapshots
│ Reverse holo  market $—   low $—     │
│ TCGplayer · updated 30 Oct 2026      │  caption subtle
│ Your copies are worth $— (3 valued)  │  sum for this card, only valued copies
├──────────────────────────────────────┤
│ Copies (3)                    Select │  H2 + text button for bulk mode
│ ┌──────────────────────────────────┐ │
│ │ Normal · NM · Binder A           │ │  copy row 64 px: variant, condition/grade,
│ │ Paid $— · 12 Oct 2026 · LGS      │ │  location; line 2 purchase info
│ ├──────────────────────────────────┤ │  tap → Copy editor sheet (§5.4)
│ │ Normal · NM · Binder A           │ │
│ ├──────────────────────────────────┤ │
│ │ Reverse holo · PSA 9 · Slab box  │ │
│ │ Cert 12345678 · Paid —           │ │
│ └──────────────────────────────────┘ │
├──────────────────────────────────────┤
│ Purchase history                     │  H2; acquisitions newest first, unknown dates last
│ 12 Oct 2026 · Local game store · 2   │
│ Unknown date · Trade · 1             │
├──────────────────────────────────────┤
│ Card info                        ▾   │  disclosure: category, HP, types, stage,
│                                      │  regulation mark, card id swsh3-136, variants available
└──────────────────────────────────────┘
```
- If you own 0: "You own 0" section is replaced by a single primary "Add to collection" button; Copies/Purchase history are omitted.
- Prices section rules: rows only for variants with at least one non-null value; columns shown are those with any data (USD: market, low, mid, high; EUR: trend, avg/mid, low). Whole section empty → "No price data from TCGdex for this card." Graded copies: note "Graded copies aren't valued automatically. Set your own price in the copy." Manual override shows on the copy row ("Your price $—").
- "Your copies are worth" uses DATA-MODEL valuation rules and states the counted subset: "(2 of 3 copies valued)".
- `⋯` menu: "View set", "Open on TCGdex" (only if we have a public URL? — no; omit), "Copy card ID". Keep to View set + Copy card ID in Phase 1.
- Zoom viewer: full-screen black, high.webp, pinch-zoom native (`touch-action: pinch-zoom`), close button 44 px top-right, Esc closes.

### 5.2 Layout ≥ 1024 px
Two columns: left 380 px sticky hero (art max-width 340) + Add button under it; right column: title block, You own, Prices, Copies (table), Purchase history, Card info.

### 5.3 States
- Loading: hero skeleton at exact 63:88 size, 3 text lines, 2 section skeletons.
- Catalog metadata missing but owned copies exist (cache wiped or not yet synced): render from the owned snapshot; warning-soft banner "Catalog details unavailable — showing what you saved. Sync the catalog to see prices and card info." Price section hidden.
- Not found (no catalog card and no copies): 404 page "Card not found" / "This card isn't in the catalog on this PC. It may be in a set that hasn't synced yet." / buttons "Search the catalog" and "Create a custom card".
- Custom card: "Custom" chip (surface-3) next to the title; no price section; Copies + "Edit card details" (opens §9 form in edit mode).

### 5.4 Copy editor (sheet / side panel)

Opens from a copy row or `/collection/[ownedId]`. Same field set as Add confirm (§7.3) minus identity (identity is fixed; DATA-MODEL: change identity = delete + re-add). Fields: Variant (chips; changing variant is allowed — it is not identity), Condition, Raw/Graded (+ company, grade, cert), Paid (amount + currency), Purchase (date, source — with the shared-acquisition note "This purchase is shared by 3 copies. Changing the date or source changes it for all of them."), Location, Groups, Your price (manual override amount + currency + "Clear"), Notes.
Footer: `Delete copy` (text, negative) · `Save` (primary, disabled until dirty). Delete → confirm dialog "Delete this copy of Furret? This can't be undone." [Cancel] [Delete copy]. After save: toast "Saved".
Bulk mode (from "Select" on the Copies header): checkboxes on rows, sticky footer "Move 2 to location…" and "Delete 2". Confirm dialogs state the count.

### 5.5 Accessibility
Hero `alt="Furret — Darkness Ablaze 136/189 card art"`. Price table is a real `<table>` with `<caption class="sr-only">`. Copy rows are buttons whose name reads the row ("Normal, Near Mint, Binder A, paid …, edit"). Sheet focuses its title on open, returns focus to the row on close.

## 6. Sets

### 6.1 Sets list (`/sets`) — 390 px

```
┌──────────────────────────────────────┐
│ Sets                            [⌕]  │
├──────────────────────────────────────┤
│ (EN)(JA)        [Collecting | All]   │  language chips (default = languages you own; else EN)
│ Sort: Newest ▾                       │  Newest (`release_desc`), Name (`name_asc`)
├──────────────────────────────────────┤
│ ┌──────────────────────────────────┐ │
│ │ [logo] Darkness Ablaze      EN   │ │  row 72 px: logo 56×32 contain (or set initials
│ │        45 / 201 · 22%            │ │  chip if no logo); counts tabular
│ │        ▓▓▓▓░░░░░░░░░░░░░░        │ │  4 px progress bar, accent fill
│ ├──────────────────────────────────┤ │
│ │ [logo] Base Set             EN   │ │
│ │        102 / 102 · 100% ✓        │ │  complete → positive check + "Complete"
│ └──────────────────────────────────┘ │
│ Show TCG Pocket sets  [ ]            │  footer toggle (digital-only sets hidden by default)
└──────────────────────────────────────┘
```
- "Collecting" (default when you own ≥ 1 card) = sets with ownedCount > 0; "All" = every synced set. The set list API has no owned filter — **request R5** (`owned=true` on SetListQuery). Fallback: "Collecting" is built from the distinct `(language, setId)` of owned copies, then each set summary fetched (`GET /api/catalog/sets/:language/:setId`), max ~50 sets per screen. "Most complete" sort is part of R5.
- Count format: `ownedUnique / catalogCount · completionPercent%`. When `completionPercent` is null (catalog incomplete) show `45 / 201 loaded · Catalog incomplete` in `warning` and no percent.
- Logos: TCGdex has a logo for 157/220 EN sets and **0/184 JA sets** (research, tcgdex-api.md). Without a logo, render a 56×32 `surface-3` chip with the set id in micro mono (`SV1a`, `PMCG1`) — never a stretched placeholder image. Logo URL = `logo + ".webp"`.
- Duplicates per set appear as a small caption "8 extra" when > 0.
- TCG Pocket (series id `tcgp`: 15 EN sets, ~2.5k digital-only cards) hidden unless toggled — they are not physical cards. Needs `series` in SetSummary or a `excludeSeries` filter (**request R6**); until then the toggle is not shown and Pocket sets appear in "All".
- ≥ 1024: 2–3 column grid of set cards (logo larger 120×48, progress ring 48 px + counts).

### 6.2 Set detail (`/sets/[language]/[setId]`) — 390 px

```
┌──────────────────────────────────────┐
│ ‹ Sets                         [⋯]   │
├──────────────────────────────────────┤
│ [ Darkness Ablaze logo ]             │  logo max 240×80, centered
│ Darkness Ablaze                      │  H1
│ Sword & Shield · 14 Aug 2020 · EN    │  muted
│ ┌──────┐  45 of 201 cards            │  progress ring 64 px (accent), % inside
│ │ 22%  │  156 missing · 8 duplicates │
│ └──────┘  Official set: 189 + 12 secret
├──────────────────────────────────────┤
│ [All 201|Owned 45|Missing 156|Dupes] │  segmented tabs (counts inside), sticky
├──────────────────────────────────────┤
│ ┌────┐ ┌────┐ ┌────┐                 │  grid ordered by localIdSort
│ │ 1  │ │ 2  │ │ 3  │                 │  owned: normal tile (+qty badge)
│ └────┘ └────┘ └────┘                 │  missing: art at 35% opacity, grayscale(1),
│ ┌────┐ ┌────┐ ┌────┐                 │  1 px dashed border, "+" button 44 px bottom-right
└──────────────────────────────────────┘
```
- Tabs: All (missing cards dimmed), Owned, Missing (full-opacity art — you're shopping here), Duplicates (only groups with extras, qty badge shows count; caption "2 extra").
- Missing tile "+" → add-confirm sheet for that card (§7.3) without leaving the set; on add the tile animates from dimmed to full (opacity/filter fade 320 ms — color-only, survives reduced motion).
- Tile tap → Card Details.
- `⋯` menu: "Add cards from this set" → `/add?set=<language>:<setId>` (search prefiltered to the set, sorted by number — fastest way to log a binder page).
- Incomplete catalog: banner "This set hasn't fully synced (180 of 201 cards loaded). Completion will show once it finishes." + "Sync now" link to `/settings/data`.
- Complete set: Missing tab empty state "Set complete" / "You own every card in Darkness Ablaze." (positive check icon).
- Custom copies tagged with this set name are not counted (DATA-MODEL) — if `customOwnedCount > 0` show caption "+ 2 custom cards not counted".
- ≥ 1024: header becomes a row (logo · title block · ring + stats); grid 6–8 columns.

### 6.3 States
Loading skeleton: list rows (logo box + 2 lines + bar); set detail: header skeleton + 12 tile skeletons. Empty (no sets synced): "No sets yet" / "Sync the TCGdex catalog to browse sets and track completion." / "Go to Data & sync". Error/offline: global.

## 7. Add flow (`/add`) — the Phase 1 core loop

Goal: from the Collection screen to a saved card in **3 taps + typing**: [+] → type "furret 136" → tap result → tap "Add to collection". Everything is editable before commit; nothing is written until the Add button is pressed.

### 7.1 Search step — 390 px

```
┌──────────────────────────────────────┐
│ ‹  [⌕ furret 136                 ×]  │  SearchField autofocused (keyboard opens)
│ (All)(EN)(JA)          in: Any set ▾ │  language chips (remember last), set scope
├──────────────────────────────────────┤
│ ┌──┐ Furret                     EN   │  CardRow (catalog variant): thumb 40×56,
│ │  │ Darkness Ablaze · 136/189       │  name, set · number, rarity dot
│ └──┘ ● Uncommon        You own 3     │  "You own N" (accent-fg) if owned
│ ┌──┐ Furret                     EN   │
│ │  │ …other printings by number      │
│ └──┘                                 │
├──────────────────────────────────────┤
│ Can't find it?  Create a custom card │  sticky footer link (always visible)
└──────────────────────────────────────┘
```
- Query parsing (client maps to `GET /api/catalog/cards`, which searches `q` against the name only, prefix by default, with exact `localId`, `setId`, `language` filters; limit 50):
  - `swsh3-136` (matches `^[A-Za-z0-9.]+-[A-Za-z0-9]+$` and resolves) → `GET /api/catalog/cards/<language>/swsh3-136` directly (try selected language, then the other).
  - `136` or `136/189` → `localId=136` (the `/189` part narrows results client-side to sets whose official count is 189). JA numbers are zero-padded (`001`): if `localId=1` returns nothing, retry once with the 3-digit padded value.
  - `furret 136` → `q=furret&localId=136`; if empty, retry `q=furret` alone.
  - anything else → `q=<text>&match=prefix`; when that returns 0, automatically retry `match=contains` and label the list "Broader matches".
  - Set abbreviations (`DAA 136`) are not supported by the API (request R4); treat as name text.
- Ranking is the API's (exact name, prefix, contains). Result rows also show the set's release year so reprints are distinguishable.
- Empty query: show "Recent" (last 8 cards added, from recent copies) and, if `?set=` is present, that set's cards in number order (missing first toggle).
- Results update as you type (debounce 200 ms; stale responses discarded via AbortController). Enter on desktop opens the first result.
- No results: "No cards found for “furet”" / "Check the spelling, try the collector number (like 136/189), or switch language." / buttons "Search all languages" (if filtered) and "Create a custom card".
- Catalog not synced: EmptyState "The card catalog isn't downloaded yet" → "Go to Data & sync" (and still offer "Create a custom card").

### 7.2 Search step ≥ 1024
Two panes: results list (left, 420 px) and the confirm panel (right) live side by side — clicking a result fills the right pane instantly, so desktop entry is type → click → Enter.

### 7.3 Confirm sheet (`/add?card=en:swsh3-136`) — 390 px

```
┌──────────────────────────────────────┐
│ ─────                                │
│ ┌────────┐ Furret                    │  art 112×156 (high.webp) left; title H3
│ │  art   │ Darkness Ablaze · 136/189 │
│ │        │ ● Uncommon · EN           │
│ └────────┘ Market $— (Normal)        │  latest price for SELECTED variant, if any
├──────────────────────────────────────┤
│ Variant                               │
│ (✓ Normal)( Reverse holo )           │  chips from catalog availableVariants;
│                                      │  "Other…" text button → enum + detail input
│ Condition                             │
│ (✓NM)(LP)(MP)(HP)(DMG)               │
│ Quantity                [ − ][ 1 ][ + ]
│ Graded                         [  ○] │  switch, off = raw
├──────────────────────────────────────┤
│ More details                      ▾  │  disclosure, collapsed by default
│   Paid per card   [$ 0.00 ][USD ▾]   │  empty = unknown (NOT 0)
│   Purchase date   [ 30 Oct 2026  ]   │  empty by default; "Today" chip
│   Bought from     [ e.g. Local game store ]
│   Location        [ None          ▾ ]│
│   Group           [ None          ▾ ]│
│   Notes           [               ]  │
├──────────────────────────────────────┤
│ [       Add to collection        ]   │  sticky footer, primary 48 px
└──────────────────────────────────────┘
```
Defaults (tap-tap-add path):
- **Variant**: if the catalog lists exactly one available variant, it is preselected. If several, preselect by priority `normal → holo → reverse_holo → first_edition → promo_stamped` among those available (Furret → Normal), and the chip row is the first thing under the art so the choice is visible. If the catalog lists none (brief record or JA cards without variant data), preselect `normal` and show caption "Variant not listed in the catalog — check it". Any enum value can be picked via "Other…" (DATA-MODEL: false/missing flags don't prohibit a manual choice).
- **Condition** NM. **Quantity** 1. **Raw** (Graded off). Everything else empty/None.
- Graded on → reveals Company chips (PSA BGS CGC SGC ACE TAG Other; Other reveals a required "Company name" field) + Grade text input (`inputmode="decimal"`, placeholder "10", allows labels like "Authentic") + Cert number (optional). If quantity > 1 the cert field is disabled with helper "Add slabs with certificate numbers one at a time" (API rejects graded bulk adds with a cert). Condition chips hide while graded (grade replaces condition on the badge) but the stored condition stays whatever was selected (DATA-MODEL condition is nullable — graded copies save `condition: null` unless the user explicitly set one; implementer: send null when graded and the user never touched condition).
- "Remember location for this session": when a location is chosen, a checkbox "Use for the next cards too" (default on) keeps it for subsequent adds until the tab closes (sessionStorage). Same for Group and Bought from/date (one checkbox: "Keep purchase details for next card"). This makes binder-page logging fast.
- Price field: empty means unknown. Placeholder `0.00` in subtle color is fine but must never be submitted as 0 unless typed. Currency select USD/EUR (default from Settings).
- Button label reflects quantity: "Add to collection" (1), "Add 3 copies" (3). While submitting: spinner + "Adding…", button disabled (prevents double adds).

Commit (one request: bulk add N copies; DATA-MODEL max 100):
- Success: the sheet's body is replaced by a success state (no navigation):
```
│   ✓  Added Furret × 1               │  positive check (pop under normal motion)
│   Darkness Ablaze · Normal · NM      │
│   You now own 4                      │
│ [ Add another ]  [ Undo ]  [ View ]  │  Add another = primary
```
  - **Add another** (primary, autofocused): closes the sheet, returns to the search step with the query text selected (so the next keystroke replaces it) and the keyboard open; results list scroll position kept. On desktop focus returns to the search field.
  - **Undo**: deletes exactly the copies just created (one `DELETE /api/owned-cards/:id` per returned copy id; there is no bulk delete API), toast "Removed". Available until the next add or 30 s.
  - **View**: Card Details.
  - Toast also fires ("Added Furret · Darkness Ablaze") for screen readers via the live region.
- Error: inline banner inside the sheet above the button, fields intact: "Couldn't add the card. Your PC didn't respond — try again." [Try again]. Validation errors (400 `VALIDATION_ERROR`) are attached to the offending field (`details.issues[].path`) with `aria-describedby`.
- Dismiss without adding: if any field differs from defaults → confirm "Discard this card?" [Keep editing] [Discard]; else close silently. Nothing is ever auto-saved.

### 7.4 Accessibility
Search results are a `listbox`-free plain list of buttons (simpler, robust on mobile SRs). Sheet title is the card name. Chip groups are `radiogroup` (single) with arrow-key support; Graded is a `switch`. Stepper buttons named "Decrease quantity"/"Increase quantity", value announced. Success state moves focus to "Add another".

## 8. Storage locations (`/settings/locations`)

```
┌──────────────────────────────────────┐
│ ‹ Settings   Storage locations   [+] │
├──────────────────────────────────────┤
│ ┌──────────────────────────────────┐ │
│ │ Binder A                    124 ›│ │  row 56 px: name, copy count (tabular)
│ │ Red 9-pocket, SWSH era           │ │  description caption (if any)
│ ├──────────────────────────────────┤ │
│ │ Bulk box 1                  210 ›│ │
│ ├──────────────────────────────────┤ │
│ │ Slab case                     6 ›│ │
│ └──────────────────────────────────┘ │
│ Cards without a location: 72     ›   │  link → /collection?loc=none
└──────────────────────────────────────┘
```
- Row tap → `/collection?loc=<id>`. Row trailing `⋯` (44 px) → Rename / Edit description / Delete.
- [+] → sheet: Name (required, 1–200, unique case-insensitively — inline error "You already have a location called “Binder A”"), Description (optional). Button "Create location".
- Delete with cards → dialog "Delete “Binder A”? 124 cards will have no location. The cards themselves are not deleted." [Cancel] [Delete location] (DATA-MODEL: SET NULL).
- Empty: "No storage locations" / "Create one for each binder, box or deck so you can find any card later." / "Create a location".
- No nesting in Phase 1.

## 9. Custom card creation (`/custom-cards/new`, edit at `/custom-cards/[id]?edit=1`)

When to show: from Add search ("Can't find it? Create a custom card", prefilled `name` with the query), Card-not-found page, Settings.

```
┌──────────────────────────────────────┐
│ ‹  New custom card                   │
├──────────────────────────────────────┤
│ For cards missing from the catalog — │  body muted, 2 lines
│ misprints, new releases, oddities.   │
│ Name *        [ Furret            ]  │
│ Language      (EN)(JA)               │
│ Set name      [ Darkness Ablaze    ] │  free text with suggestions from synced sets;
│ Number        [ 136               ]  │  choosing a suggestion fills setId too
│ Rarity        [ Uncommon         ▾]  │  list of known strings + free text
│ Image URL     [ https://…         ]  │  optional; preview in 63:88 frame below
│ ┌────┐                               │  preview: placeholder until a URL loads
│ │    │                               │
│ └────┘                               │
│ Notes         [                   ]  │
├──────────────────────────────────────┤
│ [ Create and add to collection ]     │  primary → opens §7.3 confirm for the new card
│ [ Create only ]                      │  secondary
└──────────────────────────────────────┘
```
- Image is a URL in Phase 1 (DATA-MODEL `imageUrl`, http/https only; server never fetches it). Photo upload is out of scope until a media store exists — say so in helper text: "Paste a link to an image. Photo upload comes later."
- Validation: name required; URL must start with http(s)://.
- Edit mode: same form, button "Save changes", note "Changes don't alter copies you already own." (DATA-MODEL snapshot rule). Delete: allowed only when no copies reference it; otherwise disabled with "Delete the 2 copies first" (API 409 IN_USE).
- Custom tiles everywhere carry a "Custom" micro chip in place of the variant chip position if variant is normal.

## 10. Settings (`/settings`) and Data (`/settings/data`)

### 10.1 Settings home — 390 px
```
┌──────────────────────────────────────┐
│ Settings                             │
├──────────────────────────────────────┤
│ DATA                                 │  section caption
│ Catalog, import & export        ›    │  → /settings/data ; trailing status "EN ✓ JA ✓"
│ Storage locations               ›    │  → /settings/locations ; count
│ Custom cards                    ›    │  opens a sheet listing GET /api/custom-cards (tap → /custom-cards/[id]) + "New custom card"
├──────────────────────────────────────┤
│ PREFERENCES                          │
│ Theme          (Dark)(Light)(System) │  default Dark
│ Price source   (TCGplayer $)(Cardmarket €)   display currency for tiles/dashboard
│ Default language for search (All)(EN)(JA)
│ Default currency for what I paid  (USD)(EUR)
├──────────────────────────────────────┤
│ ABOUT                                │
│ pokescan 0.1.0                       │
│ Card data and images: TCGdex         │  link https://tcgdex.dev
│ Not affiliated with Nintendo, The Pokémon Company or Creatures. │
└──────────────────────────────────────┘
```
Preferences are device-local (`localStorage`), applied instantly, no Save button (they are view preferences, not collection data — the "never auto-saves" rule concerns collection mutations).

### 10.2 Data — sync section
```
│ CARD CATALOG (TCGdex)                │
│ ┌──────────────────────────────────┐ │
│ │ English   220 sets · 23,736 cards│ │  counts from the catalog
│ │ Synced 30 Oct 2026, 14:05     ✓  │ │
│ │ Japanese  184 sets · 12,781 cards│ │
│ │ Synced 30 Oct 2026, 14:41     ✓  │ │
│ └──────────────────────────────────┘ │
│ [ Sync catalog ]   Mode: Quick ▾     │  Quick = incremental, Full refresh = refresh
│ Downloads card lists and prices. Your collection is never changed by a sync.
```
Running state (polls status every 2 s; `role="progressbar"` with `aria-valuenow`, plus a polite live region announcing every 10 %):
```
│ Syncing English and Japanese…        │
│ ▓▓▓▓▓▓▓▓░░░░░░░░░░░░  34 / 220 sets  │  determinate when setsTotal known; else indeterminate
│ 6,120 of 23,736 cards · 3 failed     │  cardsDone / cardsTotal · cardsFailed (warning color if >0)
│ You can leave this page — the sync keeps running on your PC.
│ [ Cancel sync ]                      │  secondary; confirm "Stop the sync? Cards already downloaded are kept."
```
End states:
- Completed: positive banner "Catalog up to date — 23,736 English and 12,781 Japanese cards." (real counts).
- Completed with warnings: "Synced with 3 warnings" + disclosure listing `warnings[].message`.
- Failed / interrupted: warning banner "Sync stopped at 34 of 220 sets (3 cards failed). Everything downloaded so far is kept." [Resume] (resumes same run id) [Details].
- Cancelled: info "Sync cancelled. Downloaded data is kept." [Resume].
- Another sync active (409): the running card is shown instead of the button.
- Cancel-requested: button becomes "Stopping…" disabled.

### 10.3 Import (dry-run first)
```
│ IMPORT                               │
│ Bring in cards from a pokescan JSON export or a CSV file.  [Format guide]→ docs link
│ [ Choose file ]                      │  accept=".json,.csv,application/json,text/csv"
```
After choosing → upload to dry-run → **preview** (full-height sheet / dialog):
```
│ Import preview — collection.csv      │
│ 412 rows read                        │
│ ✓ 398 will be added                  │  positive
│ ↻ 6 match existing copies            │  info — policy below decides
│ ⚠ 5 need attention                   │  warning (e.g. unknown card id → will become custom card)
│ ✕ 3 will be skipped (errors)         │  negative
│ If a row matches a copy you already have:
│ (Skip it)(Update my copy)            │  conflictPolicy `skip` (default) | `update` — changing it re-runs the dry-run
│ ▸ Row details (first 100)            │  table: row #, card, outcome, message
│ [ Import 398 cards ]   [ Cancel ]    │  commit button shows the exact count for the chosen policy
```
- Nothing is written before "Import N cards". Commit uses the preview id; if the collection changed since the preview (409 stale revision) → "Your collection changed since this preview. [Preview again]".
- Result: "Imported 398 cards. 3 rows skipped." [Download skipped rows] (if API provides) [View collection].
- Errors: unsupported file → "This file isn't a pokescan export or a CSV with the expected columns. See the format guide." Too large (413) → "That file is too large (max 25 MB)."

### 10.4 Export
```
│ EXPORT                               │
│ [ Download JSON ]  Complete — use this for backups and moving to another PC.
│ [ Download CSV ]   One row per card, for spreadsheets. Some details aren't included.
```
Filenames come from the server (`pokescan-<UTC compact>.json` / `.csv`, API.md). Button shows spinner while the blob downloads; error toast on failure.

### 10.5 Backup and restore
```
│ BACKUP & RESTORE                     │
│ [ Download backup ]  A complete copy of the database file (.sqlite), including the catalog.
│ [ Restore from backup… ]             │  negative-outlined secondary button
```
Restore flow: choose `.sqlite` → upload to restore dry-run → dialog:
```
│ Restore this backup?                 │
│ Backup:  412 cards · made 28 Oct 2026│  from dry-run metadata
│ Current: 431 cards                   │
│ Restoring replaces everything in pokescan with the backup.
│ A copy of your current data is saved first.
│ Type RESTORE to confirm  [         ] │
│ [ Cancel ]   [ Restore backup ]      │  danger-solid, enabled only after typing
```
During restore: full-screen blocking overlay "Restoring backup… Don't close this page." then reload. Failure: "Restore failed. Your previous data is unchanged." (ARCHITECTURE guarantees re-open of the previous copy).

### 10.6 Data page ≥ 1024
Two-column: left catalog sync card + backup/restore; right import + export.

## 11. Scanner (`/scan`) — Phase 3 design, disabled in Phase 1

Phase 1 ships only the nav slot (disabled) and the "Scanner coming" sheet (§11.6). Everything else here is the target for Phase 3 so the shell, tokens and add-confirm sheet are built compatible with it now.

### 11.1 Layout 390 px (Phase 3)
```
┌──────────────────────────────────────┐
│ ✕          Looking for a card…   ⚡ ↺│  translucent top bar over video: close, status pill,
│                                      │  torch (if supported), switch camera
│    ┌────────────────────────┐        │
│    ┃                        ┃        │  framing guide: 63:88, 78% of width, corner brackets
│    ┃                        ┃        │  4 px accent; outside darkened 55%
│    ┃                        ┃        │  guide turns positive when a card quad is detected
│    ┃                        ┃        │
│    └────────────────────────┘        │
│        Fill the frame with the card  │  hint caption
│                                      │
│ [🖼 Photo]      ( ◉ )      [≡ 12]    │  upload photo · shutter 72 px · session tray (count)
│ Continuous  [●  ]   EN|JA|Auto       │  continuous toggle, language hint
└──────────────────────────────────────┘
```
Status pill copy sequence: "Looking for a card…" → "Hold steady" (quad found) → "Identifying…" → "Match found" / "Pick the right card" / "No match — try again or search".

### 11.2 Result sheet (peeks over the bottom 55 %)
- **Confident** (status confident): art thumb, name, set · number, language, confidence meter "96% match" with a text label (High ≥ threshold / Check / Low), variant chips with the hint preselected only when the variant hint is confident (else preselected by the §7.3 rule and labelled "Looks like Reverse holo? — confirm"), condition NM, qty stepper, **Add card** primary. Still requires a tap (never auto-saves). In continuous mode with the Settings option "Quick add confident matches" (off by default, Phase 3 decision) the Add button shows a 2 s ring countdown that the user can cancel — that is still an explicit opt-in, and only for confident results.
- **Uncertain**: "Pick the right card" + up to **3** candidate tiles side-by-side (art, name, set·number, % match) + "None of these — search" → `/add?q=<best name>`. Nothing is preselected.
- **No match / no card**: "Couldn't identify this card" + [Try again] [Search manually].
- Every field editable before Add; Add reuses the exact §7.3 component.
- After Add in continuous mode: sheet collapses to a toast "Added Furret · ×1" [Undo], camera resumes, the session tray count increments with a pop. Tray opens a list of this session's adds (ScanSession) with per-row Undo/Edit.

### 11.3 ≥ 1024 (webcam)
Video left (max 640 px wide), result panel right (420 px) always visible.

### 11.4 Error states
- **Camera needs HTTPS**: when `window.isSecureContext` is false (phone on `http://<pc-ip>:3200`): "The live camera needs a secure (HTTPS) connection. You can still take a photo." [Take a photo] (uses `<input type="file" accept="image/*" capture="environment">`, which works on plain HTTP) [How to enable HTTPS] → docs.
- Permission denied: "Camera access is blocked. Allow it in your browser's site settings, or take a photo instead."
- No camera: "No camera found on this device." [Upload a photo].
- Recognition service down (503): "Card recognition is offline on your PC. Search manually or try again later." [Search manually].
- Slow (> 4 s): status pill "Still working…"; timeout at 10 s → No-match state with retry.

### 11.5 Accessibility
Status pill is a polite live region. Shutter: "Take photo" button. Candidates are radio-like buttons ("Furret, Darkness Ablaze 136 of 189, 62 percent match"). Torch/switch buttons have names and pressed state. Respect reduced motion: guide color change without pulse.

### 11.6 Phase 1: "Scanner coming" sheet (the only scanner UI that ships now)
```
│ ─────                                │
│ [ScanLine icon, muted]               │
│ Camera scanning is coming            │  H3
│ Scanning arrives in a later update.  │
│ For now, find cards by name or       │
│ number — it takes a few seconds.     │
│ [ Add a card by search ]             │  primary → /add
│ [ Close ]                            │  text button
```
Playwright: the Scan nav button has `aria-disabled="true"`, no `href`, and opening it never calls `getUserMedia`.

## 12. Global states and copy library

Error messages map API `error.code` → friendly text (fallback to "Something went wrong. Try again."):

| Code / condition | Title | Body |
|---|---|---|
| network failure / fetch rejected | Can't reach pokescan | Your phone couldn't connect to the PC. Check you're on the same Wi-Fi and pokescan is running. |
| `DB_BUSY` (503) | Busy for a moment | pokescan is saving something else. Trying again… (auto-retry once after `Retry-After`) |
| `MAINTENANCE` (503) | Restoring a backup | The app will be back in a moment. |
| `WORKER_UNAVAILABLE` (503) | Couldn't start the sync | The background worker didn't start on your PC. Try again; if it keeps failing, run `npm run sync` on the PC. |
| `NOT_FOUND` (404) | Not found | This item doesn't exist anymore. It may have been deleted. |
| `VALIDATION_ERROR` (400) | (inline on fields) | per-field message from `details.issues[].path` |
| `IN_USE` (409) | Can't delete yet | It's still used by N cards. (N = `details.dependentCount`) |
| `CONFLICT` (409, `details.field=name`) | (inline) | You already have one called “…”. |
| `STALE_PREVIEW` (409) | Your collection changed | Preview again to see the latest. |
| `PREVIEW_EXPIRED` (410) | Preview expired | Previews last 10 minutes. Choose the file again. |
| `ACTIVE_SYNC` (409) | A sync is already running | (show the running sync card) |
| `PAYLOAD_TOO_LARGE` (413) | File too large | The limit is 25 MB for imports, 512 MB for backups. |
| `IMPORT_INVALID` / `BACKUP_INVALID` (422) | This file can't be used | It isn't a valid pokescan export/backup. See the format guide. |

Button vocabulary (consistent verbs): Add to collection · Add N copies · Add another · Save · Delete copy · Create location · Create and add to collection · Sync catalog · Resume · Cancel sync · Choose file · Import N cards · Download JSON · Download CSV · Download backup · Restore backup · Clear filters · Show N cards · Try again.
Never: "Submit", "OK" for destructive actions, "Oops".

Skeleton rule: skeletons mirror final geometry exactly (same tile count per row, same row heights) and crossfade to content in 320 ms. Show skeletons only after 150 ms (avoid flash on fast LAN responses).

## 13. Accessibility checklist (implementer must meet; Playwright + axe where noted)

- Landmarks: `header`, `nav[aria-label=Primary]`, `main`, sheet `role=dialog`. One H1 per page.
- Focus: visible `:focus-visible` ring (2 px `--ps-focus-ring`, 2 px offset) on every interactive element; never `outline:none` without replacement. Sheets trap focus and restore it.
- Targets ≥ 44 × 44 (Playwright: query all `a,button,[role=button],input,select,[role=switch]` in the viewport at 390 px and assert bounding box ≥ 44 in both dimensions, allowing inline text links inside paragraphs).
- Labels: every input has a visible `<label>`; icon buttons have `aria-label`; badges have `aria-label` with long names.
- Color is never the only signal (rarity labels, condition text, gain/loss signs, missing tiles also dashed + "Missing" in accessible name).
- Contrast tokens verified (DESIGN-TOKENS §3).
- Live regions: toasts (`status`), sync progress, collection result count, scanner status.
- Reduced motion: no transform animations; fades kept.
- Zoom: layout survives 200 % text zoom at 390 px without horizontal scroll (truncation allowed in tiles, full text available in details).
- Language: `<html lang="en">`; JA card names wrapped in `<span lang="ja">` when the card language is `ja` so screen readers switch voices.
- Run `@axe-core/playwright` on `/`, `/collection`, `/cards/en/swsh3-136`, `/sets`, `/add`, `/settings/data` with zero serious/critical violations.

## 14. Acceptance hooks for Playwright (390 × 844)

Stable selectors the implementer must add (`data-testid`): `bottom-nav`, `nav-scan` (aria-disabled), `add-button`, `search-input`, `result-row`, `confirm-sheet`, `variant-chip-<enum>`, `condition-chip-<NM…>`, `qty-input`, `add-submit`, `add-another`, `card-tile`, `qty-badge`, `price`, `filter-button`, `filter-sheet`, `sync-start`, `sync-progress`, `import-file`, `import-preview`, `import-commit`, `export-json`, `export-csv`, `backup-download`, `restore-file`.

Key flows to script:
1. Tap-tap-add: `/collection` → `add-button` → type "furret" → first `result-row` (Furret, Darkness Ablaze) → `add-submit` (no other interaction) → success shows "Added Furret" → `add-another` focuses `search-input` with text selected. Verify one new owned copy: variant normal, condition NM, raw, no price.
2. Null price: a card with no price snapshot renders no `price` element in its tile and no "$0.00" anywhere on the page.
3. No horizontal overflow on every route listed in §1.1.
4. Scan slot: `nav-scan` has `aria-disabled="true"`; activating it shows the "Camera scanning is coming" sheet; `navigator.mediaDevices.getUserMedia` is never called (spy).
5. Discard: open confirm, change condition to LP, close → "Discard this card?" appears; Discard → no copy created.
6. Theme: default `data-theme="dark"`; switching to Light persists across reload.
