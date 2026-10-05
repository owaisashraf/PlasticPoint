import { useMutation } from '@tanstack/react-query';
import { formatPaisa, paisaToInput, parseRupeesToPaisa, roundDiv, type Sale, type SalesReturn } from '@shopledger/shared';
import { useState } from 'react';
import { toast } from 'sonner';
import { FormField } from '@/components/FormField';
import { MoneyInput } from '@/components/inputs';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input, NativeSelect } from '@/components/ui/input';
import { api, errorMessage } from '@/lib/api';
import { useRefreshAfterMoney } from './api';

function todayKarachi(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Karachi' }).format(new Date());
}

/**
 * Goods back from a customer (CLAUDE.md 8.7), started from the invoice. The
 * customer is credited what they actually paid (after discounts). The credit
 * reduces this invoice first; cash can also be paid back now.
 */
export function SalesReturnDialog({ sale, onClose }: { sale: Sale; onClose: () => void }) {
  const refresh = useRefreshAfterMoney();
  const lines = (sale.lines ?? []).filter((l) => l.qty > l.returned_qty);
  const [qty, setQty] = useState<Record<number, string>>({});
  const [date, setDate] = useState(todayKarachi());
  const [reason, setReason] = useState('');
  const [refundOn, setRefundOn] = useState(false);
  const [refund, setRefund] = useState('');
  const [method, setMethod] = useState<'cash' | 'bank' | 'online'>('cash');
  const [error, setError] = useState<string | null>(null);

  const picked = lines.map((l) => ({ l, n: Number(qty[l.id] || 0) })).filter((x) => x.n > 0);
  const tooMany = picked.find((x) => x.n > x.l.qty - x.l.returned_qty);
  // Estimate shown while typing; the server works out the exact credit (the last return of a line takes what is left).
  const credit = picked.reduce((a, x) => a + roundDiv(x.l.line_net_paisa * x.n, x.l.qty), 0);
  const refundPaisa = refundOn && refund.trim() ? parseRupeesToPaisa(refund) : 0;
  const refundBad = refundOn && (refundPaisa === null || refundPaisa <= 0 || refundPaisa > credit);
  const valid = picked.length > 0 && !tooMany && reason.trim().length >= 3 && !refundBad;

  const save = useMutation({
    mutationFn: () =>
      api.post<{ sales_return: SalesReturn }>(`/api/sales/${sale.id}/returns`, {
        date,
        reason,
        lines: picked.map((x) => ({ sale_item_id: x.l.id, qty: x.n })),
        ...(refundOn && refundPaisa ? { refund: { amount_paisa: refundPaisa, method } } : {}),
      }),
    onSuccess: ({ sales_return: r }) => {
      refresh();
      toast.success(`Return ${r.doc_no} saved: ${formatPaisa(r.total_paisa)} credited${r.refunded_paisa ? `, ${formatPaisa(r.refunded_paisa)} paid back` : ''}.`);
      onClose();
    },
    onError: (e) => setError(errorMessage(e)),
  });

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>Return items from {sale.doc_no}</DialogTitle>
          <DialogDescription>
            {sale.customer_name} is credited what they paid for these items. The credit reduces this invoice first; anything extra stays as an advance unless you pay it back now.
          </DialogDescription>
        </DialogHeader>
        <div className="max-h-[45vh] overflow-y-auto">
          <table className="w-full text-[15px]">
            <thead className="text-left text-sm text-muted-foreground">
              <tr>
                <th className="py-1">Item</th>
                <th className="text-right">Sold</th>
                <th className="text-right">Returned</th>
                <th className="text-right">Paid each</th>
                <th className="text-right">Return now</th>
              </tr>
            </thead>
            <tbody>
              {lines.map((l, i) => {
                const left = l.qty - l.returned_qty;
                const n = Number(qty[l.id] || 0);
                return (
                  <tr key={l.id} className="border-t border-border">
                    <td className="py-1.5">
                      <span className="font-mono font-semibold">{l.item_code}</span> {[l.color, l.size].filter(Boolean).join(' / ')}
                    </td>
                    <td className="amount">{l.qty}</td>
                    <td className="amount">{l.returned_qty || ''}</td>
                    <td className="amount">{formatPaisa(roundDiv(l.line_net_paisa, l.qty))}</td>
                    <td className="text-right">
                      <Input
                        autoFocus={i === 0}
                        className={n > left ? 'amount ml-auto h-8 w-20 border-destructive' : 'amount ml-auto h-8 w-20'}
                        inputMode="numeric"
                        placeholder={`max ${left}`}
                        value={qty[l.id] ?? ''}
                        onChange={(e) => setQty((q) => ({ ...q, [l.id]: e.target.value.replace(/\D/g, '') }))}
                        aria-label={`Return quantity for ${l.item_code} ${l.color} ${l.size}`}
                      />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
          <FormField label="Date" htmlFor="sr_date">
            <Input id="sr_date" type="date" min={sale.date} max={todayKarachi()} value={date} onChange={(e) => setDate(e.target.value)} />
          </FormField>
          <div className="md:col-span-2">
            <FormField label="Reason" htmlFor="sr_reason">
              <Input id="sr_reason" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Cracked, wrong size" />
            </FormField>
          </div>
        </div>
        <div className="rounded-md border border-border p-3">
          <label className="flex items-center gap-2 font-medium">
            <input
              type="checkbox"
              checked={refundOn}
              onChange={(e) => {
                setRefundOn(e.target.checked);
                if (e.target.checked && !refund && credit > 0) setRefund(paisaToInput(credit));
              }}
            />
            Pay money back now
          </label>
          {refundOn && (
            <div className="mt-3 grid grid-cols-2 gap-4">
              <FormField label="Refund amount" htmlFor="sr_refund" error={refundBad ? `Up to ${formatPaisa(credit)}` : undefined}>
                <MoneyInput id="sr_refund" value={refund} onChange={(e) => setRefund(e.target.value)} />
              </FormField>
              <FormField label="Paid by" htmlFor="sr_refund_method">
                <NativeSelect id="sr_refund_method" value={method} onChange={(e) => setMethod(e.target.value as typeof method)}>
                  <option value="cash">Cash</option>
                  <option value="bank">Bank transfer</option>
                  <option value="online">Online / wallet</option>
                </NativeSelect>
              </FormField>
            </div>
          )}
        </div>
        <div className="text-right text-lg">
          Credit <span className="amount font-bold">{formatPaisa(credit)}</span>
        </div>
        {tooMany && <p className="font-medium text-destructive">{tooMany.l.item_code}: you can return at most {tooMany.l.qty - tooMany.l.returned_qty}.</p>}
        {error && <p className="font-medium text-destructive">{error}</p>}
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={() => save.mutate()} disabled={!valid || save.isPending}>
            {save.isPending ? 'Saving…' : 'Save return'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
