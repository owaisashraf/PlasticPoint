import { formatPaisa, type Asset } from '@shopledger/shared';
import { Plus } from 'lucide-react';
import { useState } from 'react';
import { useNavigate } from 'react-router';
import { PageHeader } from '@/components/PageHeader';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input, NativeSelect } from '@/components/ui/input';
import { AssetFormDialog } from '@/features/expenses/AssetDialogs';
import { CATEGORY_LABEL, useAssets } from '@/features/expenses/api';
import { errorMessage } from '@/lib/api';
import { todayKarachi } from '@/lib/utils';

export function AssetStatusBadge({ a }: { a: Pick<Asset, 'status'> }) {
  if (a.status === 'disposed') return <Badge variant="default">Disposed</Badge>;
  if (a.status === 'void') return <Badge variant="grey">VOID</Badge>;
  return null;
}

export function depreciationText(a: Asset): string {
  return a.depreciation_method === 'straight_line' ? `Straight line, ${a.useful_life_months} months` : 'None';
}

/** Asset register (CLAUDE.md 10.5), owner and superuser only. Book values as of any date. */
export function AssetsPage() {
  const navigate = useNavigate();
  const [asOf, setAsOf] = useState(todayKarachi());
  const [status, setStatus] = useState('all');
  const [adding, setAdding] = useState(false);
  const list = useAssets({ as_of: asOf, status });
  const rows = list.data?.assets ?? [];
  const totals = list.data?.totals;
  return (
    <div className="max-w-6xl">
      <PageHeader
        title="Assets"
        description="Things the business owns and uses for more than a year. Their depreciation reduces net profit."
        actions={
          <Button onClick={() => setAdding(true)}>
            <Plus /> Add asset
          </Button>
        }
      />
      <div className="mb-3 flex flex-wrap items-end gap-2">
        <label className="text-sm">
          Book values on <Input type="date" className="w-44" value={asOf} max={todayKarachi()} onChange={(e) => setAsOf(e.target.value || todayKarachi())} aria-label="Book values on" />
        </label>
        <NativeSelect className="w-40" value={status} onChange={(e) => setStatus(e.target.value)} aria-label="Status">
          <option value="all">All</option>
          <option value="active">In use</option>
          <option value="disposed">Disposed</option>
          <option value="void">Void</option>
        </NativeSelect>
      </div>
      {list.isError && <p className="text-destructive">{errorMessage(list.error)}</p>}
      <div className="overflow-x-auto rounded-lg border border-border bg-card">
        <table className="w-full text-[15px]">
          <thead className="bg-muted text-left text-sm text-muted-foreground">
            <tr>
              <th className="px-3 py-2">Asset</th>
              <th className="px-3 py-2">Type</th>
              <th className="px-3 py-2">Bought</th>
              <th className="px-3 py-2 text-right">Cost</th>
              <th className="px-3 py-2">Depreciation</th>
              <th className="px-3 py-2 text-right">Accumulated</th>
              <th className="px-3 py-2 text-right">Book value</th>
              <th className="px-3 py-2">Status</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((a) => (
              <tr key={a.id} className="cursor-pointer border-t border-border hover:bg-muted/60" tabIndex={0} onClick={() => navigate(`/assets/${a.id}`)} onKeyDown={(e) => e.key === 'Enter' && navigate(`/assets/${a.id}`)}>
                <td className="px-3 py-2">
                  <span className="font-semibold">{a.name}</span> <span className="font-mono text-sm text-muted-foreground">{a.doc_no}</span>
                </td>
                <td className="px-3 py-2">{CATEGORY_LABEL[a.category]}</td>
                <td className="px-3 py-2 whitespace-nowrap">{a.purchase_date}</td>
                <td className="amount px-3 py-2">{formatPaisa(a.cost_paisa)}</td>
                <td className="px-3 py-2 text-sm">{depreciationText(a)}</td>
                <td className="amount px-3 py-2">{formatPaisa(a.accumulated_depreciation_paisa)}</td>
                <td className="amount px-3 py-2 font-semibold">{formatPaisa(a.book_value_paisa)}</td>
                <td className="px-3 py-2">
                  <AssetStatusBadge a={a} />
                  {a.status === 'disposed' && <span className="ml-1 text-sm text-muted-foreground">{a.disposal_date}</span>}
                </td>
              </tr>
            ))}
            {list.data && rows.length === 0 && (
              <tr>
                <td colSpan={8} className="px-3 py-8 text-center text-muted-foreground">
                  No assets yet.
                </td>
              </tr>
            )}
          </tbody>
          {totals && rows.length > 0 && (
            <tfoot className="border-t-2 border-border font-semibold">
              <tr>
                <td className="px-3 py-2" colSpan={3}>
                  Held on {asOf}
                </td>
                <td className="amount px-3 py-2">{formatPaisa(totals.cost_paisa)}</td>
                <td />
                <td className="amount px-3 py-2">{formatPaisa(totals.accumulated_depreciation_paisa)}</td>
                <td className="amount px-3 py-2">{formatPaisa(totals.book_value_paisa)}</td>
                <td />
              </tr>
            </tfoot>
          )}
        </table>
      </div>
      {adding && <AssetFormDialog onClose={() => setAdding(false)} onSaved={(a) => navigate(`/assets/${a.id}`)} />}
    </div>
  );
}
