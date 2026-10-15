import { useMutation } from '@tanstack/react-query';
import { formatPaisa, paisaToInput, parseRupeesToPaisa, PAYMENT_METHODS, type Payment, type PaymentMethod, type Supplier } from '@shopledger/shared';
import { useState } from 'react';
import { toast } from 'sonner';
import { FormField } from '@/components/FormField';
import { MoneyInput } from '@/components/inputs';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input, NativeSelect } from '@/components/ui/input';
import { ChangeReasonField, changeReasonOk } from '@/features/documents';
import { api, firstFieldError } from '@/lib/api';
import { todayKarachi } from '@/lib/utils';
import { useRefreshAfterMoney } from './api';
import { METHOD_LABEL } from './ReceivePaymentDialog';

/** Pay the supplier (CLAUDE.md 10.7). Reduces what we owe on the supplier ledger. */
export function PaySupplierDialog({ suppliers, payment, onClose }: { suppliers: Supplier[]; /** Edit this payment instead. */ payment?: Payment; onClose: () => void }) {
  const refresh = useRefreshAfterMoney();
  const active = suppliers.filter((s) => s.active || s.id === payment?.party_id);
  const [supplierId, setSupplierId] = useState<number | null>(payment?.party_id ?? (active.length === 1 ? (active[0]?.id ?? null) : null));
  const [date, setDate] = useState(payment?.date ?? todayKarachi());
  const [amount, setAmount] = useState(payment ? paisaToInput(payment.amount_paisa) : '');
  const [method, setMethod] = useState<PaymentMethod>(payment?.method ?? 'bank');
  const [reference, setReference] = useState(payment?.reference ?? '');
  const [chequeNo, setChequeNo] = useState(payment?.cheque_no ?? '');
  const [chequeBank, setChequeBank] = useState(payment?.cheque_bank ?? '');
  const [chequeDate, setChequeDate] = useState(payment?.cheque_date ?? '');
  const [notes, setNotes] = useState(payment?.notes ?? '');
  const [changeReason, setChangeReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const supplier = active.find((s) => s.id === supplierId);
  const amountPaisa = amount.trim() ? parseRupeesToPaisa(amount) : null;
  const valid = supplierId !== null && amountPaisa !== null && amountPaisa > 0 && (method !== 'cheque' || chequeNo.trim() !== '') && (!payment || changeReasonOk(changeReason));

  const save = useMutation({
    mutationFn: () => {
      const body = {
        date,
        amount_paisa: amountPaisa,
        method,
        reference,
        notes,
        ...(method === 'cheque' ? { cheque_no: chequeNo, cheque_bank: chequeBank, cheque_date: chequeDate || null } : {}),
      };
      return payment
        ? api.put<{ payment: Payment }>(`/api/payments/supplier/${payment.id}`, { ...body, change_reason: changeReason })
        : api.post<{ payment: Payment }>('/api/payments/supplier', { ...body, supplier_id: supplierId });
    },
    onSuccess: ({ payment: saved }) => {
      refresh();
      toast.success(payment ? `Payment ${saved.doc_no} updated.` : `Payment ${saved.doc_no} saved.`);
      onClose();
    },
    onError: (e) => setError(firstFieldError(e)),
  });

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>{payment ? `Edit payment ${payment.doc_no}` : 'Pay supplier'}</DialogTitle>
          {supplier && (
            <DialogDescription>
              We owe {supplier.name} {supplier.balance_paisa < 0 ? `nothing (advance paid ${formatPaisa(-supplier.balance_paisa)})` : formatPaisa(supplier.balance_paisa)}.
            </DialogDescription>
          )}
        </DialogHeader>
        <form
          className="grid grid-cols-1 gap-4 md:grid-cols-2"
          onSubmit={(e) => {
            e.preventDefault();
            setError(null);
            if (valid) save.mutate();
          }}
        >
          {active.length > 1 && !payment && (
            <div className="md:col-span-2">
              <FormField label="Supplier" htmlFor="ps_supplier">
                <NativeSelect id="ps_supplier" value={supplierId ?? ''} onChange={(e) => setSupplierId(Number(e.target.value) || null)}>
                  <option value="">Pick…</option>
                  {active.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
                </NativeSelect>
              </FormField>
            </div>
          )}
          <FormField label="Amount paid" htmlFor="ps_amount" error={amount && amountPaisa === null ? 'Enter an amount in rupees' : undefined}>
            <MoneyInput id="ps_amount" autoFocus value={amount} onChange={(e) => setAmount(e.target.value)} />
          </FormField>
          <FormField label="Date" htmlFor="ps_date">
            <Input id="ps_date" type="date" max={todayKarachi()} value={date} onChange={(e) => setDate(e.target.value)} />
          </FormField>
          <FormField label="Method" htmlFor="ps_method">
            <NativeSelect id="ps_method" value={method} onChange={(e) => setMethod(e.target.value as PaymentMethod)}>
              {PAYMENT_METHODS.map((m) => (
                <option key={m} value={m}>
                  {METHOD_LABEL[m]}
                </option>
              ))}
            </NativeSelect>
          </FormField>
          {method === 'cheque' ? (
            <FormField label="Cheque no." htmlFor="ps_cheque_no">
              <Input id="ps_cheque_no" value={chequeNo} onChange={(e) => setChequeNo(e.target.value)} />
            </FormField>
          ) : (
            <FormField label="Reference" htmlFor="ps_ref">
              <Input id="ps_ref" value={reference} onChange={(e) => setReference(e.target.value)} />
            </FormField>
          )}
          {method === 'cheque' && (
            <>
              <FormField label="Bank" htmlFor="ps_cheque_bank">
                <Input id="ps_cheque_bank" value={chequeBank} onChange={(e) => setChequeBank(e.target.value)} />
              </FormField>
              <FormField label="Cheque date" htmlFor="ps_cheque_date">
                <Input id="ps_cheque_date" type="date" value={chequeDate} onChange={(e) => setChequeDate(e.target.value)} />
              </FormField>
            </>
          )}
          <div className="md:col-span-2">
            <FormField label="Notes" htmlFor="ps_notes">
              <Input id="ps_notes" value={notes} onChange={(e) => setNotes(e.target.value)} />
            </FormField>
          </div>
          {payment && (
            <div className="md:col-span-2">
              <ChangeReasonField id="ps_change_reason" value={changeReason} onChange={setChangeReason} />
            </div>
          )}
          {error && <p className="font-medium text-destructive md:col-span-2">{error}</p>}
          <DialogFooter className="md:col-span-2">
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={!valid || save.isPending}>
              {save.isPending ? 'Saving…' : 'Save payment'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
