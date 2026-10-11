import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { REPORTS, type Customer, type Dashboard, type ReportResult, type Role, type Sale } from '@shopledger/shared';
import { createTestContext, type TestContext } from '../../../test/helpers';
import { setupShop, type Shop } from '../../../test/shop';
import { periodFigures } from '../../lib/profit-loss';

let t: TestContext;
let shop: Shop;
let bilal: Customer;
let saleA: Sale;

/**
 * The scenario (today = 2026-10-10, fiscal year 2026-27 from 1 July). Stock
 * was bought on 2026-09-01 at Rs 880 (Rs 1,000 less 12%).
 *
 *   2026-07-15  Asset Rs 12,000, 12 months → Rs 1,000 a month from August
 *   2026-08-01  Bilal: 1 × Rs 1,000 at 10% = Rs 900 (cost 880, profit 20), unpaid
 *   2026-09-15  Ahmed A: 10 × Rs 1,000 at 10% = Rs 9,000 (cost 8,800, profit 200)
 *   2026-10-02  Expense: rent Rs 500
 *   2026-10-05  Ahmed B: 5 × Rs 1,000 at 15% = Rs 4,250 (cost 4,400, profit −150), owner approved
 *   2026-10-06  Ahmed returns 2 from A: credit Rs 1,800 (cost 1,760, profit reversed 40)
 *   2026-10-08  Write-off Rs 1,000 of Ahmed's balance; 2026-10-09 Rs 300 of it reversed
 */
beforeEach(async () => {
  // The clock is set first: sessions created at login expire after 12 idle hours.
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-10T06:00:00Z'));
  t = await createTestContext();
  shop = await setupShop(t);
  bilal = (await shop.ok<{ customer: Customer }>('owner', 'POST', '/api/customers', { name: 'Bilal Traders', type: 'retailer', city: 'Multan', payment_terms_days: 30 })).customer;

  await shop.ok('owner', 'POST', '/api/assets', { name: 'Laptop', category: 'computer', purchase_date: '2026-07-15', cost_paisa: 1_200_000, method: 'bank', depreciation_method: 'straight_line', useful_life_months: 12, salvage_value_paisa: 0 });
  await shop.ok('owner', 'POST', '/api/sales', { customer_id: bilal.id, date: '2026-08-01', lines: [{ variant_id: shop.variant(0), qty: 1, discount_bp: 1000 }], approval: { confirmed: true } });
  saleA = await shop.sell({ qty: 10, date: '2026-09-15' });
  const rent = (await shop.ok<{ categories: { id: number; name: string }[] }>('owner', 'GET', '/api/expense-categories')).categories.find((c) => c.name === 'Rent')?.id;
  await shop.ok('owner', 'POST', '/api/expenses', { date: '2026-10-02', category_id: rent, amount_paisa: 50_000, method: 'cash', paid_to: 'Landlord' });
  await shop.ok('owner', 'POST', '/api/sales', { customer_id: shop.customer.id, date: '2026-10-05', lines: [{ variant_id: shop.variant(0), qty: 5, discount_bp: 1500 }], approval: { confirmed: true } });
  await shop.ok('operator', 'POST', `/api/sales/${saleA.id}/returns`, { date: '2026-10-06', reason: 'Cracked', lines: [{ sale_item_id: saleA.lines?.[0]?.id, qty: 2 }] });
  const w = (await shop.ok<{ write_off: { id: number } }>('owner', 'POST', `/api/customers/${shop.customer.id}/write-offs`, { date: '2026-10-08', amount_paisa: 100_000, reason: 'Disputed' })).write_off;
  await shop.ok('owner', 'POST', `/api/write-offs/${w.id}/reverse`, { date: '2026-10-09', amount_paisa: 30_000, reason: 'Paid some' });
});
afterEach(async () => {
  vi.useRealTimers();
  await t.close();
});

const report = (role: Role, key: string, qs = '') => shop.ok<ReportResult>(role, 'GET', `/api/reports/${key}${qs ? `?${qs}` : ''}`);
const row = (r: ReportResult, first: string) => r.rows.find((x) => Object.values(x)[0] === first || x.name === first || x.line === first || x.group === first);

describe('profit (CLAUDE.md 8.11)', () => {
  it('gross and net profit for a month, with returns, expenses, depreciation and bad debts', () => {
    const oct = periodFigures(t.dbh.db, '2026-10-01', '2026-10-10');
    expect(oct).toMatchObject({
      sales_net_paisa: 425_000,
      returns_net_paisa: 180_000,
      net_sales_paisa: 245_000,
      cost_of_sales_paisa: 440_000 - 176_000,
      gross_profit_paisa: -15_000 - 4_000,
      expenses_paisa: 50_000,
      depreciation_paisa: 0, // October is charged on the 31st
      net_bad_debt_paisa: 70_000,
      net_profit_paisa: -19_000 - 50_000 - 70_000,
    });
    const sep = periodFigures(t.dbh.db, '2026-09-01', '2026-09-30');
    expect(sep).toMatchObject({ gross_profit_paisa: 20_000, depreciation_paisa: 100_000, net_profit_paisa: -80_000 });
  });

  it('the fiscal year so far, and its boundary', () => {
    const fy = periodFigures(t.dbh.db, '2026-07-01', '2026-10-10');
    // Gross: 2,000 (Aug) + 20,000 (Sep) − 19,000 (Oct) = 3,000; depreciation Aug + Sep.
    expect(fy).toMatchObject({ gross_profit_paisa: 3_000, depreciation_paisa: 200_000, net_profit_paisa: 3_000 - 50_000 - 200_000 - 70_000 });
    // The previous fiscal year (ending 30 June) has nothing.
    expect(periodFigures(t.dbh.db, '2025-07-01', '2026-06-30').net_profit_paisa).toBe(0);
  });

  it('depreciation can be left out of net profit (Settings)', async () => {
    await shop.ok('owner', 'PATCH', '/api/settings', { changes: { include_depreciation_in_profit: false } });
    expect(periodFigures(t.dbh.db, '2026-07-01', '2026-10-10').net_profit_paisa).toBe(3_000 - 50_000 - 70_000);
  });

  it('profit & loss: months as columns, rows from net sales to net margin, and last year to compare', async () => {
    const pl = await report('owner', 'profit-loss', 'fiscal_year=2026&compare=1');
    expect(pl.subtitle).toMatch(/Fiscal year 2026-27/);
    expect(pl.columns.map((c) => c.label).slice(0, 4)).toEqual(['', 'Jul 26', 'Aug 26', 'Sep 26']);
    expect(pl.columns.at(-2)?.label).toBe('Total 2026-27');
    expect(pl.columns.at(-1)?.label).toBe('Total 2025-26');
    expect(row(pl, 'Net sales')).toMatchObject({ 'm_2026-08': 90_000, 'm_2026-10': 245_000, total: 90_000 + 900_000 + 245_000, prev: 0 });
    expect(row(pl, 'Gross profit')).toMatchObject({ total: 3_000, _strong: 1 });
    expect(row(pl, '   Rent')).toMatchObject({ 'm_2026-10': -50_000 });
    expect(row(pl, 'Depreciation')).toMatchObject({ 'm_2026-08': -100_000, 'm_2026-11': 0, total: -200_000 });
    expect(row(pl, 'Net bad debts')).toMatchObject({ total: -70_000 });
    expect(row(pl, 'Net profit')).toMatchObject({ total: -317_000 });
    expect(row(pl, 'Net margin')).toMatchObject({ _kind: 'percent', total: Math.round((-317_000 * 10_000) / 1_235_000) });
  });

  it('net profit summary and gross profit by customer and by operator', async () => {
    const np = await report('owner', 'net-profit', 'from=2026-10-01&to=2026-10-10');
    expect(np.summary[0]).toEqual({ label: 'You made', value: -139_000, kind: 'money' });
    const byCustomer = await report('owner', 'gross-profit', 'from=2026-07-01&group_by=customer');
    expect(byCustomer.rows.map((r) => [r.group, r.gross_profit_paisa])).toEqual([
      ['Bilal Traders', 2_000],
      ['Ahmed Khan', 1_000],
    ]);
    expect(byCustomer.totals?.gross_profit_paisa).toBe(3_000);
    const byOperator = await report('owner', 'gross-profit', 'from=2026-07-01&group_by=operator');
    expect(byOperator.rows.map((r) => [r.group, r.gross_profit_paisa])).toEqual([
      ['operator', 16_000], // sale A 20,000 less the return's 4,000
      ['owner', -13_000], // Bilal 2,000 + sale B −15,000
    ]);
  });
});

describe('customer reports', () => {
  it('customer summary totals', async () => {
    const s = await report('owner', 'customer-summary', 'from=2026-07-01');
    expect(row(s, 'Ahmed Khan')).toMatchObject({
      invoices: 2,
      sales_paisa: 1_325_000,
      returns_paisa: 180_000,
      net_sales_paisa: 1_145_000,
      receipts_paisa: 0,
      write_offs_paisa: 100_000,
      balance_paisa: 1_145_000 - 100_000 + 30_000,
      avg_invoice_paisa: 662_500,
      avg_discount_bp: 1167, // 1,750 of 15,000
      gross_profit_paisa: 1_000,
      profit_bp: 9,
    });
    expect(s.totals).toMatchObject({ invoices: 3, net_sales_paisa: 1_235_000, gross_profit_paisa: 3_000 });
    // Operators get the same report without profit.
    const op = await report('operator', 'customer-summary', 'from=2026-07-01');
    expect(op.columns.map((c) => c.key)).not.toContain('gross_profit_paisa');
    expect(JSON.stringify(op)).not.toMatch(/profit/);
  });

  it('aging buckets by days past due', async () => {
    const a = await report('operator', 'customer-aging');
    // Bilal's invoice was due 2026-08-31: 40 days past due. Ahmed owes nothing past due.
    expect(row(a, 'Bilal Traders')).toMatchObject({ d31_60_paisa: 90_000, total_paisa: 90_000 });
    expect(row(a, 'Ahmed Khan')).toMatchObject({ not_due_paisa: 1_075_000, d1_30_paisa: 0, total_paisa: 1_075_000 });
    expect(a.totals).toMatchObject({ not_due_paisa: 1_075_000, d31_60_paisa: 90_000, total_paisa: 1_165_000 });
  });

  it('payment behaviour: days to pay, on time and the longest delay', async () => {
    // Bilal pays on 2026-09-10: 40 days after the invoice, 10 days late.
    await shop.ok('operator', 'POST', '/api/payments/receipts', { customer_id: bilal.id, date: '2026-09-10', amount_paisa: 90_000, method: 'cash' });
    const b = await report('operator', 'payment-behaviour', 'from=2026-07-01');
    expect(row(b, 'Bilal Traders')).toMatchObject({ invoices: 1, paid: 1, avg_days_to_pay: 40, on_time_bp: 0, longest_delay: 10 });
  });

  it('items bought: net of returns, for one customer', async () => {
    const r = await report('operator', 'items-bought', `from=2026-07-01&customer_id=${shop.customer.id}`);
    expect(r.columns.map((c) => c.key)).not.toContain('customer');
    expect(r.rows).toEqual([expect.objectContaining({ item_code: 'B-101', color: 'Red', size: '10L', qty: 15, returned_qty: 2, net_qty: 13, net_value_paisa: 1_325_000 - 180_000 })]);
  });
});

describe('operational and financial lists', () => {
  it('cash and bank book: expenses and asset purchases, by book', async () => {
    const cash = await report('owner', 'cash-bank-book', 'from=2026-07-01&method=cash');
    expect(cash.rows.map((r) => [r.type, r.out_paisa])).toEqual([['Expense: Rent', 50_000]]);
    const bank = await report('owner', 'cash-bank-book', 'from=2026-07-01&method=bank');
    expect(bank.rows.map((r) => [r.type, r.out_paisa])).toEqual([['Asset bought: Laptop', 1_200_000]]);
  });

  it('profit check finds the below-cost sale', async () => {
    const r = await report('owner', 'profit-check', 'from=2026-10-01');
    expect(r.rows.map((x) => [x.problem, x.document])).toEqual([['Sold below cost', 'INV-000003']]);
  });

  it('day book, sales by item, stock and price list for operators', async () => {
    const d = await report('operator', 'day-book', 'from=2026-10-05&to=2026-10-06');
    expect(d.rows.map((r) => [r.type, r.amount_paisa])).toEqual([
      ['Sale', 425_000],
      ['Sales return', -180_000],
    ]);
    const s = await report('operator', 'sales-by-item', 'from=2026-07-01&group_by=item');
    expect(s.rows[0]).toMatchObject({ item_code: 'B-101', qty: 16, returned_qty: 2, net_qty: 14 });
    expect(s.columns.map((c) => c.key)).not.toContain('profit_paisa');
    const st = await report('operator', 'stock-on-hand');
    expect(st.rows.map((r) => r.stock)).toEqual([36, 50]);
    const pl = await report('operator', 'price-list');
    expect(pl.rows[0]).toMatchObject({ price_paisa: 100_000, discount_bp: 1000, customer_price_paisa: 90_000 });
  });

  it('every report runs for the owner, and as CSV and PDF', async () => {
    for (const def of REPORTS) {
      const r = await report('owner', def.key);
      expect(r.title, def.key).toBe(def.title);
      const csv = await shop.call('owner', 'GET', `/api/reports/${def.key}?format=csv`);
      expect(csv.headers['content-type'], def.key).toBe('text/csv; charset=utf-8');
      const pdf = await shop.call('owner', 'GET', `/api/reports/${def.key}?format=pdf`);
      expect(pdf.rawPayload.subarray(0, 4).toString(), def.key).toBe('%PDF');
    }
  });

  it('operators cannot open financial reports', async () => {
    for (const def of REPORTS.filter((r) => r.group === 'financial')) {
      expect((await shop.call('operator', 'GET', `/api/reports/${def.key}`)).statusCode, def.key).toBe(403);
    }
  });
});

describe('dashboard', () => {
  it('operators see today’s numbers only; the owner also sees profit and a 12-month trend', async () => {
    await shop.sell({ qty: 1, date: '2026-10-10', cash: 90_000 });
    const op = await shop.ok<Dashboard>('operator', 'GET', '/api/dashboard');
    expect(op).toEqual({ today: '2026-10-10', sales_today_count: 1, sales_today_paisa: 90_000, receipts_today_paisa: 90_000, overdue_customers: 1, low_stock_count: 0 });
    const owner = await shop.ok<Dashboard>('owner', 'GET', '/api/dashboard');
    expect(owner).toMatchObject({ profit_today_paisa: 2_000, profit_month_paisa: -17_000, month_expenses_paisa: 50_000, fiscal_year_label: '2026-27', net_profit_fy_paisa: -315_000 });
    expect(owner.profit_trend).toHaveLength(12);
    expect(owner.profit_trend?.at(-1)).toEqual({ month: '2026-10', gross_profit_paisa: -17_000, net_profit_paisa: -137_000 });
  });
});
