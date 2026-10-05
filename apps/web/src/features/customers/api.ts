import { useQuery } from '@tanstack/react-query';
import type { Customer, PublicSettings, Statement } from '@shopledger/shared';
import { api } from '@/lib/api';

export const CUSTOMERS_KEY = ['customers'] as const;

export interface CustomerFilters {
  q?: string;
  type?: string;
  city?: string;
  status?: string;
  limit?: number;
}

function qs(f: Record<string, string | number | undefined>): string {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(f)) if (v !== undefined && v !== '') p.set(k, String(v));
  return p.toString();
}

export function useCustomers(f: CustomerFilters, enabled = true) {
  return useQuery({
    queryKey: [...CUSTOMERS_KEY, 'list', f],
    queryFn: () => api.get<{ customers: Customer[]; total: number }>(`/api/customers?${qs({ ...f })}`),
    enabled,
    placeholderData: (prev) => prev,
  });
}

export function useCustomer(id: number, enabled = true) {
  return useQuery({
    queryKey: [...CUSTOMERS_KEY, 'one', id],
    queryFn: () => api.get<{ customer: Customer }>(`/api/customers/${id}`).then((r) => r.customer),
    enabled,
  });
}

export function useCustomerLedger(id: number, range: { from?: string; to?: string }) {
  return useQuery({
    queryKey: [...CUSTOMERS_KEY, 'ledger', id, range],
    queryFn: () => api.get<Statement>(`/api/customers/${id}/ledger?${qs(range)}`),
  });
}

export function useCities() {
  return useQuery({ queryKey: [...CUSTOMERS_KEY, 'cities'], queryFn: () => api.get<{ cities: string[] }>('/api/customers/cities').then((r) => r.cities) });
}

export function usePublicSettings() {
  return useQuery({ queryKey: ['settings', 'public'], queryFn: () => api.get<PublicSettings>('/api/settings/public'), staleTime: 5 * 60_000 });
}
