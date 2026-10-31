import { assetWebp } from '../lib/format';

/** Set logo (contain) or a 56×32 chip with the set id in micro mono. Never stretched, never a broken image. */
export function SetLogo({ set, large }: { set: { id: string; logoUrl: string | null }; large?: boolean }) {
  const logo = assetWebp(set.logoUrl);
  return (
    <span aria-hidden className={`flex shrink-0 items-center justify-center overflow-hidden rounded-xs bg-surface-3 ${large ? 'h-20 w-60 max-w-full' : 'h-8 w-14'}`}>
      {logo ? <img src={logo} alt="" loading="lazy" decoding="async" className="max-h-full max-w-full object-contain" onError={(e) => (e.currentTarget.style.display = 'none')} /> : <span className="font-mono text-micro font-normal text-fg-muted">{set.id}</span>}
    </span>
  );
}
