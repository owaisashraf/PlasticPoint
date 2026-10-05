import { permissionsFor, type Role } from '@shopledger/shared';
import { describe, expect, it } from 'vitest';
import { isFinancialField, redact } from './redact';

const as = (role: Role) => ({ role, permissions: permissionsFor(role, { operators_can_record_purchases: true }) });

const sale = {
  doc_no: 'INV-000001',
  total_paisa: 90000,
  lines: [
    {
      qty: 1,
      list_price_paisa: 100000,
      discount_bp: 1000,
      line_net_paisa: 90000,
      supplier_margin_bp: 1200,
      unit_cost_paisa: 88000,
      line_cost_paisa: 88000,
      cost_source: 'purchase_avg',
      profit_paisa: 2000,
    },
  ],
  profit_paisa: 2000,
  stock_valuation_paisa: 5,
  expenses: [{ amount_paisa: 1 }],
  assets: [],
  accumulated_depreciation_paisa: 1,
};

describe('redact', () => {
  it('removes supplier margin, cost, profit, valuation, expenses and assets for operators', () => {
    const out = redact(sale, as('operator'));
    expect(out).toEqual({
      doc_no: 'INV-000001',
      total_paisa: 90000,
      lines: [{ qty: 1, list_price_paisa: 100000, discount_bp: 1000, line_net_paisa: 90000 }],
    });
  });

  it('removes everything financial when there is no user', () => {
    expect(redact({ profit_paisa: 1, name: 'x' }, null)).toEqual({ name: 'x' });
  });

  it('leaves data untouched for owner and superuser', () => {
    expect(redact(sale, as('owner'))).toBe(sale);
    expect(redact(sale, as('superuser'))).toBe(sale);
  });

  it('keeps supplier margin and cost for the purchase entry screen, but still removes profit', () => {
    const purchaseLine = { list_price_paisa: 100000, supplier_margin_bp: 1200, line_cost_paisa: 88000, profit_paisa: 1 };
    expect(redact(purchaseLine, as('operator'), { allow: ['supplier_margin', 'cost'] })).toEqual({
      list_price_paisa: 100000,
      supplier_margin_bp: 1200,
      line_cost_paisa: 88000,
    });
  });

  it('does not treat price or discount fields as financial', () => {
    for (const k of ['list_price_paisa', 'discount_bp', 'default_customer_discount_bp', 'line_net_paisa', 'total_paisa']) {
      expect(isFinancialField(k)).toBe(false);
    }
  });
});
