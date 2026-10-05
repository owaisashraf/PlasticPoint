import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Sale, SalesReturn } from '@shopledger/shared';
import { createTestContext, type TestContext } from '../../../test/helpers';
import { setupShop, type Shop } from '../../../test/shop';
import { returnedNetForLine } from '../../lib/profit';

let t: TestContext;
let shop: Shop;

beforeEach(async () => {
  // The clock is set first: sessions created at login expire after 12 idle hours.
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-10T06:00:00Z'));
  t = await createTestContext();
  shop = await setupShop(t);
});
afterEach(async () => {
  vi.useRealTimers();
  await t.close();
});

const sale = async (id: number) => (await shop.ok<{ sale: Sale }>('owner', 'GET', `/api/sales/${id}`)).sale;
const giveBack = (s: Sale, qty: number, extra: object = {}, role: 'operator' | 'owner' = 'operator') =>
  shop.call(role, 'POST', `/api/sales/${s.id}/returns`, { date: '2026-10-10', reason: 'Cracked', lines: [{ sale_item_id: s.lines?.[0]?.id, qty }], ...extra });
const returnOk = async (s: Sale, qty: number, extra: object = {}, role: 'operator' | 'owner' = 'operator') => {
  const res = await giveBack(s, qty, extra, role);
  expect(res.statusCode, res.body).toBe(200);
  return res.json().sales_return as SalesReturn;
};

describe('returnedNetForLine', () => {
  it('credits qty × net ÷ qty, and the last return takes exactly what is left', () => {
    const line = { line_net_paisa: 269_999, qty: 3 };
    expect(returnedNetForLine(line, 1, 3, 0)).toBe(90_000); // 89,999.67 → 90,000
    expect(returnedNetForLine(line, 2, 2, 90_000)).toBe(179_999);
    expect(() => returnedNetForLine(line, 3, 2, 0)).toThrow();
  });
});

describe('sales returns', () => {
  it('credits the discounted amount, restocks at the original cost and reverses profit — one audit row', async () => {
    const s = await shop.sell({ qty: 3 }); // 3 × Rs 900 = 2,700; cost 3 × 880
    const stockBefore = shop.stockOf(shop.variant(0));
    const before = t.auditCount();
    const r = await returnOk(s, 2, {}, 'owner');
    expect(r).toMatchObject({ doc_no: 'SRN-000001', sale_doc_no: s.doc_no, total_paisa: 180_000, profit_reversed_paisa: 4_000, refunded_paisa: 0, total_qty: 2 });
    expect(r.lines?.[0]).toMatchObject({ qty: 2, line_net_paisa: 180_000, unit_cost_paisa: 88_000, line_cost_paisa: 176_000, profit_reversed_paisa: 4_000 });
    expect(t.auditCount()).toBe(before + 1);
    expect(shop.stockOf(shop.variant(0))).toBe(stockBefore + 2);
    expect(await shop.balance()).toBe(90_000);
    const after = await sale(s.id);
    expect(after).toMatchObject({ outstanding_paisa: 90_000 });
    expect(after.lines?.[0]?.returned_qty).toBe(2);
    expect(after.returns).toMatchObject([{ doc_no: 'SRN-000001', total_paisa: 180_000 }]);
    expect(after.allocations).toMatchObject([{ source_type: 'sales_return', doc_no: 'SRN-000001', amount_paisa: 180_000 }]);
  });

  it('cannot return more than sold minus already returned', async () => {
    const s = await shop.sell({ qty: 3 });
    await returnOk(s, 2);
    const res = await giveBack(s, 2);
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/only 1 can still be returned \(sold 3, already returned 2\)/);
    expect((await returnOk(s, 1)).total_paisa).toBe(90_000);
  });

  it('credits across returns add up to the line net exactly', async () => {
    const r = await shop.ok<{ sale: Sale }>('owner', 'POST', '/api/sales', {
      customer_id: shop.customer.id,
      date: '2026-10-01',
      lines: [{ variant_id: shop.variant(0), qty: 3, discount_bp: 1000 }],
      extra_discount_paisa: 1,
    });
    const s = r.sale; // line net 269,999
    const one = await returnOk(s, 1);
    const two = await returnOk(s, 2);
    expect([one.total_paisa, two.total_paisa]).toEqual([90_000, 179_999]);
    expect(await shop.balance()).toBe(0);
  });

  it('a return pays its own invoice first, not the oldest', async () => {
    const a = await shop.sell({ date: '2026-10-01' });
    const b = await shop.sell({ date: '2026-10-02' });
    await returnOk(b, 1);
    expect((await sale(a.id)).outstanding_paisa).toBe(90_000);
    expect((await sale(b.id)).outstanding_paisa).toBe(0);
  });

  it('a paid invoice: the return credit becomes an advance for the next invoice', async () => {
    const s = await shop.sell({ cash: 90_000 });
    await returnOk(s, 1);
    expect(await shop.balance()).toBe(-90_000);
    const next = await shop.sell({ date: '2026-10-10' });
    expect(next.outstanding_paisa).toBe(0);
  });

  it('optionally refunds cash now, up to the credit', async () => {
    const s = await shop.sell({ qty: 2, cash: 180_000 });
    expect((await giveBack(s, 1, { refund: { amount_paisa: 90_001, method: 'cash' } })).json().error).toMatch(/cannot be more than the credit/);
    const before = t.auditCount();
    const r = await returnOk(s, 1, { refund: { amount_paisa: 90_000, method: 'cash' } });
    expect(t.auditCount()).toBe(before + 2); // the return and the refund
    expect(r.refunded_paisa).toBe(90_000);
    expect(await shop.balance()).toBe(0);
    const refund = t.dbh.sqlite.prepare("SELECT doc_no, kind, amount_paisa, sales_return_id FROM payments WHERE kind = 'refund'").get();
    expect(refund).toEqual({ doc_no: 'RFD-000001', kind: 'refund', amount_paisa: 90_000, sales_return_id: r.id });
    // The invoice stays paid: the cash went back, so the credit does not touch it.
    expect((await sale(s.id)).outstanding_paisa).toBe(0);
  });

  it('refuses dates before the invoice or in the future', async () => {
    const s = await shop.sell({ date: '2026-10-05' });
    expect((await giveBack(s, 1, { date: '2026-10-04' })).json().error).toMatch(/before the invoice/);
    expect((await giveBack(s, 1, { date: '2026-10-11' })).json().error).toMatch(/future/);
  });

  it('hides returned cost and profit from operators', async () => {
    const s = await shop.sell({ qty: 2 });
    const r = await returnOk(s, 1);
    expect(r.profit_reversed_paisa).toBeUndefined();
    for (const url of ['/api/sales-returns', `/api/sales-returns/${r.id}`]) {
      expect((await shop.call('operator', 'GET', url)).body).not.toMatch(/cost|profit/);
      expect((await shop.call('owner', 'GET', url)).body).toMatch(/profit_reversed_paisa/);
    }
  });

  it('lists sales and purchase returns with search', async () => {
    const s = await shop.sell({ qty: 2 });
    await returnOk(s, 1);
    const list = (await shop.ok<{ returns: SalesReturn[] }>('operator', 'GET', '/api/sales-returns?q=ahmed')).returns;
    expect(list.map((r) => r.doc_no)).toEqual(['SRN-000001']);
    expect((await shop.ok<{ returns: SalesReturn[] }>('operator', 'GET', '/api/sales-returns?q=nobody')).returns).toEqual([]);
    const purchase = (await shop.ok<{ purchases: { id: number; lines: { id: number }[] }[] }>('owner', 'GET', '/api/purchases')).purchases[0];
    const full = (await shop.ok<{ purchase: { id: number; lines: { id: number }[] } }>('owner', 'GET', `/api/purchases/${purchase?.id}`)).purchase;
    await shop.ok('operator', 'POST', `/api/purchases/${full.id}/returns`, { date: '2026-10-10', reason: 'Damaged', lines: [{ purchase_item_id: full.lines[0]?.id, qty: 1 }] });
    const pr = await shop.ok<{ returns: { doc_no: string; total_cost_paisa?: number }[] }>('operator', 'GET', '/api/purchase-returns');
    expect(pr.returns).toMatchObject([{ doc_no: 'PRN-000001', total_cost_paisa: 88_000 }]);
  });
});
