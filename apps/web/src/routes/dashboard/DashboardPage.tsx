import { useQuery } from '@tanstack/react-query';
import { formatPaisa, type Dashboard } from '@shopledger/shared';
import { ShieldAlert } from 'lucide-react';
import { lazy, Suspense, type ReactNode } from 'react';
import { Link } from 'react-router';
import { ErrorBoundary } from '@/components/ErrorBoundary';
import { PageHeader } from '@/components/PageHeader';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { useCan, useMe } from '@/features/auth/useAuth';
import { api } from '@/lib/api';
import { cn } from '@/lib/utils';

// Charts are only loaded when the owner's dashboard needs them (CLAUDE.md section 3).
const ProfitTrendChart = lazy(() => import('./ProfitTrendChart'));

export function DashboardPage() {
  const { data: me } = useMe();
  const can = useCan();
  const d = useQuery({ queryKey: ['dashboard'], queryFn: () => api.get<Dashboard>('/api/dashboard'), refetchInterval: 5 * 60_000 });
  const x = d.data;
  return (
    <div className="max-w-6xl">
      <PageHeader title="Dashboard" description={me ? `Welcome, ${me.user.display_name}.` : undefined} />
      {x && (
        <>
          <div className="mb-4 grid grid-cols-2 gap-3 md:grid-cols-4">
            <Tile label="Sales today" to="/sales">
              {formatPaisa(x.sales_today_paisa)} <span className="text-base font-normal text-muted-foreground">({x.sales_today_count})</span>
            </Tile>
            <Tile label="Received today" to="/payments">
              {formatPaisa(x.receipts_today_paisa)}
            </Tile>
            <Tile label="Overdue customers" to="/overdue" warn={x.overdue_customers > 0}>
              {x.overdue_customers}
            </Tile>
            <Tile label="Low stock items" to="/reports/stock-on-hand" warn={x.low_stock_count > 0}>
              {x.low_stock_count}
            </Tile>
          </div>
          {x.profit_trend && (
            <>
              <div className="mb-4 grid grid-cols-2 gap-3 md:grid-cols-4">
                <Tile label="Profit today" to="/reports/gross-profit" money={x.profit_today_paisa}>
                  {formatPaisa(x.profit_today_paisa ?? 0)}
                </Tile>
                <Tile label="Profit this month" to="/reports/gross-profit" money={x.profit_month_paisa}>
                  {formatPaisa(x.profit_month_paisa ?? 0)}
                </Tile>
                <Tile label={`Net profit ${x.fiscal_year_label ?? ''} so far`} to="/reports/profit-loss" money={x.net_profit_fy_paisa}>
                  {formatPaisa(x.net_profit_fy_paisa ?? 0)}
                </Tile>
                <Tile label="Expenses this month" to="/expenses">
                  {formatPaisa(x.month_expenses_paisa ?? 0)}
                </Tile>
              </div>
              <Card className="mb-4">
                <CardHeader>
                  <CardTitle>Profit, last 12 months</CardTitle>
                </CardHeader>
                <CardContent className="h-72">
                  <ErrorBoundary fallback={<p className="text-muted-foreground">The chart could not be drawn. The figures above are still correct.</p>}>
                    <Suspense fallback={<p className="text-muted-foreground">Loading chart…</p>}>
                      <ProfitTrendChart trend={x.profit_trend} />
                    </Suspense>
                  </ErrorBoundary>
                </CardContent>
              </Card>
            </>
          )}
        </>
      )}
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">{can('changelog.view') && <UnreviewedCard />}</div>
      <p className="mt-4 text-sm text-muted-foreground">
        Press <kbd className="rounded border border-border px-1">?</kbd> to see the keyboard shortcuts.
      </p>
    </div>
  );
}

function Tile({ label, to, children, warn, money }: { label: string; to: string; children: ReactNode; warn?: boolean; money?: number }) {
  return (
    <Link to={to} className="block">
      <Card className={cn('h-full hover:border-primary', warn && 'border-amber-400')}>
        <CardContent className="pt-4">
          <div className="text-sm text-muted-foreground">{label}</div>
          <div className={cn('amount text-left text-2xl font-bold', money !== undefined && money < 0 && 'text-destructive', warn && 'text-amber-700')}>{children}</div>
        </CardContent>
      </Card>
    </Link>
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
