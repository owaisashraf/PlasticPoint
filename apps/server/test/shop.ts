import { expect } from 'vitest';
import type { LightMyRequestResponse } from 'fastify';
import type { Customer, Product, Role, Sale } from '@shopledger/shared';
import type { TestContext } from './helpers';

/**
 * A small shop for document tests: one supplier, product B-101 (Rs 1,000,
 * 12% supplier margin → cost Rs 880, 10% default discount) in Red 10L and
 * Red 15L with 50 of each in stock, and one wholesale customer on 30 days.
 */
export interface Shop {
  supplierId: number;
  product: Product;
  customer: Customer;
  variant(i: number): number;
  call(role: Role, method: 'GET' | 'POST' | 'PATCH' | 'PUT', url: string, payload?: object): Promise<LightMyRequestResponse>;
  ok<T = Record<string, unknown>>(role: Role, method: 'GET' | 'POST' | 'PATCH' | 'PUT', url: string, payload?: object): Promise<T>;
  /** Posts a sale of `qty` × variant 0 at 10% (Rs 900 each) on `date`. */
  sell(opts?: { qty?: number; date?: string; customerId?: number; cash?: number; variant?: number; discount_bp?: number }): Promise<Sale>;
  balance(customerId?: number): Promise<number>;
  stockOf(variantId: number): number;
}

export async function setupShop(t: TestContext): Promise<Shop> {
  const call: Shop['call'] = async (role, method, url, payload) =>
    t.app.inject({ method, url, headers: { cookie: await t.cookie(role) }, ...(payload ? { payload } : {}) });
  const ok: Shop['ok'] = async (role, method, url, payload) => {
    const res = await call(role, method, url, payload);
    expect(res.statusCode, `${method} ${url}: ${res.body}`).toBe(200);
    return res.json();
  };

  const supplierId = (await ok<{ supplier: { id: number } }>('owner', 'POST', '/api/suppliers', { name: 'Popular Plastics' })).supplier.id;
  const product = (await ok<{ product: Product }>('owner', 'POST', '/api/products', { item_code: 'B-101', name: 'Bucket', sizes: ['10L', '15L'], colors: ['Red'], list_price_paisa: 100_000 })).product;
  const variant = (i: number) => product.variants?.[i]?.id as number;
  await ok('owner', 'POST', '/api/purchases', {
    supplier_id: supplierId,
    date: '2026-09-01',
    lines: [0, 1].map((i) => ({ variant_id: variant(i), qty: 50, list_price_paisa: 100_000, supplier_margin_bp: 1200 })),
  });
  const customer = (await ok<{ customer: Customer }>('operator', 'POST', '/api/customers', { name: 'Ahmed Khan', type: 'wholesaler', city: 'Lahore', payment_terms_days: 30 })).customer;

  return {
    supplierId,
    product,
    customer,
    variant,
    call,
    ok,
    async sell(o = {}) {
      const r = await ok<{ sale: Sale }>('operator', 'POST', '/api/sales', {
        customer_id: o.customerId ?? customer.id,
        date: o.date ?? '2026-10-01',
        lines: [{ variant_id: variant(o.variant ?? 0), qty: o.qty ?? 1, discount_bp: o.discount_bp ?? 1000 }],
        cash_received_paisa: o.cash ?? 0,
      });
      return r.sale;
    },
    async balance(customerId = customer.id) {
      return (await ok<{ customer: Customer }>('owner', 'GET', `/api/customers/${customerId}`)).customer.balance_paisa;
    },
    stockOf(variantId) {
      return (t.dbh.sqlite.prepare('SELECT coalesce(sum(qty_change), 0) AS q FROM stock_movements WHERE variant_id = ?').get(variantId) as { q: number }).q;
    },
  };
}
