import { useQueryClient } from '@tanstack/react-query';
import { formatPaisa } from '@shopledger/shared';
import { ArrowLeft, Pencil, Trash } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { Link, useParams } from 'react-router';
import { FullPageMessage } from '@/components/FullPageMessage';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { useCan } from '@/features/auth/useAuth';
import { VoidButton } from '@/features/documents';
import { AssetFormDialog, DisposeAssetDialog } from '@/features/expenses/AssetDialogs';
import { ASSETS_KEY, CATEGORY_LABEL, useAsset } from '@/features/expenses/api';
import { errorMessage } from '@/lib/api';
import { cn, formatDateTime } from '@/lib/utils';
import { AssetStatusBadge, depreciationText } from './AssetsPage';

/** One asset: details, book value and its monthly depreciation schedule (CLAUDE.md 10.5). */
export function AssetDetailPage() {
  const id = Number(useParams().id);
  const can = useCan();
  const qc = useQueryClient();
  const { data: a, isPending, isError, error } = useAsset(id);
  const [dialog, setDialog] = useState<'edit' | 'dispose' | null>(null);

  if (isPending) return <p>Loading…</p>;
  if (isError) return <FullPageMessage inline title="Asset not found" detail={errorMessage(error)} />;

  const schedule = a.schedule ?? [];
  const gain = a.disposal_gain_paisa;
  const loss = gain !== null && gain < 0;
  return (
    <div className="max-w-5xl">
      <Link to="/assets" className="mb-2 inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
        <ArrowLeft className="size-4" /> Assets
      </Link>
      <div className="mb-5 flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="flex items-center gap-3 text-2xl font-bold">
            {a.name} <AssetStatusBadge a={a} />
          </h1>
          <p className="text-muted-foreground">
            {a.doc_no} · {CATEGORY_LABEL[a.category]} · entered by {a.created_by_name ?? '—'} on {formatDateTime(a.created_at)}
            {a.version > 1 ? ` · version ${a.version}` : ''}
          </p>
        </div>
        {a.status !== 'void' && (
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" onClick={() => setDialog('edit')}>
              <Pencil /> Edit
            </Button>
            {a.status === 'active' && (
              <Button variant="outline" onClick={() => setDialog('dispose')}>
                <Trash /> Dispose
              </Button>
            )}
            {can('documents.edit_any') && <VoidButton url={`/api/assets/${a.id}/void`} docNo={a.doc_no} onDone={() => void qc.invalidateQueries({ queryKey: ASSETS_KEY })} />}
          </div>
        )}
      </div>

      <div className="mb-5 grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat k="Cost">{formatPaisa(a.cost_paisa)}</Stat>
        <Stat k={`Depreciated to ${a.as_of}`}>{formatPaisa(a.accumulated_depreciation_paisa)}</Stat>
        <Stat k="Book value">{formatPaisa(a.book_value_paisa)}</Stat>
        {a.status === 'disposed' ? (
          <Stat k={loss ? 'Loss on disposal' : 'Gain on disposal'}>
            <span className={loss ? 'text-destructive' : 'text-green-800'}>{formatPaisa(Math.abs(gain ?? 0))}</span>
          </Stat>
        ) : (
          <Stat k="Monthly depreciation">{a.monthly_depreciation_paisa ? formatPaisa(a.monthly_depreciation_paisa) : '—'}</Stat>
        )}
      </div>

      <Card className="mb-5">
        <CardContent className="grid grid-cols-1 gap-x-8 gap-y-2 pt-5 md:grid-cols-2">
          <Row k="Bought on">{a.purchase_date}</Row>
          <Row k="Paid by">{a.method === 'cash' ? 'Cash' : 'Bank'}</Row>
          <Row k="Bought from">{a.vendor}</Row>
          <Row k="Depreciation">{depreciationText(a)}</Row>
          <Row k="Salvage value">{formatPaisa(a.salvage_value_paisa)}</Row>
          <Row k="Notes">{a.notes}</Row>
          {a.status === 'disposed' && (
            <>
              <Row k="Disposed on">{a.disposal_date}</Row>
              <Row k="Amount received">
                {formatPaisa(a.disposal_amount_paisa ?? 0)} ({a.disposal_method === 'bank' ? 'bank' : 'cash'})
              </Row>
              <Row k="Reason">{a.disposal_reason}</Row>
            </>
          )}
        </CardContent>
      </Card>

      {schedule.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>Depreciation schedule</CardTitle>
          </CardHeader>
          <CardContent>
            <table className="w-full text-[15px]">
              <thead className="text-left text-sm text-muted-foreground">
                <tr>
                  <th className="py-1">Month</th>
                  <th className="text-right">Charge</th>
                  <th className="text-right">Accumulated</th>
                  <th className="text-right">Book value</th>
                </tr>
              </thead>
              <tbody>
                {schedule.map((r) => (
                  <tr key={r.month} className={cn('border-t border-border', r.charge_date > a.as_of && 'text-muted-foreground')}>
                    <td className="py-1">{r.month}</td>
                    <td className="amount">{formatPaisa(r.charge_paisa)}</td>
                    <td className="amount">{formatPaisa(r.accumulated_paisa)}</td>
                    <td className="amount">{formatPaisa(r.book_value_paisa)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="mt-2 text-sm text-muted-foreground">Each month is charged on its last day. Greyed months are still to come.</p>
          </CardContent>
        </Card>
      )}

      {dialog === 'edit' && <AssetFormDialog asset={a} onClose={() => setDialog(null)} />}
      {dialog === 'dispose' && <DisposeAssetDialog asset={a} onClose={() => setDialog(null)} />}
    </div>
  );
}

function Stat({ k, children }: { k: string; children: ReactNode }) {
  return (
    <Card>
      <CardContent className="pt-4">
        <div className="text-sm text-muted-foreground">{k}</div>
        <div className="amount text-left text-xl font-bold">{children}</div>
      </CardContent>
    </Card>
  );
}

function Row({ k, children }: { k: string; children: ReactNode }) {
  return (
    <div className="flex gap-3 border-b border-border py-1.5">
      <dt className="w-36 shrink-0 text-muted-foreground">{k}</dt>
      <dd>{children || '—'}</dd>
    </div>
  );
}
