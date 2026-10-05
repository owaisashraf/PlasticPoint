import type { Settings } from '@shopledger/shared';
import { applyBp, roundDiv } from './money';

// Sale line arithmetic is shared with the New Sale screen.
export { addDaysToDate, defaultDiscountBp, saleLineAmounts, type SaleLineAmounts } from '@shopledger/shared';

/**
 * Price, supplier margin and customer discount (CLAUDE.md 8.10). Every
 * percentage is taken off the one product price, on line totals (not per
 * unit), rounded half-up to the paisa.
 */

export interface PurchaseLineAmounts {
  line_gross_paisa: number;
  line_margin_paisa: number;
  line_cost_paisa: number;
  unit_cost_paisa: number;
}

/**
 * Cost of a purchase line: gross − supplier margin.
 * 10 × Rs 1,000 at 12% → gross 10,000, margin 1,200, cost 8,800 (880 each).
 */
export function purchaseLineAmounts(qty: number, listPricePaisa: number, supplierMarginBp: number): PurchaseLineAmounts {
  if (!Number.isInteger(qty) || qty <= 0) throw new Error('Quantity must be a positive whole number');
  const gross = qty * listPricePaisa;
  const margin = applyBp(gross, supplierMarginBp);
  const cost = gross - margin;
  return { line_gross_paisa: gross, line_margin_paisa: margin, line_cost_paisa: cost, unit_cost_paisa: roundDiv(cost, qty) };
}

/** Estimated unit cost when nothing has been bought yet: price × (1 − supplier margin). */
export function estimatedUnitCost(listPricePaisa: number, supplierMarginBp: number): number {
  return listPricePaisa - applyBp(listPricePaisa, supplierMarginBp);
}

// --- Sale safety rules -------------------------------------------------------------

export type PricingRule = 'discount_above_max' | 'below_cost' | 'below_min_profit';

export interface PricingRuleHit {
  rule: PricingRule;
  /** 'approval' needs an owner or the superuser; 'warning' does not block. */
  severity: 'approval' | 'warning';
}

export interface LineForRules {
  discount_bp: number;
  max_customer_discount_bp: number | null;
  line_gross_paisa: number;
  line_net_paisa: number;
  line_cost_paisa: number;
}

/**
 * The safety rules for one sale line (CLAUDE.md 8.10):
 *  - a discount above the product's maximum needs owner approval;
 *  - selling below cost always needs owner approval;
 *  - profit as a % of price below `min_profit_bp` warns, or needs approval
 *    when `below_min_profit_action` is 'require_owner'.
 * Below cost is reported instead of below minimum profit, not as well.
 */
export function pricingRuleHits(line: LineForRules, settings: Pick<Settings, 'min_profit_bp' | 'below_min_profit_action'>): PricingRuleHit[] {
  const hits: PricingRuleHit[] = [];
  if (line.max_customer_discount_bp !== null && line.discount_bp > line.max_customer_discount_bp) {
    hits.push({ rule: 'discount_above_max', severity: 'approval' });
  }
  const profit = line.line_net_paisa - line.line_cost_paisa;
  if (profit < 0) {
    hits.push({ rule: 'below_cost', severity: 'approval' });
  } else if (profit * 10_000 < settings.min_profit_bp * line.line_gross_paisa) {
    hits.push({ rule: 'below_min_profit', severity: settings.below_min_profit_action === 'require_owner' ? 'approval' : 'warning' });
  }
  return hits;
}
