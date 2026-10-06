import { useMutation } from '@tanstack/react-query';
import { paisaToInput, parseRupeesToPaisa, type Payment } from '@shopledger/shared';
import { useState } from 'react';
import { toast } from 'sonner';
import { FormField } from '@/components/FormField';
import { MoneyInput } from '@/components/inputs';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input, NativeSelect } from '@/components/ui/input';
import { ChangeReasonField, changeReasonOk } from '@/features/documents';
import { api, errorMessage } from '@/lib/api';
import { todayKarachi } from '@/lib/utils';
import { useRefreshAfterMoney } from './api';

/** Edit money paid back for a return: amount (up to the return's credit), method and date. */
export function RefundEditDialog({ payment, onClose }: { payment: Payment; onClose: () => void }) {
  const refresh = useRefreshAfterMoney();
  const [amount, setAmount] = useState(paisaToInput(payment.amount_paisa));
  const [method, setMethod] = useState<'cash' | 'bank' | 'online'>(payment.method === 'cheque' ? 'cash' : payment.method);
  const [date, setDate] = useState(payment.date);
  const [changeReason, setChangeReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const amountPaisa = parseRupeesToPaisa(amount);
  const valid = amountPaisa !== null && amountPaisa > 0 && changeReasonOk(changeReason);
  const save = useMutation({
    mutationFn: () => api.put(`/api/payments/refunds/${payment.id}`, { date, amount_paisa: amountPaisa, method, change_reason: changeReason }),
    onSuccess: () => {
      refresh();
      toast.success(`Refund ${payment.doc_no} updated.`);
      onClose();
    },
    onError: (e) => setError(errorMessage(e)),
  });
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Edit refund {payment.doc_no}</DialogTitle>
          <DialogDescription>Money paid back to {payment.party_name} for returned goods.</DialogDescription>
        </DialogHeader>
        <form
          className="grid grid-cols-2 gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            setError(null);
            if (valid) save.mutate();
          }}
        >
          <FormField label="Amount paid back" htmlFor="rf_amount">
            <MoneyInput id="rf_amount" autoFocus value={amount} onChange={(e) => setAmount(e.target.value)} />
          </FormField>
          <FormField label="Paid by" htmlFor="rf_method">
            <NativeSelect id="rf_method" value={method} onChange={(e) => setMethod(e.target.value as typeof method)}>
              <option value="cash">Cash</option>
              <option value="bank">Bank transfer</option>
              <option value="online">Online / wallet</option>
            </NativeSelect>
          </FormField>
          <FormField label="Date" htmlFor="rf_date">
            <Input id="rf_date" type="date" max={todayKarachi()} value={date} onChange={(e) => setDate(e.target.value)} />
          </FormField>
          <div className="col-span-2">
            <ChangeReasonField id="rf_change_reason" value={changeReason} onChange={setChangeReason} />
          </div>
          {error && <p className="col-span-2 font-medium text-destructive">{error}</p>}
          <DialogFooter className="col-span-2">
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={!valid || save.isPending}>
              Save
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
