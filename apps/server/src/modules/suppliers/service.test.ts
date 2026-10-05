import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Role } from '@shopledger/shared';
import { createTestContext, type TestContext } from '../../../test/helpers';

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

describe('supplier', () => {
  it('owner creates the supplier with an opening payable; operators can view but not change it', async () => {
    const body = { name: 'Popular Plastics (Pvt) Ltd', phone: '042-35761234', opening_balance_paisa: 125_000_000, opening_balance_date: '2026-07-01' };
    expect((await call('operator', 'POST', '/api/suppliers', body)).statusCode).toBe(403);

    const before = t.auditCount();
    const res = await call('owner', 'POST', '/api/suppliers', body);
    expect(res.statusCode, res.body).toBe(200);
    const s = res.json().supplier;
    expect(s).toMatchObject({ phone: '+924235761234', balance_paisa: 125_000_000, opening_balance_paisa: 125_000_000 });
    expect(t.auditCount()).toBe(before + 1);

    // We owe the supplier: the opening balance is a credit.
    const ledger = (await call('operator', 'GET', `/api/suppliers/${s.id}/ledger`)).json();
    expect(ledger.lines[0]).toMatchObject({ credit_paisa: 125_000_000, debit_paisa: 0, balance_paisa: 125_000_000 });

    expect((await call('operator', 'GET', '/api/suppliers')).json().suppliers).toHaveLength(1);
    expect((await call('operator', 'PATCH', `/api/suppliers/${s.id}`, { name: 'X' })).statusCode).toBe(403);

    const upd = await call('owner', 'PATCH', `/api/suppliers/${s.id}`, { opening_balance_paisa: -5_000_000 });
    expect(upd.json().supplier.balance_paisa).toBe(-5_000_000);
  });
});
