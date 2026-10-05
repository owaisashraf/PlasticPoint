import { useMutation } from '@tanstack/react-query';
import type { AuditVerifyResult } from '@shopledger/shared';
import { ShieldCheck, ShieldAlert } from 'lucide-react';
import { PageHeader } from '@/components/PageHeader';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { api, errorMessage } from '@/lib/api';

/** Superuser only. The full change history arrives in phase 7; integrity checking works now. */
export function ChangeHistoryPage() {
  const verify = useMutation({ mutationFn: () => api.get<AuditVerifyResult>('/api/audit/verify') });
  const r = verify.data;

  return (
    <div>
      <PageHeader
        title="Change History"
        description="The list of every change, with differences, comes in phase 7."
        actions={
          <Button onClick={() => verify.mutate()} disabled={verify.isPending}>
            <ShieldCheck /> {verify.isPending ? 'Checking…' : 'Verify integrity'}
          </Button>
        }
      />
      {verify.isError && <p className="font-medium text-destructive">{errorMessage(verify.error)}</p>}
      {r && (
        <Card className={r.ok ? 'max-w-2xl border-green-600' : 'max-w-2xl border-destructive'}>
          <CardHeader>
            <CardTitle className={r.ok ? 'flex items-center gap-2 text-success' : 'flex items-center gap-2 text-destructive'}>
              {r.ok ? <ShieldCheck /> : <ShieldAlert />}
              {r.ok ? 'The audit log is intact' : 'The audit log has been tampered with'}
            </CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-2 text-[15px]">
            <p>{r.rows_checked} rows checked.</p>
            {r.last_hash && (
              <p className="break-all font-mono text-xs text-muted-foreground">
                Last row {r.last_id}: {r.last_hash}
              </p>
            )}
            {r.problems.length > 0 && (
              <ul className="list-disc pl-5 text-destructive">
                {r.problems.map((p) => (
                  <li key={p}>{p}</li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}
