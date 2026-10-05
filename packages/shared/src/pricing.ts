import { applyBp } from './money';

/**
 * Sale line arithmetic shared by the server and the New Sale screen
 * (CLAUDE.md 8.10). Every percentage is taken off the one product price and
 * applied to the line total, not per unit, rounded half-up to the paisa.
 */

export interface SaleLineAmounts {
  /** qty × price */
  line_gross_paisa: number;
  /** round(gross × discount_bp ÷ 10000) */
  line_discount_paisa: number;
  /** gross − discount: what the line shows as "Amount" */
  line_amount_paisa: number;
}

export function saleLineAmounts(qty: number, listPricePaisa: number, discountBp: number): SaleLineAmounts {
  if (!Number.isInteger(qty) || qty <= 0) throw new Error('Quantity must be a positive whole number');
  if (!Number.isInteger(discountBp) || discountBp < 0 || discountBp > 10_000) throw new Error('Discount must be between 0% and 100%');
  const gross = qty * listPricePaisa;
  const discount = applyBp(gross, discountBp);
  return { line_gross_paisa: gross, line_discount_paisa: discount, line_amount_paisa: gross - discount };
}

/**
 * The suggested customer discount for a line, in this order:
 *   1. the product's default customer discount
 *   2. settings.default_customer_discount_bp
 * Retail customers then get `retailReductionBp` less (never below 0).
 */
export function defaultDiscountBp(opts: {
  productDiscountBp: number | null | undefined;
  settingsDiscountBp: number;
  customerType: 'wholesaler' | 'retailer';
  retailReductionBp: number;
}): number {
  const base = opts.productDiscountBp ?? opts.settingsDiscountBp;
  return opts.customerType === 'retailer' ? Math.max(0, base - opts.retailReductionBp) : base;
}

/** A business date plus a number of days, e.g. the due date = sale date + payment terms. */
export function addDaysToDate(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
