import { useMutation, useQueryClient } from '@tanstack/react-query';
import { applyBp, bpToPercentString, formatPaisa, type Product, type Variant } from '@shopledger/shared';
import { ArrowLeft, Ban, PackageCheck, Pencil } from 'lucide-react';
import { useState } from 'react';
import { Link, useParams } from 'react-router';
import { toast } from 'sonner';
import { ActiveBadge } from '@/components/badges';
import { FullPageMessage } from '@/components/FullPageMessage';
import { ReasonDialog } from '@/components/ReasonDialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { useCan } from '@/features/auth/useAuth';
import { PRODUCTS_KEY, usePriceHistory, useProduct } from '@/features/products/api';
import { ProductFormDialog } from '@/features/products/ProductFormDialog';
import { StockGrid } from '@/features/products/StockPanels';
import { api, errorMessage } from '@/lib/api';
import { formatDateTime } from '@/lib/utils';

export function ProductDetailPage() {
  const id = Number(useParams().id);
  const can = useCan();
  const qc = useQueryClient();
  const { data: p, isPending, isError, error } = useProduct(id);
  const history = usePriceHistory(id, can('finance.view'));
  const [editing, setEditing] = useState(false);
  const [deactivating, setDeactivating] = useState(false);

  const setActive = useMutation({
    mutationFn: ({ active, reason }: { active: boolean; reason?: string }) => api.patch(`/api/products/${id}`, { active, ...(reason ? { reason } : {}) }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: PRODUCTS_KEY });
      setDeactivating(false);
      toast.success('Product updated.');
    },
    onError: (e) => toast.error(errorMessage(e)),
  });

  if (isPending) return <p>Loading…</p>;
  if (isError) return <FullPageMessage inline title="Product not found" detail={errorMessage(error)} />;

  const showFinance = can('finance.view') && p.supplier_margin_bp !== undefined;
  const marginBp = p.supplier_margin_bp ?? 0;
  const losing = showFinance && marginBp < p.default_customer_discount_bp;

  return (
    <div>
      <Link to="/products" className="mb-2 inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
        <ArrowLeft className="size-4" /> Products
      </Link>
      <div className="mb-5 flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="flex items-center gap-3 text-2xl font-bold">
            <span className="font-mono">{p.item_code}</span> {p.name} <ActiveBadge active={p.active} />
          </h1>
          <p className="text-muted-foreground">{[p.category, `sold in ${p.unit}`].filter(Boolean).join(' · ')}</p>
        </div>
        {can('products.manage') && (
          <div className="flex gap-2">
            <Button variant="outline" onClick={() => setEditing(true)}>
              <Pencil /> Edit
            </Button>
            {p.active ? (
              <Button variant="ghost" onClick={() => setDeactivating(true)}>
                <Ban /> Deactivate
              </Button>
            ) : (
              <Button variant="outline" onClick={() => setActive.mutate({ active: true })}>
                <PackageCheck /> Activate
              </Button>
            )}
          </div>
        )}
      </div>

      <div className="mb-5 grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat label="Price">{formatPaisa(p.list_price_paisa)}</Stat>
        <Stat label="Default customer discount">
          {bpToPercentString(p.default_customer_discount_bp)}% → {formatPaisa(p.list_price_paisa - applyBp(p.list_price_paisa, p.default_customer_discount_bp))}
          {p.max_customer_discount_bp != null && <div className="text-sm text-muted-foreground">Max {bpToPercentString(p.max_customer_discount_bp)}%</div>}
        </Stat>
        {showFinance && (
          <>
            <Stat label="Supplier margin → cost">
              {bpToPercentString(marginBp)}% → {formatPaisa(p.list_price_paisa - applyBp(p.list_price_paisa, marginBp))}
            </Stat>
            <Stat label="Profit at default discount">
              <span className={losing ? 'font-bold text-destructive' : ''}>
                {formatPaisa(applyBp(p.list_price_paisa, marginBp) - applyBp(p.list_price_paisa, p.default_customer_discount_bp))} (
                {bpToPercentString(marginBp - p.default_customer_discount_bp)}%)
              </span>
              {losing && <div className="text-sm text-destructive">Loses money at the default discount</div>}
            </Stat>
          </>
        )}
      </div>

      <Card className="mb-5">
        <CardHeader>
          <CardTitle>Stock on hand</CardTitle>
        </CardHeader>
        <CardContent>
          <StockGrid product={p} />
        </CardContent>
      </Card>

      <Card className="mb-5">
        <CardHeader>
          <CardTitle>Variants</CardTitle>
        </CardHeader>
        <CardContent>
          <VariantsTable product={p} canEdit={can('products.manage')} showCost={showFinance} />
        </CardContent>
      </Card>

      {can('finance.view') && (
        <Card>
          <CardHeader>
            <CardTitle>Price history</CardTitle>
          </CardHeader>
          <CardContent>
            {history.data && (
              <table className="w-full text-[15px]">
                <thead className="text-left text-sm text-muted-foreground">
                  <tr>
                    <th className="py-1.5">From</th>
                    <th className="text-right">Price</th>
                    <th className="text-right">Supplier margin</th>
                    <th className="text-right">Default discount</th>
                    <th className="pl-6">Changed by</th>
                  </tr>
                </thead>
                <tbody>
                  {history.data.map((h) => (
                    <tr key={h.id} className="border-t border-border">
                      <td className="py-1.5">{h.effective_date}</td>
                      <td className="amount">{formatPaisa(h.list_price_paisa)}</td>
                      <td className="amount">{bpToPercentString(h.supplier_margin_bp)}%</td>
                      <td className="amount">{bpToPercentString(h.default_customer_discount_bp)}%</td>
                      <td className="pl-6 text-sm text-muted-foreground">
                        {h.changed_by_name ?? '—'} · {formatDateTime(h.created_at)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </CardContent>
        </Card>
      )}

      {editing && <ProductFormDialog product={p} onClose={() => setEditing(false)} />}
      {deactivating && (
        <ReasonDialog
          title={`Deactivate ${p.item_code}?`}
          description="It disappears from product searches. Stock and past documents are kept, and you can activate it again."
          confirmLabel="Deactivate"
          destructive
          pending={setActive.isPending}
          onConfirm={(reason) => setActive.mutate({ active: false, reason })}
          onClose={() => setDeactivating(false)}
        />
      )}
    </div>
  );
}

function Stat({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <Card>
      <CardContent className="pt-4">
        <div className="text-sm text-muted-foreground">{label}</div>
        <div className="amount mt-1 text-left text-lg font-semibold">{children}</div>
      </CardContent>
    </Card>
  );
}

function VariantsTable({ product, canEdit, showCost }: { product: Product; canEdit: boolean; showCost: boolean }) {
  const variants = product.variants ?? [];
  const [showInactive, setShowInactive] = useState(false);
  const shown = variants.filter((v) => v.active || showInactive);
  const inactiveCount = variants.length - variants.filter((v) => v.active).length;
  return (
    <div>
      <table className="w-full text-[15px]">
        <thead className="text-left text-sm text-muted-foreground">
          <tr>
            <th className="py-1.5">Color</th>
            <th>Size</th>
            <th>SKU</th>
            <th className="text-right">In stock</th>
            <th className="text-right">Low stock at</th>
            {showCost && <th className="text-right">Average cost</th>}
          </tr>
        </thead>
        <tbody>
          {shown.map((v) => (
            <tr key={v.id} className="border-t border-border">
              <td className="py-1.5">
                {v.color || '—'} {!v.active && <Badge variant="grey">Hidden</Badge>}
              </td>
              <td>{v.size || '—'}</td>
              <td className="font-mono text-sm">{v.sku}</td>
              <td className="amount">{v.stock_qty}</td>
              <td className="text-right">{canEdit ? <ThresholdInput variant={v} /> : <span className="amount">{v.low_stock_threshold}</span>}</td>
              {showCost && <td className="amount">{v.avg_cost_paisa != null ? formatPaisa(v.avg_cost_paisa) : <span className="text-muted-foreground">not bought yet</span>}</td>}
            </tr>
          ))}
        </tbody>
      </table>
      {inactiveCount > 0 && (
        <button className="mt-2 cursor-pointer text-sm text-primary hover:underline" onClick={() => setShowInactive((s) => !s)}>
          {showInactive ? 'Hide' : 'Show'} {inactiveCount} hidden variant{inactiveCount > 1 ? 's' : ''}
        </button>
      )}
    </div>
  );
}

function ThresholdInput({ variant }: { variant: Variant }) {
  const qc = useQueryClient();
  const [value, setValue] = useState(String(variant.low_stock_threshold));
  const save = useMutation({
    mutationFn: (n: number) => api.patch(`/api/variants/${variant.id}`, { low_stock_threshold: n }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: PRODUCTS_KEY }),
    onError: (e) => toast.error(errorMessage(e)),
  });
  const commit = () => {
    const n = Number(value);
    if (!Number.isInteger(n) || n < 0) return setValue(String(variant.low_stock_threshold));
    if (n !== variant.low_stock_threshold) save.mutate(n);
  };
  return (
    <Input
      className="amount ml-auto h-8 w-20"
      inputMode="numeric"
      value={value}
      aria-label={`Low stock threshold for ${variant.sku}`}
      onChange={(e) => setValue(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
    />
  );
}
