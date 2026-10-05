import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { Me, PermissionKey, SetupStatus } from '@shopledger/shared';
import { can } from '@shopledger/shared';
import { api, ApiError } from '@/lib/api';

export const ME_KEY = ['me'] as const;
export const SETUP_KEY = ['setup-status'] as const;

/** The logged-in user, or null if not logged in. */
export function useMe() {
  return useQuery({
    queryKey: ME_KEY,
    queryFn: async () => {
      try {
        return await api.get<Me>('/api/me');
      } catch (e) {
        if (e instanceof ApiError && e.status === 401) return null;
        throw e;
      }
    },
    staleTime: 60_000,
  });
}

export function useSetupStatus() {
  return useQuery({ queryKey: SETUP_KEY, queryFn: () => api.get<SetupStatus>('/api/setup/status') });
}

/** Permission check for showing or hiding UI. The server enforces the same keys. */
export function useCan() {
  const { data } = useMe();
  return (key: PermissionKey) => can(data ? { role: data.user.role, permissions: data.permissions } : null, key);
}

export function useRefreshAuth() {
  const qc = useQueryClient();
  return async () => {
    await qc.invalidateQueries({ queryKey: SETUP_KEY });
    await qc.invalidateQueries({ queryKey: ME_KEY });
  };
}

/** After logout or restore: forget everything cached for the previous user. */
export function useClearSession() {
  const qc = useQueryClient();
  return () => {
    qc.clear();
  };
}
