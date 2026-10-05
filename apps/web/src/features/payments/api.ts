import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { OpenItems, Payment, PaymentKind, SalesReturn, PurchaseReturnRow, WriteOff } from '@shopledger/shared';
import { api } from '@/lib/api';
import { CUSTOMERS_KEY } from '@/features/customers/api';
import { PRODUCTS_KEY } from '@/features/products/api';
import { SALES_KEY } from '@/features/sales/api';

export const PAYMENTS_KEY = ['payments'] as const;
export const RETURNS_KEY = ['returns'] as const;

function qs(f: Record<string, string | number | undefined>): string {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(f)) if (v !== undefined && v !== '') p.set(k, String(v));
  return p.toString();
}

export interface PaymentFilters {
  kind?: PaymentKind;
  q?: string;
  from?: string;
  to?: string;
  customer_id?: number;
  supplier_id?: number;
  limit?: number;
}

export function usePayments(f: PaymentFilters) {
  return useQuery({
    queryKey: [...PAYMENTS_KEY, 'list', f],
    queryFn: () => api.get<{ payments: Payment[]; total: number }>(`/api/payments?${qs({ ...f })}`),
    placeholderData: (prev) => prev,
  });
}

export function useOpenItems(customerId: number | null) {
  return useQuery({
    queryKey: [...PAYMENTS_KEY, 'open-items', customerId],
    queryFn: () => api.get<OpenItems>(`/api/customers/${customerId}/open-items`),
    enabled: customerId !== null,
  });
}

export function useSalesReturns(f: { q?: string; from?: string; to?: string; customer_id?: number; limit?: number }) {
  return useQuery({
    queryKey: [...RETURNS_KEY, 'sales', f],
    queryFn: () => api.get<{ returns: SalesReturn[]; total: number }>(`/api/sales-returns?${qs({ ...f })}`),
    placeholderData: (prev) => prev,
  });
}

export function usePurchaseReturns(f: { q?: string; from?: string; to?: string; limit?: number }) {
  return useQuery({
    queryKey: [...RETURNS_KEY, 'purchase', f],
    queryFn: () => api.get<{ returns: PurchaseReturnRow[]; total: number }>(`/api/purchase-returns?${qs({ ...f })}`),
    placeholderData: (prev) => prev,
  });
}

export function useWriteOffs(customerId: number) {
  return useQuery({
    queryKey: [...CUSTOMERS_KEY, 'write-offs', customerId],
    queryFn: () => api.get<{ write_offs: WriteOff[] }>(`/api/customers/${customerId}/write-offs`).then((r) => r.write_offs),
  });
}

/** After any money or return document: balances, invoices, stock and lists all change. */
export function useRefreshAfterMoney() {
  const qc = useQueryClient();
  return () => {
    for (const key of [PAYMENTS_KEY, RETURNS_KEY, SALES_KEY, CUSTOMERS_KEY, PRODUCTS_KEY, ['suppliers']]) void qc.invalidateQueries({ queryKey: key });
  };
}

/** Opens a statement PDF in a new tab. */
export function openStatement(kind: 'customers' | 'suppliers', id: number, range: { from?: string; to?: string }) {
  window.open(`/api/${kind}/${id}/statement.pdf?${qs(range)}`, '_blank');
}
