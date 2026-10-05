import type { Product, Variant } from '@shopledger/shared';
import { useRef, useState, type KeyboardEvent } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { cn } from '@/lib/utils';

export interface GridPick {
  variant: Variant;
  qty: number;
}

/**
 * Size × color grid (CLAUDE.md 10.1): one row per color, one column per size,
 * stock on hand in each cell. Type quantities; Enter moves to the next cell,
 * Ctrl+Enter (or the button) adds a line for every non-zero cell.
 */
export function SizeColorGrid({
  product,
  onAdd,
  onClose,
  warnAboveStock = false,
}: {
  product: Product;
  onAdd: (picks: GridPick[]) => void;
  onClose: () => void;
  /** Sale screens: highlight quantities above stock on hand. */
  warnAboveStock?: boolean;
}) {
  const variants = product.variants ?? [];
  const colors = product.colors.length ? product.colors : [''];
  const sizes = product.sizes.length ? product.sizes : [''];
  const find = (c: string, s: string) =>
    variants.find((v) => v.color.toLowerCase() === c.toLowerCase() && v.size.toLowerCase() === s.toLowerCase() && v.active);
  const [qty, setQty] = useState<Record<number, string>>({});
  const inputs = useRef<(HTMLInputElement | null)[]>([]);

  const picks = (): GridPick[] =>
    variants
      .map((v) => ({ variant: v, qty: Number(qty[v.id] || 0) }))
      .filter((p) => Number.isInteger(p.qty) && p.qty > 0);

  const submit = () => {
    const ps = picks();
    if (ps.length) onAdd(ps);
  };

  const onKey = (e: KeyboardEvent<HTMLInputElement>, idx: number) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      if (e.ctrlKey) return submit();
      const next = inputs.current.slice(idx + 1).find(Boolean);
      if (next) next.focus();
      else submit();
    }
  };

  // Input order for Enter-to-next: row by row, active cells only.
  const order = colors.flatMap((c) => sizes.map((s) => find(c, s)?.id).filter((id): id is number => id !== undefined));
  const total = picks().reduce((a, p) => a + p.qty, 0);
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-4xl">
        <DialogHeader>
          <DialogTitle>
            <span className="font-mono">{product.item_code}</span> {product.name}
          </DialogTitle>
          <DialogDescription>Type quantities. Enter moves to the next box; Ctrl+Enter adds the lines. Small numbers show stock on hand.</DialogDescription>
        </DialogHeader>
        <div className="max-h-[60vh] overflow-auto">
          <table className="text-[15px]">
            <thead>
              <tr>
                <th />
                {sizes.map((s) => (
                  <th key={s} className="px-2 pb-2 text-center font-semibold">
                    {s || 'Qty'}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {colors.map((c) => (
                <tr key={c}>
                  <th className="pr-3 text-left font-semibold">{c || '—'}</th>
                  {sizes.map((s) => {
                    const v = find(c, s);
                    if (!v) return <td key={s} className="px-1 text-center text-muted-foreground">—</td>;
                    const my = order.indexOf(v.id);
                    const n = Number(qty[v.id] || 0);
                    const over = warnAboveStock && n > v.stock_qty;
                    return (
                      <td key={s} className="px-1 py-1">
                        <input
                          ref={(el) => {
                            inputs.current[my] = el;
                          }}
                          autoFocus={my === 0}
                          inputMode="numeric"
                          aria-label={`${c} ${s} quantity`}
                          className={cn(
                            'amount h-10 w-20 rounded-md border border-input bg-card px-2 text-base',
                            n > 0 && 'border-primary bg-blue-50 font-bold',
                            over && 'border-destructive bg-red-50',
                          )}
                          value={qty[v.id] ?? ''}
                          onChange={(e) => setQty((q) => ({ ...q, [v.id]: e.target.value.replace(/\D/g, '') }))}
                          onKeyDown={(e) => onKey(e, my)}
                        />
                        <div className={cn('mt-0.5 text-center text-xs', v.stock_qty <= 0 ? 'text-destructive' : 'text-muted-foreground')}>{v.stock_qty} in stock</div>
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <DialogFooter className="items-center">
          <span className="mr-auto text-sm text-muted-foreground">
            {total} {product.unit} selected
          </span>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={total === 0}>
            Add lines
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
