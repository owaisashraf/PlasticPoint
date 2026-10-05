import { formatPaisa, type Customer } from '@shopledger/shared';
import { cn } from '@/lib/utils';
import { Badge } from './ui/badge';

export function CustomerStatusBadge({ status }: { status: Customer['status'] }) {
  if (status === 'bad_debt') return <Badge variant="danger">Bad debt</Badge>;
  if (status === 'inactive') return <Badge variant="grey">Inactive</Badge>;
  return null;
}

/** "Rs 45,000" owed, or "Advance Rs 2,000" in blue for negative balances. */
export function Balance({ paisa, className }: { paisa: number; className?: string }) {
  if (paisa < 0) return <span className={cn('amount font-semibold text-blue-700', className)}>Advance {formatPaisa(-paisa)}</span>;
  return <span className={cn('amount', paisa > 0 && 'font-semibold', className)}>{formatPaisa(paisa)}</span>;
}

export function ActiveBadge({ active }: { active: boolean }) {
  return active ? null : <Badge variant="grey">Inactive</Badge>;
}
