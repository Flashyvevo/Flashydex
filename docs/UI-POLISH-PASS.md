# FlashyDex — Mobile UI Polish Pass + Continue Milestone 2 Scanner

Repository:
https://github.com/Flashyvevo/Flashydex

Production PWA:
https://flashydex.netlify.app

Catalog packs:
https://flashydex-catalog-packs.netlify.app

## CONTEXT

The owner has now tested the current FlashyDex PWA directly on an iPhone and provided screenshots of:

- Dashboard
- Collection
- Add a card
- Sets
- Add/confirm card modal
- Expanded More details form
- Installed Home Screen app icon

Treat the owner's screenshots as the visual source of truth for this UI polish pass.

The app is functionally working.

Do NOT redesign the architecture.

Do NOT pause or restart Milestone 2 scanner/storage work.

This is a targeted consumer-quality mobile polish pass that should happen alongside/just before the scanner UI lands.

The final objective remains:

Take Photo
→ identify card
→ show match/candidates
→ confirm
→ add
→ Scan Another

---

# PRIORITY

## P0

Fix layout/interaction problems visible on the owner's actual iPhone.

## P1

Make the application feel visually intentional and polished.

## P2

Immediately continue Milestone 2 scanner integration.

Do not spend days redesigning every component.

---

# GLOBAL MOBILE UI ISSUES

The current design direction is good:

- near-black background
- dark charcoal surfaces
- lime FlashyDex accent
- white primary text
- muted gray secondary text

Keep it.

Do not introduce another visual style.

## Global spacing

There is too much unused vertical space at the tops of several screens.

Reduce dead header space while respecting iOS safe areas.

Pages should feel vertically efficient without becoming cramped.

Use a consistent layout rhythm approximately equivalent to:

- page horizontal padding: 16–20px
- section gaps: 20–28px
- card gaps: 12–16px
- safe-area-aware top padding
- bottom content padding sufficient to clear the nav

Do not let content disappear behind the bottom navigation or sticky buttons.

---

# BOTTOM NAVIGATION

This needs the most visible cleanup.

Current tabs:

Home
Collection
center Scanner
Sets
Settings

## Fix the scanner tab

The center scanner action should NOT display:

Soon

The scanner is now actively being built as Milestone 2.

Use:

Scan

The visual hierarchy should clearly make it the primary action.

Current issue:

The circular scanner button floats above the navigation but its label sits awkwardly underneath/behind it and competes with neighboring labels.

Fix:

- scanner button centered perfectly
- label "Scan" aligned underneath without overlap
- no clipping
- no glow spilling excessively into adjacent tabs
- preserve safe-area bottom inset
- all five items visually balanced
- active state remains lime
- inactive state muted gray

The Scanner button can remain disabled only until the scanner UI child lands.

Once scanner functionality lands, activate it.

---

# DASHBOARD

Current screen is functional but visually sparse at the top.

## Fix hierarchy

The current structure:

Dashboard
Estimated value
No price data yet
Add what you paid...
pricing information
four statistic cards

needs better grouping.

Target:

Dashboard

Collection value area
→ primary value or "No price data yet"
→ pricing coverage
→ market source/update action

Then:

2×2 stat grid

Then:

Recently added

Do not scatter pricing copy across several unrelated vertical lines.

### Pricing block

Create one coherent section/card for:

Estimated value
Price coverage
Cardmarket value
TCGplayer update state/action

Example hierarchy:

Estimated value
No price data yet

0 of 3 copies priced

Cardmarket
€17.62

TCGplayer
Update prices →

Do not make "Add what you paid to see gain/loss" look like the primary action when price coverage itself is missing.

Cost basis/gain-loss can be secondary.

## Recently added

The current horizontal artwork row is good.

Ensure:

- cards have consistent dimensions
- no content is hidden behind bottom nav
- card labels don't become unreadable
- tapping one opens the card detail

---

# COLLECTION

Current grid is one of the better screens.

Keep the overall direction.

## Improve header

There is too much empty space between the iOS status area and:

Collection

Bring the title upward while preserving safe-area padding.

The + button should align visually with the title region rather than appearing isolated in empty space.

## Grid

Current two-column artwork grid works.

Maintain:

- large artwork
- ×N duplicate badge
- name
- collector number/set

Improve truncation so set information doesn't end in awkward fragments like:

Furious ...

Use one intentional metadata line with ellipsis.

Example:

108/111 · Furious Fists

## Controls

Search
Filters
Recently added
grid/list

are good.

Ensure they fit cleanly at iPhone widths without feeling crowded.

---

# ADD A CARD

The current Add screen is still too search-centric.

The scanner and visual browse flows need to become primary.

Target layout:

Add a card

[ Take Photo ]

[ Choose Photo ]

Search name or number...

[ Browse by set ]

Language:
All | EN | JP

Set:
Any set

Then recent cards/search results.

The user should not have to know a card's name before finding it.

## Browse

Preserve/finish the Browse-by-set implementation already being worked on.

Browse by set should provide:

set picker
→ large art grid
→ tap card
→ same confirmation modal

Do not create a second add workflow.

---

# SEARCH RESULTS

Current list view with small thumbnails is useful.

Also support the planned grid toggle.

Grid should prioritize card art for users visually identifying cards.

At approximately 390px width:

- 3 columns where comfortable
- 2 columns on narrower devices
- fixed Pokémon card aspect ratio
- card number underneath
- lazy image loading
- owned badge when applicable

---

# ADD / CONFIRM CARD MODAL

This screen needs a focused cleanup.

## Header problem

Current sticky header:

Cancel
Dragonite EX

works, but content can visually slide underneath it awkwardly.

Ensure:

- modal content begins below the header
- first card row is never clipped
- header is opaque enough that scrolling content doesn't bleed through
- drag handle remains centered
- safe-area behavior works on iPhone

## Card identity block

Current:

artwork
Dragonite EX
Furious Fists · 108/111
Ultra Rare EN

is good.

Increase image slightly if space permits.

Do not repeat or partially clip the title.

Keep:

name
set
collector number
rarity
language

visually grouped.

---

# VARIANT

Current variant treatment:

Normal
Other...

is functional but awkward.

Use a chip group.

Example:

Variant

[ Normal ✓ ] [ Holo ] [ Reverse ] [...]

Only show variants that are valid/relevant for the catalog record when possible.

"Other..." should open additional variants rather than looking like unrelated lime text.

Do not invent variant availability.

---

# CONDITION

Current abbreviated chips are intentional.

KEEP:

NM
LP
MP
HP
DMG

Also keep:

Not set

Improve spacing so the chips look like one cohesive control rather than several unrelated pills.

Do not expand the abbreviations.

---

# QUANTITY

Current +/- design works.

Keep it.

Make sure:

- minus disabled at quantity 1
- controls are ≥44px
- quantity remains centered
- no accidental double-tap zoom behavior

---

# GRADED

Current Graded switch row is good.

When enabled, reveal:

grading company
grade
certificate number

using progressive disclosure.

Do not permanently occupy space when Graded is off.

---

# MORE DETAILS

The expanded More details view currently becomes very long and visually dense.

The fields are useful, but hierarchy needs improvement.

Keep:

Paid per copy
Currency
Purchase date
Today
Bought from
Location
Notes
Use location for next cards too
Keep condition for next card

## Fix layout

Paid per copy + Currency can remain a paired row.

Purchase date + Today must not visually collide or produce uneven widths.

Use:

Purchase date
[ date field              ][ Today ]

with consistent height.

"Bought from" placeholder is fine.

Location selector is fine.

Notes field is too tall for the default state.

Reduce default height slightly and allow growth.

The two persistence toggles should be grouped into a clearly labeled section such as:

For next cards

[ toggle ] Keep location
[ toggle ] Keep condition

Use shorter copy if needed.

---

# STICKY ADD BUTTON

The sticky:

Add to collection

button is good and should remain.

Requirements:

- always visible
- never cover fields
- safe-area-aware
- sufficient padding above home indicator
- scroll content includes enough bottom inset
- button stays disabled only when required data is invalid

After add:

Added Dragonite EX

Provide:

[ Scan Another ]
[ View Card ]

Default/focused action should be:

Scan Another

once scanner is operational.

---

# SETS

This screen has the most obvious control styling problem.

Current segmented control:

Collecting | All

shows "Collecting" inside a large white block and visually conflicts with the rest of the dark UI.

Fix it.

Use the same segmented-control language used elsewhere:

dark container
lime selected state OR subtle light selected state consistent with the system

Do not have one giant white rectangle that looks like an HTML button escaped containment.

## Filters

All / EN / JP

good.

Newest / Name / Most complete

good.

Improve spacing/alignment.

## Set cards

The current set rows work but need more visual character.

Where a set logo exists:

show it.

Fallback to the current text mark only when artwork/logo is missing.

Maintain:

set name
owned / total
completion %
duplicate count
progress bar
language

Rows should be individually tappable.

## TCG Pocket

Current:

TCG Pocket sets hidden · Show

is acceptable.

Keep this secondary.

---

# APP ICON

The current Home Screen icon has too much black padding around the internally rounded icon.

Because iOS applies its own icon mask, the actual FlashyDex artwork should occupy more of the source canvas.

Create an App Store/PWA-safe icon source where:

- dark icon background fills the square
- FlashyDex card/F mark is larger
- outer black margin is substantially reduced
- important artwork remains inside Apple's safe zone
- DO NOT draw a second obvious rounded-square boundary that makes it look like a square inside another square

Preserve the existing FlashyDex visual identity.

Do not redesign the logo.

Regenerate:

- 192 PWA
- 512 PWA
- maskable
- apple-touch-icon
- favicon
- retained 1024 source

---

# TYPOGRAPHY

Overall typography is good.

Keep the current family unless there is a concrete accessibility issue.

Standardize hierarchy:

Page title:
large bold

Section title:
medium/semibold

Card title:
semibold

Metadata:
muted

Labels:
muted smaller

Actions:
lime

Avoid oversized title + massive empty header combinations.

---

# SCANNER UI INTEGRATION

Once the active M2 scanner child is ready, integrate it into this polished shell.

The center nav Scan button becomes active.

Scan screen target:

FlashyDex Scan

large camera/photo area

[ Take Photo ]

[ Choose Photo ]

small:
Search manually
Browse by set

After photo:

Analyzing card...

Then:

## High confidence

Large artwork
Name
Set · Number
confidence indication should remain subtle

[ Confirm ]

[ Wrong card ]

## Candidate mode

"We found a few possibilities"

Show up to 3 LARGE cards.

Do not use tiny list thumbnails.

## No match

Couldn't identify this card

[ Try another photo ]
[ Search manually ]
[ Browse by set ]

---

# DO NOT DELAY SCANNER WORK

Important:

This UI pass must NOT become another multi-hour redesign loop that prevents scanner integration.

Run UI work with disjoint ownership where possible.

Recommended:

Opus
→ director

Sonnet UI child
→ global shell, Dashboard, Collection, Sets, modal polish, icon

Existing scanner child
→ scanner/photo integration

Existing Stage F
→ OPFS/storage

Existing recognition work
→ EN/JA indexes/service

Do not let the UI child edit recognition/service files.

Do not let scanner child redo unrelated Dashboard/Collection components.

---

# MOBILE QA

Use owner's screenshots as reference.

Primary target:

390×844-class iPhone viewport

Also verify:

375 width
430 width

Check:

- no horizontal scroll
- no clipped text
- no content behind sticky nav/buttons
- safe areas
- modal header clipping
- keyboard opening
- keyboard dismissal
- scroll restoration
- 44px touch targets
- dark-mode contrast
- card art fixed ratio
- image loading placeholders
- scanner center-nav alignment
- home-screen icon appearance

---

# PRODUCTION QA

After changes:

Deploy to the live Netlify PWA.

Do not call UI work done based solely on localhost.

Verify:

Dashboard
Collection
Add
Browse
Sets
Settings
Add/confirm modal
More details
Home Screen PWA

Then continue the scanner milestone.

---

# MILESTONE SUCCESS CONDITION

The milestone remains:

From the LIVE FlashyDex PWA on the owner's iPhone:

Open Scan
→ Take Photo
→ photograph real card
→ recognition returns correct card/top candidates
→ confirm
→ choose variant/condition
→ Add to collection
→ Scan Another
→ collection updates
→ reload
→ card persists

The UI polish should make that workflow feel like a consumer application, not change the underlying product architecture.

---

# FINAL REPORT

Return:

## UI
- screenshots/routes reviewed
- components changed
- mobile issues fixed
- icon changes
- remaining visual issues

## Storage
- OPFS Stage F status
- EN+JA coexistence
- install/search performance

## Recognition
- EN index count
- JA index count
- service status
- tunnel URL/status
- latency

## Scanner
- Take Photo
- Choose Photo
- candidates
- confirm/add
- Scan Another
- production iPhone status

## Tests
- typecheck
- lint
- unit
- e2e
- mobile widths

## Owner actions
Only list actions that genuinely require the owner.

Do not stop after the UI polish pass.

Immediately continue toward the live photo → identify → add milestone.