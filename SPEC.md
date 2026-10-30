# PROJECT: Personal Pokémon Card Scanner & Collection Manager

## OBJECTIVE

Build a self-hosted, installable Pokémon TCG collection application inspired by the useful core functionality of applications such as HoloDex, but without requiring a paid subscription or paid per-scan recognition API.

The primary user experience is:

Camera → identify exact Pokémon card → verify variant → add to collection → continue scanning.

The application is initially intended for a single personal collection, but its architecture should not prevent multi-user support later.

Do not over-engineer features that are not required for the initial working product.

## CORE REQUIREMENTS

The application must:

1. Identify Pokémon cards from camera images.
2. Identify the exact set and collector number whenever possible.
3. Support English and Japanese cards where catalog data exists.
4. Distinguish or allow confirmation of variants including:
   - normal
   - holo
   - reverse holo
   - first edition
   - stamped/promotional variants
   - other catalog-supported variants
5. Allow low-confidence matches to present multiple candidates rather than automatically selecting one.
6. Allow manual searching and manual card creation when recognition/catalog coverage fails.
7. Track:
   - quantity
   - condition
   - raw or graded
   - grading company
   - grade
   - certification number
   - purchase price
   - purchase date
   - purchase source
   - storage location
   - notes
8. Track duplicate cards.
9. Track set completion.
10. Show missing cards within sets.
11. Estimate collection market value.
12. Track cost basis and estimated gain/loss.
13. Support CSV and JSON export/import.
14. Work as an installable mobile-friendly PWA.

## TECHNICAL DIRECTION

Preferred architecture:

Frontend:
- Next.js
- TypeScript
- responsive/mobile-first PWA
- camera integration

Recognition service:
- Python
- FastAPI
- OpenCV
- ONNX Runtime
- DINOv2-derived visual embeddings
- perceptual hashing
- OCR
- nearest-neighbor retrieval

Card data:
- TCGdex

Database:
- SQLite initially
- schema must permit future migration to PostgreSQL

Recognition should use retrieval rather than a classifier with one class per Pokémon card.

Reference architecture:

camera image
→ detect card rectangle
→ perspective correction
→ normalized card crop
→ perceptual hashes
→ visual embedding
→ OCR collector number
→ set-symbol/set-code analysis
→ weighted candidate ranking
→ confidence score
→ exact match or candidate selection

Review the MIT-licensed Pokeum project as an architectural and implementation reference. Do not blindly copy code. Understand its components and reuse/adapt MIT-licensed portions only when doing so materially improves the project.

## DATABASE MODEL

At minimum design entities equivalent to:

CatalogCard
OwnedCard
Acquisition
Grade
StorageLocation
PriceSnapshot
CollectionGroup
ScanSession
CustomCard

Catalog data and personal collection data must remain separated.

Deleting/re-syncing catalog data must never delete the user's collection.

## PRODUCT SCREENS

Dashboard

Display:
- total cards
- unique cards
- duplicates
- estimated value
- total amount paid
- estimated gain/loss
- recently added cards

Scanner

Provide:
- mobile camera
- card framing guide
- detection status
- recognized card
- confidence score
- alternative matches when needed
- variant confirmation
- Add Card action
- continuous scanning mode

Collection

Provide:
- card grid
- compact list
- search
- set filter
- rarity filter
- language filter
- condition filter
- raw/graded filter
- duplicate filter
- storage-location filter

Card Details

Provide:
- card art
- set
- collector number
- rarity
- language
- copies owned
- variants
- purchase history
- price information
- condition
- grading information
- storage location
- notes

Sets

Provide:
- set list
- owned count
- total count
- completion percentage
- missing cards
- duplicates

Settings/Data

Provide:
- catalog sync
- import
- export
- backup
- restore

## PRICE DATA

Pricing must not block core card identification.

Start with pricing available through TCGdex.

Cache pricing locally.

Store historical PriceSnapshot records.

Allow missing pricing values.

Never fabricate a price.

Allow manual price overrides.

Do not build undocumented scraping against TCGPlayer, PriceCharting, eBay, or other marketplaces during the MVP.

## RELIABILITY RULES

Never automatically save a low-confidence identification.

Return up to three candidate cards when confidence is insufficient.

Every scanner result must remain editable before being committed.

Manual entry must always remain available.

User collection data must never depend entirely on third-party availability.

Imports and exports must use documented schemas.

Implement automated tests around recognition matching, duplicate handling, collection mutations and pricing calculations.

## DEVELOPMENT PHASES

Phase 1:
Application shell, database, TCGdex synchronization, search and manual collection management.

Phase 2:
Single-card image recognition.

Phase 3:
Live mobile scanner and continuous scanning.

Phase 4:
Variants, conditions, graded cards, purchase tracking and storage locations.

Phase 5:
Pricing and portfolio calculations.

Phase 6:
Set completion and missing-card tracking.

Phase 7:
Offline/PWA polish, backups, batch workflows and performance.

## AGENT RESPONSIBILITIES

Hermes acts as project director.

Claude should generally be the primary implementation agent.

ChatGPT should generally handle:
- architecture
- data modeling
- API contracts
- acceptance criteria
- UX decisions
- algorithm review
- debugging strategy
- security review
- code review
- implementation review

Do not allow multiple agents to independently modify the same subsystem without coordination.

For meaningful features:

1. Define specification.
2. Define acceptance criteria.
3. Implement.
4. Run tests.
5. Have another agent review.
6. Correct issues.
7. Commit.

Do not declare a feature complete merely because it compiles.

## MVP DEFINITION OF DONE

The MVP is complete when a user can:

1. Open the application on their phone.
2. Scan a Pokémon card.
3. Receive the correct card or a short list of likely candidates.
4. Confirm its variant.
5. Add it to the collection.
6. Scan another card immediately.
7. Search the collection later.
8. See quantities and duplicates.
9. Record what was paid.
10. Export the complete collection.

Everything else is secondary until this workflow is reliable.