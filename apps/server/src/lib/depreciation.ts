import { spreadLargestRemainder } from './money';

/**
 * Straight-line depreciation (CLAUDE.md 8.13). Always worked out, never
 * stored.
 *
 *   monthly charge = (cost − salvage) ÷ useful life in months
 *
 * - The first charge is for the month after the purchase month.
 * - Each month's charge counts on the last day of that month. So an asset
 *   disposed of part-way through a month gets no charge for that month.
 * - Charges stop once the asset is fully depreciated, or after the last full
 *   month before its disposal.
 * - The remainder of the division is spread over the first months
 *   (largest remainder), so the charges add up exactly to cost − salvage.
 */

export interface DepreciableAsset {
  purchase_date: string;
  cost_paisa: number;
  salvage_value_paisa: number;
  depreciation_method: 'none' | 'straight_line';
  useful_life_months: number | null;
  disposal_date: string | null;
}

export interface ScheduleRow {
  /** 'YYYY-MM' */
  month: string;
  /** The day the charge counts: the last day of the month. */
  charge_date: string;
  charge_paisa: number;
  accumulated_paisa: number;
  book_value_paisa: number;
}

/** Last day of a month, 'YYYY-MM-DD'. */
export function monthEnd(year: number, month1to12: number): string {
  const d = new Date(Date.UTC(year, month1to12, 0));
  return d.toISOString().slice(0, 10);
}

/** The month after `date`'s month, then the one after, … */
function* monthsAfter(date: string): Generator<{ year: number; month: number }> {
  let year = Number(date.slice(0, 4));
  let month = Number(date.slice(5, 7));
  for (;;) {
    month++;
    if (month > 12) {
      month = 1;
      year++;
    }
    yield { year, month };
  }
}

/** Every monthly charge of the asset, until fully depreciated or disposed of. */
export function depreciationSchedule(a: DepreciableAsset): ScheduleRow[] {
  if (a.depreciation_method !== 'straight_line' || !a.useful_life_months || a.useful_life_months <= 0) return [];
  const depreciable = a.cost_paisa - a.salvage_value_paisa;
  if (depreciable <= 0) return [];
  const charges = spreadLargestRemainder(depreciable, Array<number>(a.useful_life_months).fill(1));
  const rows: ScheduleRow[] = [];
  let accumulated = 0;
  const months = monthsAfter(a.purchase_date);
  for (const charge of charges) {
    const { year, month } = months.next().value as { year: number; month: number };
    const chargeDate = monthEnd(year, month);
    if (a.disposal_date && chargeDate > a.disposal_date) break;
    accumulated += charge;
    rows.push({
      month: `${year}-${String(month).padStart(2, '0')}`,
      charge_date: chargeDate,
      charge_paisa: charge,
      accumulated_paisa: accumulated,
      book_value_paisa: a.cost_paisa - accumulated,
    });
  }
  return rows;
}

/** Depreciation charged up to and including `date`. */
export function accumulatedDepreciation(a: DepreciableAsset, date: string): number {
  if (date < a.purchase_date) return 0;
  return depreciationSchedule(a)
    .filter((r) => r.charge_date <= date)
    .reduce((sum, r) => sum + r.charge_paisa, 0);
}

/** Book value on a date: cost − accumulated depreciation up to that date. */
export function bookValue(a: DepreciableAsset, date: string): number {
  return a.cost_paisa - accumulatedDepreciation(a, date);
}

/** Depreciation charged in a period (both dates included), e.g. for the profit & loss. */
export function depreciationInPeriod(a: DepreciableAsset, from: string, to: string): number {
  return depreciationSchedule(a)
    .filter((r) => r.charge_date >= from && r.charge_date <= to)
    .reduce((sum, r) => sum + r.charge_paisa, 0);
}

/** Gain (positive) or loss (negative) on disposal: amount received − book value on the disposal date. */
export function disposalGainLoss(a: DepreciableAsset & { disposal_amount_paisa: number | null }): number | null {
  if (!a.disposal_date || a.disposal_amount_paisa === null) return null;
  return a.disposal_amount_paisa - bookValue(a, a.disposal_date);
}
