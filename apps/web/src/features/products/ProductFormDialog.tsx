import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  applyBp,
  bpToPercentString,
  formatPaisa,
  paisaToInput,
  parsePercentToBp,
  parseRupeesToPaisa,
  PRODUCT_UNITS,
  type Product,
} from '@shopledger/shared';
import { useState } from 'react';
import { Controller, useForm, useWatch } from 'react-hook-form';
import { toast } from 'sonner';
import { applyServerFieldErrors, FormField } from '@/components/FormField';
import { MoneyInput, PercentInput, TagInput } from '@/components/inputs';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input, NativeSelect } from '@/components/ui/input';
import { useCan } from '@/features/auth/useAuth';
import { api, ApiError, errorMessage } from '@/lib/api';
import { PRODUCTS_KEY, useCategories } from './api';

interface FormValues {
  item_code: string;
  name: string;
  category: string;
  unit: (typeof PRODUCT_UNITS)[number];
  sizes: string[];
  colors: string[];
  price: string;
  supplier_margin: string;
  default_discount: string;
  max_discount: string;
  low_stock_threshold: string;
  reason: string;
}

export function ProductFormDialog({ product, onClose, onSaved }: { product?: Product; onClose: () => void; onSaved?: (p: Product) => void }) {
  const can = useCan();
  const canPrice = can('pricing.manage');
  const qc = useQueryClient();
  const categories = useCategories();
  const [serverError, setServerError] = useState<string | null>(null);

  const form = useForm<FormValues>({
    defaultValues: product
      ? {
          item_code: product.item_code,
          name: product.name,
          category: product.category ?? '',
          unit: product.unit,
          sizes: product.sizes,
          colors: product.colors,
          price: paisaToInput(product.list_price_paisa),
          supplier_margin: product.supplier_margin_bp !== undefined ? bpToPercentString(product.supplier_margin_bp) : '',
          default_discount: bpToPercentString(product.default_customer_discount_bp),
          max_discount: product.max_customer_discount_bp != null ? bpToPercentString(product.max_customer_discount_bp) : '',
          low_stock_threshold: '0',
          reason: '',
        }
      : {
          item_code: '',
          name: '',
          category: '',
          unit: 'pcs',
          sizes: [],
          colors: [],
          price: '',
          supplier_margin: '',
          default_discount: '',
          max_discount: '',
          low_stock_threshold: '0',
          reason: '',
        },
  });

  const save = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      product ? api.patch<{ product: Product }>(`/api/products/${product.id}`, body) : api.post<{ product: Product }>('/api/products', body),
    onSuccess: ({ product: saved }) => {
      void qc.invalidateQueries({ queryKey: PRODUCTS_KEY });
      toast.success(product ? 'Product saved.' : `Product ${saved.item_code} added.`);
      onSaved?.(saved);
      onClose();
    },
    onError: (e) => {
      if (e instanceof ApiError) applyServerFieldErrors(e.fields, form.setError);
      setServerError(errorMessage(e));
    },
  });

  const onSubmit = form.handleSubmit((v) => {
    setServerError(null);
    const price = parseRupeesToPaisa(v.price);
    if (price === null || price <= 0) return form.setError('price', { message: 'Enter the price, e.g. 1000' });
    const body: Record<string, unknown> = {
      item_code: v.item_code,
      name: v.name,
      category: v.category,
      unit: v.unit,
      sizes: v.sizes,
      colors: v.colors,
    };
    // Operators send the price only when creating; afterwards it is owner-only.
    if (!product || canPrice) body.list_price_paisa = price;
    if (canPrice) {
      // Empty margin/discount on a new product means "use the settings default".
      for (const [field, key] of [
        ['supplier_margin', 'supplier_margin_bp'],
        ['default_discount', 'default_customer_discount_bp'],
      ] as const) {
        if (!v[field].trim()) continue;
        const bp = parsePercentToBp(v[field]);
        if (bp === null || bp > 10_000) return form.setError(field, { message: 'Enter a percentage like 12 or 12.5' });
        body[key] = bp;
      }
      if (v.max_discount.trim()) {
        const bp = parsePercentToBp(v.max_discount);
        if (bp === null || bp > 10_000) return form.setError('max_discount', { message: 'Enter a percentage or leave empty' });
        body.max_customer_discount_bp = bp;
      } else if (product?.max_customer_discount_bp != null) body.max_customer_discount_bp = null;
    }
    if (!product) {
      const n = Number(v.low_stock_threshold || '0');
      if (!Number.isInteger(n) || n < 0) return form.setError('low_stock_threshold', { message: 'Enter a whole number' });
      body.low_stock_threshold = n;
    } else if (v.reason.trim()) body.reason = v.reason;
    save.mutate(body);
  });

  const [sizes, colors, marginText, discountText, priceText] = useWatch({
    control: form.control,
    name: ['sizes', 'colors', 'supplier_margin', 'default_discount', 'price'],
  });
  const variantCount = Math.max(sizes.length, 1) * Math.max(colors.length, 1);
  const err = form.formState.errors;
  const reg = form.register;

  // Owner+ only: the profit per unit at the default discount (margin − discount).
  const marginBp = parsePercentToBp(marginText);
  const discountBp = parsePercentToBp(discountText);
  const pricePaisa = parseRupeesToPaisa(priceText);

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>{product ? `Edit ${product.item_code}` : 'New product'}</DialogTitle>
        </DialogHeader>
        <form onSubmit={onSubmit} className="flex flex-col gap-4">
          <div className="grid grid-cols-1 gap-4 md:grid-cols-4">
            <FormField label="Item code" htmlFor="p_code" error={err.item_code?.message}>
              <Input id="p_code" autoFocus className="uppercase" {...reg('item_code', { required: 'Enter the item code' })} />
            </FormField>
            <div className="md:col-span-2">
              <FormField label="Name" htmlFor="p_name" error={err.name?.message}>
                <Input id="p_name" {...reg('name', { required: 'Enter the product name' })} />
              </FormField>
            </div>
            <FormField label="Unit" htmlFor="p_unit">
              <NativeSelect id="p_unit" {...reg('unit')}>
                {PRODUCT_UNITS.map((u) => (
                  <option key={u} value={u}>
                    {u}
                  </option>
                ))}
              </NativeSelect>
            </FormField>
            <FormField label="Category" htmlFor="p_category">
              <Input id="p_category" list="category-options" {...reg('category')} />
            </FormField>
            <div className="md:col-span-3">
              <FormField label="Sizes" htmlFor="p_sizes" error={err.sizes?.message} hint="Type a size and press Enter. Leave empty if there are none.">
                <Controller control={form.control} name="sizes" render={({ field }) => <TagInput id="p_sizes" value={field.value} onChange={field.onChange} placeholder="e.g. 10L, 15L" />} />
              </FormField>
            </div>
            <div className="md:col-span-4">
              <FormField
                label="Colors"
                htmlFor="p_colors"
                error={err.colors?.message}
                hint={`${variantCount} variant${variantCount > 1 ? 's' : ''} (every color × size). Removing one hides it; records are kept.`}
              >
                <Controller control={form.control} name="colors" render={({ field }) => <TagInput id="p_colors" value={field.value} onChange={field.onChange} placeholder="e.g. Red, Blue" />} />
              </FormField>
            </div>
          </div>

          <div className="grid grid-cols-1 gap-4 rounded-md border border-border bg-muted/40 p-4 md:grid-cols-4">
            <FormField
              label="Price"
              htmlFor="p_price"
              error={err.price?.message}
              hint={product && !canPrice ? 'Only the owner can change the price.' : 'One price for all sizes and colors.'}
            >
              <MoneyInput id="p_price" disabled={!!product && !canPrice} {...reg('price')} />
            </FormField>
            {canPrice ? (
              <>
                <FormField label="Supplier margin" htmlFor="p_margin" error={err.supplier_margin?.message} hint={product ? undefined : 'Empty = default from settings'}>
                  <PercentInput id="p_margin" {...reg('supplier_margin')} />
                </FormField>
                <FormField label="Default customer discount" htmlFor="p_discount" error={err.default_discount?.message} hint={product ? undefined : 'Empty = default from settings'}>
                  <PercentInput id="p_discount" {...reg('default_discount')} />
                </FormField>
                <FormField label="Maximum discount" htmlFor="p_max" error={err.max_discount?.message} hint="Optional. More needs owner approval.">
                  <PercentInput id="p_max" {...reg('max_discount')} />
                </FormField>
                {pricePaisa && marginBp !== null && discountBp !== null && (
                  <p className="text-sm md:col-span-4">
                    Cost {formatPaisa(pricePaisa - applyBp(pricePaisa, marginBp))} · customer pays{' '}
                    {formatPaisa(pricePaisa - applyBp(pricePaisa, discountBp))} at the default discount ·{' '}
                    <span className={marginBp < discountBp ? 'font-bold text-destructive' : 'font-semibold'}>
                      profit {bpToPercentString(marginBp - discountBp)}% of price
                    </span>
                    {marginBp < discountBp && ' — this product loses money at the default discount.'}
                  </p>
                )}
              </>
            ) : (
              <p className="self-center text-sm text-muted-foreground md:col-span-3">
                {product
                  ? `Default discount: ${bpToPercentString(product.default_customer_discount_bp)}%. The owner sets discounts.`
                  : 'The default discount comes from settings. The owner can change it later.'}
              </p>
            )}
          </div>

          {!product && (
            <div className="w-48">
              <FormField label="Low stock alert at" htmlFor="p_low" error={err.low_stock_threshold?.message} hint="For every variant. 0 = no alert.">
                <Input id="p_low" inputMode="numeric" className="amount" {...reg('low_stock_threshold')} />
              </FormField>
            </div>
          )}
          {product && (
            <FormField label="Reason for change (optional)" htmlFor="p_reason" hint="Recorded in the change history.">
              <Input id="p_reason" {...reg('reason')} />
            </FormField>
          )}
          <datalist id="category-options">
            {categories.data?.map((c) => <option key={c} value={c} />)}
          </datalist>
          {serverError && <p className="font-medium text-destructive">{serverError}</p>}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={save.isPending}>
              {product ? 'Save' : 'Add product'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
