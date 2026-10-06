import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChangeDetail, ChangeRow, DiscountOverrideRow, Sale } from '@shopledger/shared';
import { createTestContext, type TestContext } from '../../../test/helpers';
import { setupShop, type Shop } from '../../../test/shop';

let t: TestContext;
let shop: Shop;
let sale: Sale;

beforeEach(async () => {
  // The clock is set first: sessions created at login expire after 12 idle hours.
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-10T06:00:00Z'));
  t = await createTestContext();
  shop = await setupShop(t);
  // An operator's invoice, edited by the owner (smaller, later printed), then voided.
  sale = await shop.sell({ qty: 3, date: '2026-10-10' });
});
afterEach(async () => {
  vi.useRealTimers();
  await t.close();
});

const list = async (qs = '') => (await shop.ok<{ rows: ChangeRow[]; total: number }>('superuser', 'GET', `/api/changelog?${qs}`)).rows;
const edit = (qty: number, discount_bp = 1000) =>
  shop.ok('owner', 'PUT', `/api/sales/${sale.id}`, {
    customer_id: shop.customer.id,
    date: '2026-10-10',
    lines: [{ variant_id: shop.variant(0), qty, discount_bp }],
    change_reason: 'Customer took fewer',
  });

describe('change history (superuser only)', () => {
  it('lists invoice events newest first with versions, totals, balance impact and flags', async () => {
    await edit(2);
    await shop.ok('owner', 'POST', `/api/sales/${sale.id}/void`, { reason: 'Entered by mistake' });
    const rows = await list();
    expect(rows.map((r) => [r.action, r.version_before, r.version_after, r.total_before_paisa, r.total_after_paisa, r.balance_impact_paisa])).toEqual([
      ['void', 2, 3, 180_000, 0, -180_000],
      ['edit', 1, 2, 270_000, 180_000, -90_000],
      ['create', null, 1, null, 270_000, 270_000],
    ]);
    expect(rows[0]).toMatchObject({ doc_no: sale.doc_no, party_name: 'Ahmed Khan', user_name: 'owner', user_role: 'owner', reason: 'Entered by mistake', review: null });
    expect(rows[0]?.flags).toContain('voided');
    expect(rows[1]?.flags).toContain('total_reduced');
    expect(rows[2]?.flags).toEqual(['by_operator']);
  });

  it('other tabs hold documents and everything else (logins, customers, products...)', async () => {
    await shop.ok('operator', 'POST', '/api/payments/receipts', { customer_id: shop.customer.id, date: '2026-10-10', amount_paisa: 10_000, method: 'cash' });
    expect((await list('tab=documents')).map((r) => r.entity)).toEqual(['payment', 'purchase']);
    const other = await list('tab=other&limit=500');
    expect(new Set(other.map((r) => r.entity))).toEqual(new Set(['user', 'session', 'supplier', 'product', 'customer']));
  });

  it('filters by flag, flagged only, role, action, customer and review state', async () => {
    await edit(2);
    expect((await list('flag=total_reduced')).map((r) => r.action)).toEqual(['edit']);
    // by_operator alone does not count as flagged.
    expect((await list('flagged_only=true')).map((r) => r.action)).toEqual(['edit']);
    expect((await list('role=operator')).map((r) => r.action)).toEqual(['create']);
    expect((await list('action=edit')).length).toBe(1);
    expect((await list(`customer_id=${shop.customer.id}`)).length).toBe(2);
    expect((await list('customer_id=999')).length).toBe(0);
    expect((await shop.ok<{ count: number }>('superuser', 'GET', '/api/changelog/unreviewed-count')).count).toBe(1);

    const editRow = (await list('action=edit'))[0] as ChangeRow;
    const audits = t.auditCount();
    const reviewed = (await shop.ok<{ change: ChangeRow }>('superuser', 'POST', `/api/changelog/${editRow.id}/review`, { note: 'Checked with Ali' })).change;
    expect(reviewed.review).toMatchObject({ reviewed_by_name: 'super', note: 'Checked with Ali' });
    expect(t.auditCount()).toBe(audits); // the log itself never changes
    expect(await list('unreviewed=true&flagged_only=true')).toEqual([]);
    expect((await shop.ok<{ count: number }>('superuser', 'GET', '/api/changelog/unreviewed-count')).count).toBe(0);
  });

  it('shows a side-by-side diff: header fields and lines changed', async () => {
    await edit(2, 1100);
    const row = (await list('action=edit'))[0] as ChangeRow;
    const d = (await shop.ok<{ change: ChangeDetail }>('superuser', 'GET', `/api/changelog/${row.id}`)).change;
    expect(d.diff.fields.total_paisa).toEqual([270_000, 178_000]);
    expect(d.diff.lines.added).toEqual([]);
    expect(d.diff.lines.removed).toEqual([]);
    expect(d.diff.lines.changed).toHaveLength(1);
    expect(d.diff.lines.changed[0]).toMatchObject({ label: 'B-101 Red 10L', fields: { qty: [3, 2], discount_bp: [1000, 1100], discount_overridden: [false, true] } });
    expect(d.can_pdf).toBe(true);
    expect(d.before?.version).toBe(1);
  });

  it('has a per-document timeline and re-creates the PDF of any version', async () => {
    await shop.ok('operator', 'POST', `/api/sales/${sale.id}/print`);
    await edit(2);
    const rows = (await shop.ok<{ rows: ChangeRow[] }>('superuser', 'GET', `/api/changelog/timeline?entity=sale&entity_id=${sale.id}`)).rows;
    expect(rows.map((r) => r.action)).toEqual(['create', 'print', 'edit']);
    expect(rows[2]?.flags).toContain('edited_after_printed');
    const editId = rows[2]?.id;
    for (const which of ['before', 'after']) {
      const pdf = await shop.call('superuser', 'GET', `/api/changelog/${editId}/pdf?which=${which}`);
      expect(pdf.statusCode).toBe(200);
      expect(pdf.headers['content-disposition']).toBe(`inline; filename="${sale.doc_no}-v${which === 'before' ? 1 : 2}.pdf"`);
      expect(pdf.rawPayload.subarray(0, 4).toString()).toBe('%PDF');
    }
    const login = (await list('tab=other&action=login'))[0] as ChangeRow;
    expect((await shop.call('superuser', 'GET', `/api/changelog/${login.id}/pdf`)).statusCode).toBe(404);
  });

  it('lists discount overrides, below-minimum and below-cost lines', async () => {
    await shop.sell({ qty: 1, discount_bp: 1100 }); // changed discount
    await shop.ok('owner', 'POST', '/api/sales', {
      customer_id: shop.customer.id,
      date: '2026-10-10',
      lines: [{ variant_id: shop.variant(1), qty: 1, discount_bp: 1500 }],
      approval: { confirmed: true },
    }); // below cost
    const rows = (await shop.ok<{ rows: DiscountOverrideRow[] }>('superuser', 'GET', '/api/changelog/discount-overrides')).rows;
    expect(rows.map((r) => [r.user_name, r.discount_bp, r.reasons])).toEqual([
      ['owner', 1500, ['discount_changed', 'below_cost']],
      ['operator', 1100, ['discount_changed']],
    ]);
  });

  it('exports CSV', async () => {
    await edit(2);
    const res = await shop.call('superuser', 'GET', '/api/changelog/export.csv');
    expect(res.statusCode).toBe(200);
    const lines = res.body.slice(1).trim().split('\r\n');
    expect(lines).toHaveLength(3);
    expect(lines[1]).toMatch(/,owner,owner,edit,sale,INV-000001,Ahmed Khan,1 > 2,2700\.00,1800\.00,-900\.00,Customer took fewer,total_reduced,$/);
  });

  it('is refused to the owner and operators', async () => {
    for (const role of ['owner', 'operator'] as const) {
      for (const url of ['/api/changelog', '/api/changelog/1', '/api/changelog/unreviewed-count', '/api/changelog/discount-overrides']) {
        expect((await shop.call(role, 'GET', url)).statusCode).toBe(403);
      }
    }
  });
});
