import { formatPaisa } from '@shopledger/shared';
import { useState } from 'react';
import { useNavigate } from 'react-router';
import { CustomerStatusBadge } from '@/components/badges';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { errorMessage } from '@/lib/api';
import { cn } from '@/lib/utils';
import { OverdueBadge } from '@/features/overdue';
import { useSales } from './api';

/** Sales with search and date filters. With `customerId`, only that customer's invoices. */
export function SalesTable({ customerId }: { customerId?: number }) {
  const navigate = useNavigate();
  const [q, setQ] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [limit, setLimit] = useState(100);
  const list = useSales({ q: q.trim(), from, to, customer_id: customerId, limit });
  const rows = list.data?.sales ?? [];
  const showProfit = rows.some((s) => s.profit_paisa !== undefined);
  const cols = (customerId ? 8 : 9) + (showProfit ? 1 : 0);
  return (
    <div>
      <div className="mb-3 flex flex-wrap items-end gap-2">
        <Input
          className="w-72"
          placeholder={customerId ? 'Invoice no.' : 'Invoice no., customer, code or city'}
          value={q}
          onChange={(e) => setQ(e.target.value)}
          aria-label="Search sales"
        />
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
              <th className="px-3 py-2">Invoice</th>
              {!customerId && <th className="px-3 py-2">Customer</th>}
              <th className="px-3 py-2 text-right">Qty</th>
              <th className="px-3 py-2 text-right">Total</th>
              <th className="px-3 py-2 text-right">Paid</th>
              <th className="px-3 py-2 text-right">Outstanding</th>
              <th className="px-3 py-2">Due</th>
              {showProfit && <th className="px-3 py-2 text-right">Profit</th>}
              <th className="px-3 py-2">Entered by</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((s) => (
              <tr
                key={s.id}
                className="cursor-pointer border-t border-border hover:bg-muted/60"
                tabIndex={0}
                onClick={() => navigate(`/sales/${s.id}`)}
                onKeyDown={(e) => e.key === 'Enter' && navigate(`/sales/${s.id}`)}
              >
                <td className="px-3 py-2 whitespace-nowrap">{s.date}</td>
                <td className="px-3 py-2 font-mono font-semibold">
                  {s.doc_no} {s.status === 'void' && <Badge variant="grey">VOID</Badge>}
                </td>
                {!customerId && (
                  <td className="px-3 py-2">
                    {s.customer_name} <span className="text-sm text-muted-foreground">{s.customer_code}</span> <CustomerStatusBadge status={s.customer_status} />
                  </td>
                )}
                <td className="amount px-3 py-2">{s.total_qty}</td>
                <td className="amount px-3 py-2 font-semibold">{formatPaisa(s.total_paisa)}</td>
                <td className="amount px-3 py-2">{s.paid_paisa ? formatPaisa(s.paid_paisa) : '—'}</td>
                <td className="amount px-3 py-2">
                  {s.outstanding_paisa ? formatPaisa(s.outstanding_paisa) : <Badge variant="success">Paid</Badge>}
                  <OverdueBadge days={s.days_overdue} className="ml-1" />
                </td>
                <td className="px-3 py-2 whitespace-nowrap">{s.due_date}</td>
                {showProfit && (
                  <td className={cn('amount px-3 py-2', (s.profit_paisa ?? 0) < 0 && 'font-semibold text-destructive')}>{formatPaisa(s.profit_paisa ?? 0)}</td>
                )}
                <td className="px-3 py-2 text-sm text-muted-foreground">{s.created_by_name}</td>
              </tr>
            ))}
            {list.data && rows.length === 0 && (
              <tr>
                <td colSpan={cols} className="px-3 py-8 text-center text-muted-foreground">
                  No sales found.
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
