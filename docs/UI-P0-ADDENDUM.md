# FlashyDex — P0 UI Addendum

Apply these changes to the active UI polish/scanner milestone.

Do not delay scanner integration.

## 1. Card search must be visually usable

Current issue:

The Add/Search screen uses very small card thumbnails that are difficult to visually distinguish on an iPhone.

FlashyDex is a visual card-identification application. Search results must prioritize card artwork.

### Default search result mode

At iPhone widths, search results should default to a CARD ART GRID.

Target:

390px width:
- 3 columns

≤360px:
- 2 columns

430px:
- 3 columns, with slightly larger gutters/cards

Each tile must show:

- large card artwork
- card name
- collector number
- set name or abbreviated set metadata
- language badge if useful
- owned quantity badge when applicable

Use the existing card-art component and fixed Pokémon card aspect ratio.

Artwork must be large enough for a user holding a physical card to visually compare details.

### List mode

Keep list mode available as a secondary toggle.

If list mode remains:

- increase thumbnail size substantially from the current tiny image
- minimum target around 72–90px card height
- do not return to 40px thumbnails

Grid should be the remembered/default mode for Add/Search.

### Search behavior

Search by:

- Pokémon/card name
- collector number
- set

Results should update without excessive delay.

Do not make the user type an exact full card name.

### Browse by set

Use the same large art-grid component for:

Browse by set
→ select set
→ visually browse cards
→ tap
→ existing confirmation sheet

Do not fork a second visual-card component.

### Recognition candidates

Recognition results should be even larger than search results.

For up to 3 candidates:

- one card per row or large vertical candidates
- artwork approximately 55–65% of viewport width where practical
- name
- set
- collector number
- confidence indicator kept subtle

The user should be able to compare the candidate with the physical card without zooming.

---

# 2. USD must be the default pricing currency

Current issue:

The Dashboard can show Cardmarket EUR pricing even when TCGplayer USD pricing exists.

For the primary FlashyDex experience, USD is the default display currency.

### Pricing priority

For English cards:

1. TCGplayer USD market price when available
2. other valid TCGplayer USD quote according to current pricing rules
3. if NO USD quote exists, display available Cardmarket EUR value explicitly as EUR
4. never silently convert EUR to USD in this milestone
5. never label an EUR value as USD

Example:

Preferred:

Estimated value
$42.16

If no USD data exists:

No USD price

Cardmarket
€17.62

Do not allow an available EUR quote to override a valid USD quote simply because it appears first in stored pricing rows.

### Dashboard

The main Estimated value should use USD by default.

If some cards lack USD values:

show coverage:

15 of 18 copies priced in USD

and optionally:

3 copies have EUR-only pricing

Do not mix USD + EUR values into one portfolio total.

### Settings

Add:

Settings
→ Catalog & prices
→ Display currency

Options:

USD
EUR

Default:

USD

Changing the display currency changes presentation/portfolio selection only.

Do not mutate stored source pricing data.

### Pricing tests

Use the real production EN catalog pack.

Test at least:

- card with TCGplayer USD + Cardmarket EUR
- USD-only card
- EUR-only card
- card with no price
- multiple variants with different pricing rows
- portfolio containing mixed availability

Assertions:

- USD is selected by default
- USD wins when available
- EUR is clearly labelled when used
- no fake conversion
- no $0.00 for missing values
- mixed currencies are never summed together

---

# 3. Mobile QA

Verify on:

375px
390px
430px

Specifically confirm:

- search card art is large enough to visually compare
- no horizontal overflow
- tile text does not overlap
- images retain fixed card aspect ratio
- owned badges remain readable
- tapping a card opens the existing confirmation flow
- Dashboard defaults to USD
- EUR-only fallback is clearly marked
- currency preference persists after reload

---

# SUCCESS CONDITION

From the live FlashyDex PWA on an iPhone:

1. Open Add.
2. Search "Charizard".
3. Immediately see large, recognizable card artwork.
4. Visually distinguish different Charizard printings.
5. Tap the correct card.
6. Add it through the existing confirmation sheet.

And on Dashboard:

- TCGplayer USD is used when available.
- EUR appears only as an explicit fallback or when the user selects EUR.

These are P0 usability fixes and should land with the current UI/scanner milestone.