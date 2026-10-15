import { useMutation, useQueryClient } from '@tanstack/react-query';
import { bpToPercentString, formatPaisa, parsePercentToBp, parseRupeesToPaisa, type BulkUpdateRow } from '@shopledger/shared';
import { useState } from 'react';
import { toast } from 'sonner';
import { FormField } from '@/components/FormField';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input, NativeSelect } from '@/components/ui/input';
import { api, errorMessage } from '@/lib/api';
import { PRODUCTS_KEY, useCategories } from './api';

type ChangeKind = 'price_percent' | 'price_amount' | 'supplier_margin' | 'default_discount';

const KIND_LABEL: Record<ChangeKind, string> = {
  price_percent: 'Change price by %',
  price_amount: 'Change price by amount (Rs)',
  supplier_margin: 'Set supplier margin %',
  default_discount: 'Set default customer discount %',
};

/** Owner+: change price, supplier margin or default discount for many products at once. */
export function BulkUpdateDialog({ selectedIds, onClose }: { selectedIds: number[]; onClose: () => void }) {
  const qc = useQueryClient();
  const categories = useCategories();
  const [targetKind, setTargetKind] = useState<'category' | 'products'>(selectedIds.length ? 'products' : 'category');
  const [category, setCategory] = useState('');
  const [kind, setKind] = useState<ChangeKind>('price_percent');
  const [value, setValue] = useState('');
  const [reason, setReason] = useState('');
  const [preview, setPreview] = useState<BulkUpdateRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const buildBody = (dry_run: boolean) => {
    const neg = value.trim().startsWith('-');
    const abs = value.trim().replace(/^[-+]/, '');
    let change: Record<string, unknown>;
    if (kind === 'price_amount') {
      const p = parseRupeesToPaisa(abs);
      if (p === null) throw new Error('Enter an amount like 50 or -25');
      change = { kind, paisa: neg ? -p : p };
    } else {
      const bp = parsePercentToBp(abs);
      if (bp === null) throw new Error('Enter a percentage like 5 or 7.5');
      if (kind !== 'price_percent' && neg) throw new Error('Margins and discounts cannot be negative');
      change = { kind, bp: neg ? -bp : bp };
    }
    if (targetKind === 'category' && !category) throw new Error('Pick a category');
    const target = targetKind === 'category' ? { kind: 'category', category } : { kind: 'products', product_ids: selectedIds };
    return { target, change, reason, dry_run };
  };

  const run = useMutation({
    mutationFn: (dry: boolean) => api.post<{ rows: BulkUpdateRow[]; applied: boolean }>('/api/products/bulk-update', buildBody(dry)),
    onSuccess: (r) => {
      if (r.applied) {
        void qc.invalidateQueries({ queryKey: PRODUCTS_KEY });
        toast.success(`${r.rows.length} product${r.rows.length === 1 ? '' : 's'} updated.`);
        onClose();
      } else setPreview(r.rows);
    },
    onError: (e) => setError(errorMessage(e)),
  });

  const go = (dry: boolean) => {
    setError(null);
    try {
      buildBody(dry);
    } catch (e) {
      setError(errorMessage(e));
      return;
    }
    run.mutate(dry);
  };

  const reset = () => setPreview(null);
  const fmt = (r: BulkUpdateRow['before']) => {
    if (kind === 'supplier_margin') return `${bpToPercentString(r.supplier_margin_bp)}%`;
    if (kind === 'default_discount') return `${bpToPercentString(r.default_customer_discount_bp)}%`;
    return formatPaisa(r.list_price_paisa);
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Bulk update</DialogTitle>
          <DialogDescription>Preview first. Every change is recorded in price history and the change log. Stock already bought keeps its cost.</DialogDescription>
        </DialogHeader>
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <FormField label="Products" htmlFor="b_target">
            <NativeSelect
              id="b_target"
              value={targetKind}
              onChange={(e) => {
                setTargetKind(e.target.value as 'category' | 'products');
                reset();
              }}
            >
              <option value="category">A whole category</option>
              {selectedIds.length > 0 && <option value="products">The {selectedIds.length} selected products</option>}
            </NativeSelect>
          </FormField>
          {targetKind === 'category' && (
            <FormField label="Category" htmlFor="b_category">
              <NativeSelect
                id="b_category"
                value={category}
                onChange={(e) => {
                  setCategory(e.target.value);
                  reset();
                }}
              >
                <option value="">Pick a category…</option>
                {categories.data?.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </NativeSelect>
            </FormField>
          )}
          <FormField label="Change" htmlFor="b_kind">
            <NativeSelect
              id="b_kind"
              value={kind}
              onChange={(e) => {
                setKind(e.target.value as ChangeKind);
                reset();
              }}
            >
              {Object.entries(KIND_LABEL).map(([k, l]) => (
                <option key={k} value={k}>
                  {l}
                </option>
              ))}
            </NativeSelect>
          </FormField>
          <FormField
            label={kind === 'price_amount' ? 'Amount (Rs)' : 'Percent'}
            htmlFor="b_value"
            hint={kind.startsWith('price') ? 'Use minus to lower prices, e.g. -5' : undefined}
          >
            <Input
              id="b_value"
              className="amount"
              value={value}
              onChange={(e) => {
                setValue(e.target.value);
                reset();
              }}
            />
          </FormField>
          <div className="md:col-span-2">
            <FormField label="Reason" htmlFor="b_reason">
              <Input id="b_reason" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Manufacturer price list August 2026" />
            </FormField>
          </div>
        </div>

        {preview && (
          <div className="max-h-64 overflow-y-auto rounded-md border border-border">
            <table className="w-full text-sm">
              <thead className="sticky top-0 bg-muted text-left text-muted-foreground">
                <tr>
                  <th className="px-3 py-1.5">Item</th>
                  <th className="px-3 py-1.5 text-right">Now</th>
                  <th className="px-3 py-1.5 text-right">New</th>
                </tr>
              </thead>
              <tbody>
                {preview.length === 0 && (
                  <tr>
                    <td colSpan={3} className="px-3 py-3 text-muted-foreground">
                      Nothing would change.
                    </td>
                  </tr>
                )}
                {preview.map((r) => (
                  <tr key={r.product_id} className="border-t border-border">
                    <td className="px-3 py-1.5">
                      <span className="font-mono font-semibold">{r.item_code}</span> {r.name}
                    </td>
                    <td className="amount px-3 py-1.5">{fmt(r.before)}</td>
                    <td className="amount px-3 py-1.5 font-semibold">{fmt(r.after)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {error && <p className="font-medium text-destructive">{error}</p>}
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="secondary" onClick={() => go(true)} disabled={run.isPending}>
            Preview
          </Button>
          <Button onClick={() => go(false)} disabled={run.isPending || !preview || preview.length === 0 || reason.trim().length < 3}>
            Apply to {preview?.length ?? 0} product{preview?.length === 1 ? '' : 's'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
