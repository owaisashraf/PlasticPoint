import type { ReactNode } from 'react';
import type { PermissionKey } from '@shopledger/shared';
import { useCan } from '@/features/auth/useAuth';
import { FullPageMessage } from './FullPageMessage';

/**
 * Shows the page only with the permission. The page's data is never fetched
 * otherwise, because its components are not rendered. The server still
 * refuses the API calls on its own.
 */
export function Guard({ permission, children }: { permission: PermissionKey; children: ReactNode }) {
  const can = useCan();
  if (!can(permission)) {
    return <FullPageMessage inline title="Not available" detail="Your account does not have access to this page. Ask the owner if you need it." />;
  }
  return <>{children}</>;
}
