export const ROLES = ['superuser', 'owner', 'operator'] as const;
export type Role = (typeof ROLES)[number];

/**
 * Every permission key in the app. Routes declare the key they need; the UI
 * uses the same keys to show or hide menus, columns and buttons.
 *
 * Superuser-only features use the `superuser.` prefix (or are simply left out
 * of the owner/operator sets). The superuser automatically has every key,
 * including any future `superuser.<feature>` key, without other code changes.
 */
export const PERMISSION_KEYS = [
  // Day-to-day work (all roles)
  'dashboard.view',
  'sales.view',
  'sales.create',
  'purchases.view',
  'purchases.create', // operators only when settings.operators_can_record_purchases
  'payments.view',
  'payments.create',
  'returns.view',
  'returns.create',
  'customers.view',
  'customers.manage',
  'products.view',
  'products.manage',
  'overdue.view',
  'reports.operational',
  'documents.edit_own_same_day',

  // Owner and superuser
  'documents.edit_any',
  'customers.bad_debt',
  'write_offs.manage',
  'cheques.mark_bounced',
  'pricing.manage',
  'approvals.grant',
  'finance.view',
  'expenses.manage',
  'assets.manage',
  'reports.financial',
  'settings.manage',
  'backups.manage',
  'users.manage_operators',
  'suppliers.manage',

  // Superuser only
  'users.manage_owners',
  'changelog.view',
  'changelog.review',
  'changelog.verify',
] as const;

export type KnownPermission = (typeof PERMISSION_KEYS)[number];
export type PermissionKey = KnownPermission | `superuser.${string}`;

const OPERATOR_KEYS: readonly KnownPermission[] = [
  'dashboard.view',
  'sales.view',
  'sales.create',
  'purchases.view',
  'purchases.create',
  'payments.view',
  'payments.create',
  'returns.view',
  'returns.create',
  'customers.view',
  'customers.manage',
  'products.view',
  'products.manage',
  'overdue.view',
  'reports.operational',
  'documents.edit_own_same_day',
];

const OWNER_KEYS: readonly KnownPermission[] = [
  ...OPERATOR_KEYS,
  'documents.edit_any',
  'customers.bad_debt',
  'write_offs.manage',
  'cheques.mark_bounced',
  'pricing.manage',
  'approvals.grant',
  'finance.view',
  'expenses.manage',
  'assets.manage',
  'reports.financial',
  'settings.manage',
  'backups.manage',
  'users.manage_operators',
  'suppliers.manage',
];

/** Role -> permission keys. The superuser gets every key. */
export const ROLE_PERMISSIONS: Record<Role, readonly KnownPermission[]> = {
  superuser: PERMISSION_KEYS,
  owner: OWNER_KEYS,
  operator: OPERATOR_KEYS,
};

/** Settings that can switch an operator permission off. */
export interface PermissionSettings {
  operators_can_record_purchases: boolean;
}

/** The effective permission list for a role, taking settings into account. */
export function permissionsFor(role: Role, settings: PermissionSettings): KnownPermission[] {
  let keys = [...ROLE_PERMISSIONS[role]];
  if (role === 'operator' && !settings.operators_can_record_purchases) {
    keys = keys.filter((k) => k !== 'purchases.create');
  }
  return keys;
}

/**
 * Whether a user with this role and permission list may use `key`.
 * The superuser always may, including for `superuser.*` keys that do not
 * exist yet.
 */
export function can(
  user: { role: Role; permissions: readonly string[] } | null | undefined,
  key: PermissionKey,
): boolean {
  if (!user) return false;
  if (user.role === 'superuser') return true;
  if (key.startsWith('superuser.')) return false;
  return user.permissions.includes(key);
}
