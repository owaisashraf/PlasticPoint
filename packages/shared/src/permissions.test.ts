import { describe, expect, it } from 'vitest';
import { can, PERMISSION_KEYS, permissionsFor, type KnownPermission, type Role } from './permissions';

const on = { operators_can_record_purchases: true };
const off = { operators_can_record_purchases: false };

function user(role: Role, settings = on) {
  return { role, permissions: permissionsFor(role, settings) };
}

// The section 9 table: which roles have each key.
const MATRIX: Record<KnownPermission, Role[]> = {
  'dashboard.view': ['operator', 'owner', 'superuser'],
  'sales.view': ['operator', 'owner', 'superuser'],
  'sales.create': ['operator', 'owner', 'superuser'],
  'purchases.view': ['operator', 'owner', 'superuser'],
  'purchases.create': ['operator', 'owner', 'superuser'],
  'payments.view': ['operator', 'owner', 'superuser'],
  'payments.create': ['operator', 'owner', 'superuser'],
  'returns.view': ['operator', 'owner', 'superuser'],
  'returns.create': ['operator', 'owner', 'superuser'],
  'customers.view': ['operator', 'owner', 'superuser'],
  'customers.manage': ['operator', 'owner', 'superuser'],
  'products.view': ['operator', 'owner', 'superuser'],
  'products.manage': ['operator', 'owner', 'superuser'],
  'overdue.view': ['operator', 'owner', 'superuser'],
  'reports.operational': ['operator', 'owner', 'superuser'],
  'documents.edit_own_same_day': ['operator', 'owner', 'superuser'],
  'documents.edit_any': ['owner', 'superuser'],
  'customers.bad_debt': ['owner', 'superuser'],
  'write_offs.manage': ['owner', 'superuser'],
  'cheques.mark_bounced': ['owner', 'superuser'],
  'pricing.manage': ['owner', 'superuser'],
  'approvals.grant': ['owner', 'superuser'],
  'finance.view': ['owner', 'superuser'],
  'expenses.manage': ['owner', 'superuser'],
  'assets.manage': ['owner', 'superuser'],
  'reports.financial': ['owner', 'superuser'],
  'settings.manage': ['owner', 'superuser'],
  'backups.manage': ['owner', 'superuser'],
  'users.manage_operators': ['owner', 'superuser'],
  'users.manage_owners': ['superuser'],
  'changelog.view': ['superuser'],
  'changelog.review': ['superuser'],
  'changelog.verify': ['superuser'],
};

describe('permissions matrix', () => {
  it('covers every key', () => {
    expect(Object.keys(MATRIX).sort()).toEqual([...PERMISSION_KEYS].sort());
  });

  for (const key of PERMISSION_KEYS) {
    for (const role of ['operator', 'owner', 'superuser'] as const) {
      const expected = MATRIX[key].includes(role);
      it(`${role} ${expected ? 'has' : 'lacks'} ${key}`, () => {
        expect(can(user(role), key)).toBe(expected);
      });
    }
  }

  it('the superuser has every key, including future superuser.* keys', () => {
    const su = user('superuser');
    expect(can(su, 'superuser.some_future_feature')).toBe(true);
    expect(PERMISSION_KEYS.every((k) => su.permissions.includes(k))).toBe(true);
  });

  it('owners and operators never get superuser.* keys', () => {
    expect(can(user('owner'), 'superuser.some_future_feature')).toBe(false);
    expect(can(user('operator'), 'superuser.some_future_feature')).toBe(false);
  });

  it('operators_can_record_purchases=false removes purchases.create from operators only', () => {
    expect(can(user('operator', off), 'purchases.create')).toBe(false);
    expect(can(user('operator', off), 'purchases.view')).toBe(true);
    expect(can(user('owner', off), 'purchases.create')).toBe(true);
    expect(can(user('superuser', off), 'purchases.create')).toBe(true);
  });

  it('a missing user has no permissions', () => {
    expect(can(null, 'dashboard.view')).toBe(false);
  });
});
