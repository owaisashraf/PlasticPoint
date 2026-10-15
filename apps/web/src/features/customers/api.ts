import { useQuery } from '@tanstack/react-query';
import type { Customer, PublicSettings, Statement } from '@shopledger/shared';
import { api, queryString } from '@/lib/api';

export const CUSTOMERS_KEY = ['customers'] as const;

export interface CustomerFilters {
  q?: string;
  type?: string;
  city?: string;
  status?: string;
  limit?: number;
}

export function useCustomers(f: CustomerFilters, enabled = true) {
  return useQuery({
    queryKey: [...CUSTOMERS_KEY, 'list', f],
    queryFn: () => api.get<{ customers: Customer[]; total: number }>(`/api/customers?${queryString({ ...f })}`),
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
    queryFn: () => api.get<Statement>(`/api/customers/${id}/ledger?${queryString(range)}`),
  });
}

export function useCities(enabled = true) {
  return useQuery({ queryKey: [...CUSTOMERS_KEY, 'cities'], queryFn: () => api.get<{ cities: string[] }>('/api/customers/cities').then((r) => r.cities), enabled });
}

export function usePublicSettings() {
  return useQuery({ queryKey: ['settings', 'public'], queryFn: () => api.get<PublicSettings>('/api/settings/public'), staleTime: 5 * 60_000 });
}
