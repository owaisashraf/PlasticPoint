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

type Mode = 'create' | 'reverse' | 'edit';

/** The dialog's wording for each mode. */
function copyFor(mode: Mode, customerName: string, docNo: string | undefined, max: number) {
  switch (mode) {
    case 'create':
      return {
        title: `Write off ${customerName}'s debt`,
        description: `Up to the balance of ${formatPaisa(max)}. The oldest invoices are cleared first and stop counting as overdue. This is recorded in the change history.`,
        done: 'Written off.',
        confirm: 'Write off',
      };
    case 'edit':
      return {
        title: `Edit write-off ${docNo}`,
        description: `Up to ${formatPaisa(max)}: what ${customerName} would owe without this write-off. Recorded in the change history.`,
        done: 'Write-off updated.',
        confirm: 'Save',
      };
    case 'reverse':
      return {
        title: `Reverse write-off ${docNo}`,
        description: `The customer is paying after all. Up to ${formatPaisa(max)} can be taken back; then record their payment as usual.`,
        done: 'Write-off reversed. Now record the payment.',
        confirm: 'Reverse',
      };
  }
}

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
  mode: Mode;
  customerId: number;
  customerName: string;
  /** Balance (create) or amount still written off (reverse). */
  max: number;
  writeOff?: WriteOff;
  onClose: () => void;
}) {
  const refresh = useRefreshAfterMoney();
  const copy = copyFor(mode, customerName, writeOff?.doc_no, max);
  const editing = mode === 'edit' ? writeOff : undefined;
  const [amount, setAmount] = useState(paisaToInput(editing?.amount_paisa ?? max));
  const [date, setDate] = useState(editing?.date ?? todayKarachi());
  const [reason, setReason] = useState(editing?.reason ?? '');
  const [changeReason, setChangeReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const amountPaisa = parseRupeesToPaisa(amount);
  const valid = amountPaisa !== null && amountPaisa > 0 && amountPaisa <= max && reason.trim().length >= 3 && (mode !== 'edit' || changeReasonOk(changeReason));

  const save = useMutation({
    mutationFn: () => {
      const body = { date, amount_paisa: amountPaisa, reason };
      switch (mode) {
        case 'create':
          return api.post<{ write_off: WriteOff }>(`/api/customers/${customerId}/write-offs`, body);
        case 'reverse':
          return api.post<{ write_off: WriteOff }>(`/api/write-offs/${writeOff?.id}/reverse`, body);
        case 'edit':
          return api.put<{ write_off: WriteOff }>(`/api/write-offs/${writeOff?.id}`, { ...body, change_reason: changeReason });
      }
    },
    onSuccess: () => {
      refresh();
      toast.success(copy.done);
      onClose();
    },
    onError: (e) => setError(errorMessage(e)),
  });

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{copy.title}</DialogTitle>
          <DialogDescription>{copy.description}</DialogDescription>
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
              {copy.confirm}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
