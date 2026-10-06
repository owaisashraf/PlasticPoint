import { useMutation } from '@tanstack/react-query';
import { formatPaisa, paisaToInput, parseRupeesToPaisa, PAYMENT_METHODS, type Customer, type OpenItem, type Payment, type PaymentMethod } from '@shopledger/shared';
import { Search } from 'lucide-react';
import { useRef, useState } from 'react';
import { toast } from 'sonner';
import { Balance, CustomerStatusBadge } from '@/components/badges';
import { FormField } from '@/components/FormField';
import { MoneyInput } from '@/components/inputs';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input, NativeSelect } from '@/components/ui/input';
import { CustomerPicker } from '@/features/customers/CustomerPicker';
import { ChangeReasonField, changeReasonOk } from '@/features/documents';
import { api, ApiError, errorMessage } from '@/lib/api';
import { useHotkey } from '@/lib/useHotkey';
import { cn, todayKarachi } from '@/lib/utils';
import { useOpenItems, useRefreshAfterMoney } from './api';

export const METHOD_LABEL: Record<PaymentMethod, string> = { cash: 'Cash', bank: 'Bank transfer', cheque: 'Cheque', online: 'Online / wallet' };

const itemKey = (i: OpenItem) => (i.sale_id === null ? 'opening' : String(i.sale_id));

/** FIFO preview: how `amount` would pay the open items, oldest first. */
function fifoPreview(items: OpenItem[], amount: number): Map<string, number> {
  const out = new Map<string, number>();
  let left = amount;
  for (const i of items) {
    if (left <= 0) break;
    const a = Math.min(left, i.outstanding_paisa);
    out.set(itemKey(i), a);
    left -= a;
  }
  return out;
}

/**
 * Receive money from a customer (CLAUDE.md 10.7): FIFO by default, or pick
 * invoices by hand. The preview shows how the money will be applied; any
 * amount left over is kept as an advance.
 */
export function ReceivePaymentDialog({
  customer: initial,
  saleId,
  payment,
  onClose,
  onSaved,
}: {
  customer?: Customer;
  saleId?: number;
  /** Edit this receipt instead of recording a new one (its customer cannot change). */
  payment?: Payment;
  onClose: () => void;
  onSaved?: (p: Payment) => void;
}) {
  const refresh = useRefreshAfterMoney();
  const [customer, setCustomer] = useState<Customer | null>(initial ?? null);
  const [picking, setPicking] = useState(!initial);
  // The picker reports the pick and its closing in the same tick, so `customer` is not updated yet there.
  const picked = useRef(!!initial);
  const [date, setDate] = useState(payment?.date ?? todayKarachi());
  const [amount, setAmount] = useState(payment ? paisaToInput(payment.amount_paisa) : '');
  const [method, setMethod] = useState<PaymentMethod>(payment?.method ?? 'cash');
  const [reference, setReference] = useState(payment?.reference ?? '');
  const [chequeNo, setChequeNo] = useState(payment?.cheque_no ?? '');
  const [chequeBank, setChequeBank] = useState(payment?.cheque_bank ?? '');
  const [chequeDate, setChequeDate] = useState(payment?.cheque_date ?? '');
  const [notes, setNotes] = useState(payment?.notes ?? '');
  const pickedBefore = (payment?.allocations ?? []).filter((a) => a.is_manual);
  const [mode, setMode] = useState<'fifo' | 'manual'>(saleId || pickedBefore.length ? 'manual' : 'fifo');
  const [manual, setManual] = useState<Record<string, string>>(
    Object.fromEntries(pickedBefore.map((a) => [a.sale_id === null ? 'opening' : String(a.sale_id), paisaToInput(a.amount_paisa)])),
  );
  const [changeReason, setChangeReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  /** Cash taken with a sale stays linked to that sale. */
  const counterCash = payment?.sale_id ?? null;
  const open = useOpenItems(customer?.id ?? null, payment?.id);
  const items = open.data?.items ?? [];

  const amountPaisa = amount.trim() ? parseRupeesToPaisa(amount) : null;
  const manualPaisa = Object.fromEntries(Object.entries(manual).map(([k, v]) => [k, v.trim() ? parseRupeesToPaisa(v) : 0]));
  const manualTotal = Object.values(manualPaisa).reduce<number>((a, v) => a + (v ?? 0), 0);
  const manualBad = Object.values(manualPaisa).some((v) => v === null) || items.some((i) => (manualPaisa[itemKey(i)] ?? 0) > i.outstanding_paisa);
  const applied = mode === 'fifo' ? fifoPreview(items, amountPaisa ?? 0) : new Map(Object.entries(manualPaisa).map(([k, v]) => [k, v ?? 0]));
  const appliedTotal = [...applied.values()].reduce((a, b) => a + b, 0);
  const advance = (amountPaisa ?? 0) - appliedTotal;
  const valid =
    customer !== null &&
    amountPaisa !== null &&
    amountPaisa > 0 &&
    (method !== 'cheque' || chequeNo.trim() !== '') &&
    (counterCash !== null || mode === 'fifo' || (!manualBad && manualTotal <= amountPaisa)) &&
    (!payment || changeReasonOk(changeReason));

  // Paying one invoice from its page: prefill it once the open items arrive.
  const [prefilled, setPrefilled] = useState(false);
  if (saleId && !prefilled && open.data) {
    const it = items.find((i) => i.sale_id === saleId);
    setPrefilled(true);
    if (it) {
      setManual({ [itemKey(it)]: paisaToInput(it.outstanding_paisa) });
      setAmount(paisaToInput(it.outstanding_paisa));
    } else setMode('fifo');
  }

  const save = useMutation({
    mutationFn: () => {
      const body = {
        date,
        amount_paisa: amountPaisa,
        method,
        reference,
        notes,
        ...(method === 'cheque' ? { cheque_no: chequeNo, cheque_bank: chequeBank, cheque_date: chequeDate || null } : {}),
        allocations:
          mode === 'manual' && counterCash === null
            ? items.filter((i) => (manualPaisa[itemKey(i)] ?? 0) > 0).map((i) => ({ sale_id: i.sale_id, amount_paisa: manualPaisa[itemKey(i)] }))
            : [],
      };
      return payment
        ? api.put<{ payment: Payment }>(`/api/payments/receipts/${payment.id}`, { ...body, change_reason: changeReason })
        : api.post<{ payment: Payment }>('/api/payments/receipts', { ...body, customer_id: customer?.id });
    },
    onSuccess: ({ payment: saved }) => {
      refresh();
      toast.success(payment ? `Receipt ${saved.doc_no} updated.` : `Receipt ${saved.doc_no} saved.`);
      onSaved?.(saved);
      onClose();
    },
    onError: (e) => setError(e instanceof ApiError && e.fields ? Object.values(e.fields)[0] ?? errorMessage(e) : errorMessage(e)),
  });

  const submit = () => {
    setError(null);
    if (valid && !save.isPending) save.mutate();
  };
  useHotkey('ctrl+s', submit);

  return (
    <>
      <Dialog open={!picking} onOpenChange={(o) => !o && onClose()}>
        <DialogContent className="max-w-3xl">
          <DialogHeader>
            <DialogTitle>{payment ? `Edit receipt ${payment.doc_no}` : 'Receive payment'}</DialogTitle>
            <DialogDescription>Money is applied to the oldest unpaid first, unless you pick invoices. Anything left over is kept as an advance.</DialogDescription>
          </DialogHeader>
          <div className="grid grid-cols-1 gap-4 md:grid-cols-[2fr_1fr_1fr]">
            <FormField label="Customer" htmlFor="rp_customer">
              <button
                id="rp_customer"
                type="button"
                onClick={() => !payment && setPicking(true)}
                disabled={!!payment}
                className="flex h-9 w-full cursor-pointer disabled:cursor-default items-center gap-2 rounded-md border border-input bg-card px-3 text-left text-[15px] hover:bg-muted"
              >
                <Search className="size-4 text-muted-foreground" />
                {customer ? (
                  <span className="flex min-w-0 items-center gap-2 font-semibold">
                    <span className="truncate">{customer.name}</span> <span className="text-sm font-normal text-muted-foreground">{customer.code}</span>
                    <CustomerStatusBadge status={customer.status} />
                  </span>
                ) : (
                  <span className="text-muted-foreground">Find customer…</span>
                )}
              </button>
            </FormField>
            <FormField label="Amount received" htmlFor="rp_amount" error={amount && amountPaisa === null ? 'Enter an amount in rupees' : undefined}>
              <MoneyInput id="rp_amount" autoFocus={!!initial} value={amount} onChange={(e) => setAmount(e.target.value)} />
            </FormField>
            <FormField label="Date" htmlFor="rp_date">
              <Input id="rp_date" type="date" max={todayKarachi()} value={date} onChange={(e) => setDate(e.target.value)} />
            </FormField>
            <FormField label="Method" htmlFor="rp_method">
              <NativeSelect id="rp_method" value={method} onChange={(e) => setMethod(e.target.value as PaymentMethod)}>
                {PAYMENT_METHODS.map((m) => (
                  <option key={m} value={m}>
                    {METHOD_LABEL[m]}
                  </option>
                ))}
              </NativeSelect>
            </FormField>
            {method === 'cheque' ? (
              <>
                <FormField label="Cheque no." htmlFor="rp_cheque_no">
                  <Input id="rp_cheque_no" value={chequeNo} onChange={(e) => setChequeNo(e.target.value)} />
                </FormField>
                <FormField label="Bank" htmlFor="rp_cheque_bank">
                  <Input id="rp_cheque_bank" value={chequeBank} onChange={(e) => setChequeBank(e.target.value)} />
                </FormField>
                <FormField label="Cheque date" htmlFor="rp_cheque_date">
                  <Input id="rp_cheque_date" type="date" value={chequeDate} onChange={(e) => setChequeDate(e.target.value)} />
                </FormField>
              </>
            ) : (
              <FormField label="Reference" htmlFor="rp_ref">
                <Input id="rp_ref" value={reference} onChange={(e) => setReference(e.target.value)} placeholder="e.g. transaction ID" />
              </FormField>
            )}
            <div className={method === 'cheque' ? 'md:col-span-2' : ''}>
              <FormField label="Notes" htmlFor="rp_notes">
                <Input id="rp_notes" value={notes} onChange={(e) => setNotes(e.target.value)} />
              </FormField>
            </div>
          </div>

          {customer && counterCash !== null && (
            <p className="text-sm text-muted-foreground">This cash was taken at the counter with an invoice and stays linked to it.</p>
          )}
          {customer && counterCash === null && (
            <div>
              <div className="mb-2 flex items-center justify-between">
                <div className="text-sm">
                  Balance <Balance paisa={customer.balance_paisa} />
                  {open.data && open.data.advance_paisa > 0 && <span className="ml-3 text-blue-700">Advance held {formatPaisa(open.data.advance_paisa)}</span>}
                </div>
                <div className="flex gap-1 rounded-md bg-muted p-1 text-sm" role="radiogroup" aria-label="How to apply the money">
                  {(['fifo', 'manual'] as const).map((m) => (
                    <button
                      key={m}
                      type="button"
                      role="radio"
                      aria-checked={mode === m}
                      onClick={() => setMode(m)}
                      className={cn('cursor-pointer rounded px-3 py-1', mode === m ? 'bg-card font-semibold shadow-xs' : 'text-muted-foreground')}
                    >
                      {m === 'fifo' ? 'Oldest first' : 'Pick invoices'}
                    </button>
                  ))}
                </div>
              </div>
              <div className="max-h-64 overflow-y-auto rounded-lg border border-border">
                <table className="w-full text-[15px]">
                  <thead className="sticky top-0 bg-muted text-left text-sm text-muted-foreground">
                    <tr>
                      <th className="px-3 py-1.5">Invoice</th>
                      <th className="px-3 py-1.5">Date</th>
                      <th className="px-3 py-1.5">Due</th>
                      <th className="px-3 py-1.5 text-right">Outstanding</th>
                      <th className="px-3 py-1.5 text-right">Apply</th>
                    </tr>
                  </thead>
                  <tbody>
                    {items.length === 0 && (
                      <tr>
                        <td colSpan={5} className="px-3 py-4 text-center text-muted-foreground">
                          Nothing outstanding. The whole amount will be kept as an advance.
                        </td>
                      </tr>
                    )}
                    {items.map((i) => {
                      const k = itemKey(i);
                      const a = applied.get(k) ?? 0;
                      return (
                        <tr key={k} className={cn('border-t border-border', a > 0 && 'bg-green-50')}>
                          <td className="px-3 py-1.5 font-mono font-semibold">{i.doc_no ?? 'Opening balance'}</td>
                          <td className="px-3 py-1.5">{i.date}</td>
                          <td className="px-3 py-1.5">{i.due_date ?? '—'}</td>
                          <td className="amount px-3 py-1.5">{formatPaisa(i.outstanding_paisa)}</td>
                          <td className="px-3 py-1.5 text-right">
                            {mode === 'fifo' ? (
                              <span className="amount">{a ? formatPaisa(a) : ''}</span>
                            ) : (
                              <Input
                                className={cn('amount ml-auto h-8 w-28', (manualPaisa[k] ?? 0) > i.outstanding_paisa && 'border-destructive')}
                                inputMode="decimal"
                                value={manual[k] ?? ''}
                                onChange={(e) => setManual((m) => ({ ...m, [k]: e.target.value }))}
                                aria-label={`Apply to ${i.doc_no ?? 'opening balance'}`}
                              />
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              <div className="mt-2 flex justify-end gap-6 text-sm">
                <span>
                  Applied <span className="amount font-semibold">{formatPaisa(appliedTotal)}</span>
                </span>
                <span className={advance < 0 ? 'font-semibold text-destructive' : advance > 0 ? 'text-blue-700' : ''}>
                  {advance < 0 ? `Picked ${formatPaisa(-advance)} more than received` : `Kept as advance ${formatPaisa(advance)}`}
                </span>
              </div>
            </div>
          )}

          {payment && <ChangeReasonField id="rp_change_reason" value={changeReason} onChange={setChangeReason} />}
          {error && <p className="font-medium text-destructive">{error}</p>}
          <DialogFooter>
            <Button variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button onClick={submit} disabled={!valid || save.isPending}>
              {save.isPending ? 'Saving…' : 'Save receipt'} <kbd className="text-xs opacity-70">Ctrl+S</kbd>
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <CustomerPicker
        open={picking}
        onOpenChange={(o) => {
          setPicking(o);
          if (!o && !picked.current) onClose();
        }}
        onSelect={(c) => {
          picked.current = true;
          setCustomer(c);
          setManual({});
        }}
      />
    </>
  );
}
