import { Command } from 'cmdk';
import { formatPaisa, bpToPercentString, type Product } from '@shopledger/shared';
import { Search } from 'lucide-react';
import { useDeferredValue, useState } from 'react';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import { useProducts } from './api';

/** Quick product search by item code or name (F3). Exact code matches come first. */
export function ProductPicker({
  open,
  onOpenChange,
  onSelect,
  initialQuery = '',
}: {
  initialQuery?: string;
  open: boolean;
  onOpenChange: (o: boolean) => void;
  onSelect: (p: Product) => void;
}) {
  const [q, setQ] = useState(initialQuery);
  const deferred = useDeferredValue(q.trim());
  const { data, isFetching } = useProducts({ q: deferred, limit: 25, status: 'active' }, open);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl gap-0 p-0" aria-describedby={undefined}>
        <DialogTitle className="sr-only">Find product</DialogTitle>
        <Command shouldFilter={false} loop>
          <div className="flex items-center gap-2 border-b border-border px-4">
            <Search className="size-5 text-muted-foreground" />
            <Command.Input
              autoFocus
              value={q}
              onValueChange={setQ}
              placeholder="Item code or name…"
              className="h-12 flex-1 bg-transparent text-base uppercase outline-none placeholder:normal-case"
            />
            {isFetching && <span className="text-xs text-muted-foreground">Searching…</span>}
          </div>
          <Command.List className="max-h-[60vh] overflow-y-auto p-2">
            {data && data.products.length === 0 && <div className="px-3 py-4 text-sm text-muted-foreground">No product matches “{deferred}”.</div>}
            {data?.products.map((p) => (
              <Command.Item
                key={p.id}
                value={String(p.id)}
                onSelect={() => {
                  onSelect(p);
                  onOpenChange(false);
                  setQ('');
                }}
                className="flex cursor-pointer items-center gap-3 rounded-md px-3 py-2 data-[selected=true]:bg-primary data-[selected=true]:text-primary-foreground"
              >
                <span className="w-28 font-mono font-bold">{p.item_code}</span>
                <span className="min-w-0 flex-1 truncate">
                  {p.name}
                  {p.category && <span className="opacity-70"> · {p.category}</span>}
                </span>
                <span className="amount w-28">{formatPaisa(p.list_price_paisa)}</span>
                <span className="amount w-16 text-sm opacity-80">−{bpToPercentString(p.default_customer_discount_bp)}%</span>
                <span className="amount w-20 text-sm opacity-80">
                  {p.stock_qty} {p.unit}
                </span>
              </Command.Item>
            ))}
          </Command.List>
        </Command>
      </DialogContent>
    </Dialog>
  );
}
