import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS, type Customer, type Product, type Role, type Sale, type Settings } from '@shopledger/shared';
import { createTestContext, TEST_PASSWORD, type TestContext } from '../../../test/helpers';
import { pricingRuleHits } from '../../lib/pricing';
import { computeSale, saleUnitCost, spreadExtraDiscount } from '../../lib/profit';
import { invoiceDocDefinition } from '../../pdf/invoice';
import { updateSettings } from '../settings/service';
import { getSale, invoiceBalances } from './service';

let t: TestContext;
let supplierId: number;
let product: Product;
let customer: Customer;

beforeEach(async () => {
  t = await createTestContext();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-05T06:00:00Z'));
  supplierId = (await call('owner', 'POST', '/api/suppliers', { name: 'Popular Plastics' })).json().supplier.id;
  product = (
    await call('owner', 'POST', '/api/products', { item_code: 'B-101', name: 'Bucket', sizes: ['10L', '15L'], colors: ['Red'], list_price_paisa: 100_000 })
  ).json().product;
  customer = (await call('operator', 'POST', '/api/customers', { name: 'Ahmed Khan', type: 'wholesaler', city: 'Lahore', payment_terms_days: 30 })).json().customer;
});
afterEach(async () => {
  vi.useRealTimers();
  await t.close();
});

async function call(role: Role, method: 'GET' | 'POST' | 'PATCH', url: string, payload?: object) {
  return t.app.inject({ method, url, headers: { cookie: await t.cookie(role) }, ...(payload ? { payload } : {}) });
}

const v = (i: number) => product.variants?.[i]?.id as number;
const settings = (s: Partial<Settings>) => updateSettings(t.dbh.db, { id: null, role: 'system' }, s);

async function buy(qty: number, variant = 0, margin = 1200) {
  const res = await call('owner', 'POST', '/api/purchases', {
    supplier_id: supplierId,
    date: '2026-10-05',
    lines: [{ variant_id: v(variant), qty, list_price_paisa: 100_000, supplier_margin_bp: margin }],
  });
  expect(res.statusCode, res.body).toBe(200);
}

function saleBody(extra: object = {}, lines: { variant?: number; qty?: number; discount_bp?: number }[] = [{}]) {
  return {
    customer_id: customer.id,
    date: '2026-10-05',
    lines: lines.map((l) => ({ variant_id: v(l.variant ?? 0), qty: l.qty ?? 1, discount_bp: l.discount_bp ?? 1000 })),
    ...extra,
  };
}

async function sell(role: Role, extra: object = {}, lines?: { variant?: number; qty?: number; discount_bp?: number }[]) {
  return call(role, 'POST', '/api/sales', saleBody(extra, lines));
}

async function sellOk(role: Role, extra: object = {}, lines?: { variant?: number; qty?: number; discount_bp?: number }[]): Promise<Sale> {
  const res = await sell(role, extra, lines);
  expect(res.statusCode, res.body).toBe(200);
  return res.json().sale;
}

const balance = async () => (await call('owner', 'GET', `/api/customers/${customer.id}`)).json().customer.balance_paisa as number;
const stockOf = (id: number) => (t.dbh.sqlite.prepare('SELECT coalesce(sum(qty_change), 0) AS q FROM stock_movements WHERE variant_id = ?').get(id) as { q: number }).q;
const lastAudit = () => t.dbh.sqlite.prepare('SELECT action, entity, doc_no, flags, summary_json FROM audit_log ORDER BY id DESC LIMIT 1').get() as { action: string; entity: string; doc_no: string; flags: string; summary_json: string };

// --- Pure functions -----------------------------------------------------------------

describe('profit library', () => {
  it('the worked example: price 1,000, supplier margin 12%, customer discount 10% → cost 880, pays 900, profit 20', () => {
    const cost = saleUnitCost(null, 100_000, 1200);
    expect(cost).toEqual({ unit_cost_paisa: 88_000, cost_source: 'estimated' });
    const r = computeSale([{ qty: 1, list_price_paisa: 100_000, discount_bp: 1000, unit_cost_paisa: cost.unit_cost_paisa }], 0);
    expect(r.lines[0]).toMatchObject({ line_gross_paisa: 100_000, line_discount_paisa: 10_000, line_net_paisa: 90_000, line_cost_paisa: 88_000, profit_paisa: 2_000 });
    expect(r.profit_paisa).toBe(2_000);
  });

  it('uses the average purchase cost when there is one', () => {
    expect(saleUnitCost(96_250, 100_000, 1200)).toEqual({ unit_cost_paisa: 96_250, cost_source: 'purchase_avg' });
  });

  it('spreads the extra discount by line amount, exact to the paisa', () => {
    expect(spreadExtraDiscount([100, 100, 100], 100)).toEqual([34, 33, 33]);
    expect(spreadExtraDiscount([90_000, 45_000, 15_000], 1_000)).toEqual([600, 300, 100]);
    expect(spreadExtraDiscount([1, 2], 0)).toEqual([0, 0]);
    expect(() => spreadExtraDiscount([100], 101)).toThrow();
    const lines = [
      { qty: 3, list_price_paisa: 33_333, discount_bp: 750, unit_cost_paisa: 25_000 },
      { qty: 7, list_price_paisa: 12_345, discount_bp: 1000, unit_cost_paisa: 10_000 },
      { qty: 1, list_price_paisa: 99_999, discount_bp: 0, unit_cost_paisa: 80_000 },
    ];
    const r = computeSale(lines, 12_347);
    const amounts = r.lines.reduce((a, l) => a + l.line_amount_paisa, 0);
    expect(r.lines.reduce((a, l) => a + l.extra_discount_share_paisa, 0)).toBe(12_347);
    expect(r.net_paisa).toBe(amounts - 12_347);
    expect(r.profit_paisa).toBe(r.net_paisa - r.cost_paisa);
  });

  it('safety rules: max discount, below cost, minimum profit', () => {
    const base = { discount_bp: 1000, max_customer_discount_bp: null, line_gross_paisa: 100_000, line_net_paisa: 90_000, line_cost_paisa: 88_000 };
    const s = { min_profit_bp: 0, below_min_profit_action: 'warn' as const };
    expect(pricingRuleHits(base, s)).toEqual([]);
    expect(pricingRuleHits({ ...base, max_customer_discount_bp: 800 }, s)).toEqual([{ rule: 'discount_above_max', severity: 'approval' }]);
    expect(pricingRuleHits({ ...base, line_net_paisa: 87_999 }, s)).toEqual([{ rule: 'below_cost', severity: 'approval' }]);
    // 2% profit vs 3% minimum
    expect(pricingRuleHits(base, { ...s, min_profit_bp: 300 })).toEqual([{ rule: 'below_min_profit', severity: 'warning' }]);
    expect(pricingRuleHits(base, { min_profit_bp: 300, below_min_profit_action: 'require_owner' })).toEqual([{ rule: 'below_min_profit', severity: 'approval' }]);
    expect(pricingRuleHits(base, { ...s, min_profit_bp: 200 })).toEqual([]); // exactly at the minimum
  });
});

// --- Posting -------------------------------------------------------------------------

describe('posting a sale', () => {
  it('the worked example end to end: stock out, ledger debit, profit 20, one audit row', async () => {
    await buy(10);
    const before = t.auditCount();
    const sale = await sellOk('operator');
    expect(sale).toMatchObject({ doc_no: 'INV-000001', gross_paisa: 100_000, line_discount_paisa: 10_000, total_paisa: 90_000, paid_paisa: 0, outstanding_paisa: 90_000 });
    expect(sale.profit_paisa).toBeUndefined(); // operator view
    expect(t.auditCount()).toBe(before + 1);
    expect(lastAudit()).toMatchObject({ action: 'create', entity: 'sale', doc_no: 'INV-000001', flags: '["by_operator"]' });
    expect(stockOf(v(0))).toBe(9);
    expect(await balance()).toBe(90_000);

    const owner = (await call('owner', 'GET', `/api/sales/${sale.id}`)).json().sale as Sale;
    expect(owner.profit_paisa).toBe(2_000);
    expect(owner.lines?.[0]).toMatchObject({ list_price_paisa: 100_000, discount_bp: 1000, default_discount_bp: 1000, discount_overridden: false, line_net_paisa: 90_000, unit_cost_paisa: 88_000, cost_source: 'purchase_avg', line_cost_paisa: 88_000, profit_paisa: 2_000 });
    expect((await sellOk('owner')).doc_no).toBe('INV-000002');
  });

  it('estimates the cost from the supplier margin when nothing was bought yet', async () => {
    settings({ allow_negative_stock: true });
    const sale = await sellOk('owner');
    expect(sale.lines?.[0]).toMatchObject({ cost_source: 'estimated', unit_cost_paisa: 88_000, profit_paisa: 2_000 });
    expect(stockOf(v(0))).toBe(-1);
  });

  it('a later price change does not change the cost of stock already bought', async () => {
    await buy(10);
    await call('owner', 'PATCH', `/api/products/${product.id}`, { list_price_paisa: 110_000 });
    const sale = await sellOk('owner');
    // 1,100 − 10% = 990 against the old cost of 880
    expect(sale.lines?.[0]).toMatchObject({ list_price_paisa: 110_000, line_net_paisa: 99_000, unit_cost_paisa: 88_000, profit_paisa: 11_000 });
  });

  it('spreads an extra discount over the lines and flags it', async () => {
    await buy(10, 0);
    await buy(10, 1);
    const sale = await sellOk('owner', { extra_discount_paisa: 1_001 }, [{ variant: 0, qty: 2 }, { variant: 1, qty: 1 }]);
    expect(sale.total_paisa).toBe(270_000 - 1_001);
    expect((sale.lines ?? []).reduce((a, l) => a + l.line_net_paisa, 0)).toBe(sale.total_paisa);
    expect(sale.lines?.map((l) => l.line_amount_paisa - l.line_net_paisa)).toEqual([667, 334]);
    expect(JSON.parse(lastAudit().flags)).toContain('extra_discount_added');
    const bad = await sell('owner', { extra_discount_paisa: 270_001 }, [{ variant: 0, qty: 2 }, { variant: 1, qty: 1 }]);
    expect(bad.statusCode).toBe(400);
  });

  it('records a changed discount, and gives retailers the retail reduction', async () => {
    await buy(10);
    settings({ retail_discount_reduction_bp: 300 });
    const changed = await sellOk('owner', {}, [{ discount_bp: 1100 }]);
    expect(changed.lines?.[0]).toMatchObject({ default_discount_bp: 1000, discount_bp: 1100, discount_overridden: true });
    expect(JSON.parse(lastAudit().flags)).toContain('discount_above_default');

    const retailer = (await call('owner', 'POST', '/api/customers', { name: 'Small Shop', type: 'retailer' })).json().customer;
    const res = await call('owner', 'POST', '/api/sales', { ...saleBody({}, [{ discount_bp: 700 }]), customer_id: retailer.id });
    expect(res.json().sale.lines[0]).toMatchObject({ default_discount_bp: 700, discount_bp: 700, discount_overridden: false });
  });

  it('copies payment terms from the customer, allows a change, and computes the due date', async () => {
    await buy(10);
    expect(await sellOk('owner')).toMatchObject({ payment_terms_days: 30, due_date: '2026-11-04' });
    expect(await sellOk('owner', { payment_terms_days: 0 })).toMatchObject({ payment_terms_days: 0, due_date: '2026-10-05' });
    expect(await sellOk('owner', { date: '2026-09-20', payment_terms_days: 15 })).toMatchObject({ due_date: '2026-10-05' });
  });

  it('never takes a price from the request, and refuses when the price changed', async () => {
    await buy(10);
    const withPrice = await call('operator', 'POST', '/api/sales', { ...saleBody(), lines: [{ variant_id: v(0), qty: 1, discount_bp: 0, list_price_paisa: 1 }] });
    expect(withPrice.statusCode).toBe(400);
    const stale = await sell('operator', { expected_total_paisa: 85_000 });
    expect(stale.statusCode).toBe(409);
    expect(stale.json().code).toBe('PRICE_CHANGED');
    expect((await sellOk('operator', { expected_total_paisa: 90_000 })).doc_no).toBe('INV-000001');
  });

  it('refuses future dates, inactive customers and items, without using up a number', async () => {
    await buy(10);
    expect((await sell('owner', { date: '2026-10-06' })).statusCode).toBe(400);
    expect((await sell('owner', {}, [])).statusCode).toBe(400);
    await call('owner', 'PATCH', `/api/customers/${customer.id}`, { active: false });
    expect((await sell('owner')).json().error).toMatch(/inactive/);
    await call('owner', 'PATCH', `/api/customers/${customer.id}`, { active: true });
    await call('owner', 'PATCH', `/api/products/${product.id}`, { sizes: ['15L'] });
    expect((await sell('owner')).json().error).toMatch(/inactive/);
    await buy(5, 1);
    expect((await sellOk('owner', {}, [{ variant: 1 }])).doc_no).toBe('INV-000001');
  });
});

describe('cash received at the counter', () => {
  it('posts a receipt allocated to the invoice, with its own audit row', async () => {
    await buy(10);
    const before = t.auditCount();
    const sale = await sellOk('operator', { cash_received_paisa: 50_000 });
    expect(sale).toMatchObject({ paid_paisa: 50_000, outstanding_paisa: 40_000 });
    expect(sale.receipts).toEqual([{ payment_id: 1, doc_no: 'RCV-000001', date: '2026-10-05', method: 'cash', amount_paisa: 50_000 }]);
    expect(await balance()).toBe(40_000);
    expect(t.auditCount()).toBe(before + 2);
    expect(lastAudit()).toMatchObject({ entity: 'payment', doc_no: 'RCV-000001' });
    const alloc = t.dbh.sqlite.prepare('SELECT source_type, sale_id, amount_paisa, is_manual FROM payment_allocations').all();
    expect(alloc).toEqual([{ source_type: 'payment', sale_id: sale.id, amount_paisa: 50_000, is_manual: 1 }]);
  });

  it('refuses more cash than the invoice', async () => {
    await buy(10);
    expect((await sell('operator', { cash_received_paisa: 90_001 })).statusCode).toBe(400);
    expect((await sellOk('operator', { cash_received_paisa: 90_000 })).outstanding_paisa).toBe(0);
  });
});

// --- Safety rules and approval --------------------------------------------------------

describe('owner approval', () => {
  beforeEach(async () => {
    await buy(10);
    await call('owner', 'PATCH', `/api/products/${product.id}`, { max_customer_discount_bp: 1100 });
  });

  it('a discount above the maximum needs the owner; the operator message never reveals cost', async () => {
    const res = await sell('operator', {}, [{ discount_bp: 1500 }]);
    expect(res.statusCode).toBe(409);
    const body = res.json();
    expect(body.code).toBe('APPROVAL_REQUIRED');
    // 15% is above the maximum and below cost (850 < 880): one generic message.
    expect(body.details.issues).toEqual([{ kind: 'discount_needs_approval', severity: 'approval', line_index: 0, message: 'This discount needs owner approval.' }]);
    expect(res.body).not.toMatch(/cost|margin|880|loss|profit/i);

    const check = await call('operator', 'POST', '/api/sales/check', saleBody({}, [{ discount_bp: 1500 }]));
    expect(check.json().needs_approval).toBe(true);
    expect(check.body).not.toMatch(/cost|margin|880|profit/i);
  });

  it('the owner sees the detailed reasons and profit in the live check', async () => {
    const check = (await call('owner', 'POST', '/api/sales/check', saleBody({}, [{ discount_bp: 1500 }]))).json();
    expect(check.issues.map((i: { kind: string }) => i.kind)).toEqual(['discount_above_max', 'below_cost']);
    expect(check.issues[1].message).toBe('Below cost: this line loses Rs 30.');
    expect(check.totals).toMatchObject({ total_paisa: 85_000, profit_paisa: -3_000, profit_bp: -300 });
  });

  it("an operator sale goes through with the owner's password, and records who approved", async () => {
    const ok = await sell('operator', { approval: { username: 'owner', password: TEST_PASSWORD } }, [{ discount_bp: 1500 }]);
    expect(ok.statusCode, ok.body).toBe(200);
    expect(ok.json().sale.approved_by_name).toBe('owner');
    const audit = lastAudit();
    expect(JSON.parse(audit.flags)).toEqual(['discount_above_default', 'sold_below_cost', 'by_operator']);
    expect(JSON.parse(audit.summary_json)).toMatchObject({ approved_by: t.users.owner.id, approved_for: ['discount_needs_approval'] });
  });

  it('a wrong password or a non-owner approver is refused and audited', async () => {
    const wrong = await sell('operator', { approval: { username: 'owner', password: 'nope-nope' } }, [{ discount_bp: 1500 }]);
    expect(wrong.statusCode).toBe(403);
    expect(wrong.json().error).toBe('Wrong owner username or password.');
    expect(lastAudit()).toMatchObject({ action: 'approval_failed' });
    const self = await sell('operator', { approval: { username: 'operator', password: TEST_PASSWORD } }, [{ discount_bp: 1500 }]);
    expect(self.statusCode).toBe(403);
    const confirmed = await sell('operator', { approval: { confirmed: true } }, [{ discount_bp: 1500 }]);
    expect(confirmed.statusCode).toBe(409);
    expect(t.dbh.sqlite.prepare('SELECT count(*) AS n FROM sales').get()).toEqual({ n: 0 });
  });

  it('owners and the superuser must confirm too — selling below cost always needs approval', async () => {
    for (const role of ['owner', 'superuser'] as Role[]) {
      expect((await sell(role, {}, [{ discount_bp: 1300 }])).statusCode).toBe(409);
      expect((await sell(role, { approval: { confirmed: true } }, [{ discount_bp: 1300 }])).statusCode).toBe(200);
    }
  });

  it('minimum profit warns, or needs the owner when set to require_owner', async () => {
    settings({ min_profit_bp: 300 }); // 2% profit at 10% discount
    const warn = await call('operator', 'POST', '/api/sales/check', saleBody());
    expect(warn.json().issues).toEqual([{ kind: 'discount_warning', severity: 'warning', line_index: 0, message: 'This discount is higher than usual. Please check it.' }]);
    await sellOk('operator');
    expect(JSON.parse(lastAudit().flags)).toContain('profit_below_minimum');
    settings({ below_min_profit_action: 'require_owner' });
    expect((await sell('operator')).statusCode).toBe(409);
  });
});

describe('stock, credit limit and bad debt', () => {
  it('selling more than stock needs approval, unless negative stock is allowed', async () => {
    await buy(2);
    const res = await sell('operator', {}, [{ qty: 2 }, { qty: 1 }]);
    expect(res.statusCode).toBe(409);
    expect(res.json().details.issues).toEqual([{ kind: 'stock_short', severity: 'approval', line_index: 0, message: 'B-101 Red 10L: only 2 in stock, selling 3. Selling more than stock needs owner approval.' }]);
    settings({ allow_negative_stock: true });
    await sellOk('operator', {}, [{ qty: 2 }, { qty: 1 }]);
    expect(stockOf(v(0))).toBe(-1);
  });

  it('warns about the credit limit without blocking', async () => {
    await buy(10);
    await call('owner', 'PATCH', `/api/customers/${customer.id}`, { credit_limit_paisa: 100_000 });
    await sellOk('operator');
    const check = (await call('operator', 'POST', '/api/sales/check', saleBody())).json();
    expect(check.needs_approval).toBe(false);
    expect(check.issues[0]).toMatchObject({ kind: 'credit_limit', severity: 'warning' });
    await sellOk('operator');
  });

  it('a credit sale to a bad-debt customer needs the owner; a fully paid cash sale does not', async () => {
    await buy(10);
    await call('owner', 'POST', `/api/customers/${customer.id}/bad-debt`, { reason: 'Shop closed, not answering' });
    const res = await sell('operator');
    expect(res.statusCode).toBe(409);
    expect(res.json().details.issues[0].kind).toBe('bad_debt_credit');
    await sellOk('operator', { cash_received_paisa: 90_000 });
    await sellOk('operator', { approval: { username: 'owner', password: TEST_PASSWORD } });
  });
});

// --- Reading, redaction and invoices ------------------------------------------------------

describe('reading sales', () => {
  it('redacts cost and profit for operators everywhere', async () => {
    await buy(10);
    const sale = await sellOk('owner');
    for (const url of [`/api/sales/${sale.id}`, '/api/sales']) {
      const op = await call('operator', 'GET', url);
      expect(op.body).not.toMatch(/cost|profit|margin/);
      expect((await call('owner', 'GET', url)).body).toMatch(/profit_paisa/);
    }
  });

  it('lists and searches sales by number, customer and date', async () => {
    await buy(10);
    await sellOk('owner');
    const other = (await call('owner', 'POST', '/api/customers', { name: 'Bilal Traders', type: 'wholesaler', city: 'Multan' })).json().customer;
    await call('owner', 'POST', '/api/sales', { ...saleBody(), customer_id: other.id, date: '2026-10-01' });
    const list = async (qs: string) => ((await call('operator', 'GET', `/api/sales?${qs}`)).json().sales as Sale[]).map((s) => s.doc_no);
    expect(await list('')).toEqual(['INV-000001', 'INV-000002']);
    expect(await list('q=bilal')).toEqual(['INV-000002']);
    expect(await list('q=000001')).toEqual(['INV-000001']);
    expect(await list('q=multan')).toEqual(['INV-000002']);
    expect(await list('from=2026-10-02')).toEqual(['INV-000001']);
    expect(await list(`customer_id=${other.id}`)).toEqual(['INV-000002']);
  });
});

describe('invoice PDF', () => {
  it('shows price, discount % and amount with the balance — never margin, cost or profit', async () => {
    await buy(10);
    await call('owner', 'PATCH', `/api/customers/${customer.id}`, { opening_balance_paisa: 45_000 });
    const s = await sellOk('owner', { cash_received_paisa: 20_000 }, [{ qty: 2 }]);
    const sale = getSale(t.dbh.db, s.id);
    const balances = invoiceBalances(t.dbh.db, sale);
    expect(balances).toEqual({ previous_balance_paisa: 45_000, paid_now_paisa: 20_000, total_outstanding_paisa: 45_000 + 180_000 - 20_000 });
    // A later sale does not change this invoice's figures.
    await sellOk('owner');
    expect(invoiceBalances(t.dbh.db, sale)).toEqual(balances);

    for (const size of ['A4', '80mm'] as const) {
      const text = JSON.stringify(invoiceDocDefinition(sale, balances, DEFAULT_SETTINGS, size).content);
      expect(text).toContain('Rs 1,000'); // price
      expect(text).toContain('10%'); // discount
      expect(text).toContain('Rs 1,800'); // amount
      expect(text).toContain('Rupees One Thousand Eight Hundred Only');
      expect(text).toContain('Rs 450'); // previous balance
      expect(text).toContain('Rs 2,050'); // total outstanding
      // ("margin" alone is pdfmake's spacing key, so look for the wording instead.)
      expect(text).not.toMatch(/cost|supplier|profit|1,760|880/i);
    }
  });

  it('print is audited and the PDF is served in both sizes', async () => {
    await buy(10);
    const sale = await sellOk('operator');
    for (const size of ['A4', '80mm']) {
      const res = await call('operator', 'POST', `/api/sales/${sale.id}/print?size=${size}`);
      expect(res.statusCode, res.body).toBe(200);
      expect(lastAudit()).toMatchObject({ action: 'print', entity: 'sale', doc_no: 'INV-000001' });
      const pdf = await call('operator', 'GET', res.json().url);
      expect(pdf.statusCode).toBe(200);
      expect(pdf.headers['content-type']).toBe('application/pdf');
      expect(pdf.rawPayload.subarray(0, 4).toString()).toBe('%PDF');
    }
  });
});
