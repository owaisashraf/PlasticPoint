import { useQuery } from '@tanstack/react-query';
import type { Sale } from '@shopledger/shared';
import { api, printInNewTab, queryString } from '@/lib/api';

export const SALES_KEY = ['sales'] as const;

export interface SaleFilters {
  q?: string;
  from?: string;
  to?: string;
  customer_id?: number;
  limit?: number;
}

export function useSales(f: SaleFilters, enabled = true) {
  return useQuery({
    queryKey: [...SALES_KEY, 'list', f],
    queryFn: () => api.get<{ sales: Sale[]; total: number }>(`/api/sales?${queryString({ ...f })}`),
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
export function printSale(id: number, size?: 'A4' | '80mm'): Promise<void> {
  return printInNewTab(`/api/sales/${id}/print${size ? `?size=${size}` : ''}`);
}
