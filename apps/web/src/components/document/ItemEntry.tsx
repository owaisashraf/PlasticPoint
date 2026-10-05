import type { Product } from '@shopledger/shared';
import { useState } from 'react';
import { toast } from 'sonner';
import { Input } from '@/components/ui/input';
import { ProductPicker } from '@/features/products/ProductPicker';
import { api, errorMessage } from '@/lib/api';
import { useHotkey } from '@/lib/useHotkey';
import { SizeColorGrid, type GridPick } from './SizeColorGrid';

/**
 * Item code box for purchase and sale screens: type a code and press Enter
 * (or F3 to search). The size × color grid then opens for that product.
 * `loadProduct` fetches the product with its variants (purchases use an
 * endpoint that includes the supplier margin).
 */
export function ItemEntry({
  loadProduct,
  onAdd,
  warnAboveStock,
}: {
  loadProduct: (id: number) => Promise<Product>;
  onAdd: (product: Product, picks: GridPick[]) => void;
  warnAboveStock?: boolean;
}) {
  const [code, setCode] = useState('');
  const [picking, setPicking] = useState(false);
  const [pickerQuery, setPickerQuery] = useState('');
  const [product, setProduct] = useState<Product | null>(null);
  const [busy, setBusy] = useState(false);

  useHotkey('F3', () => {
    setPickerQuery('');
    setPicking(true);
  });

  const open = async (id: number) => {
    setBusy(true);
    try {
      setProduct(await loadProduct(id));
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const lookup = async () => {
    const q = code.trim().toUpperCase();
    if (!q) {
      setPickerQuery('');
      setPicking(true);
      return;
    }
    try {
      const { products } = await api.get<{ products: Product[] }>(`/api/products?q=${encodeURIComponent(q)}&status=active&limit=5`);
      const exact = products.find((p) => p.item_code === q);
      if (exact) {
        setCode('');
        await open(exact.id);
      } else {
        setPickerQuery(q);
        setPicking(true);
      }
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };

  return (
    <>
      <div className="flex items-center gap-2">
        <Input
          className="w-56 font-mono uppercase placeholder:font-sans placeholder:normal-case"
          placeholder="Item code, then Enter"
          value={code}
          disabled={busy}
          onChange={(e) => setCode(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              void lookup();
            }
          }}
          aria-label="Item code"
        />
        <span className="text-sm text-muted-foreground">
          or press <kbd className="rounded border border-border px-1">F3</kbd> to search
        </span>
      </div>
      <ProductPicker
        key={pickerQuery}
        open={picking}
        initialQuery={pickerQuery}
        onOpenChange={setPicking}
        onSelect={(p) => {
          setCode('');
          void open(p.id);
        }}
      />
      {product && (
        <SizeColorGrid
          product={product}
          warnAboveStock={warnAboveStock}
          onClose={() => setProduct(null)}
          onAdd={(picks) => {
            onAdd(product, picks);
            setProduct(null);
          }}
        />
      )}
    </>
  );
}
