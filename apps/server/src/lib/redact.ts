import { can } from '@shopledger/shared';
import type { SessionUser } from './permissions';

/**
 * Strips financial fields from API responses for users without
 * `finance.view` (CLAUDE.md section 6 and 17). Fields are recognised by name
 * at any depth, so new tables are covered as long as they follow the naming
 * conventions (`*_cost_paisa`, `supplier_margin_*`, `*profit*`, ...).
 */

export type RedactionRule = 'supplier_margin' | 'cost' | 'profit' | 'valuation' | 'expenses' | 'assets';

const RULES: Record<RedactionRule, (key: string) => boolean> = {
  supplier_margin: (k) => k.includes('supplier_margin') || k === 'margin_paisa' || k.endsWith('_margin_paisa'),
  cost: (k) => k === 'cost_paisa' || k.endsWith('_cost_paisa') || k === 'cost_source' || k === 'unit_cost',
  profit: (k) => k.includes('profit'),
  valuation: (k) => k.includes('valuation') || k === 'stock_value_paisa',
  expenses: (k) => k === 'expenses' || k.startsWith('expense_') || k.endsWith('_expenses_paisa'),
  assets: (k) =>
    k === 'assets' ||
    k.startsWith('asset_') ||
    k.includes('depreciation') ||
    k === 'book_value_paisa' ||
    k.startsWith('disposal_'),
};

const ALL_RULES = Object.keys(RULES) as RedactionRule[];

export interface RedactOptions {
  /**
   * Rules to skip. Only for the purchase entry screen, which shows supplier
   * margin and cost to anyone allowed to record purchases.
   */
  allow?: RedactionRule[];
}

/** Whether a field name is financial (and would be removed for this user). */
export function isFinancialField(key: string, allow: RedactionRule[] = []): boolean {
  return ALL_RULES.some((r) => !allow.includes(r) && RULES[r](key));
}

export function redact<T>(data: T, user: Pick<SessionUser, 'role' | 'permissions'> | null, opts: RedactOptions = {}): T {
  if (user && can(user, 'finance.view')) return data;
  return strip(data, opts.allow ?? []) as T;
}

function strip(value: unknown, allow: RedactionRule[]): unknown {
  if (Array.isArray(value)) return value.map((v) => strip(v, allow));
  if (value !== null && typeof value === 'object' && !(value instanceof Date)) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      if (!isFinancialField(k, allow)) out[k] = strip(v, allow);
    }
    return out;
  }
  return value;
}
