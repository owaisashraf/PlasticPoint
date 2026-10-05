import { applyBp, roundDiv } from './money';

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
