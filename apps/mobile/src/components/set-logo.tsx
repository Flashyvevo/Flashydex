import { useEffect, useRef, useState } from 'react';
import { useSetCover } from '../data';
import { assetWebp, imageUrl, type Language } from '../lib/format';

type ArtSet = { id: string; language: Language; name?: string; logoUrl: string | null; symbolUrl?: string | null };
type Tier = 'logo' | 'symbol' | 'cover';

/** True once the element has been within ~200px of the viewport (sticky). Without IntersectionObserver (tests) it is immediately true. */
function useNearViewport() {
  const ref = useRef<HTMLSpanElement | null>(null);
  const [near, setNear] = useState(() => typeof IntersectionObserver === 'undefined');
  useEffect(() => {
    const el = ref.current;
    if (near || !el) return;
    const io = new IntersectionObserver((entries) => entries.some((e) => e.isIntersecting) && setNear(true), { rootMargin: '200px' });
    io.observe(el);
    return () => io.disconnect();
  }, [near]);
  return { ref, near };
}

/**
 * Set art tile, never blank and never a broken image. Precedence: logo (contain) -> symbol (centered, smaller) -> cover card
 * (first card of the set with art, `low.webp`, object-cover, top-biased so the illustration shows) -> the set-id chip.
 * An `<img>` error advances to the next tier. The box is a fixed size (56×32, or 240×80 `large`) so nothing shifts while
 * tiers resolve. `showName` overlays the set name on a cover card for layouts with no adjacent name.
 */
export function SetLogo({ set, large, showName }: { set: ArtSet; large?: boolean; showName?: boolean }) {
  const [failed, setFailed] = useState<readonly Tier[]>([]);
  const { ref, near } = useNearViewport();
  const logo = assetWebp(set.logoUrl);
  const symbol = assetWebp(set.symbolUrl ?? null);
  const logoOk = !!logo && !failed.includes('logo');
  const symbolOk = !logoOk && !!symbol && !failed.includes('symbol');
  // The cover is only looked up once the tile is near the screen and no logo/symbol tier is left to try.
  const wantCover = near && !logoOk && !symbolOk;
  const cover = useSetCover(set.language, set.id, wantCover);
  const coverSrc = imageUrl(cover.data ?? null, 'low');
  const coverOk = wantCover && !!coverSrc && !failed.includes('cover');
  const resolving = wantCover ? cover.isPending : !near && !logoOk && !symbolOk;
  const tier: Tier | 'chip' | 'loading' = logoOk ? 'logo' : symbolOk ? 'symbol' : coverOk ? 'cover' : resolving ? 'loading' : 'chip';
  const fail = (t: Tier) => setFailed((f) => (f.includes(t) ? f : [...f, t]));

  return (
    <span
      ref={ref}
      aria-hidden
      data-testid="set-art"
      data-tier={tier}
      className={`relative flex shrink-0 items-center justify-center overflow-hidden rounded-xs bg-surface-3 ${large ? 'h-20 w-60 max-w-full' : 'h-8 w-14'}`}
    >
      {tier === 'logo' && <img src={logo!} alt="" loading="lazy" decoding="async" className="max-h-full max-w-full object-contain" onError={() => fail('logo')} />}
      {tier === 'symbol' && <img src={symbol!} alt="" loading="lazy" decoding="async" className="max-h-3/4 max-w-3/5 object-contain" onError={() => fail('symbol')} />}
      {tier === 'cover' && (
        <>
          <img src={coverSrc!} alt="" loading="lazy" decoding="async" className="absolute inset-0 size-full object-cover" style={{ objectPosition: '50% 20%' }} onError={() => fail('cover')} />
          <span className="absolute inset-0 bg-linear-to-t from-black/45 to-transparent" />
          {showName && set.name && <span className="absolute inset-x-1 bottom-0.5 truncate text-micro font-medium leading-tight text-white">{set.name}</span>}
        </>
      )}
      {tier === 'chip' && <span className="font-mono text-micro font-normal text-fg-muted">{set.id}</span>}
    </span>
  );
}
