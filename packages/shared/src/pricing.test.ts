import { describe, expect, it } from 'vitest';
import { addDaysToDate, defaultDiscountBp, saleLineAmounts } from './pricing';

describe('saleLineAmounts', () => {
  it('the worked example: Rs 1,000 at 10% discount → the customer pays Rs 900', () => {
    expect(saleLineAmounts(1, 100_000, 1000)).toEqual({ line_gross_paisa: 100_000, line_discount_paisa: 10_000, line_amount_paisa: 90_000 });
    expect(saleLineAmounts(12, 100_000, 1000)).toEqual({ line_gross_paisa: 1_200_000, line_discount_paisa: 120_000, line_amount_paisa: 1_080_000 });
  });

  it('applies the discount to the line total, not per unit', () => {
    // 3 × Rs 333.33 at 12.5%: per unit 4166.625 → 4167 × 3 = 12,501 paisa;
    // on the line total 99,999 × 12.5% = 12,499.875 → 12,500.
    expect(saleLineAmounts(3, 33_333, 1250)).toEqual({ line_gross_paisa: 99_999, line_discount_paisa: 12_500, line_amount_paisa: 87_499 });
    // 7 × Rs 0.15 at 50% = 52.5 paisa → rounds half up to 53
    expect(saleLineAmounts(7, 15, 5000).line_discount_paisa).toBe(53);
  });

  it('allows 0% and 100% but nothing outside, and needs a whole positive quantity', () => {
    expect(saleLineAmounts(2, 500, 0).line_amount_paisa).toBe(1000);
    expect(saleLineAmounts(2, 500, 10_000).line_amount_paisa).toBe(0);
    expect(() => saleLineAmounts(1, 500, 10_001)).toThrow();
    expect(() => saleLineAmounts(1, 500, -1)).toThrow();
    expect(() => saleLineAmounts(1, 500, 12.5)).toThrow();
    expect(() => saleLineAmounts(0, 500, 0)).toThrow();
    expect(() => saleLineAmounts(1.5, 500, 0)).toThrow();
  });
});

describe('defaultDiscountBp', () => {
  const base = { settingsDiscountBp: 1000, retailReductionBp: 0 } as const;

  it("uses the product's default first, then the settings default", () => {
    expect(defaultDiscountBp({ ...base, productDiscountBp: 800, customerType: 'wholesaler' })).toBe(800);
    expect(defaultDiscountBp({ ...base, productDiscountBp: 0, customerType: 'wholesaler' })).toBe(0);
    expect(defaultDiscountBp({ ...base, productDiscountBp: null, customerType: 'wholesaler' })).toBe(1000);
    expect(defaultDiscountBp({ ...base, productDiscountBp: undefined, customerType: 'wholesaler' })).toBe(1000);
  });

  it('gives retailers the retail reduction less, never below 0', () => {
    const r = { ...base, retailReductionBp: 300 };
    expect(defaultDiscountBp({ ...r, productDiscountBp: 1000, customerType: 'retailer' })).toBe(700);
    expect(defaultDiscountBp({ ...r, productDiscountBp: 1000, customerType: 'wholesaler' })).toBe(1000);
    expect(defaultDiscountBp({ ...r, productDiscountBp: null, customerType: 'retailer' })).toBe(700);
    expect(defaultDiscountBp({ ...r, productDiscountBp: 200, customerType: 'retailer' })).toBe(0);
  });
});

describe('addDaysToDate', () => {
  it('adds days across month, year and leap-day boundaries', () => {
    expect(addDaysToDate('2026-10-05', 30)).toBe('2026-11-04');
    expect(addDaysToDate('2026-12-15', 30)).toBe('2027-01-14');
    expect(addDaysToDate('2028-02-28', 1)).toBe('2028-02-29');
    expect(addDaysToDate('2027-02-28', 1)).toBe('2027-03-01');
    expect(addDaysToDate('2026-10-05', 0)).toBe('2026-10-05');
  });
});
