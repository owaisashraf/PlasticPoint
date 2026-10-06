import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Customer, OverdueList, Sale, SaleCheckResult } from '@shopledger/shared';
import { createTestContext, type TestContext } from '../../../test/helpers';
import { setupShop, type Shop } from '../../../test/shop';
import { csvCell, rupeesCell, toCsv } from '../../lib/csv';
import { updateSettings } from '../settings/service';

let t: TestContext;
let shop: Shop;

beforeEach(async () => {
  // The clock is set first: sessions created at login expire after 12 idle hours.
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-10T06:00:00Z')); // business date 2026-10-10
  t = await createTestContext();
  shop = await setupShop(t);
});
afterEach(async () => {
  vi.useRealTimers();
  await t.close();
});

const overdue = async (qs = '') => shop.ok<OverdueList>('operator', 'GET', `/api/overdue${qs ? `?${qs}` : ''}`);
const count = async () => (await shop.ok<{ count: number }>('operator', 'GET', '/api/overdue/count')).count;
const newCustomer = async (body: object) => (await shop.ok<{ customer: Customer }>('owner', 'POST', '/api/customers', { type: 'wholesaler', payment_terms_days: 30, ...body })).customer;
const receive = (customerId: number, amount: number) =>
  shop.ok('operator', 'POST', '/api/payments/receipts', { customer_id: customerId, date: '2026-10-10', amount_paisa: amount, method: 'cash' });

describe('overdue rules (CLAUDE.md 8.4)', () => {
  it('an invoice is overdue the day after its due date, not on it', async () => {
    await shop.sell({ date: '2026-09-10' }); // due 2026-10-10 (today)
    expect((await overdue()).rows).toEqual([]);
    const s = await shop.sell({ date: '2026-09-09' }); // due 2026-10-09
    const list = await overdue();
    expect(list.rows).toHaveLength(1);
    expect(list.rows[0]).toMatchObject({ name: 'Ahmed Khan', overdue_count: 1, overdue_paisa: 90_000, balance_paisa: 180_000, oldest_due_date: '2026-10-09', max_days_overdue: 1 });
    expect(list.rows[0]?.invoices).toEqual([{ sale_id: s.id, doc_no: s.doc_no, date: '2026-09-09', due_date: '2026-10-09', total_paisa: 90_000, paid_paisa: 0, outstanding_paisa: 90_000, days_overdue: 1 }]);
    expect(list.as_of).toBe('2026-10-10');
  });

  it('grace days delay overdue, but days overdue still count from the due date', async () => {
    updateSettings(t.dbh.db, { id: null, role: 'system' }, { grace_days: 3 });
    await shop.sell({ date: '2026-09-07' }); // due 10-07: 3 days past due = within grace
    expect((await overdue()).rows).toEqual([]);
    await shop.sell({ date: '2026-09-06' }); // due 10-06: 4 days
    expect((await overdue()).rows[0]).toMatchObject({ overdue_count: 1, max_days_overdue: 4 });
  });

  it('counts only what is still outstanding; paid invoices drop off', async () => {
    const a = await shop.sell({ date: '2026-08-01' }); // due 08-31
    await shop.sell({ date: '2026-08-15' }); // due 09-14
    await receive(shop.customer.id, 120_000); // pays a in full, 30,000 of b
    const row = (await overdue()).rows[0];
    expect(row).toMatchObject({ overdue_count: 1, overdue_paisa: 60_000, max_days_overdue: 26 });
    expect(row?.invoices.map((i) => i.sale_id)).not.toContain(a.id);
    expect(row?.last_payment_date).toBe('2026-10-10');
    expect(row?.last_payment_paisa).toBe(120_000);
    await receive(shop.customer.id, 60_000);
    expect((await overdue()).rows).toEqual([]);
  });

  it('written-off invoices stop counting as overdue', async () => {
    await shop.sell({ date: '2026-08-01' });
    await shop.ok('owner', 'POST', `/api/customers/${shop.customer.id}/write-offs`, { date: '2026-10-10', amount_paisa: 90_000, reason: 'Gone' });
    expect((await overdue()).rows).toEqual([]);
  });

  it("an owed opening balance is due on its date plus the customer's terms", async () => {
    await shop.ok('operator', 'PATCH', `/api/customers/${shop.customer.id}`, { opening_balance_paisa: 50_000, opening_balance_date: '2026-08-01' });
    const row = (await overdue()).rows[0];
    // 2026-08-01 + 30 days = 08-31 → 40 days overdue
    expect(row?.invoices).toEqual([{ sale_id: null, doc_no: null, date: '2026-08-01', due_date: '2026-08-31', total_paisa: 50_000, paid_paisa: 0, outstanding_paisa: 50_000, days_overdue: 40 }]);
    // Longer terms move it: 60 days → due 09-30, 10 days overdue.
    await shop.ok('operator', 'PATCH', `/api/customers/${shop.customer.id}`, { payment_terms_days: 60 });
    expect((await overdue()).rows[0]?.max_days_overdue).toBe(10);
  });

  it('a sale shows its days overdue, and the customer their overdue amount and last activity', async () => {
    const s = await shop.sell({ date: '2026-08-20' }); // due 09-19 → 21 days
    await receive(shop.customer.id, 10_000);
    expect((await shop.ok<{ sale: Sale }>('operator', 'GET', `/api/sales/${s.id}`)).sale).toMatchObject({ outstanding_paisa: 80_000, days_overdue: 21 });
    const fresh = await shop.sell({ date: '2026-10-10' });
    expect(fresh.days_overdue).toBeNull();
    const c = (await shop.ok<{ customer: Customer }>('operator', 'GET', `/api/customers/${shop.customer.id}`)).customer;
    expect(c).toMatchObject({ overdue_paisa: 80_000, overdue_days: 21, last_sale_date: '2026-10-10', last_payment_date: '2026-10-10' });
    const listed = (await shop.ok<{ customers: Customer[] }>('operator', 'GET', '/api/customers')).customers[0];
    expect(listed).toMatchObject({ overdue_paisa: 80_000, overdue_days: 21 });
  });

  it('the New Sale check warns about overdue invoices without blocking', async () => {
    await shop.sell({ date: '2026-08-20' });
    const check = await shop.ok<SaleCheckResult>('operator', 'POST', '/api/sales/check', {
      customer_id: shop.customer.id,
      date: '2026-10-10',
      lines: [{ variant_id: shop.variant(0), qty: 1, discount_bp: 1000 }],
    });
    expect(check.needs_approval).toBe(false);
    expect(check.issues).toEqual([{ kind: 'overdue', severity: 'warning', line_index: null, message: 'Ahmed Khan has an overdue invoice: Rs 900, up to 21 days late.' }]);
  });
});

describe('the Overdue tab', () => {
  let bilal: Customer;
  let shop2: Customer;
  beforeEach(async () => {
    bilal = await newCustomer({ name: 'Bilal Traders', city: 'Multan', phone: '0321 7654321' });
    shop2 = await newCustomer({ name: 'Corner Shop', city: 'Lahore', type: 'retailer' });
    await shop.sell({ date: '2026-08-01' }); // Ahmed: 40 days
    await shop.sell({ date: '2026-09-01', customerId: bilal.id }); // Bilal: 9 days
    await shop.sell({ date: '2026-07-01', customerId: shop2.id, qty: 2 }); // Corner Shop: 71 days
  });

  it('lists customers most days overdue first, with filters and totals', async () => {
    const all = await overdue();
    expect(all.rows.map((r) => [r.name, r.max_days_overdue])).toEqual([
      ['Corner Shop', 71],
      ['Ahmed Khan', 40],
      ['Bilal Traders', 9],
    ]);
    expect(all.totals).toEqual({ customers: 3, overdue_paisa: 360_000, balance_paisa: 360_000 });
    const names = async (qs: string) => (await overdue(qs)).rows.map((r) => r.name);
    expect(await names('type=retailer')).toEqual(['Corner Shop']);
    expect(await names('city=lahore')).toEqual(['Corner Shop', 'Ahmed Khan']);
    expect(await names('min_days=40')).toEqual(['Corner Shop', 'Ahmed Khan']);
    expect(await names('q=0321')).toEqual(['Bilal Traders']);
    expect(await count()).toBe(3);
  });

  it('bad-debt customers have their own sub-tab and are left out of the count', async () => {
    await shop.ok('owner', 'POST', `/api/customers/${shop2.id}/bad-debt`, { reason: 'Not answering' });
    expect((await overdue()).rows.map((r) => r.name)).toEqual(['Ahmed Khan', 'Bilal Traders']);
    expect((await overdue('bad_debt=only')).rows.map((r) => r.name)).toEqual(['Corner Shop']);
    expect((await overdue('bad_debt=include')).rows).toHaveLength(3);
    expect(await count()).toBe(2);
  });

  it('exports CSV for Excel and a printable PDF', async () => {
    const res = await shop.call('operator', 'GET', '/api/overdue/export.csv?min_days=10');
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('text/csv; charset=utf-8');
    expect(res.headers['content-disposition']).toBe('attachment; filename="overdue-2026-10-10.csv"');
    expect(res.body.charCodeAt(0)).toBe(0xfeff); // byte-order mark for Excel
    const lines = res.body.slice(1).trim().split('\r\n');
    expect(lines[0]).toMatch(/^Customer,Code,Phone,City/);
    expect(lines.slice(1)).toEqual(['Corner Shop,C-0003,,Lahore,retailer,active,30,1,1800.00,1800.00,2026-07-31,71,,', 'Ahmed Khan,C-0001,,Lahore,wholesaler,active,30,1,900.00,900.00,2026-08-31,40,,']);
    const pdf = await shop.call('operator', 'GET', '/api/overdue/report.pdf?bad_debt=include');
    expect(pdf.statusCode).toBe(200);
    expect(pdf.rawPayload.subarray(0, 4).toString()).toBe('%PDF');
  });
});

describe('csv', () => {
  it('quotes text with commas, quotes and new lines, and defuses formulas', () => {
    expect(csvCell('Khan, Sons')).toBe('"Khan, Sons"');
    expect(csvCell('6" pipe')).toBe('"6"" pipe"');
    expect(csvCell('=HYPERLINK("x")')).toBe(`"'=HYPERLINK(""x"")"`);
    expect(csvCell('-12.50')).toBe('-12.50');
    expect(csvCell(null)).toBe('');
    expect(rupeesCell(123_450)).toBe('1234.50');
    expect(rupeesCell(-5)).toBe('-0.05');
    expect(toCsv(['a', 'b'], [[1, 'x']])).toBe(`${String.fromCharCode(0xfeff)}a,b\r\n1,x\r\n`);
  });
});
