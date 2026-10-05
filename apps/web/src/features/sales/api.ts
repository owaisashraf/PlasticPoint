import { useQuery } from '@tanstack/react-query';
import type { Sale } from '@shopledger/shared';
import { api } from '@/lib/api';

export const SALES_KEY = ['sales'] as const;

export interface SaleFilters {
  q?: string;
  from?: string;
  to?: string;
  customer_id?: number;
  limit?: number;
}

export function useSales(f: SaleFilters, enabled = true) {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(f)) if (v !== undefined && v !== '') p.set(k, String(v));
  return useQuery({
    queryKey: [...SALES_KEY, 'list', f],
    queryFn: () => api.get<{ sales: Sale[]; total: number }>(`/api/sales?${p}`),
    enabled,
    placeholderData: (prev) => prev,
  });
}

export function useSale(id: number) {
  return useQuery({
    queryKey: [...SALES_KEY, 'one', id],
    queryFn: () => api.get<{ sale: Sale }>(`/api/sales/${id}`).then((r) => r.sale),
  });
}

/** Logs the print in the audit log, then opens the invoice PDF in a new tab. */
export async function printSale(id: number, size?: 'A4' | '80mm'): Promise<void> {
  // Open the tab first (inside the click) so the browser does not block it.
  const tab = window.open('', '_blank');
  try {
    const { url } = await api.post<{ url: string }>(`/api/sales/${id}/print${size ? `?size=${size}` : ''}`);
    if (tab) tab.location.href = url;
    else window.location.href = url;
  } catch (e) {
    tab?.close();
    throw e;
  }
}
