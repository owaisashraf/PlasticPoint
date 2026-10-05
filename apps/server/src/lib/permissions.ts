import type { FastifyReply, FastifyRequest } from 'fastify';
import { can, permissionsFor, type KnownPermission, type PermissionKey, type Role } from '@shopledger/shared';
import { forbidden, unauthorized } from './errors';

export { can };

export interface SessionUser {
  id: number;
  username: string;
  display_name: string;
  role: Role;
  active: boolean;
  created_at: string;
  updated_at: string;
  /** Effective permission keys for this request (role + settings). */
  permissions: KnownPermission[];
}

/** Who may call a route: anyone, any logged-in user, or holders of one key. */
export type RouteAccess = 'public' | 'authenticated' | PermissionKey;

declare module 'fastify' {
  interface FastifyRequest {
    user: SessionUser | null;
  }
  interface FastifyContextConfig {
    access?: RouteAccess;
  }
}

export function effectivePermissions(role: Role, operatorsCanRecordPurchases: boolean): KnownPermission[] {
  return permissionsFor(role, { operators_can_record_purchases: operatorsCanRecordPurchases });
}

/** Throws 401/403 unless the request's user holds `key`. */
export function assertPermission(user: SessionUser | null, key: PermissionKey): asserts user is SessionUser {
  if (!user) throw unauthorized();
  if (!can(user, key)) throw forbidden();
}

/** Throws 401 unless someone is logged in. */
export function assertAuthenticated(user: SessionUser | null): asserts user is SessionUser {
  if (!user) throw unauthorized();
}

/**
 * Route guard. Spread into route options:
 *
 *   app.get('/api/settings', { ...requirePermission('settings.manage'), schema }, handler)
 *
 * It runs at onRequest, before the body is parsed or validated, so a user
 * without the key always gets 403 regardless of what they send. The key is
 * also recorded in the route config so every /api route must declare one.
 */
export function requirePermission(key: PermissionKey) {
  return {
    config: { access: key },
    onRequest: async (req: FastifyRequest, _reply: FastifyReply) => {
      assertPermission(req.user, key);
    },
  };
}

/** Any logged-in user. */
export const authenticated = {
  config: { access: 'authenticated' as const },
  onRequest: async (req: FastifyRequest, _reply: FastifyReply) => {
    assertAuthenticated(req.user);
  },
};

/** No login needed (health, setup status, login). */
export const publicRoute = {
  config: { access: 'public' as const },
};

/** The logged-in user from a route that already passed a guard. */
export function currentUser(req: FastifyRequest): SessionUser {
  assertAuthenticated(req.user);
  return req.user;
}
