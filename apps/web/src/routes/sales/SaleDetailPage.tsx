import { formatBp, formatPaisa, formatPhone, roundDiv, type SaleAllocation, type SalesReturn } from '@shopledger/shared';
import { ArrowLeft, HandCoins, Pencil, Share2, Undo2 } from 'lucide-react';
import { useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router';
import { toast } from 'sonner';
import { CustomerStatusBadge } from '@/components/badges';
import { FullPageMessage } from '@/components/FullPageMessage';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { useCan } from '@/features/auth/useAuth';
import { useCustomer } from '@/features/customers/api';
import { useDocRights, VoidButton } from '@/features/documents';
import { OverdueBadge } from '@/features/overdue';
import { ReceivePaymentDialog } from '@/features/payments/ReceivePaymentDialog';
import { SalesReturnDialog } from '@/features/payments/SalesReturnDialog';
import { useSale } from '@/features/sales/api';
import { ShareDialog } from '@/features/sales/ShareDialog';
import { LastSent, useWhatsAppHistory } from '@/features/whatsapp/WhatsApp';
import { api, errorMessage } from '@/lib/api';
import { cn, formatDateTime } from '@/lib/utils';

export function SaleDetailPage() {
  const id = Number(useParams().id);
  const [params, setParams] = useSearchParams();
  const can = useCan();
  const { data: s, isPending, isError, error } = useSale(id);
  const customer = useCustomer(s?.customer_id ?? 0, s !== undefined).data;
  const [sharing, setSharing] = useState(params.get('share') === '1');
  const [dialog, setDialog] = useState<'pay' | 'return' | null>(params.get('return') === '1' ? 'return' : null);
  const [editingReturn, setEditingReturn] = useState<SalesReturn | null>(null);
  const navigate = useNavigate();
  const rights = useDocRights(s);
  const shared = useWhatsAppHistory({ sale_id: id }, can('whatsapp.send'));

  if (isPending) return <p>Loading…</p>;
  if (isError) return <FullPageMessage inline title="Sale not found" detail={errorMessage(error)} />;

  const lines = s.lines ?? [];
  const profit = s.profit_paisa;
  const anyReturned = lines.some((l) => l.returned_qty > 0);
  const canReturn = can('returns.create') && s.status === 'posted' && lines.some((l) => l.qty > l.returned_qty);
  const canPay = can('payments.create') && s.status === 'posted' && s.outstanding_paisa > 0;
  const closeShare = () => {
    setSharing(false);
    if (params.has('share')) setParams({}, { replace: true });
  };
  const closeDialog = () => {
    setDialog(null);
    if (params.has('return')) setParams({}, { replace: true });
  };

  return (
    <div className="max-w-6xl">
      <Link to="/sales" className="mb-2 inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
        <ArrowLeft className="size-4" /> Sales
      </Link>
      <div className="mb-5 flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="flex items-center gap-3 text-2xl font-bold">
            Invoice {s.doc_no} {s.status === 'void' && <Badge variant="grey">VOID</Badge>}
          </h1>
          <p className="text-muted-foreground">
            {s.date} · due {s.due_date} ({s.payment_terms_days} days) · entered by {s.created_by_name ?? '—'} on {formatDateTime(s.created_at)}
            {s.approved_by_name && ` · approved by ${s.approved_by_name}`}
          </p>
          <LastSent entries={shared.data} kind="invoice" />
        </div>
        <div className="flex flex-wrap gap-2">
          {rights.canEdit && (
            <Button variant="outline" onClick={() => navigate(`/sales/${s.id}/edit`)}>
              <Pencil /> Edit
            </Button>
          )}
          {rights.canVoid && (
            <VoidButton
              url={`/api/sales/${s.id}/void`}
              docNo={s.doc_no}
              description={s.allocations?.some((a) => a.source_type === 'payment' && a.is_manual) ? 'Cash taken at the counter with it is voided too.' : undefined}
            />
          )}
          {canPay && (
            <Button variant="outline" onClick={() => setDialog('pay')} disabled={!customer}>
              <HandCoins /> Record payment
            </Button>
          )}
          {canReturn && (
            <Button variant="outline" onClick={() => setDialog('return')}>
              <Undo2 /> Return items
            </Button>
          )}
          <Button onClick={() => setSharing(true)}>
            <Share2 /> Print / PDF / Share
          </Button>
        </div>
      </div>

      <div className="mb-5 grid grid-cols-1 gap-3 md:grid-cols-4">
        <Card className="md:col-span-2">
          <CardContent className="pt-4">
            <Link to={`/customers/${s.customer_id}`} className="text-lg font-semibold text-primary hover:underline">
              {s.customer_name}
            </Link>{' '}
            <CustomerStatusBadge status={s.customer_status} />
            <div className="text-sm text-muted-foreground">
              {[s.customer_code, s.customer_business_name, s.customer_city, formatPhone(s.customer_phone)].filter(Boolean).join(' · ')}
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-4">
            <div className="text-sm text-muted-foreground">Total</div>
            <div className="amount text-left text-xl font-bold">{formatPaisa(s.total_paisa)}</div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-4">
            <div className="text-sm text-muted-foreground">Outstanding</div>
            <div className="amount text-left text-xl font-bold">{s.outstanding_paisa ? formatPaisa(s.outstanding_paisa) : <Badge variant="success">Paid</Badge>}</div>
            <OverdueBadge days={s.days_overdue} className="mt-1" />
          </CardContent>
        </Card>
      </div>

      <div className="overflow-x-auto rounded-lg border border-border bg-card">
        <table className="w-full text-[15px]">
          <thead className="bg-muted text-left text-sm text-muted-foreground">
            <tr>
              <th className="px-3 py-2">#</th>
              <th className="px-3 py-2">Item</th>
              <th className="px-3 py-2">Color</th>
              <th className="px-3 py-2">Size</th>
              <th className="px-3 py-2 text-right">Qty</th>
              {anyReturned && <th className="px-3 py-2 text-right">Returned</th>}
              <th className="px-3 py-2 text-right">Price</th>
              <th className="px-3 py-2 text-right">Discount %</th>
              <th className="px-3 py-2 text-right">Amount</th>
              {profit !== undefined && <th className="px-3 py-2 text-right">Cost</th>}
              {profit !== undefined && <th className="px-3 py-2 text-right">Profit</th>}
            </tr>
          </thead>
          <tbody>
            {lines.map((l) => {
              const loss = l.profit_paisa !== undefined && l.profit_paisa < 0;
              return (
                <tr key={l.id} className={cn('border-t border-border', loss && 'bg-red-50')}>
                  <td className="px-3 py-1.5 text-muted-foreground">{l.line_no}</td>
                  <td className="px-3 py-1.5">
                    <span className="font-mono font-semibold">{l.item_code}</span> <span className="text-sm text-muted-foreground">{l.name}</span>
                  </td>
                  <td className="px-3 py-1.5">{l.color || '—'}</td>
                  <td className="px-3 py-1.5">{l.size || '—'}</td>
                  <td className="amount px-3 py-1.5">{l.qty}</td>
                  {anyReturned && <td className="amount px-3 py-1.5">{l.returned_qty || ''}</td>}
                  <td className="amount px-3 py-1.5">{formatPaisa(l.list_price_paisa)}</td>
                  <td className="amount px-3 py-1.5">
                    {l.discount_overridden && (
                      <Badge className="mr-1 bg-purple-100 text-purple-900" title={`Usual discount ${formatBp(l.default_discount_bp)}`}>
                        changed
                      </Badge>
                    )}
                    {formatBp(l.discount_bp)}
                  </td>
                  <td className="amount px-3 py-1.5">{formatPaisa(l.line_amount_paisa)}</td>
                  {profit !== undefined && (
                    <td className="amount px-3 py-1.5">
                      {formatPaisa(l.line_cost_paisa ?? 0)}
                      {l.cost_source === 'estimated' && (
                        <Badge variant="grey" className="ml-1" title="Nothing was bought yet: cost estimated from the supplier margin">
                          est.
                        </Badge>
                      )}
                    </td>
                  )}
                  {profit !== undefined && <td className={cn('amount px-3 py-1.5', loss && 'font-semibold text-destructive')}>{formatPaisa(l.profit_paisa ?? 0)}</td>}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <div className="mt-4 flex flex-wrap justify-between gap-4">
        <div className="flex flex-col gap-3">
          {s.notes && <p>Notes: {s.notes}</p>}
          {s.allocations && s.allocations.length > 0 && (
            <Card>
              <CardHeader>
                <CardTitle>Paid by</CardTitle>
              </CardHeader>
              <CardContent>
                <ul className="flex flex-col gap-1">
                  {s.allocations.map((a) => (
                    <li key={`${a.source_type}:${a.source_id}`}>
                      <span className="font-mono font-semibold">{a.doc_no ?? 'Opening advance'}</span> · {a.date ?? ''} · {SOURCE_LABEL[a.source_type]}
                      {a.method ? ` (${a.method})` : ''}
                      <span className="amount ml-2">{formatPaisa(a.amount_paisa)}</span>
                    </li>
                  ))}
                </ul>
              </CardContent>
            </Card>
          )}
          {s.returns && s.returns.length > 0 && (
            <Card>
              <CardHeader>
                <CardTitle>Returns</CardTitle>
              </CardHeader>
              <CardContent>
                <ul className="flex flex-col gap-1">
                  {s.returns.map((r) => (
                    <li key={r.id} className="flex flex-wrap items-center gap-2">
                      <span className="font-mono font-semibold">{r.doc_no}</span>
                  {r.status === 'void' && <Badge variant="grey">VOID</Badge>}
                  <span>
                    · {r.date} · {r.reason}
                  </span>
                      <span className="amount ml-2">{formatPaisa(r.total_paisa)}</span>
                      {r.status === 'posted' && (can('documents.edit_any') || can('documents.edit_own_same_day')) && (
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() =>
                            api
                              .get<{ sales_return: SalesReturn }>(`/api/sales-returns/${r.id}`)
                              .then((x) => setEditingReturn(x.sales_return))
                              .catch((e: unknown) => toast.error(errorMessage(e)))
                          }
                        >
                          <Pencil /> Edit
                        </Button>
                      )}
                      {r.status === 'posted' && can('documents.edit_any') && <VoidButton size="sm" url={`/api/sales-returns/${r.id}/void`} docNo={r.doc_no} description="Money paid back for it is voided too." />}
                    </li>
                  ))}
                </ul>
              </CardContent>
            </Card>
          )}
        </div>
        <div className="min-w-72 rounded-lg border border-border bg-card p-4">
          <Row k="Gross (qty × price)" v={formatPaisa(s.gross_paisa)} />
          <Row k="Discount" v={`−${formatPaisa(s.line_discount_paisa)}`} />
          {s.extra_discount_paisa > 0 && <Row k="Extra discount" v={`−${formatPaisa(s.extra_discount_paisa)}`} />}
          <Row k="Total" v={formatPaisa(s.total_paisa)} strong />
          <Row k="Paid" v={formatPaisa(s.paid_paisa)} />
          <Row k="Outstanding" v={formatPaisa(s.outstanding_paisa)} strong />
          {profit !== undefined && (
            <div className={cn('mt-2 border-t border-border pt-2', profit < 0 ? 'text-destructive' : 'text-green-800')}>
              <Row k="Profit" v={`${formatPaisa(profit)}${s.gross_paisa ? ` (${formatBp(roundDiv(profit * 10_000, s.gross_paisa))})` : ''}`} strong />
              {(s.returned_profit_paisa ?? 0) !== 0 && (
                <>
                  <Row k="Less returned" v={`−${formatPaisa(s.returned_profit_paisa ?? 0)}`} />
                  <Row k="Profit after returns" v={formatPaisa(profit - (s.returned_profit_paisa ?? 0))} strong />
                </>
              )}
            </div>
          )}
        </div>
      </div>

      {sharing && <ShareDialog sale={s} onClose={closeShare} />}
      {dialog === 'pay' && customer && <ReceivePaymentDialog customer={customer} saleId={s.id} onClose={closeDialog} />}
      {dialog === 'return' && canReturn && <SalesReturnDialog sale={s} onClose={closeDialog} />}
      {editingReturn && <SalesReturnDialog sale={s} existing={editingReturn} onClose={() => setEditingReturn(null)} />}
    </div>
  );
}

const SOURCE_LABEL: Record<SaleAllocation['source_type'], string> = {
  payment: 'payment',
  sales_return: 'return credit',
  write_off: 'written off',
  opening_balance: 'opening advance',
};

function Row({ k, v, strong }: { k: string; v: string; strong?: boolean }) {
  return (
    <div className={cn('flex justify-between gap-6 py-0.5', strong && 'text-lg font-bold')}>
      <span className={strong ? '' : 'text-muted-foreground'}>{k}</span>
      <span className="amount">{v}</span>
    </div>
  );
}
