import { DEFAULT_SETTINGS, PUBLIC_SETTING_KEYS } from '@shopledger/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestContext, type TestContext } from '../../../test/helpers';
import { getSettings } from './service';

let t: TestContext;
beforeEach(async () => {
  t = await createTestContext();
});
afterEach(async () => {
  await t.close();
});

const patch = async (role: 'operator' | 'owner' | 'superuser', changes: object) =>
  t.app.inject({ method: 'PATCH', url: '/api/settings', headers: { cookie: await t.cookie(role) }, payload: { changes } });

describe('settings', () => {
  it('has the documented defaults', () => {
    const s = getSettings(t.dbh.db);
    expect(s).toEqual(DEFAULT_SETTINGS);
    expect(s).toMatchObject({
      default_payment_terms_days: 30,
      grace_days: 0,
      default_supplier_margin_bp: 1200,
      default_customer_discount_bp: 1000,
      retail_discount_reduction_bp: 0,
      min_profit_bp: 0,
      below_min_profit_action: 'warn',
      operators_can_record_purchases: true,
      include_depreciation_in_profit: true,
      allow_negative_stock: false,
      allow_lan_access: false,
      fiscal_year_start_month: 7,
      prefix_sale: 'INV',
      backup_time: '21:00',
    });
  });

  it('owner updates settings with exactly one audit row holding before and after', async () => {
    const before = t.auditCount();
    const res = await patch('owner', { default_payment_terms_days: 45, min_profit_bp: 150 });
    expect(res.statusCode).toBe(200);
    expect(res.json().changed.sort()).toEqual(['default_payment_terms_days', 'min_profit_bp']);
    expect(getSettings(t.dbh.db).default_payment_terms_days).toBe(45);
    expect(t.auditCount()).toBe(before + 1);
    const row = t.dbh.sqlite.prepare('SELECT * FROM audit_log ORDER BY id DESC LIMIT 1').get() as Record<string, string>;
    expect(row.entity).toBe('settings');
    expect(JSON.parse(row.before_json ?? '')).toEqual({ default_payment_terms_days: 30, min_profit_bp: 0 });
    expect(JSON.parse(row.after_json ?? '')).toEqual({ default_payment_terms_days: 45, min_profit_bp: 150 });
    expect(JSON.parse(row.flags ?? '')).toContain('price_changed');
  });

  it('a save changes only the settings it sends; earlier saved values are kept', async () => {
    expect((await patch('owner', { business_name: 'Plastic Point', grace_days: 5 })).statusCode).toBe(200);
    const res = await patch('owner', { default_payment_terms_days: 45 });
    expect(res.json().changed).toEqual(['default_payment_terms_days']);
    expect(getSettings(t.dbh.db)).toMatchObject({ business_name: 'Plastic Point', grace_days: 5, default_payment_terms_days: 45 });
  });

  it('a no-op update writes nothing', async () => {
    const before = t.auditCount();
    expect((await patch('owner', { grace_days: 0 })).statusCode).toBe(200);
    expect(t.auditCount()).toBe(before);
  });

  it('setting a value back to its default removes the stored row', async () => {
    await patch('owner', { grace_days: 5 });
    await patch('owner', { grace_days: 0 });
    const n = t.dbh.sqlite.prepare("SELECT COUNT(*) AS n FROM settings WHERE key = 'grace_days'").get() as { n: number };
    expect(n.n).toBe(0);
  });

  it('validates values and cross-field rules', async () => {
    expect((await patch('owner', { default_supplier_margin_bp: 12.5 })).statusCode).toBe(400);
    expect((await patch('owner', { fiscal_year_start_month: 13 })).statusCode).toBe(400);
    expect((await patch('owner', { not_a_setting: 1 })).statusCode).toBe(400);
    const bands = await patch('owner', { overdue_amber_max_days: 50 });
    expect(bands.statusCode).toBe(400);
    expect(bands.json().error).toMatch(/orange band/);
    expect((await patch('owner', { prefix_purchase: 'INV' })).statusCode).toBe(400);
  });

  it('operators cannot read or change settings, but can read the public subset', async () => {
    const cookie = await t.cookie('operator');
    expect((await t.app.inject({ method: 'GET', url: '/api/settings', headers: { cookie } })).statusCode).toBe(403);
    expect((await patch('operator', { grace_days: 3 })).statusCode).toBe(403);
    const pub = await t.app.inject({ method: 'GET', url: '/api/settings/public', headers: { cookie } });
    expect(pub.statusCode).toBe(200);
    expect(Object.keys(pub.json()).sort()).toEqual([...PUBLIC_SETTING_KEYS].sort());
    expect(pub.json().default_supplier_margin_bp).toBeUndefined();
    expect(pub.json().min_profit_bp).toBeUndefined();
  });

  it('operators_can_record_purchases switches purchases.create for operators', async () => {
    const cookie = await t.cookie('operator');
    const perms = async () => (await t.app.inject({ method: 'GET', url: '/api/me', headers: { cookie } })).json().permissions as string[];
    expect(await perms()).toContain('purchases.create');
    await patch('owner', { operators_can_record_purchases: false });
    expect(await perms()).not.toContain('purchases.create');
  });

  it('LAN access needs a restart', async () => {
    const res = await patch('owner', { allow_lan_access: true });
    expect(res.json().restart_required).toBe(true);
  });
});
