import { existsSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Product, Purchase, Role } from '@shopledger/shared';
import { createTestContext, type TestContext } from '../../../test/helpers';
import { purchaseLineAmounts } from '../../lib/pricing';
import { replayAverageCost } from '../../lib/stock';
import { updateSettings } from '../settings/service';

let t: TestContext;
let supplierId: number;
let product: Product;

beforeEach(async () => {
  t = await createTestContext();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-05T06:00:00Z'));
  supplierId = (await call('owner', 'POST', '/api/suppliers', { name: 'Popular Plastics' })).json().supplier.id;
  product = (
    await call('owner', 'POST', '/api/products', {
      item_code: 'B-101',
      name: 'Bucket',
      category: 'Buckets',
      sizes: ['10L', '15L'],
      colors: ['Red'],
      list_price_paisa: 100_000,
    })
  ).json().product;
});
afterEach(async () => {
  vi.useRealTimers();
  await t.close();
});

async function call(role: Role, method: 'GET' | 'POST' | 'PATCH', url: string, payload?: object) {
  return t.app.inject({ method, url, headers: { cookie: await t.cookie(role) }, ...(payload ? { payload } : {}) });
}

const v = (i: number) => product.variants?.[i]?.id as number;

async function buy(lines: { variant: number; qty: number; price?: number; margin?: number }[], role: Role = 'operator', extra: object = {}) {
  const res = await call(role, 'POST', '/api/purchases', {
    supplier_id: supplierId,
    date: '2026-10-05',
    supplier_ref: 'BILL-1',
    lines: lines.map((l) => ({ variant_id: v(l.variant), qty: l.qty, list_price_paisa: l.price ?? 100_000, supplier_margin_bp: l.margin ?? 1200 })),
    ...extra,
  });
  expect(res.statusCode, res.body).toBe(200);
  return res.json().purchase as Purchase;
}

const supplierBalance = async () => (await call('owner', 'GET', `/api/suppliers/${supplierId}`)).json().supplier.balance_paisa as number;
const variantRow = (id: number) => t.dbh.sqlite.prepare('SELECT avg_cost_paisa FROM product_variants WHERE id = ?').get(id) as { avg_cost_paisa: number | null };
const stockOf = (id: number) => (t.dbh.sqlite.prepare('SELECT coalesce(sum(qty_change), 0) AS q FROM stock_movements WHERE variant_id = ?').get(id) as { q: number }).q;

describe('purchase line cost', () => {
  it('the worked example: Rs 1,000 at 12% margin costs Rs 880', () => {
    expect(purchaseLineAmounts(1, 100_000, 1200)).toEqual({ line_gross_paisa: 100_000, line_margin_paisa: 12_000, line_cost_paisa: 88_000, unit_cost_paisa: 88_000 });
    expect(purchaseLineAmounts(10, 100_000, 1200)).toMatchObject({ line_cost_paisa: 880_000, unit_cost_paisa: 88_000 });
  });

  it('applies the margin to the line total, not per unit', () => {
    // 3 × Rs 333.33 at 12.5%: per unit would be 4166.625 -> 4167 × 3 = 12,501; on the total it is 12,499.875 -> 12,500
    expect(purchaseLineAmounts(3, 33_333, 1250)).toMatchObject({ line_gross_paisa: 99_999, line_margin_paisa: 12_500, line_cost_paisa: 87_499, unit_cost_paisa: 29_166 });
  });
});

describe('posting a purchase', () => {
  it('numbers it, credits the supplier, adds stock and sets the average cost — with one audit row', async () => {
    const before = t.auditCount();
    const p = await buy([
      { variant: 0, qty: 10 },
      { variant: 1, qty: 5, margin: 1500 },
    ]);
    expect(p.doc_no).toBe('PUR-000001');
    expect(p).toMatchObject({ gross_paisa: 1_500_000, margin_paisa: 120_000 + 75_000, total_cost_paisa: 880_000 + 425_000 });
    expect(await supplierBalance()).toBe(1_305_000);
    expect(stockOf(v(0))).toBe(10);
    expect(stockOf(v(1))).toBe(5);
    expect(variantRow(v(0)).avg_cost_paisa).toBe(88_000);
    expect(variantRow(v(1)).avg_cost_paisa).toBe(85_000);
    expect(t.auditCount()).toBe(before + 1);
    const audit = t.dbh.sqlite.prepare('SELECT entity, doc_no, flags FROM audit_log ORDER BY id DESC LIMIT 1').get();
    expect(audit).toEqual({ entity: 'purchase', doc_no: 'PUR-000001', flags: '["by_operator"]' });
    expect((await buy([{ variant: 0, qty: 1 }])).doc_no).toBe('PUR-000002');
  });

  it('averages costs across purchases at different prices and margins', async () => {
    await buy([{ variant: 0, qty: 10, price: 100_000, margin: 1200 }]); // 10 @ 880
    await buy([{ variant: 0, qty: 30, price: 110_000, margin: 1000 }]); // 30 @ 990
    // (10 × 880 + 30 × 990) / 40 = 962.50
    expect(variantRow(v(0)).avg_cost_paisa).toBe(96_250);
  });

  it('old stock keeps its cost when the product price changes later', async () => {
    await buy([{ variant: 0, qty: 10 }]);
    await call('owner', 'PATCH', `/api/products/${product.id}`, { list_price_paisa: 120_000 });
    expect(variantRow(v(0)).avg_cost_paisa).toBe(88_000);
  });

  it('refuses future dates, empty bills and inactive items, without using up a number', async () => {
    const bad = (body: object) => call('operator', 'POST', '/api/purchases', { supplier_id: supplierId, date: '2026-10-05', lines: [{ variant_id: v(0), qty: 1, list_price_paisa: 100_000, supplier_margin_bp: 1200 }], ...body });
    expect((await bad({ date: '2026-10-06' })).statusCode).toBe(400);
    expect((await bad({ lines: [] })).statusCode).toBe(400);
    expect((await bad({ lines: [{ variant_id: v(0), qty: 0, list_price_paisa: 1, supplier_margin_bp: 0 }] })).statusCode).toBe(400);
    await call('owner', 'PATCH', `/api/products/${product.id}`, { sizes: ['15L'] });
    const inactive = await bad({});
    expect(inactive.statusCode).toBe(400);
    expect(inactive.json().error).toMatch(/inactive/);
    expect((await buy([{ variant: 1, qty: 1 }])).doc_no).toBe('PUR-000001');
  });

  it('respects operators_can_record_purchases', async () => {
    updateSettings(t.dbh.db, { id: null, role: 'system' }, { operators_can_record_purchases: false });
    const body = { supplier_id: supplierId, date: '2026-10-05', lines: [{ variant_id: v(0), qty: 1, list_price_paisa: 100_000, supplier_margin_bp: 1200 }] };
    expect((await call('operator', 'POST', '/api/purchases', body)).statusCode).toBe(403);
    expect((await call('owner', 'POST', '/api/purchases', body)).statusCode).toBe(200);
  });
});

describe('who sees supplier margin and cost', () => {
  it('anyone who can record purchases sees them; operators without that right do not', async () => {
    const p = await buy([{ variant: 0, qty: 2 }]);
    const asOperator = (await call('operator', 'GET', `/api/purchases/${p.id}`)).json().purchase;
    expect(asOperator.total_cost_paisa).toBe(176_000);
    expect(asOperator.lines[0]).toMatchObject({ supplier_margin_bp: 1200, line_cost_paisa: 176_000, unit_cost_paisa: 88_000 });

    updateSettings(t.dbh.db, { id: null, role: 'system' }, { operators_can_record_purchases: false });
    const hidden = (await call('operator', 'GET', `/api/purchases/${p.id}`)).json().purchase;
    expect(hidden).not.toHaveProperty('total_cost_paisa');
    expect(hidden).not.toHaveProperty('margin_paisa');
    expect(hidden.lines[0]).not.toHaveProperty('supplier_margin_bp');
    expect(hidden.lines[0]).not.toHaveProperty('line_cost_paisa');
    expect(hidden.lines[0]).not.toHaveProperty('line_margin_paisa');
    expect(hidden.lines[0]).toHaveProperty('list_price_paisa', 100_000);
    const list = (await call('operator', 'GET', '/api/purchases')).json().purchases[0];
    expect(list).not.toHaveProperty('total_cost_paisa');
    expect((await call('operator', 'POST', `/api/purchases/${p.id}/print`)).statusCode).toBe(403);

    // The purchase entry screen gets the product's margin for prefilling — only for purchase recorders.
    expect((await call('operator', 'GET', `/api/purchase-entry/products/${product.id}`)).statusCode).toBe(403);

    // Product screens never show cost to operators, even when they can record purchases.
    updateSettings(t.dbh.db, { id: null, role: 'system' }, { operators_can_record_purchases: true });
    const entry = (await call('operator', 'GET', `/api/purchase-entry/products/${product.id}`)).json().product;
    expect(entry.supplier_margin_bp).toBe(1200);
    expect(entry.variants[0]).not.toHaveProperty('avg_cost_paisa');
    const prod = (await call('operator', 'GET', `/api/products/${product.id}`)).json().product;
    expect(prod.variants[0]).not.toHaveProperty('avg_cost_paisa');
    const moves = (await call('operator', 'GET', `/api/variants/${v(0)}/movements`)).json().movements;
    expect(moves[0]).not.toHaveProperty('unit_cost_paisa');
    expect((await call('operator', 'GET', '/api/stock/valuation')).statusCode).toBe(403);
  });
});

describe('updating the product from the bill', () => {
  it('owner can update price and margin in the same posting; operators cannot', async () => {
    const lines = [{ variant: 0, qty: 1, price: 105_000, margin: 1300 }];
    const update = { update_products: [{ product_id: product.id, list_price_paisa: 105_000, supplier_margin_bp: 1300 }] };
    const res = await call('operator', 'POST', '/api/purchases', {
      supplier_id: supplierId,
      date: '2026-10-05',
      lines: [{ variant_id: v(0), qty: 1, list_price_paisa: 105_000, supplier_margin_bp: 1300 }],
      ...update,
    });
    expect(res.statusCode).toBe(403);

    await buy(lines, 'owner', update);
    const p = (await call('owner', 'GET', `/api/products/${product.id}`)).json().product;
    expect(p).toMatchObject({ list_price_paisa: 105_000, supplier_margin_bp: 1300 });
    const history = (await call('owner', 'GET', `/api/products/${product.id}/price-history`)).json().history;
    expect(history[0]).toMatchObject({ list_price_paisa: 105_000, supplier_margin_bp: 1300 });
  });
});

describe('purchase returns', () => {
  it('sends goods back at the original cost, debits the supplier and limits the quantity', async () => {
    const p = await buy([{ variant: 0, qty: 10 }]);
    await buy([{ variant: 0, qty: 10, price: 110_000, margin: 1000 }]); // avg now (8,800 + 9,900)/20 = 935
    const lineId = p.lines?.[0]?.id as number;
    const ret = (qty: number, role: Role = 'operator') =>
      call(role, 'POST', `/api/purchases/${p.id}/returns`, { date: '2026-10-05', reason: 'Cracked buckets', lines: [{ purchase_item_id: lineId, qty }] });

    const first = await ret(3);
    expect(first.statusCode, first.body).toBe(200);
    expect(first.json().purchase_return).toMatchObject({ doc_no: 'PRN-000001', total_cost_paisa: 264_000 });
    expect(stockOf(v(0))).toBe(17);
    expect(await supplierBalance()).toBe(880_000 + 990_000 - 264_000);
    // Out at 880: (20 × 935 − 3 × 880) / 17 = 944.70… -> 94,471
    expect(variantRow(v(0)).avg_cost_paisa).toBe(94_471);

    const tooMany = await ret(8);
    expect(tooMany.statusCode).toBe(400);
    expect(tooMany.json().error).toMatch(/only 7 can still be returned/);

    expect((await ret(7)).statusCode).toBe(200);
    const view = (await call('operator', 'GET', `/api/purchases/${p.id}`)).json().purchase;
    expect(view.lines[0].returned_qty).toBe(10);
    expect(view.returns).toHaveLength(2);
    // Both returns add up to exactly the line cost.
    const returned = t.dbh.sqlite.prepare("SELECT sum(debit_paisa) AS d FROM ledger_entries WHERE entry_type = 'purchase_return'").get() as { d: number };
    expect(returned.d).toBe(880_000);
    expect((await ret(1)).statusCode).toBe(400);
  });

  it('splits the cost so partial returns add up to the line cost exactly', async () => {
    // 3 × Rs 333.33 at 12.5% -> line cost 87,499 (not divisible by 3)
    const p = await buy([{ variant: 0, qty: 3, price: 33_333, margin: 1250 }]);
    const lineId = p.lines?.[0]?.id as number;
    for (let i = 0; i < 3; i++) {
      const r = await call('operator', 'POST', `/api/purchases/${p.id}/returns`, { date: '2026-10-05', reason: 'Damaged', lines: [{ purchase_item_id: lineId, qty: 1 }] });
      expect(r.statusCode).toBe(200);
    }
    const sum = t.dbh.sqlite.prepare('SELECT sum(line_cost_paisa) AS c FROM purchase_return_items').get() as { c: number };
    expect(sum.c).toBe(87_499);
    expect(await supplierBalance()).toBe(0);
  });

  it('blocks returning items that are no longer in stock', async () => {
    const p = await buy([{ variant: 0, qty: 5 }]);
    // Simulate 4 sold (sales arrive in phase 4).
    t.dbh.sqlite.prepare("INSERT INTO stock_movements (variant_id, date, qty_change, source_type, source_id) VALUES (?, '2026-10-05', -4, 'sale', 1)").run(v(0));
    const res = await call('operator', 'POST', `/api/purchases/${p.id}/returns`, { date: '2026-10-05', reason: 'Damaged', lines: [{ purchase_item_id: p.lines?.[0]?.id, qty: 2 }] });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/only 1 in stock/);
  });

  it('needs a reason and cannot be dated before the purchase', async () => {
    const p = await buy([{ variant: 0, qty: 5 }]);
    const lineId = p.lines?.[0]?.id;
    expect((await call('operator', 'POST', `/api/purchases/${p.id}/returns`, { date: '2026-10-05', reason: '', lines: [{ purchase_item_id: lineId, qty: 1 }] })).statusCode).toBe(400);
    expect((await call('operator', 'POST', `/api/purchases/${p.id}/returns`, { date: '2026-10-04', reason: 'Damaged', lines: [{ purchase_item_id: lineId, qty: 1 }] })).statusCode).toBe(400);
  });
});

describe('average cost replay', () => {
  it('ignores sales for the average and restarts after stock runs out', () => {
    expect(
      replayAverageCost([
        { qty_change: 10, unit_cost_paisa: 1000, source_type: 'purchase' },
        { qty_change: -10, unit_cost_paisa: null, source_type: 'sale' },
        { qty_change: 5, unit_cost_paisa: 2000, source_type: 'purchase' },
      ]),
    ).toBe(2000);
    expect(
      replayAverageCost([
        { qty_change: 10, unit_cost_paisa: 1000, source_type: 'purchase' },
        { qty_change: -4, unit_cost_paisa: null, source_type: 'sale' },
        { qty_change: 6, unit_cost_paisa: 2000, source_type: 'purchase' },
      ]),
    ).toBe(1500);
    expect(replayAverageCost([])).toBeNull();
  });
});

describe('stock screens', () => {
  it('lists low stock, movement history and owner-only valuation', async () => {
    await call('operator', 'PATCH', `/api/variants/${v(0)}`, { low_stock_threshold: 5 });
    await call('operator', 'PATCH', `/api/variants/${v(1)}`, { low_stock_threshold: 5 });
    await buy([
      { variant: 0, qty: 3 },
      { variant: 1, qty: 20 },
    ]);
    const low = (await call('operator', 'GET', '/api/stock/low')).json().rows;
    expect(low.map((r: { sku: string; stock_qty: number }) => [r.sku, r.stock_qty])).toEqual([['B-101-RED-10L', 3]]);

    const moves = (await call('owner', 'GET', `/api/variants/${v(1)}/movements`)).json().movements;
    expect(moves[0]).toMatchObject({ qty_change: 20, balance_qty: 20, doc_no: 'PUR-000001', unit_cost_paisa: 88_000 });

    const val = (await call('owner', 'GET', '/api/stock/valuation')).json();
    expect(val).toMatchObject({ total_qty: 23, total_value_paisa: 23 * 88_000 });
  });
});

describe('purchase PDF', () => {
  it('is written under DATA_DIR/invoices and each print is audited', async () => {
    const p = await buy([{ variant: 0, qty: 2 }]);
    const before = t.auditCount();
    const res = await call('operator', 'POST', `/api/purchases/${p.id}/print`);
    expect(res.statusCode, res.body).toBe(200);
    expect(t.auditCount()).toBe(before + 1);
    expect(t.dbh.sqlite.prepare('SELECT action FROM audit_log ORDER BY id DESC LIMIT 1').get()).toEqual({ action: 'print' });
    expect(existsSync(`${t.config.invoicesDir}/2026/10/PUR-000001-v1.pdf`)).toBe(true);

    const pdf = await call('operator', 'GET', `/api/purchases/${p.id}/pdf`);
    expect(pdf.statusCode).toBe(200);
    expect(pdf.headers['content-type']).toBe('application/pdf');
    expect(pdf.rawPayload.subarray(0, 5).toString()).toBe('%PDF-');
    expect(t.auditCount()).toBe(before + 1);
  });
});
