import { useMutation, useQueryClient } from '@tanstack/react-query';
import { bpToPercentString, formatPaisa, type Purchase, type PurchaseReturn } from '@shopledger/shared';
import { ArrowLeft, Printer, Undo2 } from 'lucide-react';
import { useState } from 'react';
import { Link, useParams } from 'react-router';
import { toast } from 'sonner';
import { FormField } from '@/components/FormField';
import { FullPageMessage } from '@/components/FullPageMessage';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { useCan } from '@/features/auth/useAuth';
import { PRODUCTS_KEY } from '@/features/products/api';
import { printPurchase, PURCHASES_KEY, usePurchase } from '@/features/purchases/api';
import { api, errorMessage } from '@/lib/api';
import { formatDateTime } from '@/lib/utils';

export function PurchaseDetailPage() {
  const id = Number(useParams().id);
  const can = useCan();
  const { data: p, isPending, isError, error } = usePurchase(id);
  const [returning, setReturning] = useState(false);
  const [printing, setPrinting] = useState(false);

  if (isPending) return <p>Loading…</p>;
  if (isError) return <FullPageMessage inline title="Purchase not found" detail={errorMessage(error)} />;

  const lines = p.lines ?? [];
  const showCost = p.total_cost_paisa !== undefined;
  const canReturn = can('purchases.create') && p.status === 'posted' && lines.some((l) => l.qty > l.returned_qty);

  const print = async () => {
    setPrinting(true);
    try {
      await printPurchase(p.id);
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setPrinting(false);
    }
  };

  return (
    <div className="max-w-6xl">
      <Link to="/purchases" className="mb-2 inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
        <ArrowLeft className="size-4" /> Purchases
      </Link>
      <div className="mb-5 flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="flex items-center gap-3 text-2xl font-bold">
            Purchase {p.doc_no} {p.status === 'void' && <Badge variant="grey">VOID</Badge>}
          </h1>
          <p className="text-muted-foreground">
            {p.date} · {p.supplier_name}
            {p.supplier_ref && ` · bill ${p.supplier_ref}`} · entered by {p.created_by_name ?? '—'} on {formatDateTime(p.created_at)}
          </p>
        </div>
        <div className="flex gap-2">
          {can('purchases.create') && (
            <Button variant="outline" onClick={() => void print()} disabled={printing}>
              <Printer /> Print / PDF
            </Button>
          )}
          {canReturn && (
            <Button variant="outline" onClick={() => setReturning(true)}>
              <Undo2 /> Return items
            </Button>
          )}
        </div>
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
              <th className="px-3 py-2 text-right">Returned</th>
              <th className="px-3 py-2 text-right">Price</th>
              {showCost && <th className="px-3 py-2 text-right">Margin</th>}
              {showCost && <th className="px-3 py-2 text-right">Cost</th>}
            </tr>
          </thead>
          <tbody>
            {lines.map((l) => (
              <tr key={l.id} className="border-t border-border">
                <td className="px-3 py-1.5 text-muted-foreground">{l.line_no}</td>
                <td className="px-3 py-1.5">
                  <span className="font-mono font-semibold">{l.item_code}</span> <span className="text-sm text-muted-foreground">{l.name}</span>
                </td>
                <td className="px-3 py-1.5">{l.color || '—'}</td>
                <td className="px-3 py-1.5">{l.size || '—'}</td>
                <td className="amount px-3 py-1.5">{l.qty}</td>
                <td className="amount px-3 py-1.5">{l.returned_qty || ''}</td>
                <td className="amount px-3 py-1.5">{formatPaisa(l.list_price_paisa)}</td>
                {showCost && <td className="amount px-3 py-1.5">{bpToPercentString(l.supplier_margin_bp ?? 0)}%</td>}
                {showCost && <td className="amount px-3 py-1.5">{formatPaisa(l.line_cost_paisa ?? 0)}</td>}
              </tr>
            ))}
          </tbody>
          <tfoot className="border-t-2 border-border">
            <tr>
              <td colSpan={4} className="px-3 py-2 text-right text-muted-foreground">
                Gross {formatPaisa(p.gross_paisa)}
                {showCost && ` · margin −${formatPaisa(p.margin_paisa ?? 0)}`}
              </td>
              <td className="amount px-3 py-2 font-semibold">{p.total_qty}</td>
              <td colSpan={showCost ? 3 : 2} />
              {showCost && <td className="amount px-3 py-2 text-lg font-bold">{formatPaisa(p.total_cost_paisa ?? 0)}</td>}
            </tr>
          </tfoot>
        </table>
      </div>
      {p.notes && <p className="mt-3">Notes: {p.notes}</p>}

      {p.returns && p.returns.length > 0 && (
        <Card className="mt-5">
          <CardHeader>
            <CardTitle>Returns to supplier</CardTitle>
          </CardHeader>
          <CardContent>
            <ul className="flex flex-col gap-1">
              {p.returns.map((r) => (
                <li key={r.id}>
                  <span className="font-mono font-semibold">{r.doc_no}</span> · {r.date} · {r.reason}
                  {r.total_cost_paisa !== undefined && <span className="amount ml-2">{formatPaisa(r.total_cost_paisa)}</span>}
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      )}

      {returning && <ReturnDialog purchase={p} onClose={() => setReturning(false)} />}
    </div>
  );
}

function todayKarachi(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Karachi' }).format(new Date());
}

function ReturnDialog({ purchase, onClose }: { purchase: Purchase; onClose: () => void }) {
  const qc = useQueryClient();
  const lines = (purchase.lines ?? []).filter((l) => l.qty > l.returned_qty);
  const [qty, setQty] = useState<Record<number, string>>({});
  const [date, setDate] = useState(todayKarachi());
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);

  const picked = lines.map((l) => ({ l, n: Number(qty[l.id] || 0) })).filter((x) => x.n > 0);
  const tooMany = picked.find((x) => x.n > x.l.qty - x.l.returned_qty || !Number.isInteger(x.n));

  const save = useMutation({
    mutationFn: () =>
      api.post<{ purchase_return: PurchaseReturn }>(`/api/purchases/${purchase.id}/returns`, {
        date,
        reason,
        lines: picked.map((x) => ({ purchase_item_id: x.l.id, qty: x.n })),
      }),
    onSuccess: ({ purchase_return }) => {
      void qc.invalidateQueries({ queryKey: PURCHASES_KEY });
      void qc.invalidateQueries({ queryKey: PRODUCTS_KEY });
      void qc.invalidateQueries({ queryKey: ['suppliers'] });
      toast.success(`Return ${purchase_return.doc_no} saved.`);
      onClose();
    },
    onError: (e) => setError(errorMessage(e)),
  });

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>Return items to the supplier</DialogTitle>
          <DialogDescription>From {purchase.doc_no}. Only items still in stock can be sent back.</DialogDescription>
        </DialogHeader>
        <div className="max-h-[50vh] overflow-y-auto">
          <table className="w-full text-[15px]">
            <thead className="text-left text-sm text-muted-foreground">
              <tr>
                <th className="py-1">Item</th>
                <th className="text-right">Bought</th>
                <th className="text-right">Already returned</th>
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
                    <td className="amount">{l.returned_qty}</td>
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
          <FormField label="Date" htmlFor="pr_date">
            <Input id="pr_date" type="date" min={purchase.date} max={todayKarachi()} value={date} onChange={(e) => setDate(e.target.value)} />
          </FormField>
          <div className="md:col-span-2">
            <FormField label="Reason" htmlFor="pr_reason">
              <Input id="pr_reason" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Cracked on delivery" />
            </FormField>
          </div>
        </div>
        {tooMany && <p className="font-medium text-destructive">{tooMany.l.item_code}: you can return at most {tooMany.l.qty - tooMany.l.returned_qty}.</p>}
        {error && <p className="font-medium text-destructive">{error}</p>}
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={() => save.mutate()} disabled={save.isPending || picked.length === 0 || !!tooMany || reason.trim().length < 3}>
            Save return
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
