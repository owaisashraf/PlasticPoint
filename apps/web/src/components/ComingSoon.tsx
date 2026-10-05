import { Construction } from 'lucide-react';
import { PageHeader } from './PageHeader';

export function ComingSoon({ title, phase }: { title: string; phase: number }) {
  return (
    <div>
      <PageHeader title={title} />
      <div className="flex flex-col items-center gap-3 rounded-lg border border-dashed border-border bg-card py-20 text-center text-muted-foreground">
        <Construction className="size-10" />
        <p className="text-base">This screen is not built yet.</p>
        <p className="text-sm">It is planned for phase {phase}.</p>
      </div>
    </div>
  );
}
