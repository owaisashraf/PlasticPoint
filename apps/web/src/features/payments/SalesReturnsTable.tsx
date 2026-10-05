import { formatPaisa } from '@shopledger/shared';
import { useState } from 'react';
import { useNavigate } from 'react-router';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { errorMessage } from '@/lib/api';
import { useSalesReturns } from './api';

/** Sales returns (credit notes). Clicking a row opens the original invoice. */
export function SalesReturnsTable({ customerId }: { customerId?: number }) {
  const navigate = useNavigate();
  const [q, setQ] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [limit, setLimit] = useState(100);
  const list = useSalesReturns({ q: q.trim(), from, to, customer_id: customerId, limit });
  const rows = list.data?.returns ?? [];
  const showProfit = rows.some((r) => r.profit_reversed_paisa !== undefined);
  return (
    <div>
      <div className="mb-3 flex flex-wrap items-end gap-2">
        <Input className="w-72" placeholder="Return or invoice no., customer" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search sales returns" />
        <label className="text-sm">
          From <Input type="date" className="w-44" value={from} onChange={(e) => setFrom(e.target.value)} />
        </label>
        <label className="text-sm">
          To <Input type="date" className="w-44" value={to} onChange={(e) => setTo(e.target.value)} />
        </label>
      </div>
      {list.isError && <p className="text-destructive">{errorMessage(list.error)}</p>}
      <div className="overflow-x-auto rounded-lg border border-border bg-card">
        <table className="w-full text-[15px]">
          <thead className="bg-muted text-left text-sm text-muted-foreground">
            <tr>
              <th className="px-3 py-2">Date</th>
              <th className="px-3 py-2">Return</th>
              <th className="px-3 py-2">Invoice</th>
              {!customerId && <th className="px-3 py-2">Customer</th>}
              <th className="px-3 py-2">Reason</th>
              <th className="px-3 py-2 text-right">Qty</th>
              <th className="px-3 py-2 text-right">Credit</th>
              <th className="px-3 py-2 text-right">Refunded</th>
              {showProfit && <th className="px-3 py-2 text-right">Profit reversed</th>}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr
                key={r.id}
                className="cursor-pointer border-t border-border hover:bg-muted/60"
                tabIndex={0}
                onClick={() => navigate(`/sales/${r.sale_id}`)}
                onKeyDown={(e) => e.key === 'Enter' && navigate(`/sales/${r.sale_id}`)}
              >
                <td className="px-3 py-2 whitespace-nowrap">{r.date}</td>
                <td className="px-3 py-2 font-mono font-semibold">
                  {r.doc_no} {r.status === 'void' && <Badge variant="grey">VOID</Badge>}
                </td>
                <td className="px-3 py-2 font-mono">{r.sale_doc_no}</td>
                {!customerId && (
                  <td className="px-3 py-2">
                    {r.customer_name} <span className="text-sm text-muted-foreground">{r.customer_code}</span>
                  </td>
                )}
                <td className="px-3 py-2">{r.reason}</td>
                <td className="amount px-3 py-2">{r.total_qty}</td>
                <td className="amount px-3 py-2 font-semibold">{formatPaisa(r.total_paisa)}</td>
                <td className="amount px-3 py-2">{r.refunded_paisa ? formatPaisa(r.refunded_paisa) : ''}</td>
                {showProfit && <td className="amount px-3 py-2">{formatPaisa(r.profit_reversed_paisa ?? 0)}</td>}
              </tr>
            ))}
            {list.data && rows.length === 0 && (
              <tr>
                <td colSpan={9} className="px-3 py-8 text-center text-muted-foreground">
                  No returns.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      {list.data && list.data.total > rows.length && (
        <Button className="mt-3" variant="outline" size="sm" onClick={() => setLimit((l) => l + 100)}>
          Show more ({rows.length} of {list.data.total})
        </Button>
      )}
    </div>
  );
}
