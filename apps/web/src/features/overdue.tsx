import { useQuery } from '@tanstack/react-query';
import { formatPaisa, overdueBand, type OverdueBand } from '@shopledger/shared';
import { usePublicSettings } from '@/features/customers/api';
import { api } from '@/lib/api';
import { cn } from '@/lib/utils';

export const OVERDUE_KEY = ['overdue'] as const;

/** Amber / orange / red by days overdue (thresholds from Settings). */
export function useOverdueBand(): (days: number) => OverdueBand {
  const s = usePublicSettings().data;
  return (days) => overdueBand(days, { overdue_amber_max_days: s?.overdue_amber_max_days ?? 15, overdue_orange_max_days: s?.overdue_orange_max_days ?? 45 });
}

export const BAND_BADGE: Record<OverdueBand, string> = {
  amber: 'bg-amber-100 text-amber-900',
  orange: 'bg-orange-200 text-orange-950',
  red: 'bg-red-600 text-white',
};

export const BAND_ROW: Record<OverdueBand, string> = {
  amber: 'bg-amber-50',
  orange: 'bg-orange-100/70',
  red: 'bg-red-100/70',
};

/** "Overdue Rs 45,000 · 23 days" (CLAUDE.md 10.1). Nothing when not overdue. */
export function OverdueBadge({ paisa, days, className }: { paisa?: number; days: number | null | undefined; className?: string }) {
  const band = useOverdueBand();
  if (!days || days <= 0) return null;
  return (
    <span className={cn('inline-flex items-center rounded px-1.5 py-0.5 text-xs font-semibold whitespace-nowrap', BAND_BADGE[band(days)], className)}>
      Overdue{paisa !== undefined ? ` ${formatPaisa(paisa)}` : ''} · {days} day{days === 1 ? '' : 's'}
    </span>
  );
}

/** Number of overdue customers for the menu badge; refreshed regularly so a new day is picked up. */
export function useOverdueCount(enabled: boolean) {
  return useQuery({
    queryKey: [...OVERDUE_KEY, 'count'],
    queryFn: () => api.get<{ count: number }>('/api/overdue/count').then((r) => r.count),
    enabled,
    refetchInterval: 10 * 60_000,
    refetchOnWindowFocus: true,
  });
}
