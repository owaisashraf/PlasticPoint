import { useQuery } from '@tanstack/react-query';
import { formatPaisa, formatPhone, type Customer, type OverdueList, type OverdueRow } from '@shopledger/shared';
import { ChevronDown, ChevronRight, FileDown, FileText, HandCoins, MessageCircle, Printer } from 'lucide-react';
import { Fragment, useState } from 'react';
import { Link } from 'react-router';
import { toast } from 'sonner';
import { Balance, CustomerStatusBadge } from '@/components/badges';
import { PageHeader } from '@/components/PageHeader';
import { Button } from '@/components/ui/button';
import { Input, NativeSelect } from '@/components/ui/input';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useCan } from '@/features/auth/useAuth';
import { useCities } from '@/features/customers/api';
import { BAND_BADGE, BAND_ROW, OVERDUE_KEY, useOverdueBand } from '@/features/overdue';
import { openStatement } from '@/features/payments/api';
import { ReceivePaymentDialog } from '@/features/payments/ReceivePaymentDialog';
import { api, errorMessage } from '@/lib/api';
import { cn } from '@/lib/utils';

function qs(f: Record<string, string | number | undefined>): string {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(f)) if (v !== undefined && v !== '') p.set(k, String(v));
  return p.toString();
}

/**
 * Overdue tab (CLAUDE.md 10.3): every customer with at least one overdue
 * invoice, most days overdue first, coloured amber / orange / red. Bad-debt
 * customers have their own sub-tab.
 */
export function OverduePage() {
  const can = useCan();
  const band = useOverdueBand();
  const cities = useCities();
  const [tab, setTab] = useState<'overdue' | 'bad_debt'>('overdue');
  const [q, setQ] = useState('');
  const [type, setType] = useState('');
  const [city, setCity] = useState('');
  const [minDays, setMinDays] = useState('');
  const [includeBad, setIncludeBad] = useState(false);
  const [open, setOpen] = useState<Set<number>>(new Set());
  const [paying, setPaying] = useState<Customer | null>(null);

  const filters = {
    q: q.trim() || undefined,
    type: type || undefined,
    city: city || undefined,
    min_days: minDays ? Number(minDays) : undefined,
    bad_debt: tab === 'bad_debt' ? 'only' : includeBad ? 'include' : 'exclude',
  };
  const query = qs({ ...filters });
  const list = useQuery({
    queryKey: [...OVERDUE_KEY, 'list', query],
    queryFn: () => api.get<OverdueList>(`/api/overdue?${query}`),
    placeholderData: (prev) => prev,
  });
  const rows = list.data?.rows ?? [];

  const toggle = (id: number) =>
    setOpen((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });

  const recordPayment = async (r: OverdueRow) => {
    try {
      setPaying((await api.get<{ customer: Customer }>(`/api/customers/${r.customer_id}`)).customer);
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };

  return (
    <div>
      <PageHeader
        title="Overdue"
        description={list.data ? `As of ${list.data.as_of}. Sorted by the longest wait.` : undefined}
        actions={
          <>
            <Button variant="outline" onClick={() => window.open(`/api/overdue/report.pdf?${query}`, '_blank')}>
              <Printer /> Print / PDF
            </Button>
            <Button variant="outline" asChild>
              <a href={`/api/overdue/export.csv?${query}`} download>
                <FileDown /> Export CSV
              </a>
            </Button>
          </>
        }
      />
      <Tabs value={tab} onValueChange={(v) => setTab(v as typeof tab)}>
        <TabsList>
          <TabsTrigger value="overdue">Overdue customers</TabsTrigger>
          <TabsTrigger value="bad_debt">Bad debt</TabsTrigger>
        </TabsList>
      </Tabs>

      <div className="my-3 flex flex-wrap items-end gap-2">
        <Input className="w-64" placeholder="Name, shop, phone, city or code" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search overdue customers" />
        <NativeSelect className="w-40" value={type} onChange={(e) => setType(e.target.value)} aria-label="Customer type">
          <option value="">All types</option>
          <option value="wholesaler">Wholesalers</option>
          <option value="retailer">Retailers</option>
        </NativeSelect>
        <NativeSelect className="w-40" value={city} onChange={(e) => setCity(e.target.value)} aria-label="City">
          <option value="">All cities</option>
          {(cities.data ?? []).map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </NativeSelect>
        <label className="text-sm">
          At least{' '}
          <Input className="inline-block w-20 text-right" inputMode="numeric" value={minDays} onChange={(e) => setMinDays(e.target.value.replace(/\D/g, ''))} aria-label="Minimum days overdue" /> days
        </label>
        {tab === 'overdue' && (
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={includeBad} onChange={(e) => setIncludeBad(e.target.checked)} /> Include bad-debt customers
          </label>
        )}
      </div>

      {list.isError && <p className="text-destructive">{errorMessage(list.error)}</p>}
      <div className="overflow-x-auto rounded-lg border border-border bg-card">
        <table className="w-full text-[15px]">
          <thead className="bg-muted text-left text-sm text-muted-foreground">
            <tr>
              <th className="w-8" />
              <th className="px-3 py-2">Customer</th>
              <th className="px-3 py-2">Phone</th>
              <th className="px-3 py-2">City</th>
              <th className="px-3 py-2">Type</th>
              <th className="px-3 py-2 text-right">Terms</th>
              <th className="px-3 py-2 text-right">Invoices</th>
              <th className="px-3 py-2 text-right">Overdue</th>
              <th className="px-3 py-2 text-right">Outstanding</th>
              <th className="px-3 py-2">Oldest due</th>
              <th className="px-3 py-2 text-right">Days</th>
              <th className="px-3 py-2">Last payment</th>
              <th className="px-3 py-2" />
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const b = band(r.max_days_overdue);
              const expanded = open.has(r.customer_id);
              return (
                <Fragment key={r.customer_id}>
                  <tr
                    className={cn('cursor-pointer border-t border-border', BAND_ROW[b])}
                    tabIndex={0}
                    aria-expanded={expanded}
                    onClick={() => toggle(r.customer_id)}
                    onKeyDown={(e) => e.key === 'Enter' && e.target === e.currentTarget && toggle(r.customer_id)}
                  >
                    <td className="pl-2">{expanded ? <ChevronDown className="size-4" /> : <ChevronRight className="size-4" />}</td>
                    <td className="px-3 py-2">
                      <Link to={`/customers/${r.customer_id}`} className="font-semibold text-primary hover:underline" onClick={(e) => e.stopPropagation()}>
                        {r.name}
                      </Link>{' '}
                      <span className="text-sm text-muted-foreground">{r.code}</span> <CustomerStatusBadge status={r.status} />
                    </td>
                    <td className="px-3 py-2 whitespace-nowrap">{formatPhone(r.phone)}</td>
                    <td className="px-3 py-2">{r.city}</td>
                    <td className="px-3 py-2 capitalize">{r.type}</td>
                    <td className="amount px-3 py-2">{r.payment_terms_days} d</td>
                    <td className="amount px-3 py-2">{r.overdue_count}</td>
                    <td className="amount px-3 py-2 font-semibold">{formatPaisa(r.overdue_paisa)}</td>
                    <td className="px-3 py-2 text-right">
                      <Balance paisa={r.balance_paisa} />
                    </td>
                    <td className="px-3 py-2 whitespace-nowrap">{r.oldest_due_date}</td>
                    <td className="px-3 py-2 text-right">
                      <span className={cn('rounded px-2 py-0.5 text-sm font-bold', BAND_BADGE[b])}>{r.max_days_overdue}</span>
                    </td>
                    <td className="px-3 py-2 text-sm whitespace-nowrap">{r.last_payment_date ? `${r.last_payment_date} · ${formatPaisa(r.last_payment_paisa ?? 0)}` : '—'}</td>
                    <td className="px-2 py-1 whitespace-nowrap" onClick={(e) => e.stopPropagation()}>
                      {can('payments.create') && (
                        <Button variant="ghost" size="icon" title="Record payment" aria-label={`Record payment from ${r.name}`} onClick={() => void recordPayment(r)}>
                          <HandCoins />
                        </Button>
                      )}
                      <Button variant="ghost" size="icon" title="Statement PDF" aria-label={`Statement for ${r.name}`} onClick={() => openStatement('customers', r.customer_id, {})}>
                        <FileText />
                      </Button>
                      <Button variant="ghost" size="icon" title="WhatsApp reminder (coming soon)" aria-label="WhatsApp reminder (coming soon)" disabled>
                        <MessageCircle />
                      </Button>
                    </td>
                  </tr>
                  {expanded && (
                    <tr className="border-t border-border bg-card">
                      <td />
                      <td colSpan={12} className="px-3 py-2">
                        <table className="w-full text-sm">
                          <thead className="text-left text-muted-foreground">
                            <tr>
                              <th className="py-1">Invoice</th>
                              <th>Date</th>
                              <th>Due</th>
                              <th className="text-right">Total</th>
                              <th className="text-right">Paid</th>
                              <th className="text-right">Outstanding</th>
                              <th className="text-right">Days overdue</th>
                            </tr>
                          </thead>
                          <tbody>
                            {r.invoices.map((i) => (
                              <tr key={i.sale_id ?? 'opening'} className="border-t border-border">
                                <td className="py-1 font-mono font-semibold">
                                  {i.sale_id ? (
                                    <Link to={`/sales/${i.sale_id}`} className="text-primary hover:underline">
                                      {i.doc_no}
                                    </Link>
                                  ) : (
                                    'Opening balance'
                                  )}
                                </td>
                                <td>{i.date}</td>
                                <td>{i.due_date}</td>
                                <td className="amount">{formatPaisa(i.total_paisa)}</td>
                                <td className="amount">{formatPaisa(i.paid_paisa)}</td>
                                <td className="amount font-semibold">{formatPaisa(i.outstanding_paisa)}</td>
                                <td className="amount">{i.days_overdue}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
            {list.data && rows.length === 0 && (
              <tr>
                <td colSpan={13} className="px-3 py-10 text-center text-muted-foreground">
                  {tab === 'bad_debt' ? 'No bad-debt customer has overdue invoices.' : 'No customer is overdue. 🎉'}
                </td>
              </tr>
            )}
          </tbody>
          {list.data && rows.length > 0 && (
            <tfoot className="border-t-2 border-border font-semibold">
              <tr>
                <td />
                <td className="px-3 py-2" colSpan={6}>
                  {list.data.totals.customers} customer{list.data.totals.customers === 1 ? '' : 's'}
                </td>
                <td className="amount px-3 py-2">{formatPaisa(list.data.totals.overdue_paisa)}</td>
                <td className="amount px-3 py-2">{formatPaisa(list.data.totals.balance_paisa)}</td>
                <td colSpan={4} />
              </tr>
            </tfoot>
          )}
        </table>
      </div>
      {paying && <ReceivePaymentDialog customer={paying} onClose={() => setPaying(null)} />}
    </div>
  );
}
