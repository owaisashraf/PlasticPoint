import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { OpenItems, Payment, Sale } from '@shopledger/shared';
import { createTestContext, type TestContext } from '../../../test/helpers';
import { setupShop, type Shop } from '../../../test/shop';

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

const receipt = (body: object = {}) => ({ customer_id: shop.customer.id, date: '2026-10-10', amount_paisa: 100_000, method: 'cash', ...body });
const receive = async (body: object = {}, role: 'operator' | 'owner' = 'operator') => (await shop.ok<{ payment: Payment }>(role, 'POST', '/api/payments/receipts', receipt(body))).payment;
const sale = async (id: number) => (await shop.ok<{ sale: Sale }>('owner', 'GET', `/api/sales/${id}`)).sale;
const openItems = async () => shop.ok<OpenItems>('operator', 'GET', `/api/customers/${shop.customer.id}/open-items`);
const lastAudit = () => t.dbh.sqlite.prepare('SELECT action, entity, doc_no, reason FROM audit_log ORDER BY id DESC LIMIT 1').get();

describe('receipts', () => {
  it('allocate FIFO to the oldest invoice, credit the ledger and write one audit row', async () => {
    const a = await shop.sell({ date: '2026-10-01' }); // 900
    const b = await shop.sell({ date: '2026-10-02', qty: 2 }); // 1,800
    const before = t.auditCount();
    const p = await receive({ amount_paisa: 150_000 });
    expect(p).toMatchObject({ doc_no: 'RCV-000001', kind: 'receipt', party_name: 'Ahmed Khan', allocated_paisa: 150_000 });
    expect(p.allocations).toEqual([
      { source_type: 'payment', source_id: p.id, sale_id: a.id, sale_doc_no: a.doc_no, amount_paisa: 90_000, is_manual: false },
      { source_type: 'payment', source_id: p.id, sale_id: b.id, sale_doc_no: b.doc_no, amount_paisa: 60_000, is_manual: false },
    ]);
    expect(t.auditCount()).toBe(before + 1);
    expect(lastAudit()).toMatchObject({ action: 'create', entity: 'payment', doc_no: 'RCV-000001' });
    expect(await shop.balance()).toBe(270_000 - 150_000);
    expect((await sale(a.id)).outstanding_paisa).toBe(0);
    expect((await sale(b.id)).outstanding_paisa).toBe(120_000);
  });

  it('manual allocation pays the picked invoice; FIFO is recalculated around it', async () => {
    const a = await shop.sell({ date: '2026-10-01' });
    const b = await shop.sell({ date: '2026-10-02' });
    await receive({ amount_paisa: 90_000 }); // FIFO → a
    const p = await receive({ amount_paisa: 90_000, allocations: [{ sale_id: a.id, amount_paisa: 90_000 }] });
    expect(p.allocations).toMatchObject([{ sale_id: a.id, amount_paisa: 90_000, is_manual: true }]);
    // The first receipt moved to invoice b.
    expect((await sale(a.id)).outstanding_paisa).toBe(0);
    expect((await sale(b.id)).outstanding_paisa).toBe(0);
    expect((await sale(b.id)).allocations).toMatchObject([{ doc_no: 'RCV-000001', is_manual: false }]);
  });

  it('keeps the rest as an advance and applies it to the next invoice automatically', async () => {
    const p = await receive({ amount_paisa: 100_000 });
    expect(p.allocated_paisa).toBe(0);
    expect((await openItems()).advance_paisa).toBe(100_000);
    expect(await shop.balance()).toBe(-100_000);
    const s = await shop.sell({ date: '2026-10-10' });
    expect(s).toMatchObject({ paid_paisa: 90_000, outstanding_paisa: 0 });
    expect((await openItems()).advance_paisa).toBe(10_000);
  });

  it('pays an owed opening balance first, as the oldest debt', async () => {
    await shop.ok('operator', 'PATCH', `/api/customers/${shop.customer.id}`, { opening_balance_paisa: 50_000, opening_balance_date: '2026-07-01' });
    const s = await shop.sell({ date: '2026-10-01' });
    expect((await openItems()).items.map((i) => [i.doc_no, i.outstanding_paisa])).toEqual([
      [null, 50_000],
      [s.doc_no, 90_000],
    ]);
    const p = await receive({ amount_paisa: 60_000 });
    expect(p.allocations?.map((a) => [a.sale_id, a.amount_paisa])).toEqual([
      [null, 50_000],
      [s.id, 10_000],
    ]);
    // Manual payment of the opening balance is allowed too; an opening advance pays invoices.
    await shop.ok('operator', 'PATCH', `/api/customers/${shop.customer.id}`, { opening_balance_paisa: -20_000 });
    expect((await sale(s.id)).allocations?.map((a) => [a.source_type, a.amount_paisa])).toEqual([
      ['opening_balance', 20_000],
      ['payment', 60_000],
    ]);
  });

  it('refuses manual amounts above the receipt, unknown invoices, cheques without a number and future dates', async () => {
    const a = await shop.sell();
    const bad = async (body: object) => (await shop.call('operator', 'POST', '/api/payments/receipts', receipt(body))).json().error as string;
    expect(await bad({ amount_paisa: 50_000, allocations: [{ sale_id: a.id, amount_paisa: 60_000 }] })).toMatch(/more than the Rs 500 received/);
    expect(await bad({ allocations: [{ sale_id: a.id, amount_paisa: 95_000 }] })).toMatch(/more money is linked/i);
    expect(await bad({ allocations: [{ sale_id: 999, amount_paisa: 1_000 }] })).toMatch(/not an open invoice/);
    expect(await bad({ allocations: [{ sale_id: null, amount_paisa: 1_000 }] })).toMatch(/no opening balance/);
    expect(await bad({ method: 'cheque' })).toMatch(/cheque number/);
    expect(await bad({ date: '2026-10-11' })).toMatch(/future/);
    expect(t.dbh.sqlite.prepare('SELECT count(*) AS n FROM payments WHERE kind = ?').get('receipt')).toEqual({ n: 0 });
  });
});

describe('bounced cheques', () => {
  it('owner marks a cheque bounced: receipt stays, customer is debited, invoices open again', async () => {
    const a = await shop.sell();
    const p = await receive({ amount_paisa: 90_000, method: 'cheque', cheque_no: '004512', cheque_bank: 'HBL' });
    expect((await sale(a.id)).outstanding_paisa).toBe(0);
    expect((await shop.call('operator', 'POST', `/api/payments/${p.id}/bounce`, { reason: 'Insufficient funds' })).statusCode).toBe(403);

    const before = t.auditCount();
    const res = await shop.ok<{ payment: Payment }>('owner', 'POST', `/api/payments/${p.id}/bounce`, { reason: 'Insufficient funds' });
    expect(res.payment).toMatchObject({ status: 'bounced', bounce_reason: 'Insufficient funds', allocated_paisa: 0, version: 2 });
    expect(t.auditCount()).toBe(before + 1);
    expect(lastAudit()).toMatchObject({ action: 'bounce', entity: 'payment', reason: 'Insufficient funds' });
    expect((await sale(a.id)).outstanding_paisa).toBe(90_000);
    expect(await shop.balance()).toBe(90_000);
    const ledger = (await shop.ok<{ lines: { entry_type: string; debit_paisa: number; credit_paisa: number }[] }>('owner', 'GET', `/api/customers/${shop.customer.id}/ledger`)).lines;
    expect(ledger.map((l) => [l.entry_type, l.debit_paisa, l.credit_paisa])).toEqual([
      ['sale', 90_000, 0],
      ['receipt', 0, 90_000],
      ['bounced_cheque', 90_000, 0],
    ]);
    expect((await shop.call('owner', 'POST', `/api/payments/${p.id}/bounce`, { reason: 'Again' })).json().error).toMatch(/already/);
  });

  it('only cheques can bounce', async () => {
    const p = await receive({ method: 'cash' });
    expect((await shop.call('owner', 'POST', `/api/payments/${p.id}/bounce`, { reason: 'Mistake' })).json().error).toMatch(/Only a cheque/);
  });
});

describe('supplier payments', () => {
  it('debit the supplier ledger and are listed separately', async () => {
    const before = (await shop.ok<{ supplier: { balance_paisa: number } }>('owner', 'GET', `/api/suppliers/${shop.supplierId}`)).supplier.balance_paisa;
    expect(before).toBe(8_800_000); // 100 × Rs 880
    const res = await shop.ok<{ payment: Payment }>('operator', 'POST', '/api/payments/supplier', {
      supplier_id: shop.supplierId,
      date: '2026-10-10',
      amount_paisa: 5_000_000,
      method: 'bank',
      reference: 'IBFT 7781',
    });
    expect(res.payment).toMatchObject({ doc_no: 'PAY-000001', kind: 'supplier_payment', party_name: 'Popular Plastics' });
    expect((await shop.ok<{ supplier: { balance_paisa: number } }>('owner', 'GET', `/api/suppliers/${shop.supplierId}`)).supplier.balance_paisa).toBe(3_800_000);

    await receive();
    const list = async (qs: string) => (await shop.ok<{ payments: Payment[] }>('operator', 'GET', `/api/payments?${qs}`)).payments.map((p) => p.doc_no);
    expect(await list('kind=supplier_payment')).toEqual(['PAY-000001']);
    expect(await list('kind=receipt')).toEqual(['RCV-000001']);
    expect(await list('q=7781')).toEqual(['PAY-000001']);
    expect(await list('q=ahmed')).toEqual(['RCV-000001']);
  });
});

describe('write-offs', () => {
  it('owner writes off up to the balance, FIFO; reversal takes it back; operators cannot', async () => {
    const a = await shop.sell({ date: '2026-10-01' });
    const b = await shop.sell({ date: '2026-10-02' });
    const body = { date: '2026-10-10', amount_paisa: 100_000, reason: 'Shop closed down' };
    expect((await shop.call('operator', 'POST', `/api/customers/${shop.customer.id}/write-offs`, body)).statusCode).toBe(403);
    expect((await shop.call('owner', 'POST', `/api/customers/${shop.customer.id}/write-offs`, { ...body, amount_paisa: 180_001 })).json().error).toMatch(/at most the balance/);

    const before = t.auditCount();
    const w = (await shop.ok<{ write_off: { id: number; doc_no: string } }>('owner', 'POST', `/api/customers/${shop.customer.id}/write-offs`, body)).write_off;
    expect(w.doc_no).toBe('WOF-000001');
    expect(t.auditCount()).toBe(before + 1);
    expect(await shop.balance()).toBe(80_000);
    expect((await sale(a.id)).outstanding_paisa).toBe(0);
    expect((await sale(b.id)).outstanding_paisa).toBe(80_000);

    // The customer pays after all: reverse part of the write-off, then record the receipt.
    expect((await shop.call('owner', 'POST', `/api/write-offs/${w.id}/reverse`, { ...body, amount_paisa: 100_001 })).json().error).toMatch(/at most Rs 1,000/);
    const rev = (await shop.ok<{ write_off: { reversed_paisa: number } }>('owner', 'POST', `/api/write-offs/${w.id}/reverse`, { ...body, amount_paisa: 40_000, reason: 'Paid after all' })).write_off;
    expect(rev.reversed_paisa).toBe(40_000);
    expect(lastAudit()).toMatchObject({ action: 'reverse', entity: 'write_off', doc_no: 'WOF-000001' });
    expect(await shop.balance()).toBe(120_000);
    await receive({ amount_paisa: 120_000 });
    expect(await shop.balance()).toBe(0);
    expect((await sale(a.id)).outstanding_paisa + (await sale(b.id)).outstanding_paisa).toBe(0);
    const list = (await shop.ok<{ write_offs: { reversed_paisa: number }[] }>('operator', 'GET', `/api/customers/${shop.customer.id}/write-offs`)).write_offs;
    expect(list).toMatchObject([{ reversed_paisa: 40_000 }]);
  });
});

describe('statements', () => {
  it('customer and supplier statement PDFs', async () => {
    await shop.sell();
    await receive({ amount_paisa: 50_000 });
    for (const url of [`/api/customers/${shop.customer.id}/statement.pdf?from=2026-10-01`, `/api/suppliers/${shop.supplierId}/statement.pdf`]) {
      const res = await shop.call('operator', 'GET', url);
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toBe('application/pdf');
      expect(res.rawPayload.subarray(0, 4).toString()).toBe('%PDF');
    }
  });
});
