import { PageHeader } from '@/components/PageHeader';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { useMe } from '@/features/auth/useAuth';

export function DashboardPage() {
  const { data } = useMe();
  return (
    <div>
      <PageHeader title="Dashboard" description={data ? `Welcome, ${data.user.display_name}.` : undefined} />
      <Card className="max-w-xl">
        <CardHeader>
          <CardTitle>Dashboard cards come later</CardTitle>
          <CardDescription>
            Today's sales, receipts, overdue customers and low stock appear here once those screens are built (phase 9).
          </CardDescription>
        </CardHeader>
        <CardContent className="text-sm text-muted-foreground">
          Press <kbd className="rounded border border-border px-1">?</kbd> to see the keyboard shortcuts.
        </CardContent>
      </Card>
    </div>
  );
}
