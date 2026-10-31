import { useEffect, useRef, useState } from 'react';

export function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

/** Skeletons appear only after `ms` (UX §0.10 / §12): local reads are usually faster. */
export function useDelayedFlag(active: boolean, ms = 150): boolean {
  const [shown, setShown] = useState(false);
  useEffect(() => {
    if (!active) {
      const reset = setTimeout(() => setShown(false), 0);
      return () => clearTimeout(reset);
    }
    const t = setTimeout(() => setShown(true), ms);
    return () => clearTimeout(t);
  }, [active, ms]);
  return active && shown;
}

/** Intersection sentinel for infinite scroll (rootMargin 600px). */
export function useSentinel(onVisible: () => void, enabled: boolean) {
  const ref = useRef<HTMLDivElement | null>(null);
  const cb = useRef(onVisible);
  useEffect(() => {
    cb.current = onVisible;
  });
  useEffect(() => {
    const el = ref.current;
    if (!el || !enabled) return;
    const io = new IntersectionObserver((entries) => entries.some((e) => e.isIntersecting) && cb.current(), { rootMargin: '600px' });
    io.observe(el);
    return () => io.disconnect();
  }, [enabled]);
  return ref;
}

export function useMediaQuery(query: string): boolean {
  const [m, setM] = useState(() => (typeof window === 'undefined' ? false : window.matchMedia(query).matches));
  useEffect(() => {
    const mq = window.matchMedia(query);
    const on = () => setM(mq.matches);
    on();
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, [query]);
  return m;
}
export const useIsWide = (): boolean => useMediaQuery('(min-width: 1024px)');
