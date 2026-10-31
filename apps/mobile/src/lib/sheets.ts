import { useNavigate, useRouter } from '@tanstack/react-router';
import { canGoBack } from '../components/page';

/** Sheets are history entries (UX §1.5): open = push a search param, close = history.back() (or replace if cold-started). */
export function useSheetParam<K extends string = 'sheet'>(key: K = 'sheet' as K) {
  const router = useRouter();
  const navigate = useNavigate();
  const open = (value: string, extra?: Record<string, unknown>) =>
    void navigate({ to: '.', search: ((prev: Record<string, unknown>) => ({ ...prev, ...extra, [key]: value })) as never });
  const close = () => {
    if (canGoBack()) router.history.back();
    else void navigate({ to: '.', replace: true, search: ((prev: Record<string, unknown>) => ({ ...prev, [key]: undefined })) as never });
  };
  return { open, close };
}

/** Replace search params without adding history entries (filters, query text). */
export function useSetSearch() {
  const navigate = useNavigate();
  return (patch: Record<string, unknown>, opts: { replace?: boolean } = { replace: true }) =>
    void navigate({ to: '.', replace: opts.replace, search: ((prev: Record<string, unknown>) => ({ ...prev, ...patch })) as never });
}
