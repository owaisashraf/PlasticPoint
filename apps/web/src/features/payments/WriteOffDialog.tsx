import { useMutation } from '@tanstack/react-query';
import { formatPaisa, paisaToInput, parseRupeesToPaisa, type WriteOff } from '@shopledger/shared';
import { useState } from 'react';
import { toast } from 'sonner';
import { FormField } from '@/components/FormField';
import { MoneyInput } from '@/components/inputs';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { ChangeReasonField, changeReasonOk } from '@/features/documents';
import { api, errorMessage } from '@/lib/api';
import { todayKarachi } from '@/lib/utils';
import { useRefreshAfterMoney } from './api';

/**
 * Owner+: write off a bad debt (up to the balance), or reverse part of an
 * earlier write-off when the customer pays after all (CLAUDE.md 8.8).
 */
export function WriteOffDialog({
  mode,
  customerId,
  customerName,
  max,
  writeOff,
  onClose,
}: {
  mode: 'create' | 'reverse' | 'edit';
  customerId: number;
  customerName: string;
  /** Balance (create) or amount still written off (reverse). */
  max: number;
  writeOff?: WriteOff;
  onClose: () => void;
}) {
  const refresh = useRefreshAfterMoney();
  const [amount, setAmount] = useState(paisaToInput(mode === 'edit' && writeOff ? writeOff.amount_paisa : max));
  const [date, setDate] = useState(mode === 'edit' && writeOff ? writeOff.date : todayKarachi());
  const [reason, setReason] = useState(mode === 'edit' && writeOff ? writeOff.reason : '');
  const [changeReason, setChangeReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const amountPaisa = parseRupeesToPaisa(amount);
  const valid = amountPaisa !== null && amountPaisa > 0 && amountPaisa <= max && reason.trim().length >= 3 && (mode !== 'edit' || changeReasonOk(changeReason));

  const save = useMutation({
    mutationFn: () =>
      mode === 'edit'
        ? api.put<{ write_off: WriteOff }>(`/api/write-offs/${writeOff?.id}`, { date, amount_paisa: amountPaisa, reason, change_reason: changeReason })
        : api.post<{ write_off: WriteOff }>(mode === 'create' ? `/api/customers/${customerId}/write-offs` : `/api/write-offs/${writeOff?.id}/reverse`, {
            date,
            amount_paisa: amountPaisa,
            reason,
          }),
    onSuccess: () => {
      refresh();
      toast.success(mode === 'create' ? 'Written off.' : mode === 'edit' ? 'Write-off updated.' : 'Write-off reversed. Now record the payment.');
      onClose();
    },
    onError: (e) => setError(errorMessage(e)),
  });

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{mode === 'create' ? `Write off ${customerName}'s debt` : mode === 'edit' ? `Edit write-off ${writeOff?.doc_no}` : `Reverse write-off ${writeOff?.doc_no}`}</DialogTitle>
          <DialogDescription>
            {mode === 'edit'
              ? `Up to ${formatPaisa(max)}: what ${customerName} would owe without this write-off. Recorded in the change history.`
              : mode === 'create'
              ? `Up to the balance of ${formatPaisa(max)}. The oldest invoices are cleared first and stop counting as overdue. This is recorded in the change history.`
              : `The customer is paying after all. Up to ${formatPaisa(max)} can be taken back; then record their payment as usual.`}
          </DialogDescription>
        </DialogHeader>
        <form
          className="grid grid-cols-2 gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            setError(null);
            if (valid) save.mutate();
          }}
        >
          <FormField label="Amount" htmlFor="wo_amount" error={amountPaisa !== null && amountPaisa > max ? `At most ${formatPaisa(max)}` : undefined}>
            <MoneyInput id="wo_amount" autoFocus value={amount} onChange={(e) => setAmount(e.target.value)} />
          </FormField>
          <FormField label="Date" htmlFor="wo_date">
            <Input id="wo_date" type="date" max={todayKarachi()} value={date} onChange={(e) => setDate(e.target.value)} />
          </FormField>
          <div className="col-span-2">
            <FormField label="Reason" htmlFor="wo_reason">
              <Input id="wo_reason" value={reason} onChange={(e) => setReason(e.target.value)} />
            </FormField>
          </div>
          {mode === 'edit' && (
            <div className="col-span-2">
              <ChangeReasonField id="wo_change_reason" value={changeReason} onChange={setChangeReason} />
            </div>
          )}
          {error && <p className="col-span-2 font-medium text-destructive">{error}</p>}
          <DialogFooter className="col-span-2">
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" variant={mode === 'create' ? 'destructive' : 'default'} disabled={!valid || save.isPending}>
              {mode === 'create' ? 'Write off' : mode === 'edit' ? 'Save' : 'Reverse'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
