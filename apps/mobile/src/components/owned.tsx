import type { ReactNode } from 'react';
import { CardTile, GradeBadge, ConditionBadge, LangBadge, Price, VariantChip, CardRow, type GradeLike, type TileLink } from './card';
import { CONDITION_LABEL, collectorNumber, variantLabel, type Condition, type Currency, type Language, type Variant, plural, formatMoney } from '../lib/format';

/** Structural subset of OwnedDto the UI needs (assignable from the real DTO). */
export type OwnedLike = {
  id: string;
  catalogCardId: string | null;
  customCardId: string | null;
  name: string;
  setName: string | null;
  setId: string | null;
  setOfficialCount?: number | null;
  localId: string | null;
  language: Language;
  rarity: string | null;
  imageUrl: string | null;
  variant: Variant;
  variantDetail: string;
  condition: Condition | null;
  grade: (GradeLike & { certNumber?: string | null }) | null;
  manualPrice: { cents: number; currency: Currency } | null;
  valuations: { currency: Currency; cents: number; source: 'manual' | 'tcgplayer' | 'cardmarket' }[];
};

export type GroupLike = {
  source: 'catalog' | 'custom';
  language: Language;
  cardId: string;
  variant: Variant;
  qty: number;
  totalQty: number;
  representative: OwnedLike;
  conditions: { condition: Condition | null; qty: number }[];
  grading: { raw: number; graded: number };
};

export function valuationFor(o: OwnedLike, currency: Currency): number | null {
  return o.valuations.find((v) => v.currency === currency)?.cents ?? null;
}

export function ownedLink(o: OwnedLike): TileLink {
  return { to: '/collection/$ownedId', params: { ownedId: o.id } };
}

export function groupLink(g: GroupLike): TileLink {
  if (g.source === 'custom') return { to: '/custom-cards/$customId', params: { customId: g.cardId } };
  return { to: '/cards/$language/$cardId', params: { language: g.language, cardId: g.cardId }, search: { variant: g.variant } };
}

/** The ordinal number as shown on tiles ("#136": the owned snapshot carries no official count). */
export function ownedNumber(o: OwnedLike): string | null {
  return collectorNumber(o.localId, o.setOfficialCount);
}

export function groupAriaLabel(g: GroupLike, currency: Currency): string {
  const o = g.representative;
  const parts: string[] = [o.name];
  const setPart = [o.setName, o.localId ? `${o.localId}` : null].filter(Boolean).join(' ');
  if (setPart) parts.push(setPart);
  parts.push(variantLabel(g.variant, o.variantDetail));
  parts.push(g.qty === g.totalQty ? plural(g.qty, 'copy', 'copies') : `${g.qty} of ${g.totalQty} copies match`);
  if (g.conditions.length === 1) parts.push(CONDITION_LABEL[g.conditions[0]!.condition ?? 'unknown']);
  else if (g.conditions.length > 1) parts.push('mixed conditions');
  const price = formatMoney(valuationFor(o, currency), currency);
  if (price) parts.push(price);
  return parts.join(', ');
}

export function ownedAriaLabel(o: OwnedLike, currency: Currency): string {
  const parts = [o.name, [o.setName, o.localId].filter(Boolean).join(' '), variantLabel(o.variant, o.variantDetail), o.grade ? `Graded ${o.grade.company} ${o.grade.grade}` : CONDITION_LABEL[o.condition ?? 'unknown']].filter(Boolean);
  const price = formatMoney(valuationFor(o, currency), currency);
  if (price) parts.push(price);
  return parts.join(', ');
}

function metaLine(o: OwnedLike): string {
  return [ownedNumber(o), o.setName].filter(Boolean).join(' · ');
}

export function GroupTile({ group, currency, showLang, onLongPress }: { group: GroupLike; currency: Currency; showLang: boolean; onLongPress?: () => void }) {
  const o = group.representative;
  return (
    <CardTile
      link={groupLink(group)}
      name={o.name}
      image={o.imageUrl}
      meta={{ name: o.name, setName: o.setName, localId: o.localId, rarity: o.rarity }}
      metaLine={metaLine(o)}
      qty={group.qty}
      variant={group.variant}
      variantDetail={o.variantDetail}
      conditions={group.grading.graded === group.qty ? undefined : group.conditions}
      grade={group.grading.graded === group.qty && group.qty > 0 ? o.grade : null}
      hasGraded={group.grading.graded > 0 && group.grading.raw > 0}
      priceCents={valuationFor(o, currency)}
      currency={currency}
      language={group.language}
      showLang={showLang}
      custom={group.source === 'custom'}
      ariaLabel={groupAriaLabel(group, currency)}
      onLongPress={onLongPress}
    />
  );
}

export function OwnedTile({ owned, currency, showLang }: { owned: OwnedLike; currency: Currency; showLang?: boolean }) {
  return (
    <CardTile
      link={ownedLink(owned)}
      name={owned.name}
      image={owned.imageUrl}
      meta={{ name: owned.name, setName: owned.setName, localId: owned.localId, rarity: owned.rarity }}
      metaLine={metaLine(owned)}
      variant={owned.variant}
      variantDetail={owned.variantDetail}
      conditions={owned.grade ? undefined : [{ condition: owned.condition, qty: 1 }]}
      grade={owned.grade}
      priceCents={valuationFor(owned, currency)}
      currency={currency}
      language={owned.language}
      showLang={showLang}
      custom={!!owned.customCardId}
      ariaLabel={ownedAriaLabel(owned, currency)}
    />
  );
}

export function GroupRow({ group, currency, showLang }: { group: GroupLike; currency: Currency; showLang: boolean }) {
  const o = group.representative;
  const cond = group.conditions;
  const single = cond.length === 1 ? cond[0]!.condition : undefined;
  const badges: ReactNode = (
    <>
      {group.grading.graded === group.qty && o.grade ? <GradeBadge grade={o.grade} /> : cond.length >= 1 ? <ConditionBadge condition={single ?? cond[0]!.condition} plus={cond.length > 1} /> : null}
      {showLang && <LangBadge language={group.language} />}
    </>
  );
  return (
    <CardRow
      link={groupLink(group)}
      name={o.name}
      image={o.imageUrl}
      meta={{ name: o.name, setName: o.setName, localId: o.localId, rarity: o.rarity }}
      line2={[o.setName, ownedNumber(o), group.variant !== 'normal' ? variantLabel(group.variant, o.variantDetail) : null].filter(Boolean).join(' · ')}
      qty={group.qty}
      priceCents={valuationFor(o, currency)}
      currency={currency}
      badges={badges}
      ariaLabel={groupAriaLabel(group, currency)}
      testId="card-row"
    />
  );
}

export { Price, VariantChip };
