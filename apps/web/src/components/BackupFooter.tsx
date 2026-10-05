import { useQuery } from '@tanstack/react-query';
import type { BackupStatus } from '@shopledger/shared';
import { api } from '@/lib/api';
import { cn, formatDateTime } from '@/lib/utils';

export const BACKUP_STATUS_KEY = ['backup-status'] as const;

/** "Last backup: …" — red when older than 36 hours or the latest attempt failed. */
export function BackupFooter() {
  const { data } = useQuery({
    queryKey: BACKUP_STATUS_KEY,
    queryFn: () => api.get<BackupStatus>('/api/backups/status'),
    refetchInterval: 5 * 60_000,
  });
  if (!data) return <span />;
  const bad = data.stale || data.last_failed_at !== null;
  return (
    <span className={cn(bad ? 'font-semibold text-destructive' : 'text-muted-foreground')}>
      Last backup: {data.last_ok_at ? formatDateTime(data.last_ok_at) : 'never'}
      {data.last_failed_at && ` · Last backup attempt FAILED (${data.last_error ?? 'unknown error'}). Tell the owner.`}
      {!data.last_failed_at && data.stale && ' · Backup is overdue'}
    </span>
  );
}
