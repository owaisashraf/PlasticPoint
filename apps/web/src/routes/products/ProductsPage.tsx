import { bpToPercentString, formatPaisa } from '@shopledger/shared';
import { PackagePlus, Percent, Search } from 'lucide-react';
import { useDeferredValue, useState } from 'react';
import { useNavigate } from 'react-router';
import { ActiveBadge } from '@/components/badges';
import { PageHeader } from '@/components/PageHeader';
import { Button } from '@/components/ui/button';
import { Input, NativeSelect } from '@/components/ui/input';
import { useCan } from '@/features/auth/useAuth';
import { useCategories, useProducts } from '@/features/products/api';
import { BulkUpdateDialog } from '@/features/products/BulkUpdateDialog';
import { ProductFormDialog } from '@/features/products/ProductFormDialog';
import { ProductPicker } from '@/features/products/ProductPicker';
import { errorMessage } from '@/lib/api';
import { useHotkey } from '@/lib/useHotkey';

const PAGE = 200;

export function ProductsPage() {
  const can = useCan();
  const canPrice = can('pricing.manage');
  const showMargin = can('finance.view');
  const navigate = useNavigate();
  const [q, setQ] = useState('');
  const [category, setCategory] = useState('');
  const [status, setStatus] = useState('active');
  const [limit, setLimit] = useState(PAGE);
  const [adding, setAdding] = useState(false);
  const [bulk, setBulk] = useState(false);
  const [picking, setPicking] = useState(false);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const deferred = useDeferredValue(q.trim());
  const categories = useCategories();
  const list = useProducts({ q: deferred, category, status, limit });

  useHotkey('F3', () => setPicking(true));

  const rows = list.data?.products ?? [];
  const allSelected = rows.length > 0 && rows.every((p) => selected.has(p.id));
  const toggle = (id: number) =>
    setSelected((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });

  return (
    <div>
      <PageHeader
        title="Products & Stock"
        description="Stock grids, low stock and movement history arrive with purchases (phase 3)."
        actions={
          <>
            <Button variant="outline" onClick={() => setPicking(true)}>
              <Search /> Find <kbd className="text-xs opacity-70">F3</kbd>
            </Button>
            {canPrice && (
              <Button variant="outline" onClick={() => setBulk(true)}>
                <Percent /> Bulk update{selected.size ? ` (${selected.size})` : ''}
              </Button>
            )}
            {can('products.manage') && (
              <Button onClick={() => setAdding(true)}>
                <PackagePlus /> New product
              </Button>
            )}
          </>
        }
      />
      <div className="mb-4 flex flex-wrap gap-2">
        <Input className="w-72" placeholder="Item code, name or category" value={q} onChange={(e) => setQ(e.target.value)} />
        <NativeSelect className="w-48" value={category} onChange={(e) => setCategory(e.target.value)} aria-label="Category">
          <option value="">All categories</option>
          {categories.data?.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </NativeSelect>
        <NativeSelect className="w-36" value={status} onChange={(e) => setStatus(e.target.value)} aria-label="Status">
          <option value="active">Active</option>
          <option value="inactive">Inactive</option>
          <option value="all">All</option>
        </NativeSelect>
      </div>

      {list.isError && <p className="text-destructive">{errorMessage(list.error)}</p>}
      <div className="overflow-x-auto rounded-lg border border-border bg-card">
        <table className="w-full text-[15px]">
          <thead className="bg-muted text-left text-sm text-muted-foreground">
            <tr>
              {canPrice && (
                <th className="w-8 px-3 py-2">
                  <input
                    type="checkbox"
                    aria-label="Select all"
                    checked={allSelected}
                    onChange={() => setSelected(allSelected ? new Set() : new Set(rows.map((p) => p.id)))}
                  />
                </th>
              )}
              <th className="px-3 py-2">Item code</th>
              <th className="px-3 py-2">Name</th>
              <th className="px-3 py-2">Category</th>
              <th className="px-3 py-2">Sizes / colors</th>
              <th className="px-3 py-2 text-right">Price</th>
              {showMargin && <th className="px-3 py-2 text-right">Supplier margin</th>}
              <th className="px-3 py-2 text-right">Default discount</th>
              <th className="px-3 py-2 text-right">In stock</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((p) => {
              const losing = p.supplier_margin_bp !== undefined && p.supplier_margin_bp < p.default_customer_discount_bp;
              return (
                <tr
                  key={p.id}
                  className="cursor-pointer border-t border-border hover:bg-muted/60"
                  onClick={() => navigate(`/products/${p.id}`)}
                  tabIndex={0}
                  onKeyDown={(e) => e.key === 'Enter' && navigate(`/products/${p.id}`)}
                >
                  {canPrice && (
                    <td className="px-3 py-2" onClick={(e) => e.stopPropagation()}>
                      <input type="checkbox" aria-label={`Select ${p.item_code}`} checked={selected.has(p.id)} onChange={() => toggle(p.id)} />
                    </td>
                  )}
                  <td className="px-3 py-2 font-mono font-semibold">{p.item_code}</td>
                  <td className="px-3 py-2">
                    {p.name} <ActiveBadge active={p.active} />
                  </td>
                  <td className="px-3 py-2">{p.category}</td>
                  <td className="px-3 py-2 text-sm text-muted-foreground">
                    {[p.sizes.join(', '), p.colors.join(', ')].filter(Boolean).join(' · ') || '—'}
                  </td>
                  <td className="amount px-3 py-2">{formatPaisa(p.list_price_paisa)}</td>
                  {showMargin && (
                    <td className={losing ? 'amount px-3 py-2 font-bold text-destructive' : 'amount px-3 py-2'} title={losing ? 'Margin is lower than the default discount' : undefined}>
                      {p.supplier_margin_bp !== undefined ? `${bpToPercentString(p.supplier_margin_bp)}%` : ''}
                    </td>
                  )}
                  <td className="amount px-3 py-2">{bpToPercentString(p.default_customer_discount_bp)}%</td>
                  <td className="amount px-3 py-2">
                    {p.stock_qty} {p.unit}
                  </td>
                </tr>
              );
            })}
            {list.data && rows.length === 0 && (
              <tr>
                <td colSpan={9} className="px-3 py-8 text-center text-muted-foreground">
                  No products found.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      {list.data && (
        <div className="mt-3 flex items-center gap-3 text-sm text-muted-foreground">
          Showing {rows.length} of {list.data.total}.
          {list.data.total > rows.length && (
            <Button variant="outline" size="sm" onClick={() => setLimit((l) => l + PAGE)}>
              Show more
            </Button>
          )}
        </div>
      )}

      {adding && <ProductFormDialog onClose={() => setAdding(false)} onSaved={(p) => navigate(`/products/${p.id}`)} />}
      {bulk && (
        <BulkUpdateDialog
          selectedIds={[...selected]}
          onClose={() => {
            setBulk(false);
            setSelected(new Set());
          }}
        />
      )}
      <ProductPicker open={picking} onOpenChange={setPicking} onSelect={(p) => navigate(`/products/${p.id}`)} />
    </div>
  );
}
