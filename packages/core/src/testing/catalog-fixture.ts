import type { Language, Variant } from '@flashydex/schemas';
import { localIdSort, nameSearch } from '../catalog/tcgdex';
import type { Db } from '../db/sql';
import { sha256Hex } from '../catalog/sha256';

/** Synthetic catalog rows for TESTS ONLY (clearly fake ids/names; never used by the app). */
export type FixtureSet = {
  id: string; name: string; series?: string | null; releaseDate?: string | null; status?: 'published' | 'unpublished';
  officialCount?: number | null; totalCount?: number | null;
  /** Active manifest ids. Default: ids of the fixture cards of this set. Use [] for an unpublished shell. */
  manifest?: string[];
};
export type FixtureCard = {
  id: string; setId: string; localId: string; name: string; rarity?: string | null; imageUrl?: string | null; variants?: Variant[];
  category?: string | null; illustrator?: string | null; detail?: boolean;
};
export type FixturePrice = {
  cardId: string; source: 'tcgplayer' | 'cardmarket'; variant: Variant; variantDetail?: string; key?: string; low?: number | null; mid?: number | null;
  high?: number | null; market?: number | null; trend?: number | null; sourceUpdatedAt?: string | null; capturedAt?: string;
};

const SYNCED = '2026-10-01T00:00:00.000Z';

export async function seedCatalog(db: Db, language: Language, data: { sets: FixtureSet[]; cards: FixtureCard[]; prices?: FixturePrice[] }): Promise<void> {
  await db.transaction(async (tx) => {
    for (const s of data.sets) {
      const manifest = s.manifest ?? data.cards.filter((c) => c.setId === s.id).map((c) => c.id);
      const raw = { id: s.id, name: s.name, cards: manifest.map((id) => ({ id })) };
      await tx.run(
        `INSERT INTO catalog_sets (language, id, name, name_search, series, status, release_date, official_count, total_count, logo_url, symbol_url, raw_json, synced_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?)`,
        [language, s.id, s.name, nameSearch(s.name), s.series ?? null, s.status ?? (manifest.length > 0 ? 'published' : 'unpublished'), s.releaseDate ?? null,
          s.officialCount ?? manifest.length, s.totalCount ?? manifest.length, JSON.stringify(raw), SYNCED]
      );
    }
    for (const c of data.cards) {
      const variants = c.variants ?? ['normal'];
      await tx.run(
        `INSERT INTO catalog_cards (language, id, set_id, local_id, local_id_sort, name, name_search, rarity, category, illustrator, image_url, has_normal, has_holo,
           has_reverse, has_first_edition, w_promo, available_variants_json, raw_json, synced_at, detail_synced_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, '{}', ?, ?)`,
        [language, c.id, c.setId, c.localId, localIdSort(c.localId), c.name, nameSearch(c.name), c.rarity ?? null, c.category ?? null, c.illustrator ?? null,
          c.imageUrl ?? null, variants.includes('normal') ? 1 : 0, variants.includes('holo') ? 1 : 0, variants.includes('reverse_holo') ? 1 : 0,
          variants.includes('first_edition') ? 1 : 0, JSON.stringify(variants), SYNCED, c.detail === false ? null : SYNCED]
      );
    }
    let n = 0;
    for (const p of data.prices ?? []) {
      n += 1;
      const currency = p.source === 'tcgplayer' ? 'USD' : 'EUR';
      const observationKey = sha256Hex(JSON.stringify([language, p.cardId, p.source, p.variant, p.variantDetail ?? '', p.key ?? `${p.source}:${p.variant}`, currency,
        p.sourceUpdatedAt ?? null, p.low ?? null, p.mid ?? null, p.high ?? null, p.market ?? null, p.trend ?? null]));
      const id = `00000000-0000-4000-9000-${String(n).padStart(12, '0')}`;
      await tx.run(
        `INSERT INTO catalog_latest_prices (id, catalog_card_id, language, source, variant, variant_detail, provider_variant_key, currency, low_cents, mid_cents,
           high_cents, market_cents, trend_cents, source_updated_at, captured_at, observation_key) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [id, p.cardId, language, p.source, p.variant, p.variantDetail ?? '', p.key ?? `${p.source}:${p.variant}`, currency, p.low ?? null, p.mid ?? null,
          p.high ?? null, p.market ?? null, p.trend ?? null, p.sourceUpdatedAt ?? null, p.capturedAt ?? SYNCED, observationKey]
      );
    }
  });
}
