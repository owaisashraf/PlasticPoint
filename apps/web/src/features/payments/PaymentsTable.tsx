import { useMutation, useQuery } from '@tanstack/react-query';
import { formatPaisa, type Customer, type Payment, type PaymentKind } from '@shopledger/shared';
import { useState } from 'react';
import { Link } from 'react-router';
import { toast } from 'sonner';
import { ReasonDialog } from '@/components/ReasonDialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { useCan } from '@/features/auth/useAuth';
import { useDocRights, VoidButton } from '@/features/documents';
import { useSuppliers } from '@/features/purchases/api';
import { api, errorMessage } from '@/lib/api';
import { cn, formatDateTime } from '@/lib/utils';
import { PAYMENTS_KEY, usePayments, useRefreshAfterMoney } from './api';
import { PaySupplierDialog } from './PaySupplierDialog';
import { METHOD_LABEL, ReceivePaymentDialog } from './ReceivePaymentDialog';
import { RefundEditDialog } from './RefundEditDialog';

const KIND_LABEL: Record<PaymentKind, string> = { receipt: 'Received', supplier_payment: 'Paid to supplier', refund: 'Refund' };

export function PaymentStatusBadge({ p }: { p: Payment }) {
  if (p.status === 'bounced') return <Badge variant="danger">Bounced</Badge>;
  if (p.status === 'void') return <Badge variant="grey">VOID</Badge>;
  return null;
}

function methodText(p: Payment): string {
  if (p.method === 'cheque') return `Cheque ${p.cheque_no ?? ''}${p.cheque_bank ? ` · ${p.cheque_bank}` : ''}`;
  return `${METHOD_LABEL[p.method]}${p.reference ? ` · ${p.reference}` : ''}`;
}

/** How much of a receipt went to invoices, with any advance left over. */
function AppliedCell({ p }: { p: Payment }) {
  if (p.kind !== 'receipt') return null;
  if (p.status !== 'posted') return <>—</>;
  if (p.allocated_paisa >= p.amount_paisa) return <>{formatPaisa(p.allocated_paisa)}</>;
  return (
    <span>
      {formatPaisa(p.allocated_paisa)} <Badge variant="info">Advance {formatPaisa(p.amount_paisa - p.allocated_paisa)}</Badge>
    </span>
  );
}

/** Receipts, supplier payments or refunds, with search and dates. `customerId` limits to one customer. */
export function PaymentsTable({ kind, customerId }: { kind?: PaymentKind; customerId?: number }) {
  const [q, setQ] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [limit, setLimit] = useState(100);
  const [openId, setOpenId] = useState<number | null>(null);
  const list = usePayments({ kind, customer_id: customerId, q: q.trim(), from, to, limit });
  const rows = list.data?.payments ?? [];
  const showParty = !customerId;
  const showApplied = kind !== 'supplier_payment' && kind !== 'refund';
  return (
    <div>
      <div className="mb-3 flex flex-wrap items-end gap-2">
        <Input className="w-72" placeholder="Number, customer, cheque or reference" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search payments" />
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
              <th className="px-3 py-2">Number</th>
              {!kind && <th className="px-3 py-2">Type</th>}
              {showParty && <th className="px-3 py-2">{kind === 'supplier_payment' ? 'Supplier' : 'Customer'}</th>}
              <th className="px-3 py-2">Method</th>
              <th className="px-3 py-2 text-right">Amount</th>
              {showApplied && <th className="px-3 py-2 text-right">Applied to invoices</th>}
              <th className="px-3 py-2">Entered by</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((p) => (
              <tr
                key={p.id}
                className="cursor-pointer border-t border-border hover:bg-muted/60"
                tabIndex={0}
                onClick={() => setOpenId(p.id)}
                onKeyDown={(e) => e.key === 'Enter' && setOpenId(p.id)}
              >
                <td className="px-3 py-2 whitespace-nowrap">{p.date}</td>
                <td className="px-3 py-2 font-mono font-semibold">
                  {p.doc_no} <PaymentStatusBadge p={p} />
                </td>
                {!kind && <td className="px-3 py-2">{KIND_LABEL[p.kind]}</td>}
                {showParty && (
                  <td className="px-3 py-2">
                    {p.party_name} {p.party_code && <span className="text-sm text-muted-foreground">{p.party_code}</span>}
                  </td>
                )}
                <td className="px-3 py-2">{methodText(p)}</td>
                <td className={cn('amount px-3 py-2', p.status === 'posted' ? 'font-semibold' : 'text-muted-foreground line-through')}>{formatPaisa(p.amount_paisa)}</td>
                {showApplied && (
                  <td className="amount px-3 py-2">
                    <AppliedCell p={p} />
                  </td>
                )}
                <td className="px-3 py-2 text-sm text-muted-foreground">{p.created_by_name}</td>
              </tr>
            ))}
            {list.data && rows.length === 0 && (
              <tr>
                <td colSpan={8} className="px-3 py-8 text-center text-muted-foreground">
                  Nothing found.
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
      {openId !== null && <PaymentDetailDialog id={openId} onClose={() => setOpenId(null)} />}
    </div>
  );
}

/** One payment: details, what it paid, and (owner+) "Mark cheque bounced". */
function PaymentDetailDialog({ id, onClose }: { id: number; onClose: () => void }) {
  const can = useCan();
  const refresh = useRefreshAfterMoney();
  const [bouncing, setBouncing] = useState(false);
  const [editing, setEditing] = useState<{ customer?: Customer } | null>(null);
  const suppliers = useSuppliers();
  const { data: p, isError, error } = useQuery({ queryKey: [...PAYMENTS_KEY, 'one', id], queryFn: () => api.get<{ payment: Payment }>(`/api/payments/${id}`).then((r) => r.payment) });
  const bounce = useMutation({
    mutationFn: (reason: string) => api.post(`/api/payments/${id}/bounce`, { reason }),
    onSuccess: () => {
      refresh();
      setBouncing(false);
      toast.success('Cheque marked as bounced. The customer has been charged back.');
      onClose();
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const canBounce = p && can('cheques.mark_bounced') && p.kind === 'receipt' && p.method === 'cheque' && p.status === 'posted';
  const rights = useDocRights(p);
  const startEdit = async () => {
    if (!p) return;
    if (p.kind !== 'receipt') return setEditing({});
    try {
      setEditing({ customer: (await api.get<{ customer: Customer }>(`/api/customers/${p.party_id}`)).customer });
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };

  return (
    <>
      <Dialog open={!bouncing && !editing} onOpenChange={(o) => !o && onClose()}>
        <DialogContent className="max-w-xl">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              {p?.doc_no ?? 'Payment'} {p && <PaymentStatusBadge p={p} />}
            </DialogTitle>
            {p && (
              <DialogDescription>
                {KIND_LABEL[p.kind]} · {p.date} · {p.party_name} · entered by {p.created_by_name ?? '—'} on {formatDateTime(p.created_at)}
              </DialogDescription>
            )}
          </DialogHeader>
          {isError && <p className="text-destructive">{errorMessage(error)}</p>}
          {p && (
            <div className="flex flex-col gap-3">
              <div className="flex justify-between text-lg">
                <span>{methodText(p)}</span>
                <span className="amount font-bold">{formatPaisa(p.amount_paisa)}</span>
              </div>
              {p.cheque_date && <div className="text-sm text-muted-foreground">Cheque dated {p.cheque_date}</div>}
              {p.notes && <div className="text-sm">Notes: {p.notes}</div>}
              {p.status === 'bounced' && (
                <div className="rounded-md border border-red-300 bg-red-50 px-3 py-2 text-red-900">
                  Bounced on {p.bounced_at ? formatDateTime(p.bounced_at) : '—'}: {p.bounce_reason}
                </div>
              )}
              {p.kind === 'receipt' && p.status === 'posted' && (
                <div>
                  <div className="mb-1 text-sm font-semibold">Applied to</div>
                  {(p.allocations ?? []).length === 0 && <div className="text-sm text-muted-foreground">Nothing yet — held as an advance.</div>}
                  <ul className="flex flex-col gap-1">
                    {(p.allocations ?? []).map((a) => (
                      <li key={`${a.sale_id}`} className="flex justify-between gap-4">
                        {a.sale_id ? (
                          <Link className="font-mono font-semibold text-primary hover:underline" to={`/sales/${a.sale_id}`} onClick={onClose}>
                            {a.sale_doc_no}
                          </Link>
                        ) : (
                          <span>Opening balance</span>
                        )}
                        <span className="text-sm text-muted-foreground">{a.is_manual ? 'picked' : 'oldest first'}</span>
                        <span className="amount ml-auto">{formatPaisa(a.amount_paisa)}</span>
                      </li>
                    ))}
                    {p.amount_paisa > p.allocated_paisa && (
                      <li className="flex justify-between text-blue-700">
                        <span>Advance</span>
                        <span className="amount">{formatPaisa(p.amount_paisa - p.allocated_paisa)}</span>
                      </li>
                    )}
                  </ul>
                </div>
              )}
            </div>
          )}
          <DialogFooter>
            {rights.canEdit && (
              <Button variant="outline" onClick={() => void startEdit()}>
                Edit
              </Button>
            )}
            {rights.canVoid && p && <VoidButton url={`/api/payments/${p.id}/void`} docNo={p.doc_no} onDone={onClose} />}
            {canBounce && (
              <Button variant="destructive" onClick={() => setBouncing(true)}>
                Mark cheque bounced
              </Button>
            )}
            <Button variant="outline" onClick={onClose}>
              Close
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      {editing && p?.kind === 'receipt' && editing.customer && <ReceivePaymentDialog customer={editing.customer} payment={p} onClose={onClose} />}
      {editing && p?.kind === 'supplier_payment' && suppliers.data && <PaySupplierDialog suppliers={suppliers.data} payment={p} onClose={onClose} />}
      {editing && p?.kind === 'refund' && <RefundEditDialog payment={p} onClose={onClose} />}
      {bouncing && p && (
        <ReasonDialog
          title={`Cheque ${p.cheque_no ?? ''} bounced?`}
          description={`${formatPaisa(p.amount_paisa)} is charged back to ${p.party_name}, and the invoices it paid become unpaid again. The receipt stays on record, marked bounced.`}
          confirmLabel="Mark bounced"
          destructive
          pending={bounce.isPending}
          onConfirm={(reason) => bounce.mutate(reason)}
          onClose={() => setBouncing(false)}
        />
      )}
    </>
  );
}
