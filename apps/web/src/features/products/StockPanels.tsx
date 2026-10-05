import { formatPaisa, type Product, type Variant } from '@shopledger/shared';
import { useState } from 'react';
import { Link } from 'react-router';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { errorMessage } from '@/lib/api';
import { cn } from '@/lib/utils';
import { useLowStock, useStockValuation, useVariantMovements } from './api';

const SOURCE_LABEL: Record<string, string> = {
  purchase: 'Purchase',
  purchase_return: 'Return to supplier',
  sale: 'Sale',
  sales_return: 'Customer return',
};

/** Stock on hand as a color × size grid. Click a cell for its movement history. */
export function StockGrid({ product }: { product: Product }) {
  const [variant, setVariant] = useState<Variant | null>(null);
  const variants = product.variants ?? [];
  const colors = product.colors.length ? product.colors : [''];
  const sizes = product.sizes.length ? product.sizes : [''];
  const find = (c: string, s: string) => variants.find((v) => v.color.toLowerCase() === c.toLowerCase() && v.size.toLowerCase() === s.toLowerCase());

  return (
    <>
      <table className="text-[15px]">
        <thead>
          <tr>
            <th />
            {sizes.map((s) => (
              <th key={s} className="px-3 pb-1 text-center font-semibold">
                {s || 'Stock'}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {colors.map((c) => (
            <tr key={c}>
              <th className="pr-4 text-left font-semibold">{c || '—'}</th>
              {sizes.map((s) => {
                const v = find(c, s);
                if (!v) return <td key={s} className="px-3 text-center text-muted-foreground">—</td>;
                const low = v.low_stock_threshold > 0 && v.stock_qty <= v.low_stock_threshold;
                return (
                  <td key={s} className="px-1 py-1">
                    <button
                      type="button"
                      onClick={() => setVariant(v)}
                      title="Show movements"
                      className={cn(
                        'amount h-10 w-20 cursor-pointer rounded-md border border-border px-2 text-base hover:border-primary',
                        v.stock_qty <= 0 && 'text-muted-foreground',
                        low && 'border-amber-500 bg-amber-50 font-bold text-amber-900',
                        v.stock_qty < 0 && 'border-destructive bg-red-50 text-destructive',
                      )}
                    >
                      {v.stock_qty}
                    </button>
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
      <p className="mt-2 text-sm text-muted-foreground">Amber: at or below the low-stock level. Click a number to see its history.</p>
      {variant && <MovementsDialog variant={variant} onClose={() => setVariant(null)} />}
    </>
  );
}

function MovementsDialog({ variant, onClose }: { variant: Variant; onClose: () => void }) {
  const { data, isPending, isError, error } = useVariantMovements(variant.id);
  const showCost = data?.some((m) => m.unit_cost_paisa !== undefined) ?? false;
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle className="font-mono">{variant.sku}</DialogTitle>
          <DialogDescription>Every stock movement, oldest first.</DialogDescription>
        </DialogHeader>
        {isPending && <p>Loading…</p>}
        {isError && <p className="text-destructive">{errorMessage(error)}</p>}
        {data && (
          <div className="max-h-[60vh] overflow-y-auto">
            <table className="w-full text-[15px]">
              <thead className="sticky top-0 bg-card text-left text-sm text-muted-foreground">
                <tr>
                  <th className="py-1">Date</th>
                  <th>What</th>
                  <th>Document</th>
                  <th className="text-right">In</th>
                  <th className="text-right">Out</th>
                  <th className="text-right">Balance</th>
                  {showCost && <th className="text-right">Unit cost</th>}
                </tr>
              </thead>
              <tbody>
                {data.length === 0 && (
                  <tr>
                    <td colSpan={7} className="py-4 text-muted-foreground">
                      No movements yet.
                    </td>
                  </tr>
                )}
                {data.map((m) => (
                  <tr key={m.id} className="border-t border-border">
                    <td className="py-1.5">{m.date}</td>
                    <td>{SOURCE_LABEL[m.source_type] ?? m.source_type}</td>
                    <td className="font-mono text-sm">
                      {m.source_type === 'purchase' ? (
                        <Link className="text-primary hover:underline" to={`/purchases/${m.source_id}`} onClick={onClose}>
                          {m.doc_no}
                        </Link>
                      ) : (
                        m.doc_no
                      )}
                    </td>
                    <td className="amount">{m.qty_change > 0 ? m.qty_change : ''}</td>
                    <td className="amount">{m.qty_change < 0 ? -m.qty_change : ''}</td>
                    <td className="amount font-semibold">{m.balance_qty}</td>
                    {showCost && <td className="amount">{m.unit_cost_paisa != null ? formatPaisa(m.unit_cost_paisa) : ''}</td>}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

export function LowStockPanel() {
  const { data, isPending, isError, error } = useLowStock();
  if (isPending) return <p>Loading…</p>;
  if (isError) return <p className="text-destructive">{errorMessage(error)}</p>;
  return (
    <div className="overflow-x-auto rounded-lg border border-border bg-card">
      <table className="w-full text-[15px]">
        <thead className="bg-muted text-left text-sm text-muted-foreground">
          <tr>
            <th className="px-3 py-2">Item</th>
            <th className="px-3 py-2">Category</th>
            <th className="px-3 py-2">Color</th>
            <th className="px-3 py-2">Size</th>
            <th className="px-3 py-2 text-right">In stock</th>
            <th className="px-3 py-2 text-right">Alert at</th>
          </tr>
        </thead>
        <tbody>
          {data.length === 0 && (
            <tr>
              <td colSpan={6} className="px-3 py-8 text-center text-muted-foreground">
                Nothing is low. (Only variants with a low-stock level above 0 are checked.)
              </td>
            </tr>
          )}
          {data.map((r) => (
            <tr key={r.variant_id} className="border-t border-border">
              <td className="px-3 py-2">
                <Link to={`/products/${r.product_id}`} className="font-mono font-semibold text-primary hover:underline">
                  {r.item_code}
                </Link>{' '}
                {r.name}
              </td>
              <td className="px-3 py-2">{r.category}</td>
              <td className="px-3 py-2">{r.color || '—'}</td>
              <td className="px-3 py-2">{r.size || '—'}</td>
              <td className={cn('amount px-3 py-2 font-bold', r.stock_qty <= 0 ? 'text-destructive' : 'text-amber-800')}>
                {r.stock_qty} {r.unit}
              </td>
              <td className="amount px-3 py-2">{r.low_stock_threshold}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Owner+ only. */
export function StockValuePanel() {
  const { data, isPending, isError, error } = useStockValuation(true);
  if (isPending) return <p>Loading…</p>;
  if (isError) return <p className="text-destructive">{errorMessage(error)}</p>;
  return (
    <div className="overflow-x-auto rounded-lg border border-border bg-card">
      <table className="w-full text-[15px]">
        <thead className="bg-muted text-left text-sm text-muted-foreground">
          <tr>
            <th className="px-3 py-2">Item</th>
            <th className="px-3 py-2">Category</th>
            <th className="px-3 py-2 text-right">In stock</th>
            <th className="px-3 py-2 text-right">Value at average cost</th>
          </tr>
        </thead>
        <tbody>
          {data.rows.map((r) => (
            <tr key={r.product_id} className="border-t border-border">
              <td className="px-3 py-2">
                <Link to={`/products/${r.product_id}`} className="font-mono font-semibold text-primary hover:underline">
                  {r.item_code}
                </Link>{' '}
                {r.name}
              </td>
              <td className="px-3 py-2">{r.category}</td>
              <td className="amount px-3 py-2">{r.stock_qty}</td>
              <td className="amount px-3 py-2">{formatPaisa(r.stock_value_paisa)}</td>
            </tr>
          ))}
        </tbody>
        <tfoot className="border-t-2 border-border font-bold">
          <tr>
            <td className="px-3 py-2" colSpan={2}>
              Total
            </td>
            <td className="amount px-3 py-2">{data.total_qty}</td>
            <td className="amount px-3 py-2 text-lg">{formatPaisa(data.total_value_paisa)}</td>
          </tr>
        </tfoot>
      </table>
    </div>
  );
}
