import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Asset, Expense, ExpenseCategory, ExpenseList, Role } from '@shopledger/shared';
import { createTestContext, type TestContext } from '../../../test/helpers';

// Expenses (CLAUDE.md 8.12) and assets (8.13): owner and superuser only.

let t: TestContext;

beforeEach(async () => {
  // The clock is set first: sessions created at login expire after 12 idle hours.
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-10T06:00:00Z'));
  t = await createTestContext();
});
afterEach(async () => {
  vi.useRealTimers();
  await t.close();
});

async function call(role: Role, method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE', url: string, payload?: object) {
  return t.app.inject({ method, url, headers: { cookie: await t.cookie(role) }, ...(payload ? { payload } : {}) });
}
async function ok<T>(role: Role, method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE', url: string, payload?: object): Promise<T> {
  const res = await call(role, method, url, payload);
  expect(res.statusCode, `${method} ${url}: ${res.body}`).toBe(200);
  return res.json() as T;
}
const lastAudit = () => t.dbh.sqlite.prepare('SELECT action, entity, doc_no, flags, reason FROM audit_log ORDER BY id DESC LIMIT 1').get() as { action: string; entity: string; doc_no: string; flags: string; reason: string | null };
const categories = async () => (await ok<{ categories: ExpenseCategory[] }>('owner', 'GET', '/api/expense-categories')).categories;
const catId = async (name: string) => (await categories()).find((c) => c.name === name)?.id as number;
const expense = (extra: object = {}) => ({ date: '2026-10-05', amount_paisa: 2_500_000, method: 'cash', paid_to: 'Landlord', ...extra });

describe('expense categories', () => {
  it('start with the nine defaults, and can be added, renamed and deactivated', async () => {
    expect((await categories()).map((c) => c.name)).toEqual([
      'Bank charges',
      'Electricity & gas',
      'Miscellaneous',
      'Packing material',
      'Phone & internet',
      'Rent',
      'Repairs & maintenance',
      'Salaries & wages',
      'Transport & freight',
    ]);
    const c = (await ok<{ category: ExpenseCategory }>('owner', 'POST', '/api/expense-categories', { name: 'Tea & refreshments' })).category;
    expect(lastAudit()).toMatchObject({ action: 'create', entity: 'expense_category' });
    expect((await call('owner', 'POST', '/api/expense-categories', { name: 'tea & REFRESHMENTS' })).statusCode).toBe(409);
    await ok('owner', 'PATCH', `/api/expense-categories/${c.id}`, { name: 'Tea', active: false });
    expect((await categories()).find((x) => x.id === c.id)).toMatchObject({ name: 'Tea', active: false });
    // A deactivated category cannot be used for new expenses.
    expect((await call('owner', 'POST', '/api/expenses', expense({ category_id: c.id }))).json().error).toMatch(/no longer in use/);
  });

  it('can be deleted only while unused', async () => {
    const rent = await catId('Rent');
    await ok('owner', 'POST', '/api/expenses', expense({ category_id: rent }));
    expect((await call('owner', 'DELETE', `/api/expense-categories/${rent}`)).json().error).toMatch(/Deactivate it instead/);
    const misc = await catId('Miscellaneous');
    await ok('owner', 'DELETE', `/api/expense-categories/${misc}`);
    expect(await catId('Miscellaneous')).toBeUndefined();
    expect(lastAudit()).toMatchObject({ action: 'delete', entity: 'expense_category', doc_no: 'Miscellaneous' });
  });
});

describe('expenses', () => {
  it('are numbered, audited, listed with totals by category and month', async () => {
    const rent = await catId('Rent');
    const power = await catId('Electricity & gas');
    const before = t.auditCount();
    const e = (await ok<{ expense: Expense }>('owner', 'POST', '/api/expenses', expense({ category_id: rent }))).expense;
    expect(e).toMatchObject({ doc_no: 'EXP-000001', category_name: 'Rent', amount_paisa: 2_500_000, status: 'posted', version: 1 });
    expect(t.auditCount()).toBe(before + 1);
    await ok('superuser', 'POST', '/api/expenses', expense({ category_id: power, date: '2026-09-28', amount_paisa: 800_000, method: 'bank', paid_to: 'LESCO' }));
    await ok('owner', 'POST', '/api/expenses', expense({ category_id: power, amount_paisa: 450_050, paid_to: 'SNGPL' }));

    const all = await ok<ExpenseList>('owner', 'GET', '/api/expenses');
    expect(all.expenses.map((x) => x.doc_no)).toEqual(['EXP-000003', 'EXP-000001', 'EXP-000002']);
    expect(all.total_paisa).toBe(3_750_050);
    expect(all.by_category).toEqual([
      { category_id: rent, name: 'Rent', total_paisa: 2_500_000, count: 1 },
      { category_id: power, name: 'Electricity & gas', total_paisa: 1_250_050, count: 2 },
    ]);
    expect(all.by_month).toEqual([
      { month: '2026-10', total_paisa: 2_950_050, count: 2 },
      { month: '2026-09', total_paisa: 800_000, count: 1 },
    ]);
    const filtered = await ok<ExpenseList>('owner', 'GET', `/api/expenses?method=bank`);
    expect(filtered.expenses.map((x) => x.paid_to)).toEqual(['LESCO']);
    expect((await ok<ExpenseList>('owner', 'GET', `/api/expenses?category_id=${power}&from=2026-10-01`)).total_paisa).toBe(450_050);
    expect((await ok<ExpenseList>('owner', 'GET', '/api/expenses?q=sngpl')).expenses).toHaveLength(1);
  });

  it('edit and void need a reason and are audited; voided expenses leave the totals', async () => {
    const rent = await catId('Rent');
    const e = (await ok<{ expense: Expense }>('owner', 'POST', '/api/expenses', expense({ category_id: rent }))).expense;
    const edited = (await ok<{ expense: Expense }>('owner', 'PUT', `/api/expenses/${e.id}`, { ...expense({ category_id: rent, amount_paisa: 2_000_000 }), change_reason: 'Discount from landlord' })).expense;
    expect(edited).toMatchObject({ version: 2, amount_paisa: 2_000_000 });
    expect(lastAudit()).toMatchObject({ action: 'edit', entity: 'expense', doc_no: 'EXP-000001', reason: 'Discount from landlord' });
    expect(JSON.parse(lastAudit().flags)).toContain('total_reduced');
    expect((await call('owner', 'PUT', `/api/expenses/${e.id}`, expense({ category_id: rent }))).statusCode).toBe(400); // no reason

    await ok('owner', 'POST', `/api/expenses/${e.id}/void`, { reason: 'Paid twice by mistake' });
    const list = await ok<ExpenseList>('owner', 'GET', '/api/expenses');
    expect(list.expenses[0]).toMatchObject({ status: 'void', version: 3 });
    expect(list.total_paisa).toBe(0);
    expect((await call('owner', 'PUT', `/api/expenses/${e.id}`, { ...expense({ category_id: rent }), change_reason: 'Try again' })).json().error).toMatch(/void and cannot be changed/);
  });

  it('refuse future dates, and operators cannot see or touch them', async () => {
    const rent = await catId('Rent');
    expect((await call('owner', 'POST', '/api/expenses', expense({ category_id: rent, date: '2026-10-11' }))).json().error).toMatch(/future/);
    for (const [m, url] of [['GET', '/api/expenses'], ['POST', '/api/expenses'], ['GET', '/api/expense-categories'], ['GET', '/api/assets']] as const) {
      expect((await call('operator', m, url, m === 'POST' ? expense({ category_id: rent }) : undefined)).statusCode).toBe(403);
    }
  });
});

describe('assets', () => {
  const laptop = {
    name: 'Dell laptop',
    category: 'computer',
    purchase_date: '2026-01-15',
    cost_paisa: 12_000_000,
    method: 'bank',
    vendor: 'Hafeez Centre',
    depreciation_method: 'straight_line',
    useful_life_months: 12,
    salvage_value_paisa: 0,
  };

  it('register shows depreciation and book value as of a date, with a monthly schedule', async () => {
    const a = (await ok<{ asset: Asset }>('owner', 'POST', '/api/assets', laptop)).asset;
    expect(a).toMatchObject({ doc_no: 'AST-000001', status: 'active', monthly_depreciation_paisa: 1_000_000, as_of: '2026-10-10' });
    // Feb–Sep charged (8 months); October counts on the 31st.
    expect(a).toMatchObject({ accumulated_depreciation_paisa: 8_000_000, book_value_paisa: 4_000_000 });
    expect(a.schedule).toHaveLength(12);
    expect(lastAudit()).toMatchObject({ action: 'create', entity: 'asset', doc_no: 'AST-000001' });

    await ok('owner', 'POST', '/api/assets', { ...laptop, name: 'Shop counter', category: 'furniture', purchase_date: '2026-03-01', cost_paisa: 5_000_000, depreciation_method: 'none', useful_life_months: null });
    const reg = await ok<{ assets: Asset[]; totals: { cost_paisa: number; book_value_paisa: number } }>('owner', 'GET', '/api/assets?as_of=2026-06-30');
    expect(reg.assets.map((x) => [x.name, x.book_value_paisa])).toEqual([
      ['Shop counter', 5_000_000],
      ['Dell laptop', 7_000_000],
    ]);
    expect(reg.totals).toMatchObject({ cost_paisa: 17_000_000, book_value_paisa: 12_000_000 });
    // Before the counter was bought it is not in the register.
    expect((await ok<{ assets: Asset[] }>('owner', 'GET', '/api/assets?as_of=2026-02-28')).assets.map((x) => x.name)).toEqual(['Dell laptop']);
  });

  it('needs a useful life for straight-line, and salvage within cost', async () => {
    expect((await call('owner', 'POST', '/api/assets', { ...laptop, useful_life_months: null })).json().error).toMatch(/useful life/);
    expect((await call('owner', 'POST', '/api/assets', { ...laptop, salvage_value_paisa: 12_000_001 })).json().error).toMatch(/Salvage value/);
  });

  it('disposal: gain or loss against book value, depreciation stops; cannot dispose twice', async () => {
    const a = (await ok<{ asset: Asset }>('owner', 'POST', '/api/assets', laptop)).asset;
    expect((await call('owner', 'POST', `/api/assets/${a.id}/dispose`, { date: '2026-01-01', amount_paisa: 0, method: 'cash', reason: 'Sold' })).json().error).toMatch(/before the purchase/);
    const d = (await ok<{ asset: Asset }>('owner', 'POST', `/api/assets/${a.id}/dispose`, { date: '2026-05-20', amount_paisa: 9_500_000, method: 'cash', reason: 'Sold to a staff member' })).asset;
    // Feb–Apr charged: book value Rs 90,000; sold for Rs 95,000 → gain Rs 5,000.
    expect(d).toMatchObject({ status: 'disposed', disposal_gain_paisa: 500_000, as_of: '2026-05-20', book_value_paisa: 9_000_000, version: 2 });
    expect(d.schedule?.map((r) => r.month)).toEqual(['2026-02', '2026-03', '2026-04']);
    expect(lastAudit()).toMatchObject({ action: 'dispose', entity: 'asset', reason: 'Sold to a staff member' });
    expect((await call('owner', 'POST', `/api/assets/${a.id}/dispose`, { date: '2026-06-01', amount_paisa: 0, method: 'cash', reason: 'Again' })).json().error).toMatch(/already disposed/);
  });

  it('edit and void with a reason; void assets leave the register totals', async () => {
    const a = (await ok<{ asset: Asset }>('owner', 'POST', '/api/assets', laptop)).asset;
    const e = (await ok<{ asset: Asset }>('owner', 'PUT', `/api/assets/${a.id}`, { ...laptop, useful_life_months: 24, change_reason: 'Two years is more realistic' })).asset;
    expect(e).toMatchObject({ version: 2, monthly_depreciation_paisa: 500_000, accumulated_depreciation_paisa: 4_000_000 });
    expect(lastAudit()).toMatchObject({ action: 'edit', entity: 'asset', reason: 'Two years is more realistic' });
    expect((await call('operator', 'POST', `/api/assets/${a.id}/void`, { reason: 'Mistake' })).statusCode).toBe(403);
    await ok('owner', 'POST', `/api/assets/${a.id}/void`, { reason: 'Entered twice' });
    const reg = await ok<{ assets: Asset[]; totals: { cost_paisa: number } }>('owner', 'GET', '/api/assets');
    expect(reg.assets[0]).toMatchObject({ status: 'void', accumulated_depreciation_paisa: 0 });
    expect(reg.totals.cost_paisa).toBe(0);
  });
});
