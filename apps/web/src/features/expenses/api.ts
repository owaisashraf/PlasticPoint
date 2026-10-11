import { useQuery } from '@tanstack/react-query';
import type { Asset, ExpenseCategory, ExpenseList } from '@shopledger/shared';
import { api } from '@/lib/api';

export const EXPENSES_KEY = ['expenses'] as const;
export const ASSETS_KEY = ['assets'] as const;

function qs(f: Record<string, string | number | undefined>): string {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(f)) if (v !== undefined && v !== '') p.set(k, String(v));
  return p.toString();
}

export function useExpenseCategories(enabled = true) {
  return useQuery({ queryKey: [...EXPENSES_KEY, 'categories'], queryFn: () => api.get<{ categories: ExpenseCategory[] }>('/api/expense-categories').then((r) => r.categories), enabled });
}

export function useExpenses(f: { q?: string; from?: string; to?: string; category_id?: string; method?: string; limit?: number }) {
  return useQuery({
    queryKey: [...EXPENSES_KEY, 'list', f],
    queryFn: () => api.get<ExpenseList>(`/api/expenses?${qs(f)}`),
    placeholderData: (prev) => prev,
  });
}

export function useAssets(f: { status?: string; as_of?: string }) {
  return useQuery({
    queryKey: [...ASSETS_KEY, 'list', f],
    queryFn: () => api.get<{ assets: Asset[]; totals: { cost_paisa: number; accumulated_depreciation_paisa: number; book_value_paisa: number } }>(`/api/assets?${qs(f)}`),
    placeholderData: (prev) => prev,
  });
}

export function useAsset(id: number) {
  return useQuery({ queryKey: [...ASSETS_KEY, 'one', id], queryFn: () => api.get<{ asset: Asset }>(`/api/assets/${id}`).then((r) => r.asset) });
}

export const CATEGORY_LABEL: Record<Asset['category'], string> = {
  furniture: 'Furniture',
  equipment: 'Equipment',
  computer: 'Computer',
  vehicle: 'Vehicle',
  other: 'Other',
};
