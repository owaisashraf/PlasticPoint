import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Product, Role } from '@shopledger/shared';
import { createTestContext, type TestContext } from '../../../test/helpers';
import { makeSku, variantCombos } from './service';

let t: TestContext;
beforeEach(async () => {
  t = await createTestContext();
});
afterEach(async () => {
  vi.useRealTimers();
  await t.close();
});

async function call(role: Role, method: 'GET' | 'POST' | 'PATCH', url: string, payload?: object) {
  return t.app.inject({ method, url, headers: { cookie: await t.cookie(role) }, ...(payload ? { payload } : {}) });
}

const bucket = { item_code: 'b-101', name: 'Bucket 10L', category: 'Buckets', sizes: ['10L', '15L'], colors: ['Red', 'Blue', 'Sky Blue'], list_price_paisa: 100_000 };

async function create(body: object = bucket, role: Role = 'owner'): Promise<Product> {
  const res = await call(role, 'POST', '/api/products', body);
  expect(res.statusCode, res.body).toBe(200);
  return res.json().product;
}

describe('variants', () => {
  it('makes every color × size, or one plain variant', () => {
    expect(variantCombos(['S', 'M'], ['Red'])).toEqual([
      { color: 'Red', size: 'S' },
      { color: 'Red', size: 'M' },
    ]);
    expect(variantCombos([], [])).toEqual([{ color: '', size: '' }]);
    expect(variantCombos(['S'], [])).toEqual([{ color: '', size: 'S' }]);
    expect(makeSku('B-101', 'Sky Blue', '10L')).toBe('B-101-SKY_BLUE-10L');
    expect(makeSku('B-101', '', '')).toBe('B-101');
  });

  it('creates variants with the product and keeps item codes in capitals', async () => {
    const p = await create();
    expect(p.item_code).toBe('B-101');
    expect(p.variants).toHaveLength(6);
    expect(p.variants?.map((v) => v.sku)).toContain('B-101-SKY_BLUE-15L');
    expect(p.variants?.every((v) => v.active && v.stock_qty === 0)).toBe(true);
  });

  it('removing a size deactivates its variants; adding it back reactivates them', async () => {
    const p = await create();
    const ids = p.variants?.map((v) => v.id);
    const res = await call('operator', 'PATCH', `/api/products/${p.id}`, { sizes: ['10L'] });
    const after = res.json().product as Product;
    expect(after.variants).toHaveLength(6);
    expect(after.variants?.filter((v) => v.active).map((v) => v.size)).toEqual(['10L', '10L', '10L']);

    const back = (await call('operator', 'PATCH', `/api/products/${p.id}`, { sizes: ['10L', '15L', '20L'] })).json().product as Product;
    expect(back.variants?.filter((v) => v.active)).toHaveLength(9);
    expect(back.variants?.slice(0, 6).map((v) => v.id)).toEqual(ids);
  });

  it('changing the item code renames every SKU', async () => {
    const p = await create();
    const after = (await call('operator', 'PATCH', `/api/products/${p.id}`, { item_code: 'B-102' })).json().product as Product;
    expect(after.variants?.every((v) => v.sku.startsWith('B-102'))).toBe(true);
  });

  it('refuses a duplicate item code', async () => {
    await create();
    const res = await call('owner', 'POST', '/api/products', { ...bucket, item_code: 'B-101' });
    expect(res.statusCode).toBe(409);
  });

  it('sets the low stock threshold per variant', async () => {
    const p = await create({ ...bucket, low_stock_threshold: 5 });
    expect(p.variants?.every((v) => v.low_stock_threshold === 5)).toBe(true);
    const v = p.variants?.[0];
    const res = await call('operator', 'PATCH', `/api/variants/${v?.id}`, { low_stock_threshold: 12 });
    expect(res.json().variant.low_stock_threshold).toBe(12);
  });
});

describe('prices and who can set them', () => {
  it('an operator creates a product with its price; margin and discount come from settings', async () => {
    const p = await create(bucket, 'operator');
    expect(p.list_price_paisa).toBe(100_000);
    expect(p.default_customer_discount_bp).toBe(1000);
    // Operators never receive the supplier margin or cost...
    expect(p.supplier_margin_bp).toBeUndefined();
    expect(p.variants?.[0]).not.toHaveProperty('avg_cost_paisa');
    // ...but it was stored with the default.
    const owner = (await call('owner', 'GET', `/api/products/${p.id}`)).json().product as Product;
    expect(owner.supplier_margin_bp).toBe(1200);
    expect(owner.variants?.[0]).toHaveProperty('avg_cost_paisa', null);
  });

  it('operators cannot set or change price, supplier margin or discounts', async () => {
    expect((await call('operator', 'POST', '/api/products', { ...bucket, supplier_margin_bp: 1500 })).statusCode).toBe(403);
    expect((await call('operator', 'POST', '/api/products', { ...bucket, default_customer_discount_bp: 500 })).statusCode).toBe(403);
    const p = await create();
    for (const change of [{ list_price_paisa: 110_000 }, { supplier_margin_bp: 1300 }, { default_customer_discount_bp: 800 }, { max_customer_discount_bp: 1500 }]) {
      const res = await call('operator', 'PATCH', `/api/products/${p.id}`, change);
      expect(res.statusCode, JSON.stringify(change)).toBe(403);
      expect(res.json().error).not.toMatch(/cost|margin %/i);
    }
    // Sending the unchanged price is fine (the edit form sends everything).
    expect((await call('operator', 'PATCH', `/api/products/${p.id}`, { name: 'Bucket', list_price_paisa: 100_000 })).statusCode).toBe(200);
  });

  it('operators never see supplier margins in lists', async () => {
    await create();
    const list = (await call('operator', 'GET', '/api/products')).json().products as Product[];
    expect(list[0]).not.toHaveProperty('supplier_margin_bp');
    expect((await call('owner', 'GET', '/api/products')).json().products[0]).toHaveProperty('supplier_margin_bp', 1200);
  });

  it('owner price changes are recorded in price history and flagged in the audit log', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-07-01T06:00:00Z'));
    const p = await create();
    vi.setSystemTime(new Date('2026-08-15T06:00:00Z'));
    const before = t.auditCount();
    const res = await call('owner', 'PATCH', `/api/products/${p.id}`, { list_price_paisa: 110_000, supplier_margin_bp: 1250 });
    expect(res.statusCode).toBe(200);
    expect(t.auditCount()).toBe(before + 1);
    expect(JSON.parse((t.dbh.sqlite.prepare('SELECT flags FROM audit_log ORDER BY id DESC LIMIT 1').get() as { flags: string }).flags)).toEqual(['price_changed']);

    const history = (await call('owner', 'GET', `/api/products/${p.id}/price-history`)).json().history;
    expect(history.map((h: { effective_date: string; list_price_paisa: number; supplier_margin_bp: number }) => [h.effective_date, h.list_price_paisa, h.supplier_margin_bp])).toEqual([
      ['2026-08-15', 110_000, 1250],
      ['2026-07-01', 100_000, 1200],
    ]);
    expect((await call('operator', 'GET', `/api/products/${p.id}/price-history`)).statusCode).toBe(403);
  });

  it('non-price edits do not add price history', async () => {
    const p = await create();
    await call('owner', 'PATCH', `/api/products/${p.id}`, { name: 'Renamed', colors: ['Red'] });
    expect((await call('owner', 'GET', `/api/products/${p.id}/price-history`)).json().history).toHaveLength(1);
  });

  it('deactivating a product deactivates its variants', async () => {
    const p = await create();
    const after = (await call('operator', 'PATCH', `/api/products/${p.id}`, { active: false })).json().product as Product;
    expect(after.active).toBe(false);
    expect(after.variants?.some((v) => v.active)).toBe(false);
    expect((await call('operator', 'GET', '/api/products')).json().total).toBe(0);
    expect((await call('operator', 'GET', '/api/products?status=all')).json().total).toBe(1);
  });
});

describe('bulk update', () => {
  beforeEach(async () => {
    await create({ ...bucket, item_code: 'B-1', list_price_paisa: 100_000 });
    await create({ ...bucket, item_code: 'B-2', list_price_paisa: 33_333 });
    await create({ ...bucket, item_code: 'T-1', category: 'Tubs', list_price_paisa: 50_000 });
  });

  const prices = () =>
    Object.fromEntries((t.dbh.sqlite.prepare('SELECT item_code, list_price_paisa FROM products').all() as { item_code: string; list_price_paisa: number }[]).map((r) => [r.item_code, r.list_price_paisa]));

  it('previews without saving (dry run)', async () => {
    const res = await call('owner', 'POST', '/api/products/bulk-update', {
      target: { kind: 'category', category: 'buckets' },
      change: { kind: 'price_percent', bp: 750 },
      reason: 'Manufacturer price list Aug 2026',
      dry_run: true,
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().applied).toBe(false);
    // 33,333 + 7.5% = 33,333 + 2,499.975 -> 2,500 = 35,833
    expect(res.json().rows.map((r: { item_code: string; after: { list_price_paisa: number } }) => [r.item_code, r.after.list_price_paisa])).toEqual([
      ['B-1', 107_500],
      ['B-2', 35_833],
    ]);
    expect(prices()).toEqual({ 'B-1': 100_000, 'B-2': 33_333, 'T-1': 50_000 });
  });

  it('applies to a category in one go, with history and one audit row per product', async () => {
    const before = t.auditCount();
    const res = await call('owner', 'POST', '/api/products/bulk-update', {
      target: { kind: 'category', category: 'Buckets' },
      change: { kind: 'price_percent', bp: 750 },
      reason: 'Manufacturer price list Aug 2026',
    });
    expect(res.json().applied).toBe(true);
    expect(prices()).toEqual({ 'B-1': 107_500, 'B-2': 35_833, 'T-1': 50_000 });
    expect(t.auditCount()).toBe(before + 2);
    const n = t.dbh.sqlite.prepare('SELECT COUNT(*) AS n FROM product_price_history').get() as { n: number };
    expect(n.n).toBe(3 + 2);
  });

  it('changes margins and discounts for selected products', async () => {
    const ids = (t.dbh.sqlite.prepare("SELECT id FROM products WHERE item_code IN ('B-1', 'T-1')").all() as { id: number }[]).map((r) => r.id);
    await call('owner', 'POST', '/api/products/bulk-update', { target: { kind: 'products', product_ids: ids }, change: { kind: 'supplier_margin', bp: 1500 }, reason: 'New terms' });
    await call('owner', 'POST', '/api/products/bulk-update', { target: { kind: 'products', product_ids: ids }, change: { kind: 'default_discount', bp: 800 }, reason: 'New terms' });
    const rows = t.dbh.sqlite.prepare('SELECT item_code, supplier_margin_bp AS m, default_customer_discount_bp AS d FROM products ORDER BY item_code').all();
    expect(rows).toEqual([
      { item_code: 'B-1', m: 1500, d: 800 },
      { item_code: 'B-2', m: 1200, d: 1000 },
      { item_code: 'T-1', m: 1500, d: 800 },
    ]);
  });

  it('refuses a change that would make a price zero or less, and changes nothing', async () => {
    const res = await call('owner', 'POST', '/api/products/bulk-update', {
      target: { kind: 'category', category: 'Buckets' },
      change: { kind: 'price_amount', paisa: -50_000 },
      reason: 'oops',
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/B-2/);
    expect(prices()).toEqual({ 'B-1': 100_000, 'B-2': 33_333, 'T-1': 50_000 });
  });

  it('operators cannot bulk update', async () => {
    const res = await call('operator', 'POST', '/api/products/bulk-update', {
      target: { kind: 'category', category: 'Buckets' },
      change: { kind: 'price_percent', bp: 100 },
      reason: 'try',
    });
    expect(res.statusCode).toBe(403);
  });
});
