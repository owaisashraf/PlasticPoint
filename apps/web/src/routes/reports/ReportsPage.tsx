import { REPORTS, type ReportDef } from '@shopledger/shared';
import { ArrowLeft, ChartColumn, FileText, Users } from 'lucide-react';
import { Link, useNavigate, useParams } from 'react-router';
import { FullPageMessage } from '@/components/FullPageMessage';
import { PageHeader } from '@/components/PageHeader';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { useCan } from '@/features/auth/useAuth';
import { ReportView } from '@/features/reports/ReportView';

const GROUPS: { id: ReportDef['group']; title: string; icon: typeof Users }[] = [
  { id: 'customer', title: 'Customers', icon: Users },
  { id: 'operational', title: 'Day to day', icon: FileText },
  { id: 'financial', title: 'Profit and money (owner)', icon: ChartColumn },
];

/** Links that live elsewhere in the app but belong in the catalogue (CLAUDE.md 11). */
const ELSEWHERE: Record<ReportDef['group'], { title: string; description: string; to: string }[]> = {
  customer: [
    { title: 'Customer statement', description: 'Open a customer → Ledger → Statement PDF.', to: '/customers' },
    { title: 'Overdue report', description: 'The Overdue tab → Print / PDF.', to: '/overdue' },
  ],
  operational: [{ title: 'Supplier statement', description: 'Purchases → Supplier → Statement PDF.', to: '/purchases' }],
  financial: [],
};

/** The report catalogue (CLAUDE.md 11). Only reports the user may open are listed. */
export function ReportsPage() {
  const can = useCan();
  const navigate = useNavigate();
  return (
    <div className="max-w-6xl">
      <PageHeader title="Reports" description="Every report can be shown here, printed or saved as PDF, or exported to CSV." />
      <div className="flex flex-col gap-6">
        {GROUPS.map((g) => {
          const list = REPORTS.filter((r) => r.group === g.id && can(r.permission));
          if (!list.length) return null;
          return (
            <section key={g.id}>
              <h2 className="mb-2 flex items-center gap-2 text-lg font-semibold">
                <g.icon className="size-5" /> {g.title}
              </h2>
              <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
                {list.map((r) => (
                  <Card key={r.key} className="cursor-pointer hover:border-primary" tabIndex={0} role="link" onClick={() => navigate(`/reports/${r.key}`)} onKeyDown={(e) => e.key === 'Enter' && navigate(`/reports/${r.key}`)}>
                    <CardHeader>
                      <CardTitle className="text-base">{r.title}</CardTitle>
                    </CardHeader>
                    <CardContent className="text-sm text-muted-foreground">{r.description}</CardContent>
                  </Card>
                ))}
                {ELSEWHERE[g.id].map((e) => (
                  <Card key={e.title} className="cursor-pointer border-dashed hover:border-primary" tabIndex={0} role="link" onClick={() => navigate(e.to)} onKeyDown={(ev) => ev.key === 'Enter' && navigate(e.to)}>
                    <CardHeader>
                      <CardTitle className="text-base">{e.title}</CardTitle>
                    </CardHeader>
                    <CardContent className="text-sm text-muted-foreground">{e.description}</CardContent>
                  </Card>
                ))}
              </div>
            </section>
          );
        })}
      </div>
    </div>
  );
}

/** /reports/:key — one report. */
export function ReportPage() {
  const key = useParams().key;
  const can = useCan();
  const def = REPORTS.find((r) => r.key === key);
  if (!def) return <FullPageMessage inline title="Report not found" detail="Pick a report from the list." />;
  if (!can(def.permission)) return <FullPageMessage inline title="Not available" detail="This report is for the owner." />;
  return (
    <div>
      <Link to="/reports" className="mb-2 inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
        <ArrowLeft className="size-4" /> Reports
      </Link>
      <PageHeader title={def.title} description={def.description} />
      <ReportView key={def.key} def={def} />
    </div>
  );
}
