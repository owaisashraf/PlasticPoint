import { describe, expect, it } from 'vitest';
import { planAutoAllocations, type AllocSourceInput, type AllocTarget } from './allocation';

const inv = (sale_id: number, date: string, total: number): AllocTarget => ({ sale_id, date, total_paisa: total });
const pay = (id: number, date: string, amount: number): AllocSourceInput => ({ source_type: 'payment', source_id: id, date, amount_paisa: amount });

describe('planAutoAllocations', () => {
  it('pays the oldest invoice first (FIFO), splitting a payment across invoices', () => {
    const plan = planAutoAllocations([inv(2, '2026-10-02', 500), inv(1, '2026-10-01', 300)], [pay(1, '2026-10-05', 600)], []);
    expect(plan).toEqual([
      { source_type: 'payment', source_id: 1, sale_id: 1, amount_paisa: 300 },
      { source_type: 'payment', source_id: 1, sale_id: 2, amount_paisa: 300 },
    ]);
  });

  it('leaves what is not needed as an advance', () => {
    const plan = planAutoAllocations([inv(1, '2026-10-01', 300)], [pay(1, '2026-10-05', 1000)], []);
    expect(plan).toEqual([{ source_type: 'payment', source_id: 1, sale_id: 1, amount_paisa: 300 }]);
  });

  it('applies an earlier advance to a later invoice', () => {
    const plan = planAutoAllocations([inv(1, '2026-10-09', 300)], [pay(1, '2026-10-01', 1000)], []);
    expect(plan).toEqual([{ source_type: 'payment', source_id: 1, sale_id: 1, amount_paisa: 300 }]);
  });

  it('treats an owed opening balance as the oldest debt', () => {
    const plan = planAutoAllocations([inv(1, '2026-01-01', 300), { sale_id: null, date: '2026-01-01', total_paisa: 200 }], [pay(1, '2026-10-05', 250)], []);
    expect(plan).toEqual([
      { source_type: 'payment', source_id: 1, sale_id: null, amount_paisa: 200 },
      { source_type: 'payment', source_id: 1, sale_id: 1, amount_paisa: 50 },
    ]);
  });

  it('uses an opening advance like a payment', () => {
    const plan = planAutoAllocations([inv(1, '2026-10-01', 300)], [{ source_type: 'opening_balance', source_id: 7, date: '2026-07-01', amount_paisa: 100 }], []);
    expect(plan).toEqual([{ source_type: 'opening_balance', source_id: 7, sale_id: 1, amount_paisa: 100 }]);
  });

  it('keeps manual allocations and works around them', () => {
    const plan = planAutoAllocations(
      [inv(1, '2026-10-01', 300), inv(2, '2026-10-02', 500)],
      [pay(1, '2026-10-05', 500), pay(2, '2026-10-06', 400)],
      [{ source_type: 'payment', source_id: 1, sale_id: 2, amount_paisa: 500 }],
    );
    // Payment 1 is all on invoice 2 (manual); payment 2 pays invoice 1 and keeps 100 as advance.
    expect(plan).toEqual([{ source_type: 'payment', source_id: 2, sale_id: 1, amount_paisa: 300 }]);
  });

  it('a sales return pays its own invoice first, then FIFO', () => {
    const plan = planAutoAllocations(
      [inv(1, '2026-10-01', 300), inv(2, '2026-10-02', 500)],
      [{ source_type: 'sales_return', source_id: 9, date: '2026-10-03', amount_paisa: 600, preferred_sale_id: 2 }],
      [],
    );
    expect(plan).toEqual([
      { source_type: 'sales_return', source_id: 9, sale_id: 2, amount_paisa: 500 },
      { source_type: 'sales_return', source_id: 9, sale_id: 1, amount_paisa: 100 },
    ]);
  });

  it('processes sources in date order', () => {
    const plan = planAutoAllocations([inv(1, '2026-10-01', 300)], [pay(2, '2026-10-06', 300), pay(1, '2026-10-05', 200)], []);
    expect(plan).toEqual([
      { source_type: 'payment', source_id: 1, sale_id: 1, amount_paisa: 200 },
      { source_type: 'payment', source_id: 2, sale_id: 1, amount_paisa: 100 },
    ]);
  });

  it('refuses a manual allocation larger than its invoice or its payment', () => {
    expect(() => planAutoAllocations([inv(1, '2026-10-01', 300)], [pay(1, '2026-10-05', 500)], [{ source_type: 'payment', source_id: 1, sale_id: 1, amount_paisa: 301 }])).toThrow(/more money is linked/i);
    expect(() => planAutoAllocations([inv(1, '2026-10-01', 300)], [pay(1, '2026-10-05', 100)], [{ source_type: 'payment', source_id: 1, sale_id: 1, amount_paisa: 200 }])).toThrow(/more invoices than its amount/);
    expect(() => planAutoAllocations([], [pay(1, '2026-10-05', 100)], [{ source_type: 'payment', source_id: 1, sale_id: 5, amount_paisa: 50 }])).toThrow(/no longer open/);
  });
});
