import { describe, expect, it } from 'vitest';
import { accumulatedDepreciation, bookValue, depreciationInPeriod, depreciationSchedule, disposalGainLoss, monthEnd, type DepreciableAsset } from './depreciation';

// Rs 1,20,000 laptop, no salvage, 12 months, bought mid-January 2026.
const laptop: DepreciableAsset = {
  purchase_date: '2026-01-15',
  cost_paisa: 12_000_000,
  salvage_value_paisa: 0,
  depreciation_method: 'straight_line',
  useful_life_months: 12,
  disposal_date: null,
};

describe('depreciation (CLAUDE.md 8.13)', () => {
  it('month ends, including leap years', () => {
    expect(monthEnd(2026, 2)).toBe('2026-02-28');
    expect(monthEnd(2028, 2)).toBe('2028-02-29');
    expect(monthEnd(2026, 12)).toBe('2026-12-31');
  });

  it('charges (cost − salvage) ÷ life every month, starting the month after purchase', () => {
    const s = depreciationSchedule(laptop);
    expect(s).toHaveLength(12);
    expect(s[0]).toEqual({ month: '2026-02', charge_date: '2026-02-28', charge_paisa: 1_000_000, accumulated_paisa: 1_000_000, book_value_paisa: 11_000_000 });
    expect(s.at(-1)).toMatchObject({ month: '2027-01', accumulated_paisa: 12_000_000, book_value_paisa: 0 });
  });

  it('charges count on the last day of the month; nothing in the purchase month', () => {
    expect(bookValue(laptop, '2026-01-31')).toBe(12_000_000);
    expect(bookValue(laptop, '2026-02-27')).toBe(12_000_000);
    expect(bookValue(laptop, '2026-02-28')).toBe(11_000_000);
    expect(accumulatedDepreciation(laptop, '2026-06-30')).toBe(5_000_000);
    expect(bookValue(laptop, '2030-01-01')).toBe(0); // stops when fully depreciated
    expect(bookValue(laptop, '2025-12-31')).toBe(12_000_000);
  });

  it('keeps the salvage value and spreads the remainder so the total is exact', () => {
    const odd = { ...laptop, cost_paisa: 1_000_001, salvage_value_paisa: 100_000, useful_life_months: 7 };
    const s = depreciationSchedule(odd);
    // 900,001 ÷ 7 = 128,571.57: four months of 128,572 and three of 128,571
    expect(s.map((r) => r.charge_paisa)).toEqual([128_572, 128_572, 128_572, 128_572, 128_571, 128_571, 128_571]);
    expect(s.at(-1)?.book_value_paisa).toBe(100_000);
  });

  it('depreciation in a period (for the profit & loss)', () => {
    expect(depreciationInPeriod(laptop, '2026-07-01', '2026-12-31')).toBe(6_000_000); // Jul–Dec
    expect(depreciationInPeriod(laptop, '2026-01-01', '2026-01-31')).toBe(0);
  });

  it('stops at disposal; gain or loss = amount received − book value on that date', () => {
    // Sold on 2026-05-20: Feb, Mar, Apr charged (3 × Rs 10,000); May is not.
    const sold = { ...laptop, disposal_date: '2026-05-20', disposal_amount_paisa: 9_500_000 };
    expect(depreciationSchedule(sold).map((r) => r.month)).toEqual(['2026-02', '2026-03', '2026-04']);
    expect(bookValue(sold, '2026-05-20')).toBe(9_000_000);
    expect(disposalGainLoss(sold)).toBe(500_000);
    expect(disposalGainLoss({ ...sold, disposal_amount_paisa: 8_000_000 })).toBe(-1_000_000);
    // Disposed on the last day of a month: that month's charge counts.
    expect(depreciationSchedule({ ...laptop, disposal_date: '2026-04-30' }).map((r) => r.month)).toEqual(['2026-02', '2026-03', '2026-04']);
  });

  it('assets without depreciation keep their cost', () => {
    const land = { ...laptop, depreciation_method: 'none' as const, useful_life_months: null };
    expect(depreciationSchedule(land)).toEqual([]);
    expect(bookValue(land, '2030-01-01')).toBe(12_000_000);
    expect(disposalGainLoss({ ...land, disposal_date: '2027-01-01', disposal_amount_paisa: 15_000_000 })).toBe(3_000_000);
  });
});
