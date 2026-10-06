import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Payment, Purchase, Role, Sale, SaleCheckResult, SalesReturn, WriteOff } from '@shopledger/shared';
import { createTestContext, TEST_PASSWORD, type TestContext } from '../../test/helpers';
import { setupShop, type Shop } from '../../test/shop';

// Editing and voiding documents (CLAUDE.md 8.6, 8.14).

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

type AuditRow = { action: string; entity: string; doc_no: string; version_before: number | null; version_after: number | null; before_json: string | null; after_json: string | null; summary_json: string; flags: string; reason: string | null };
const audits = (entity: string): AuditRow[] => t.dbh.sqlite.prepare('SELECT * FROM audit_log WHERE entity = ? ORDER BY id').all(entity) as AuditRow[];
const lastAudit = (entity: string) => audits(entity).at(-1) as AuditRow;
const flagsOf = (a: AuditRow) => JSON.parse(a.flags) as string[];
const getSale = async (id: number) => (await shop.ok<{ sale: Sale }>('owner', 'GET', `/api/sales/${id}`)).sale;
const nextDay = () => vi.setSystemTime(new Date('2026-10-11T06:00:00Z'));

function saleBody(lines: { variant?: number; qty: number; discount_bp?: number }[], extra: object = {}) {
  return {
    customer_id: shop.customer.id,
    date: '2026-10-10',
    lines: lines.map((l) => ({ variant_id: shop.variant(l.variant ?? 0), qty: l.qty, discount_bp: l.discount_bp ?? 1000 })),
    change_reason: 'Customer changed the order',
    ...extra,
  };
}
const editSale = (role: Role, id: number, body: object) => shop.call(role, 'PUT', `/api/sales/${id}`, body);

describe('editing a sale', () => {
  it('posts the new version: totals, ledger, stock and one audit row with before and after', async () => {
    const s = await shop.sell({ qty: 2, date: '2026-10-10' }); // 2 × 900 = 1,800
    const stock = shop.stockOf(shop.variant(0));
    const before = t.auditCount();
    const res = await editSale('operator', s.id, saleBody([{ qty: 3 }, { variant: 1, qty: 1, discount_bp: 500 }]));
    expect(res.statusCode, res.body).toBe(200);
    const e = res.json().sale as Sale;
    expect(e).toMatchObject({ doc_no: s.doc_no, version: 2, total_paisa: 270_000 + 95_000, status: 'posted' });
    expect(t.auditCount()).toBe(before + 1);
    const a = lastAudit('sale');
    expect(a).toMatchObject({ action: 'edit', doc_no: s.doc_no, version_before: 1, version_after: 2, reason: 'Customer changed the order' });
    expect(flagsOf(a)).toEqual(expect.arrayContaining(['total_increased', 'by_operator']));
    expect(JSON.parse(a.before_json ?? '{}').lines).toHaveLength(1);
    expect(JSON.parse(a.after_json ?? '{}').lines).toHaveLength(2);
    expect(JSON.parse(a.summary_json)).toMatchObject({ changed_fields: expect.arrayContaining(['total_paisa']), lines_added: 1, lines_changed: 1, total_before_paisa: 180_000, total_after_paisa: 365_000 });
    expect(shop.stockOf(shop.variant(0))).toBe(stock - 1);
    expect(await shop.balance()).toBe(365_000);
    // The ledger has one invoice entry, for the new total.
    const ledger = t.dbh.sqlite.prepare("SELECT debit_paisa FROM ledger_entries WHERE source_type = 'sale' AND source_id = ?").all(s.id);
    expect(ledger).toEqual([{ debit_paisa: 365_000 }]);
  });

  it('items already on the invoice keep their price and cost; new items use today’s', async () => {
    const s = await shop.sell({ qty: 1, date: '2026-10-10' });
    await shop.ok('owner', 'PATCH', `/api/products/${shop.product.id}`, { list_price_paisa: 120_000 });
    const e = (await editSale('owner', s.id, saleBody([{ qty: 2 }, { variant: 1, qty: 1 }]))).json().sale as Sale;
    expect(e.lines?.map((l) => [l.variant_id, l.list_price_paisa, l.unit_cost_paisa])).toEqual([
      [shop.variant(0), 100_000, 88_000],
      [shop.variant(1), 120_000, 88_000],
    ]);
    expect(e.total_paisa).toBe(180_000 + 108_000);
  });

  it('operators may edit only their own invoices, on the same day, and cannot void', async () => {
    const own = await shop.sell({ date: '2026-10-10' });
    const owners = (await shop.ok<{ sale: Sale }>('owner', 'POST', '/api/sales', { ...saleBody([{ qty: 1 }]), change_reason: undefined })).sale;
    expect((await editSale('operator', owners.id, saleBody([{ qty: 2 }]))).statusCode).toBe(403);
    expect((await shop.call('operator', 'POST', `/api/sales/${own.id}/void`, { reason: 'Mistake' })).statusCode).toBe(403);
    nextDay();
    t.dbh.sqlite.prepare('UPDATE sessions SET last_seen_at = ?').run(new Date().toISOString());
    const late = await editSale('operator', own.id, saleBody([{ qty: 2 }]));
    expect(late.statusCode).toBe(403);
    expect(late.json().error).toMatch(/same day/);
    // The owner can, and the change is flagged as made on a later day.
    expect((await editSale('owner', own.id, saleBody([{ qty: 2 }]))).statusCode).toBe(200);
    expect(flagsOf(lastAudit('sale'))).toEqual(expect.arrayContaining(['edited_later_day', 'total_increased']));
    expect(flagsOf(lastAudit('sale'))).not.toContain('by_operator');
  });

  it('flags an edit made after the invoice was printed, and a changed customer', async () => {
    const s = await shop.sell({ date: '2026-10-10' });
    await shop.ok('operator', 'POST', `/api/sales/${s.id}/print`);
    const bilal = (await shop.ok<{ customer: { id: number } }>('owner', 'POST', '/api/customers', { name: 'Bilal', type: 'wholesaler' })).customer;
    expect((await editSale('owner', s.id, { ...saleBody([{ qty: 1 }]), customer_id: bilal.id })).statusCode).toBe(200);
    expect(flagsOf(lastAudit('sale'))).toEqual(expect.arrayContaining(['edited_after_printed', 'customer_changed']));
    expect(await shop.balance()).toBe(0);
    expect(await shop.balance(bilal.id)).toBe(90_000);
  });

  it('the same approval rules apply to an edit', async () => {
    const s = await shop.sell({ date: '2026-10-10' });
    const res = await editSale('operator', s.id, saleBody([{ qty: 1, discount_bp: 1500 }]));
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe('APPROVAL_REQUIRED');
    const ok = await editSale('operator', s.id, { ...saleBody([{ qty: 1, discount_bp: 1500 }]), approval: { username: 'owner', password: TEST_PASSWORD } });
    expect(ok.statusCode, ok.body).toBe(200);
    expect(ok.json().sale.approved_by_name).toBe('owner');
    expect(flagsOf(lastAudit('sale'))).toContain('sold_below_cost');
  });

  it('cash taken at the counter stays with the invoice; it cannot exceed the new total or move to another customer', async () => {
    const s = await shop.sell({ qty: 2, cash: 100_000, date: '2026-10-10' });
    const less = await editSale('owner', s.id, saleBody([{ qty: 1 }]));
    expect(less.json().error).toMatch(/Cash taken at the counter \(Rs 1,000\) is more than the new total/);
    const bilal = (await shop.ok<{ customer: { id: number } }>('owner', 'POST', '/api/customers', { name: 'Bilal', type: 'wholesaler' })).customer;
    expect((await editSale('owner', s.id, { ...saleBody([{ qty: 2 }]), customer_id: bilal.id })).json().error).toMatch(/Void that receipt before changing the customer/);
    const e = (await editSale('owner', s.id, saleBody([{ qty: 3 }]))).json().sale as Sale;
    expect(e).toMatchObject({ total_paisa: 270_000, paid_paisa: 100_000, outstanding_paisa: 170_000 });
  });

  it('is refused while the invoice has posted returns', async () => {
    const s = await shop.sell({ qty: 2, date: '2026-10-10' });
    await shop.ok('operator', 'POST', `/api/sales/${s.id}/returns`, { date: '2026-10-10', reason: 'Cracked', lines: [{ sale_item_id: s.lines?.[0]?.id, qty: 1 }] });
    expect((await editSale('owner', s.id, saleBody([{ qty: 3 }]))).json().error).toMatch(/has returns \(SRN-000001\)/);
  });

  it('the live check while editing changes nothing', async () => {
    const s = await shop.sell({ qty: 2, date: '2026-10-10' });
    const before = { stock: shop.stockOf(shop.variant(0)), audits: t.auditCount(), balance: await shop.balance() };
    const check = await shop.ok<SaleCheckResult>('operator', 'POST', `/api/sales/${s.id}/check`, { customer_id: shop.customer.id, date: '2026-10-10', lines: [{ variant_id: shop.variant(0), qty: 50, discount_bp: 1000 }] });
    // 48 left + the 2 on this invoice = 50: enough, so no stock warning.
    expect(check.issues.filter((i) => i.kind === 'stock_short')).toEqual([]);
    expect({ stock: shop.stockOf(shop.variant(0)), audits: t.auditCount(), balance: await shop.balance() }).toEqual(before);
  });
});

describe('voiding a sale', () => {
  it('takes off stock, ledger and allocations, voids its counter cash, and keeps the invoice with a VOID stamp', async () => {
    const s = await shop.sell({ qty: 2, cash: 50_000 });
    const stock = shop.stockOf(shop.variant(0));
    const before = t.auditCount();
    const v = (await shop.ok<{ sale: Sale }>('owner', 'POST', `/api/sales/${s.id}/void`, { reason: 'Entered twice' })).sale;
    expect(v).toMatchObject({ status: 'void', version: 2, outstanding_paisa: 0 });
    expect(t.auditCount()).toBe(before + 2); // the invoice and its counter receipt
    expect(lastAudit('sale')).toMatchObject({ action: 'void', reason: 'Entered twice' });
    expect(flagsOf(lastAudit('sale'))).toContain('voided');
    expect(lastAudit('payment')).toMatchObject({ action: 'void', reason: `Voided with invoice ${s.doc_no}: Entered twice` });
    expect(shop.stockOf(shop.variant(0))).toBe(stock + 2);
    expect(await shop.balance()).toBe(0);
    expect(t.dbh.sqlite.prepare('SELECT count(*) AS n FROM payment_allocations').get()).toEqual({ n: 0 });
    expect((await shop.call('owner', 'POST', `/api/sales/${s.id}/void`, { reason: 'Again' })).json().error).toMatch(/already void/);
    expect((await editSale('owner', s.id, saleBody([{ qty: 1 }]))).json().error).toMatch(/void and cannot be changed/);
  });

  it('needs its returns voided first', async () => {
    const s = await shop.sell({ qty: 2 });
    await shop.ok('operator', 'POST', `/api/sales/${s.id}/returns`, { date: '2026-10-10', reason: 'Cracked', lines: [{ sale_item_id: s.lines?.[0]?.id, qty: 1 }] });
    expect((await shop.call('owner', 'POST', `/api/sales/${s.id}/void`, { reason: 'Mistake' })).json().error).toMatch(/Void them first/);
  });
});

describe('purchases', () => {
  const purchase = async () => (await shop.ok<{ purchases: Purchase[] }>('owner', 'GET', '/api/purchases')).purchases[0] as Purchase;
  const body = (qty: number, extra: object = {}) => ({
    supplier_id: shop.supplierId,
    date: '2026-09-01',
    lines: [0, 1].map((i) => ({ variant_id: shop.variant(i), qty, list_price_paisa: 100_000, supplier_margin_bp: 1200 })),
    change_reason: 'Bill was for 40 each',
    ...extra,
  });
  const supplierBalance = async () => (await shop.ok<{ supplier: { balance_paisa: number } }>('owner', 'GET', `/api/suppliers/${shop.supplierId}`)).supplier.balance_paisa;

  it('edit changes stock, the supplier balance and the audit trail', async () => {
    const p = await purchase();
    const e = (await shop.ok<{ purchase: Purchase }>('owner', 'PUT', `/api/purchases/${p.id}`, body(40))).purchase;
    expect(e).toMatchObject({ version: 2, total_cost_paisa: 80 * 88_000 });
    expect(shop.stockOf(shop.variant(0))).toBe(40);
    expect(await supplierBalance()).toBe(80 * 88_000);
    expect(lastAudit('purchase')).toMatchObject({ action: 'edit', reason: 'Bill was for 40 each' });
    expect(flagsOf(lastAudit('purchase'))).toContain('total_reduced');
  });

  it('cannot take out stock that was already sold', async () => {
    await shop.sell({ qty: 45 });
    const p = await purchase();
    expect((await shop.call('owner', 'PUT', `/api/purchases/${p.id}`, body(40))).json().error).toMatch(/stock would go below zero \(-5\)/);
    expect((await shop.call('owner', 'POST', `/api/purchases/${p.id}/void`, { reason: 'Wrong supplier' })).json().error).toMatch(/below zero/);
    expect(shop.stockOf(shop.variant(0))).toBe(5);
  });

  it('void takes the stock and supplier credit off; purchase returns can be edited and voided', async () => {
    const p = await purchase();
    const full = (await shop.ok<{ purchase: Purchase }>('owner', 'GET', `/api/purchases/${p.id}`)).purchase;
    const r = (await shop.ok<{ purchase_return: { id: number } }>('operator', 'POST', `/api/purchases/${p.id}/returns`, { date: '2026-10-10', reason: 'Damaged', lines: [{ purchase_item_id: full.lines?.[0]?.id, qty: 2 }] })).purchase_return;
    expect(shop.stockOf(shop.variant(0))).toBe(48);
    const edited = await shop.ok<{ purchase_return: { total_cost_paisa: number; version: number } }>('operator', 'PUT', `/api/purchase-returns/${r.id}`, {
      date: '2026-10-10',
      reason: 'Damaged',
      lines: [{ purchase_item_id: full.lines?.[0]?.id, qty: 5 }],
      change_reason: 'Five were damaged',
    });
    expect(edited.purchase_return).toMatchObject({ total_cost_paisa: 5 * 88_000, version: 2 });
    expect(shop.stockOf(shop.variant(0))).toBe(45);
    expect((await shop.call('owner', 'POST', `/api/purchases/${p.id}/void`, { reason: 'Mistake' })).json().error).toMatch(/has returns/);
    await shop.ok('owner', 'POST', `/api/purchase-returns/${r.id}/void`, { reason: 'Supplier refused the return' });
    expect(shop.stockOf(shop.variant(0))).toBe(50);
    await shop.ok('owner', 'POST', `/api/purchases/${p.id}/void`, { reason: 'Entered twice' });
    expect(shop.stockOf(shop.variant(0))).toBe(0);
    expect(await supplierBalance()).toBe(0);
  });
});

describe('payments', () => {
  const receive = async (body: object = {}) =>
    (await shop.ok<{ payment: Payment }>('operator', 'POST', '/api/payments/receipts', { customer_id: shop.customer.id, date: '2026-10-10', amount_paisa: 90_000, method: 'cash', ...body })).payment;
  const editReceipt = (role: Role, id: number, body: object) =>
    shop.call(role, 'PUT', `/api/payments/receipts/${id}`, { date: '2026-10-10', amount_paisa: 90_000, method: 'cash', change_reason: 'Typo in amount', ...body });

  it('editing a receipt re-applies it; voiding it opens the invoices again', async () => {
    const a = await shop.sell({ date: '2026-10-01' });
    const b = await shop.sell({ date: '2026-10-02' });
    const p = await receive({ amount_paisa: 90_000 });
    expect((await getSale(a.id)).outstanding_paisa).toBe(0);
    const e = await editReceipt('operator', p.id, { amount_paisa: 180_000 });
    expect(e.statusCode, e.body).toBe(200);
    expect(e.json().payment).toMatchObject({ version: 2, allocated_paisa: 180_000 });
    expect(flagsOf(lastAudit('payment'))).toEqual(expect.arrayContaining(['total_increased', 'by_operator']));
    expect((await getSale(b.id)).outstanding_paisa).toBe(0);
    // Pick invoice b by hand instead.
    await editReceipt('owner', p.id, { amount_paisa: 90_000, allocations: [{ sale_id: b.id, amount_paisa: 90_000 }] });
    expect((await getSale(a.id)).outstanding_paisa).toBe(90_000);
    expect((await getSale(b.id)).outstanding_paisa).toBe(0);
    await shop.ok('owner', 'POST', `/api/payments/${p.id}/void`, { reason: 'Cheque was never received' });
    expect((await getSale(b.id)).outstanding_paisa).toBe(90_000);
    expect(await shop.balance()).toBe(180_000);
    expect(lastAudit('payment')).toMatchObject({ action: 'void' });
  });

  it('counter cash stays linked to its invoice when edited', async () => {
    await shop.sell({ date: '2026-10-01' });
    const s = await shop.sell({ cash: 50_000 });
    const counter = s.allocations?.[0]?.source_id as number;
    await editReceipt('operator', counter, { amount_paisa: 90_000 });
    const after = await getSale(s.id);
    expect(after.allocations).toMatchObject([{ source_id: counter, amount_paisa: 90_000, is_manual: true }]);
  });

  it('bounced cheques cannot be edited or voided', async () => {
    await shop.sell();
    const p = await receive({ method: 'cheque', cheque_no: '123' });
    await shop.ok('owner', 'POST', `/api/payments/${p.id}/bounce`, { reason: 'No funds' });
    expect((await editReceipt('owner', p.id, { method: 'cheque', cheque_no: '123' })).json().error).toMatch(/bounced/);
    expect((await shop.call('owner', 'POST', `/api/payments/${p.id}/void`, { reason: 'Mistake' })).json().error).toMatch(/bounced/);
  });

  it('supplier payments can be edited and voided', async () => {
    const p = (await shop.ok<{ payment: Payment }>('operator', 'POST', '/api/payments/supplier', { supplier_id: shop.supplierId, date: '2026-10-10', amount_paisa: 1_000_000, method: 'bank' })).payment;
    const supplierBalance = async () => (await shop.ok<{ supplier: { balance_paisa: number } }>('owner', 'GET', `/api/suppliers/${shop.supplierId}`)).supplier.balance_paisa;
    await shop.ok('operator', 'PUT', `/api/payments/supplier/${p.id}`, { date: '2026-10-10', amount_paisa: 2_000_000, method: 'bank', change_reason: 'Wrong amount' });
    expect(await supplierBalance()).toBe(8_800_000 - 2_000_000);
    await shop.ok('owner', 'POST', `/api/payments/${p.id}/void`, { reason: 'Bank reversed it' });
    expect(await supplierBalance()).toBe(8_800_000);
  });
});

describe('sales returns, refunds and write-offs', () => {
  it('editing a return changes the credit; a refund must still fit; voiding voids the refund too', async () => {
    const s = await shop.sell({ qty: 3, cash: 270_000 });
    const lineId = s.lines?.[0]?.id;
    const r = (await shop.ok<{ sales_return: SalesReturn }>('operator', 'POST', `/api/sales/${s.id}/returns`, { date: '2026-10-10', reason: 'Cracked', lines: [{ sale_item_id: lineId, qty: 2 }], refund: { amount_paisa: 180_000, method: 'cash' } })).sales_return;
    const edit = (qty: number) => shop.call('operator', 'PUT', `/api/sales-returns/${r.id}`, { date: '2026-10-10', reason: 'Cracked', lines: [{ sale_item_id: lineId, qty }], change_reason: 'Counted again' });
    expect((await edit(1)).json().error).toMatch(/Rs 1,800 was paid back for this return \(RFD-000001\), more than the new credit of Rs 900/);
    const refund = t.dbh.sqlite.prepare("SELECT id FROM payments WHERE kind = 'refund'").get() as { id: number };
    expect((await shop.call('operator', 'PUT', `/api/payments/refunds/${refund.id}`, { date: '2026-10-10', amount_paisa: 270_001, method: 'cash', change_reason: 'Mistake' })).json().error).toMatch(/cannot be more than Rs 1,800/);
    await shop.ok('operator', 'PUT', `/api/payments/refunds/${refund.id}`, { date: '2026-10-10', amount_paisa: 90_000, method: 'cash', change_reason: 'Paid back less' });
    const e = await edit(1);
    expect(e.statusCode, e.body).toBe(200);
    expect(e.json().sales_return).toMatchObject({ total_paisa: 90_000, version: 2, refunded_paisa: 90_000 });
    expect(shop.stockOf(shop.variant(0))).toBe(48);
    expect(await shop.balance()).toBe(0);

    const before = t.auditCount();
    await shop.ok('owner', 'POST', `/api/sales-returns/${r.id}/void`, { reason: 'Customer kept the goods' });
    expect(t.auditCount()).toBe(before + 2); // the return and its refund
    expect(shop.stockOf(shop.variant(0))).toBe(47);
    expect(t.dbh.sqlite.prepare("SELECT status FROM payments WHERE kind = 'refund'").get()).toEqual({ status: 'void' });
    expect(await shop.balance()).toBe(0); // paid in cash, no return, no refund
  });

  it('write-offs can be edited within the balance, and voided with their reversals', async () => {
    await shop.sell({ qty: 2 });
    const w = (await shop.ok<{ write_off: WriteOff }>('owner', 'POST', `/api/customers/${shop.customer.id}/write-offs`, { date: '2026-10-10', amount_paisa: 100_000, reason: 'Gone' })).write_off;
    await shop.ok('owner', 'POST', `/api/write-offs/${w.id}/reverse`, { date: '2026-10-10', amount_paisa: 30_000, reason: 'Paid some' });
    const edit = (amount: number) => shop.call('owner', 'PUT', `/api/write-offs/${w.id}`, { date: '2026-10-10', amount_paisa: amount, reason: 'Gone', change_reason: 'Wrong amount' });
    expect((await edit(20_000)).json().error).toMatch(/already taken back/);
    // Rs 300 was taken back, so up to Rs 1,800 + Rs 300 can be written off.
    expect((await edit(210_001)).json().error).toMatch(/at most the balance of Rs 2,100/);
    expect((await edit(150_000)).statusCode).toBe(200);
    expect(await shop.balance()).toBe(180_000 - 150_000 + 30_000);
    expect((await shop.call('operator', 'POST', `/api/write-offs/${w.id}/void`, { reason: 'Mistake' })).statusCode).toBe(403);
    await shop.ok('owner', 'POST', `/api/write-offs/${w.id}/void`, { reason: 'Customer paid in full' });
    expect(await shop.balance()).toBe(180_000);
  });
});
