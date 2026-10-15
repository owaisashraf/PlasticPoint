import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  applyBp,
  bpToPercentString,
  formatPaisa,
  paisaToInput,
  parsePercentToBp,
  parseRupeesToPaisa,
  type Product,
  type Purchase,
} from '@shopledger/shared';
import { Trash2 } from 'lucide-react';
import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { toast } from 'sonner';
import { ItemEntry } from '@/components/document/ItemEntry';
import type { GridPick } from '@/components/document/SizeColorGrid';
import { FormField } from '@/components/FormField';
import { PageHeader } from '@/components/PageHeader';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input, NativeSelect } from '@/components/ui/input';
import { useCan } from '@/features/auth/useAuth';
import { ChangeReasonField, changeReasonOk } from '@/features/documents';
import { PRODUCTS_KEY } from '@/features/products/api';
import { loadPurchaseProduct, PURCHASES_KEY, useSuppliers } from '@/features/purchases/api';
import { api, errorMessage } from '@/lib/api';
import { useHotkey } from '@/lib/useHotkey';
import { cn, todayKarachi } from '@/lib/utils';

interface Line {
  key: string;
  variant_id: number;
  product_id: number;
  item_code: string;
  name: string;
  color: string;
  size: string;
  unit: string;
  qty: string;
  price: string;
  margin: string;
  product_price_paisa: number;
  product_margin_bp: number;
}

function lineAmounts(l: Line) {
  const qty = Number(l.qty);
  const price = parseRupeesToPaisa(l.price);
  const bp = parsePercentToBp(l.margin);
  if (!Number.isInteger(qty) || qty <= 0 || price === null || price <= 0 || bp === null || bp > 10_000) return null;
  const gross = qty * price;
  const margin = applyBp(gross, bp);
  return { qty, price, bp, gross, margin, cost: gross - margin };
}

interface ProductChange {
  product_id: number;
  item_code: string;
  name: string;
  oldPrice: number;
  newPrice: number | null;
  oldMargin: number;
  newMargin: number | null;
}

/** /purchases/:id/edit — the purchase screen in edit mode. */
export function EditPurchasePage() {
  const id = Number(useParams().id);
  return <NewPurchasePage key={id} editId={id} />;
}

export function NewPurchasePage({ editId }: { editId?: number } = {}) {
  const can = useCan();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const suppliers = useSuppliers();
  const active = (suppliers.data ?? []).filter((s) => s.active);
  const [supplierId, setSupplierId] = useState<number | null>(null);
  const [date, setDate] = useState(todayKarachi());
  const [ref, setRef] = useState('');
  const [notes, setNotes] = useState('');
  const [lines, setLines] = useState<Line[]>([]);
  const [changes, setChanges] = useState<ProductChange[] | null>(null);
  const [changeReason, setChangeReason] = useState('');
  // Edit mode (CLAUDE.md 8.6): load the purchase once and fill the form.
  const editing = useQuery({
    queryKey: [...PURCHASES_KEY, 'one', editId],
    queryFn: () => api.get<{ purchase: Purchase }>(`/api/purchases/${editId}`).then((r) => r.purchase),
    enabled: editId !== undefined,
  });
  const original = editing.data;
  const [loaded, setLoaded] = useState(false);
  if (editId !== undefined && !loaded && original) {
    setLoaded(true);
    setSupplierId(original.supplier_id);
    setDate(original.date);
    setRef(original.supplier_ref ?? '');
    setNotes(original.notes ?? '');
    setLines(
      (original.lines ?? []).map((l) => ({
        key: String(l.variant_id),
        variant_id: l.variant_id,
        product_id: l.product_id,
        item_code: l.item_code,
        name: l.name,
        color: l.color,
        size: l.size,
        unit: l.unit,
        qty: String(l.qty),
        price: paisaToInput(l.list_price_paisa),
        margin: bpToPercentString(l.supplier_margin_bp ?? 0),
        product_price_paisa: l.list_price_paisa,
        product_margin_bp: l.supplier_margin_bp ?? 0,
      })),
    );
  }
  const effectiveSupplier = supplierId ?? (active.length === 1 ? (active[0]?.id ?? null) : null);

  const addPicks = (product: Product, picks: GridPick[]) => {
    // Pure updater (React may run it twice in development).
    setLines((ls) => {
      let next = ls;
      for (const { variant, qty } of picks) {
        if (next.some((l) => l.variant_id === variant.id)) {
          next = next.map((l) => (l.variant_id === variant.id ? { ...l, qty: String(Number(l.qty || 0) + qty) } : l));
        } else {
          next = [
            ...next,
            {
              key: String(variant.id),
              variant_id: variant.id,
              product_id: product.id,
              item_code: product.item_code,
              name: product.name,
              color: variant.color,
              size: variant.size,
              unit: product.unit,
              qty: String(qty),
              price: paisaToInput(product.list_price_paisa),
              margin: bpToPercentString(product.supplier_margin_bp ?? 0),
              product_price_paisa: product.list_price_paisa,
              product_margin_bp: product.supplier_margin_bp ?? 0,
            },
          ];
        }
      }
      return next;
    });
  };

  const update = (key: string, field: 'qty' | 'price' | 'margin', value: string) =>
    setLines((ls) => ls.map((l) => (l.key === key ? { ...l, [field]: value } : l)));

  // Same price or margin for every line of a product (bills list one price per item).
  const applyToProduct = (productId: number, field: 'price' | 'margin', value: string) =>
    setLines((ls) => ls.map((l) => (l.product_id === productId ? { ...l, [field]: value } : l)));

  const amounts = lines.map(lineAmounts);
  const valid = lines.length > 0 && amounts.every(Boolean);
  const totals = amounts.reduce((a, x) => (x ? { qty: a.qty + x.qty, gross: a.gross + x.gross, margin: a.margin + x.margin, cost: a.cost + x.cost } : a), {
    qty: 0,
    gross: 0,
    margin: 0,
    cost: 0,
  });

  const save = useMutation({
    mutationFn: (update_products: { product_id: number; list_price_paisa?: number; supplier_margin_bp?: number }[]) => {
      const body = {
        supplier_id: effectiveSupplier,
        date,
        supplier_ref: ref,
        notes,
        lines: lines.map((l, i) => {
          const a = amounts[i];
          return { variant_id: l.variant_id, qty: a?.qty, list_price_paisa: a?.price, supplier_margin_bp: a?.bp };
        }),
      };
      return editId === undefined
        ? api.post<{ purchase: Purchase }>('/api/purchases', { ...body, update_products })
        : api.put<{ purchase: Purchase }>(`/api/purchases/${editId}`, { ...body, change_reason: changeReason });
    },
    onSuccess: ({ purchase }) => {
      void qc.invalidateQueries({ queryKey: PURCHASES_KEY });
      void qc.invalidateQueries({ queryKey: PRODUCTS_KEY });
      void qc.invalidateQueries({ queryKey: ['suppliers'] });
      toast.success(editId === undefined ? `Purchase ${purchase.doc_no} saved.` : `Purchase ${purchase.doc_no} updated (version ${purchase.version}).`);
      navigate(`/purchases/${purchase.id}`);
    },
    onError: (e) => toast.error(errorMessage(e)),
  });

  const trySave = () => {
    if (!effectiveSupplier) return toast.error('Pick the supplier.');
    if (!valid) return toast.error('Check the highlighted lines: quantity, price and margin are needed.');
    if (editId !== undefined && !changeReasonOk(changeReason)) return toast.error('Enter the reason for the change.');
    // Owner+: offer to update products whose bill price or margin differs (new purchases only).
    if (can('pricing.manage') && editId === undefined) {
      const diff = new Map<number, ProductChange>();
      lines.forEach((l, i) => {
        const a = amounts[i];
        if (!a || diff.has(l.product_id)) return;
        const priceChanged = a.price !== l.product_price_paisa;
        const marginChanged = a.bp !== l.product_margin_bp;
        if (priceChanged || marginChanged) {
          diff.set(l.product_id, {
            product_id: l.product_id,
            item_code: l.item_code,
            name: l.name,
            oldPrice: l.product_price_paisa,
            newPrice: priceChanged ? a.price : null,
            oldMargin: l.product_margin_bp,
            newMargin: marginChanged ? a.bp : null,
          });
        }
      });
      if (diff.size) return setChanges([...diff.values()]);
    }
    save.mutate([]);
  };

  useHotkey('ctrl+s', () => {
    if (!save.isPending && !changes) trySave();
  });

  if (suppliers.isSuccess && active.length === 0) {
    return (
      <div>
        <PageHeader title="New purchase" />
        <p>
          No supplier yet. {can('suppliers.manage') ? 'Add it on the ' : 'Ask the owner to add it on the '}
          <Link className="text-primary underline" to="/purchases">
            Purchases → Supplier
          </Link>{' '}
          tab.
        </p>
      </div>
    );
  }

  return (
    <div className="max-w-6xl">
      <PageHeader
        title={editId === undefined ? 'New purchase' : `Edit purchase ${original?.doc_no ?? ''}`}
        description="Copy the manufacturer's bill. Price and margin can be changed to match it."
        actions={
          <Button onClick={trySave} disabled={save.isPending || !valid} title="Ctrl+S">
            {save.isPending ? 'Saving…' : 'Save purchase'} <kbd className="text-xs opacity-70">Ctrl+S</kbd>
          </Button>
        }
      />
      <Card className="mb-4">
        <CardContent className="grid grid-cols-1 gap-4 pt-5 md:grid-cols-4">
          <FormField label="Supplier" htmlFor="pu_supplier">
            <NativeSelect id="pu_supplier" value={effectiveSupplier ?? ''} onChange={(e) => setSupplierId(Number(e.target.value) || null)}>
              {active.length > 1 && <option value="">Pick…</option>}
              {active.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </NativeSelect>
          </FormField>
          <FormField label="Date" htmlFor="pu_date">
            <Input id="pu_date" type="date" max={todayKarachi()} value={date} onChange={(e) => setDate(e.target.value)} />
          </FormField>
          <FormField label="Supplier's bill no." htmlFor="pu_ref">
            <Input id="pu_ref" value={ref} onChange={(e) => setRef(e.target.value)} />
          </FormField>
          <FormField label="Notes" htmlFor="pu_notes">
            <Input id="pu_notes" value={notes} onChange={(e) => setNotes(e.target.value)} />
          </FormField>
          {editId !== undefined && (
            <div className="md:col-span-4">
              <ChangeReasonField value={changeReason} onChange={setChangeReason} />
            </div>
          )}
        </CardContent>
      </Card>

      <div className="mb-3">
        <ItemEntry loadProduct={loadPurchaseProduct} onAdd={addPicks} />
      </div>

      <div className="overflow-x-auto rounded-lg border border-border bg-card">
        <table className="w-full text-[15px]">
          <thead className="bg-muted text-left text-sm text-muted-foreground">
            <tr>
              <th className="px-3 py-2">Item</th>
              <th className="px-3 py-2">Color</th>
              <th className="px-3 py-2">Size</th>
              <th className="px-3 py-2 text-right">Qty</th>
              <th className="px-3 py-2 text-right">Price</th>
              <th className="px-3 py-2 text-right">Supplier margin %</th>
              <th className="px-3 py-2 text-right">Cost amount</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {lines.length === 0 && (
              <tr>
                <td colSpan={8} className="px-3 py-10 text-center text-muted-foreground">
                  Type an item code above and press Enter to add items.
                </td>
              </tr>
            )}
            {lines.map((l, i) => {
              const a = amounts[i];
              const priceChanged = !!a && a.price !== l.product_price_paisa;
              const marginChanged = !!a && a.bp !== l.product_margin_bp;
              return (
                <tr key={l.key} className={cn('border-t border-border', !a && 'bg-red-50')}>
                  <td className="px-3 py-1.5">
                    <span className="font-mono font-semibold">{l.item_code}</span> <span className="text-sm text-muted-foreground">{l.name}</span>
                  </td>
                  <td className="px-3 py-1.5">{l.color || '—'}</td>
                  <td className="px-3 py-1.5">{l.size || '—'}</td>
                  <td className="px-3 py-1.5 text-right">
                    <Input className="amount ml-auto h-8 w-20" inputMode="numeric" value={l.qty} onChange={(e) => update(l.key, 'qty', e.target.value)} aria-label="Quantity" />
                  </td>
                  <td className="px-3 py-1.5 text-right">
                    <Input
                      className={cn('amount ml-auto h-8 w-28', priceChanged && 'border-purple-600 bg-purple-50 font-semibold')}
                      inputMode="decimal"
                      value={l.price}
                      onChange={(e) => applyToProduct(l.product_id, 'price', e.target.value)}
                      title={priceChanged ? `Product price is ${formatPaisa(l.product_price_paisa)}` : undefined}
                      aria-label="Price"
                    />
                  </td>
                  <td className="px-3 py-1.5 text-right">
                    <Input
                      className={cn('amount ml-auto h-8 w-20', marginChanged && 'border-purple-600 bg-purple-50 font-semibold')}
                      inputMode="decimal"
                      value={l.margin}
                      onChange={(e) => applyToProduct(l.product_id, 'margin', e.target.value)}
                      title={marginChanged ? `Product margin is ${bpToPercentString(l.product_margin_bp)}%` : undefined}
                      aria-label="Supplier margin percent"
                    />
                  </td>
                  <td className="amount px-3 py-1.5">{a ? formatPaisa(a.cost) : '—'}</td>
                  <td className="px-2">
                    <Button variant="ghost" size="icon" onClick={() => setLines((ls) => ls.filter((x) => x.key !== l.key))} aria-label="Remove line">
                      <Trash2 />
                    </Button>
                  </td>
                </tr>
              );
            })}
          </tbody>
          {lines.length > 0 && (
            <tfoot className="border-t-2 border-border">
              <tr>
                <td className="px-3 py-2 text-right text-muted-foreground" colSpan={3}>
                  Totals
                </td>
                <td className="amount px-3 py-2 font-semibold">{totals.qty}</td>
                <td className="amount px-3 py-2">{formatPaisa(totals.gross)}</td>
                <td className="amount px-3 py-2">−{formatPaisa(totals.margin)}</td>
                <td className="amount px-3 py-2 text-lg font-bold">{formatPaisa(totals.cost)}</td>
                <td />
              </tr>
            </tfoot>
          )}
        </table>
      </div>
      <p className="mt-2 text-sm text-muted-foreground">Changing a price or margin changes it for every line of that item. Purple means it differs from the product.</p>

      {changes && (
        <UpdateProductsDialog
          changes={changes}
          pending={save.isPending}
          onCancel={() => setChanges(null)}
          onConfirm={(selected) => {
            setChanges(null);
            save.mutate(
              selected.map((c) => ({
                product_id: c.product_id,
                ...(c.newPrice !== null ? { list_price_paisa: c.newPrice } : {}),
                ...(c.newMargin !== null ? { supplier_margin_bp: c.newMargin } : {}),
              })),
            );
          }}
        />
      )}
    </div>
  );
}

function UpdateProductsDialog({
  changes,
  pending,
  onCancel,
  onConfirm,
}: {
  changes: ProductChange[];
  pending: boolean;
  onCancel: () => void;
  onConfirm: (selected: ProductChange[]) => void;
}) {
  const [checked, setChecked] = useState<Set<number>>(new Set(changes.map((c) => c.product_id)));
  return (
    <Dialog open onOpenChange={(o) => !o && onCancel()}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>The bill differs from the product</DialogTitle>
          <DialogDescription>
            Update the products to match this bill? Ticked products get the new figures (recorded in price history). Stock already bought keeps its cost.
          </DialogDescription>
        </DialogHeader>
        <table className="w-full text-[15px]">
          <thead className="text-left text-sm text-muted-foreground">
            <tr>
              <th />
              <th className="py-1">Item</th>
              <th className="text-right">Price</th>
              <th className="text-right">Supplier margin</th>
            </tr>
          </thead>
          <tbody>
            {changes.map((c) => (
              <tr key={c.product_id} className="border-t border-border">
                <td className="py-2 pr-2">
                  <input
                    type="checkbox"
                    aria-label={`Update ${c.item_code}`}
                    checked={checked.has(c.product_id)}
                    onChange={() =>
                      setChecked((s) => {
                        const n = new Set(s);
                        if (n.has(c.product_id)) n.delete(c.product_id);
                        else n.add(c.product_id);
                        return n;
                      })
                    }
                  />
                </td>
                <td>
                  <span className="font-mono font-semibold">{c.item_code}</span> {c.name}
                </td>
                <td className="amount">{c.newPrice !== null ? `${formatPaisa(c.oldPrice)} → ${formatPaisa(c.newPrice)}` : '—'}</td>
                <td className="amount">{c.newMargin !== null ? `${bpToPercentString(c.oldMargin)}% → ${bpToPercentString(c.newMargin)}%` : '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <DialogFooter>
          <Button variant="outline" onClick={onCancel}>
            Back
          </Button>
          <Button variant="secondary" onClick={() => onConfirm([])} disabled={pending}>
            Save without updating
          </Button>
          <Button onClick={() => onConfirm(changes.filter((c) => checked.has(c.product_id)))} disabled={pending}>
            Save and update {checked.size} product{checked.size === 1 ? '' : 's'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
