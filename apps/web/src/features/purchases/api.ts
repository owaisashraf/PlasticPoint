import { useQuery } from '@tanstack/react-query';
import type { Product, Purchase, Supplier } from '@shopledger/shared';
import { api } from '@/lib/api';

export const PURCHASES_KEY = ['purchases'] as const;
export const SUPPLIERS_KEY = ['suppliers'] as const;

export function usePurchases(f: { q?: string; from?: string; to?: string; limit?: number }) {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(f)) if (v !== undefined && v !== '') p.set(k, String(v));
  return useQuery({
    queryKey: [...PURCHASES_KEY, 'list', f],
    queryFn: () => api.get<{ purchases: Purchase[]; total: number }>(`/api/purchases?${p}`),
    placeholderData: (prev) => prev,
  });
}

export function usePurchase(id: number) {
  return useQuery({
    queryKey: [...PURCHASES_KEY, 'one', id],
    queryFn: () => api.get<{ purchase: Purchase }>(`/api/purchases/${id}`).then((r) => r.purchase),
  });
}

export function useSuppliers() {
  return useQuery({ queryKey: SUPPLIERS_KEY, queryFn: () => api.get<{ suppliers: Supplier[] }>('/api/suppliers').then((r) => r.suppliers) });
}

/** Product with its supplier margin, for prefilling purchase lines. */
export function loadPurchaseProduct(id: number): Promise<Product> {
  return api.get<{ product: Product }>(`/api/purchase-entry/products/${id}`).then((r) => r.product);
}

/** Logs the print in the audit log, then opens the PDF in a new tab. */
export async function printPurchase(id: number): Promise<void> {
  // Open the tab first (inside the click) so the browser does not block it.
  const tab = window.open('', '_blank');
  try {
    const { url } = await api.post<{ url: string }>(`/api/purchases/${id}/print`);
    if (tab) tab.location.href = url;
    else window.location.href = url;
  } catch (e) {
    tab?.close();
    throw e;
  }
}
