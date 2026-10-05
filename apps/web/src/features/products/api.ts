import { useQuery } from '@tanstack/react-query';
import type { PriceHistoryEntry, Product } from '@shopledger/shared';
import { api } from '@/lib/api';

export const PRODUCTS_KEY = ['products'] as const;

export interface ProductFilters {
  q?: string;
  category?: string;
  status?: string;
  limit?: number;
}

export function useProducts(f: ProductFilters, enabled = true) {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(f)) if (v !== undefined && v !== '') p.set(k, String(v));
  return useQuery({
    queryKey: [...PRODUCTS_KEY, 'list', f],
    queryFn: () => api.get<{ products: Product[]; total: number }>(`/api/products?${p}`),
    enabled,
    placeholderData: (prev) => prev,
  });
}

export function useProduct(id: number) {
  return useQuery({
    queryKey: [...PRODUCTS_KEY, 'one', id],
    queryFn: () => api.get<{ product: Product }>(`/api/products/${id}`).then((r) => r.product),
  });
}

export function useCategories() {
  return useQuery({
    queryKey: [...PRODUCTS_KEY, 'categories'],
    queryFn: () => api.get<{ categories: string[] }>('/api/products/categories').then((r) => r.categories),
  });
}

/** Owner+ only: never call this without finance.view. */
export function usePriceHistory(id: number, enabled: boolean) {
  return useQuery({
    queryKey: [...PRODUCTS_KEY, 'history', id],
    queryFn: () => api.get<{ history: PriceHistoryEntry[] }>(`/api/products/${id}/price-history`).then((r) => r.history),
    enabled,
  });
}
