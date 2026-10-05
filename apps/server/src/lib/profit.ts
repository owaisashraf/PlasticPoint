import { roundDiv, spreadLargestRemainder } from './money';
import { estimatedUnitCost, saleLineAmounts } from './pricing';

/**
 * Line cost and profit (CLAUDE.md 8.11).
 *
 *   line net    = line amount − its share of the extra invoice discount
 *   line cost   = qty × unit cost (average purchase cost, or estimated)
 *   line profit = line net − line cost
 */

export type CostSource = 'purchase_avg' | 'estimated';

/**
 * Spreads an extra invoice discount over the lines in proportion to each
 * line's amount, using the largest-remainder method so the shares add up to
 * the discount exactly.
 */
export function spreadExtraDiscount(lineAmountsPaisa: readonly number[], extraDiscountPaisa: number): number[] {
  if (!Number.isSafeInteger(extraDiscountPaisa) || extraDiscountPaisa < 0) throw new Error('The extra discount must be zero or more whole paisa');
  const sum = lineAmountsPaisa.reduce((a, b) => a + b, 0);
  if (extraDiscountPaisa > sum) throw new Error('The extra discount cannot be more than the invoice amount');
  if (extraDiscountPaisa === 0) return lineAmountsPaisa.map(() => 0);
  return spreadLargestRemainder(extraDiscountPaisa, lineAmountsPaisa);
}

/**
 * Unit cost for a sale line: the variant's weighted average purchase cost,
 * or, if nothing has been bought yet, price × (1 − supplier margin).
 */
export function saleUnitCost(avgCostPaisa: number | null, listPricePaisa: number, supplierMarginBp: number): { unit_cost_paisa: number; cost_source: CostSource } {
  if (avgCostPaisa !== null) return { unit_cost_paisa: avgCostPaisa, cost_source: 'purchase_avg' };
  return { unit_cost_paisa: estimatedUnitCost(listPricePaisa, supplierMarginBp), cost_source: 'estimated' };
}

export interface SaleLineInputs {
  qty: number;
  list_price_paisa: number;
  discount_bp: number;
  unit_cost_paisa: number;
}

export interface SaleLineResult {
  line_gross_paisa: number;
  line_discount_paisa: number;
  line_amount_paisa: number;
  extra_discount_share_paisa: number;
  line_net_paisa: number;
  line_cost_paisa: number;
  profit_paisa: number;
}

export interface SaleResult {
  lines: SaleLineResult[];
  gross_paisa: number;
  line_discount_paisa: number;
  extra_discount_paisa: number;
  /** Σ line net (tax excluded). */
  net_paisa: number;
  cost_paisa: number;
  profit_paisa: number;
}

/** Every amount on a sale, from its lines and extra discount. Totals match the lines to the paisa. */
export function computeSale(lines: readonly SaleLineInputs[], extraDiscountPaisa: number): SaleResult {
  const base = lines.map((l) => ({ ...saleLineAmounts(l.qty, l.list_price_paisa, l.discount_bp), line_cost_paisa: l.qty * l.unit_cost_paisa }));
  const shares = spreadExtraDiscount(
    base.map((b) => b.line_amount_paisa),
    extraDiscountPaisa,
  );
  const out = base.map((b, i) => {
    const share = shares[i] ?? 0;
    const net = b.line_amount_paisa - share;
    return { ...b, extra_discount_share_paisa: share, line_net_paisa: net, profit_paisa: net - b.line_cost_paisa };
  });
  const sum = (k: keyof SaleLineResult) => out.reduce((a, l) => a + l[k], 0);
  return {
    lines: out,
    gross_paisa: sum('line_gross_paisa'),
    line_discount_paisa: sum('line_discount_paisa'),
    extra_discount_paisa: extraDiscountPaisa,
    net_paisa: sum('line_net_paisa'),
    cost_paisa: sum('line_cost_paisa'),
    profit_paisa: sum('profit_paisa'),
  };
}

/** Profit as basis points of the gross (price) amount: Rs 20 on Rs 1,000 → 200 (2%). */
export function profitBp(profitPaisa: number, grossPaisa: number): number {
  return grossPaisa === 0 ? 0 : roundDiv(profitPaisa * 10_000, grossPaisa);
}
