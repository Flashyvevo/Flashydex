# Pricing V2 baseline (recorded 2026-11-08)
- HEAD before work: dc9d7ea (main). Feature branch: pricing-v2 (same checkout; main untouched until owner approves release).
- Deployed app: 1e09780 (Netlify production flashydex). Deployed packs manifest targetVersion 2026.11.07.001 (EN 221/23,912; JA 202/13,156). Packs are NOT rebuilt/republished in this milestone.
- Running processes: recognizer PID 12676 on 127.0.0.1:8900 (do not touch), cloudflared tunnel, dev server :3200.
- Active agents: none (all M2 children finished). Scanner files frozen: apps/mobile/src/routes/_modal/scan.tsx, components/scanner/**, lib/recognition/**, data/recognition.ts, netlify/functions/**, services/recognition/**.
- Pricing today: catalog_latest_prices (source tcgplayer/USD, cardmarket/EUR; CHECK clp_source_currency). Derived layer packages/core/src/domain/valuation.ts: automaticValue(USD)=tcgplayer market→mid, EUR=cardmarket mid; valuationsFor emits one valuation per currency, NO cross-currency conversion → EUR-only cards have no USD value. DashboardDto.currencies (USD, EUR) buckets, displayCurrency from settings.defaultCurrency.
