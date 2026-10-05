import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Customer, Role } from '@shopledger/shared';
import { createTestContext, type TestContext } from '../../../test/helpers';
import { updateSettings } from '../settings/service';

let t: TestContext;
beforeEach(async () => {
  t = await createTestContext();
});
afterEach(async () => {
  await t.close();
});

async function call(role: Role, method: 'GET' | 'POST' | 'PATCH', url: string, payload?: object) {
  return t.app.inject({ method, url, headers: { cookie: await t.cookie(role) }, ...(payload ? { payload } : {}) });
}

async function create(body: object, role: Role = 'operator'): Promise<Customer> {
  const res = await call(role, 'POST', '/api/customers', { type: 'wholesaler', ...body });
  expect(res.statusCode, res.body).toBe(200);
  return res.json().customer;
}

const search = async (q: string) =>
  ((await call('operator', 'GET', `/api/customers?q=${encodeURIComponent(q)}`)).json().customers as Customer[]).map((c) => c.name);

describe('creating customers', () => {
  it('assigns codes, normalizes phones and takes terms from settings', async () => {
    updateSettings(t.dbh.db, { id: null, role: 'system' }, { default_payment_terms_days: 45 });
    const a = await create({ name: 'Ahmed Traders', phone: '0300-1234567' });
    const b = await create({ name: 'Bilal Store', payment_terms_days: 15 });
    expect(a.code).toBe('C-0001');
    expect(b.code).toBe('C-0002');
    expect(a.phone).toBe('+923001234567');
    expect(a.payment_terms_days).toBe(45);
    expect(b.payment_terms_days).toBe(15);
    expect(a.status).toBe('active');
    expect(a.balance_paisa).toBe(0);
  });

  it('rejects an invalid phone number with a clear message', async () => {
    const res = await call('operator', 'POST', '/api/customers', { name: 'X', type: 'retailer', phone: '12345' });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/valid phone/);
  });

  it('posts the opening balance to the ledger', async () => {
    const owes = await create({ name: 'Owes Us', opening_balance_paisa: 4_500_000, opening_balance_date: '2026-07-01' });
    expect(owes.balance_paisa).toBe(4_500_000);
    expect(owes.opening_balance_paisa).toBe(4_500_000);
    const advance = await create({ name: 'Paid Ahead', opening_balance_paisa: -200_000 });
    expect(advance.balance_paisa).toBe(-200_000);

    const ledger = (await call('operator', 'GET', `/api/customers/${owes.id}/ledger`)).json();
    expect(ledger.lines).toHaveLength(1);
    expect(ledger.lines[0]).toMatchObject({ entry_type: 'opening_balance', debit_paisa: 4_500_000, balance_paisa: 4_500_000 });
  });

  it('writes exactly one audit row per create', async () => {
    const before = t.auditCount();
    await create({ name: 'One Row', opening_balance_paisa: 100 });
    expect(t.auditCount()).toBe(before + 1);
  });
});

describe('search', () => {
  beforeEach(async () => {
    await create({ name: 'Ahmed Khan', business_name: 'Khan Plastics', city: 'Lahore', phone: '0300 1234567' });
    await create({ name: 'Bilal Ahmed', business_name: 'Bilal & Sons', city: 'Karachi', phone: '+923211112222' });
    await create({ name: 'Imran Shah', city: 'Faisalabad', type: 'retailer' });
  });

  it('matches partial words anywhere in name, business, city or code', async () => {
    expect((await search('hmed')).sort()).toEqual(['Ahmed Khan', 'Bilal Ahmed']);
    expect(await search('plast')).toEqual(['Ahmed Khan']);
    expect(await search('faisal')).toEqual(['Imran Shah']);
    expect(await search('ahmed kar')).toEqual(['Bilal Ahmed']);
    expect(await search('C-0003')).toEqual(['Imran Shah']);
  });

  it('finds phones in local or international form', async () => {
    expect(await search('0300-1234')).toEqual(['Ahmed Khan']);
    expect(await search('03211112222')).toEqual(['Bilal Ahmed']);
    expect(await search('+92321')).toEqual(['Bilal Ahmed']);
  });

  it('handles one- and two-letter words and odd characters safely', async () => {
    expect(await search('Sh')).toEqual(['Imran Shah']);
    expect(await search('"%_')).toEqual([]);
  });

  it('stays in sync after an edit', async () => {
    const [c] = (await call('operator', 'GET', '/api/customers?q=Imran')).json().customers as Customer[];
    await call('operator', 'PATCH', `/api/customers/${c?.id}`, { city: 'Multan' });
    expect(await search('multan')).toEqual(['Imran Shah']);
    expect(await search('faisal')).toEqual([]);
  });

  it('filters by type, city and status', async () => {
    const q = async (qs: string) => ((await call('owner', 'GET', `/api/customers?${qs}`)).json().customers as Customer[]).map((c) => c.name);
    expect(await q('type=retailer')).toEqual(['Imran Shah']);
    expect(await q('city=lahore')).toEqual(['Ahmed Khan']);
    expect(await q('status=bad_debt')).toEqual([]);
    const cities = (await call('operator', 'GET', '/api/customers/cities')).json().cities;
    expect(cities).toEqual(['Faisalabad', 'Karachi', 'Lahore']);
  });
});

describe('editing', () => {
  it('updates fields with one audit row holding before and after', async () => {
    const c = await create({ name: 'Edit Me', credit_limit_paisa: 0 });
    const before = t.auditCount();
    const res = await call('operator', 'PATCH', `/api/customers/${c.id}`, { credit_limit_paisa: 5_000_000, payment_terms_days: 60 });
    expect(res.statusCode).toBe(200);
    expect(res.json().customer).toMatchObject({ credit_limit_paisa: 5_000_000, payment_terms_days: 60 });
    expect(t.auditCount()).toBe(before + 1);
    const row = t.dbh.sqlite.prepare('SELECT entity, summary_json FROM audit_log ORDER BY id DESC LIMIT 1').get() as { entity: string; summary_json: string };
    expect(row.entity).toBe('customer');
    expect(JSON.parse(row.summary_json).changed_fields.sort()).toEqual(['credit_limit_paisa', 'payment_terms_days']);
  });

  it('a no-op edit writes nothing', async () => {
    const c = await create({ name: 'Same' });
    const before = t.auditCount();
    await call('operator', 'PATCH', `/api/customers/${c.id}`, { name: 'Same' });
    expect(t.auditCount()).toBe(before);
  });

  it('anyone who edits customers can change the opening balance, and the ledger follows', async () => {
    const c = await create({ name: 'Opening', opening_balance_paisa: 100_000 });
    const res = await call('operator', 'PATCH', `/api/customers/${c.id}`, { opening_balance_paisa: 150_000, reason: 'Corrected from old register' });
    expect(res.json().customer.balance_paisa).toBe(150_000);
    const n = t.dbh.sqlite.prepare("SELECT COUNT(*) AS n FROM ledger_entries WHERE entry_type = 'opening_balance'").get() as { n: number };
    expect(n.n).toBe(1);
  });

  it('deactivates instead of deleting', async () => {
    const c = await create({ name: 'Leaving' });
    const res = await call('operator', 'PATCH', `/api/customers/${c.id}`, { active: false });
    expect(res.json().customer.status).toBe('inactive');
    expect((await t.app.inject({ method: 'DELETE', url: `/api/customers/${c.id}`, headers: { cookie: await t.cookie('owner') } })).statusCode).toBe(404);
    const back = await call('operator', 'PATCH', `/api/customers/${c.id}`, { active: true });
    expect(back.json().customer.status).toBe('active');
  });
});

describe('bad debt', () => {
  it('only owner and superuser can mark or unmark, with a reason', async () => {
    const c = await create({ name: 'Risky' });
    expect((await call('operator', 'POST', `/api/customers/${c.id}/bad-debt`, { reason: 'not paying' })).statusCode).toBe(403);
    expect((await call('owner', 'POST', `/api/customers/${c.id}/bad-debt`, {})).statusCode).toBe(400);

    const before = t.auditCount();
    const marked = await call('owner', 'POST', `/api/customers/${c.id}/bad-debt`, { reason: 'Shop closed, not answering' });
    expect(marked.statusCode).toBe(200);
    expect(marked.json().customer).toMatchObject({ status: 'bad_debt', bad_debt_reason: 'Shop closed, not answering' });
    expect(t.auditCount()).toBe(before + 1);
    expect(t.dbh.sqlite.prepare('SELECT action, reason FROM audit_log ORDER BY id DESC LIMIT 1').get()).toEqual({
      action: 'mark_bad_debt',
      reason: 'Shop closed, not answering',
    });

    expect((await call('owner', 'POST', `/api/customers/${c.id}/bad-debt`, { reason: 'again' })).statusCode).toBe(400);
    const cleared = await call('superuser', 'POST', `/api/customers/${c.id}/bad-debt/clear`, { reason: 'Paid in full' });
    expect(cleared.json().customer).toMatchObject({ status: 'active', bad_debt_reason: null });
  });
});
