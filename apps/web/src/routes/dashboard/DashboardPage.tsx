import { useQuery } from '@tanstack/react-query';
import { ShieldAlert } from 'lucide-react';
import { Link } from 'react-router';
import { PageHeader } from '@/components/PageHeader';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { useCan, useMe } from '@/features/auth/useAuth';
import { api } from '@/lib/api';

export function DashboardPage() {
  const { data } = useMe();
  const can = useCan();
  return (
    <div>
      <PageHeader title="Dashboard" description={data ? `Welcome, ${data.user.display_name}.` : undefined} />
      <div className="grid max-w-4xl grid-cols-1 gap-4 md:grid-cols-2">
        {can('changelog.view') && <UnreviewedCard />}
        <Card>
          <CardHeader>
            <CardTitle>More cards come later</CardTitle>
            <CardDescription>
              Today's sales, receipts, overdue customers and low stock appear here once the reports are built (phase 9).
            </CardDescription>
          </CardHeader>
          <CardContent className="text-sm text-muted-foreground">
            Press <kbd className="rounded border border-border px-1">?</kbd> to see the keyboard shortcuts.
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

/** Superuser: flagged changes nobody has reviewed yet (CLAUDE.md 10.6). */
function UnreviewedCard() {
  const count = useQuery({ queryKey: ['changelog', 'unreviewed-count'], queryFn: () => api.get<{ count: number }>('/api/changelog/unreviewed-count').then((r) => r.count) });
  const n = count.data ?? 0;
  return (
    <Card className={n > 0 ? 'border-amber-400' : undefined}>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <ShieldAlert className={n > 0 ? 'text-amber-600' : 'text-muted-foreground'} /> Flagged changes to review
        </CardTitle>
        <CardDescription>Edits after printing, on a later day, reduced totals, discounts above usual, sales below cost, voids…</CardDescription>
      </CardHeader>
      <CardContent className="flex items-end justify-between">
        <span className="text-4xl font-bold" aria-label="Unreviewed flagged changes">
          {count.isPending ? '…' : n}
        </span>
        <Link to="/change-history?flagged=1" className="text-primary hover:underline">
          Open Change History →
        </Link>
      </CardContent>
    </Card>
  );
}
