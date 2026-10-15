import { and, eq, gte, lte, sql } from 'drizzle-orm';
import type { DbOrTx } from '../db/client';
import { assets, expense_categories, expenses, sale_items, sales, sales_return_items, sales_returns, write_off_reversals, write_offs } from '../db/schema';
import { getSetting } from '../modules/settings/service';
import { businessToday } from './dates';
import { depreciationSchedule, disposalGainLoss } from './depreciation';

/**
 * Profit for a period (CLAUDE.md 8.11), worked out month by month from the
 * documents — never stored.
 *
 *   net sales     = Σ line net of posted sales − Σ credit of posted returns
 *   cost of sales = Σ line cost of posted sales − Σ cost of returned goods
 *   gross profit  = net sales − cost of sales
 *                 (= Σ line profit − Σ profit reversed by returns)
 *   net profit    = gross profit − expenses − depreciation (if switched on)
 *                   − (write-offs − write-off reversals) ± asset gains/losses
 *
 * Sales count on their invoice date, returns on the return date, expenses on
 * their date, depreciation on the last day of each month, write-offs and
 * reversals on their dates, and disposals on the disposal date.
 */

export interface Figures {
  sales_net_paisa: number;
  sales_cost_paisa: number;
  returns_net_paisa: number;
  returns_cost_paisa: number;
  net_sales_paisa: number;
  cost_of_sales_paisa: number;
  gross_profit_paisa: number;
  expenses_paisa: number;
  /** category name → amount */
  expenses_by_category: Record<string, number>;
  depreciation_paisa: number;
  /** Whether depreciation counts in net profit (settings.include_depreciation_in_profit). */
  depreciation_included: boolean;
  write_offs_paisa: number;
  write_off_reversals_paisa: number;
  net_bad_debt_paisa: number;
  asset_gain_paisa: number;
  net_profit_paisa: number;
}

function empty(depreciationIncluded: boolean): Figures {
  return {
    sales_net_paisa: 0,
    sales_cost_paisa: 0,
    returns_net_paisa: 0,
    returns_cost_paisa: 0,
    net_sales_paisa: 0,
    cost_of_sales_paisa: 0,
    gross_profit_paisa: 0,
    expenses_paisa: 0,
    expenses_by_category: {},
    depreciation_paisa: 0,
    depreciation_included: depreciationIncluded,
    write_offs_paisa: 0,
    write_off_reversals_paisa: 0,
    net_bad_debt_paisa: 0,
    asset_gain_paisa: 0,
    net_profit_paisa: 0,
  };
}

function finish(f: Figures): Figures {
  f.net_sales_paisa = f.sales_net_paisa - f.returns_net_paisa;
  f.cost_of_sales_paisa = f.sales_cost_paisa - f.returns_cost_paisa;
  f.gross_profit_paisa = f.net_sales_paisa - f.cost_of_sales_paisa;
  f.net_bad_debt_paisa = f.write_offs_paisa - f.write_off_reversals_paisa;
  f.net_profit_paisa = f.gross_profit_paisa - f.expenses_paisa - (f.depreciation_included ? f.depreciation_paisa : 0) - f.net_bad_debt_paisa + f.asset_gain_paisa;
  return f;
}

const month = (col: unknown) => sql<string>`substr(${col}, 1, 7)`;

/** Figures for each 'YYYY-MM' month between `from` and `to` (both included). */
export function figuresByMonth(db: DbOrTx, from: string, to: string): Map<string, Figures> {
  const included = getSetting(db, 'include_depreciation_in_profit');
  const out = new Map<string, Figures>();
  const get = (m: string) => {
    let f = out.get(m);
    if (!f) {
      f = empty(included);
      out.set(m, f);
    }
    return f;
  };

  for (const r of db
    .select({ m: month(sales.date), net: sql<number>`sum(${sale_items.line_net_paisa})`, cost: sql<number>`sum(${sale_items.line_cost_paisa})` })
    .from(sale_items)
    .innerJoin(sales, eq(sales.id, sale_items.sale_id))
    .where(and(eq(sales.status, 'posted'), gte(sales.date, from), lte(sales.date, to)))
    .groupBy(month(sales.date))
    .all()) {
    const f = get(r.m);
    f.sales_net_paisa += r.net;
    f.sales_cost_paisa += r.cost;
  }

  for (const r of db
    .select({ m: month(sales_returns.date), net: sql<number>`sum(${sales_return_items.line_net_paisa})`, cost: sql<number>`sum(${sales_return_items.line_cost_paisa})` })
    .from(sales_return_items)
    .innerJoin(sales_returns, eq(sales_returns.id, sales_return_items.return_id))
    .where(and(eq(sales_returns.status, 'posted'), gte(sales_returns.date, from), lte(sales_returns.date, to)))
    .groupBy(month(sales_returns.date))
    .all()) {
    const f = get(r.m);
    f.returns_net_paisa += r.net;
    f.returns_cost_paisa += r.cost;
  }

  for (const r of db
    .select({ m: month(expenses.date), name: expense_categories.name, amount: sql<number>`sum(${expenses.amount_paisa})` })
    .from(expenses)
    .innerJoin(expense_categories, eq(expense_categories.id, expenses.category_id))
    .where(and(eq(expenses.status, 'posted'), gte(expenses.date, from), lte(expenses.date, to)))
    .groupBy(month(expenses.date), expenses.category_id)
    .all()) {
    const f = get(r.m);
    f.expenses_paisa += r.amount;
    f.expenses_by_category[r.name] = (f.expenses_by_category[r.name] ?? 0) + r.amount;
  }

  for (const r of db
    .select({ m: month(write_offs.date), amount: sql<number>`sum(${write_offs.amount_paisa})` })
    .from(write_offs)
    .where(and(eq(write_offs.status, 'posted'), gte(write_offs.date, from), lte(write_offs.date, to)))
    .groupBy(month(write_offs.date))
    .all()) {
    get(r.m).write_offs_paisa += r.amount;
  }

  for (const r of db
    .select({ m: month(write_off_reversals.date), amount: sql<number>`sum(${write_off_reversals.amount_paisa})` })
    .from(write_off_reversals)
    .innerJoin(write_offs, eq(write_offs.id, write_off_reversals.write_off_id))
    .where(and(eq(write_offs.status, 'posted'), gte(write_off_reversals.date, from), lte(write_off_reversals.date, to)))
    .groupBy(month(write_off_reversals.date))
    .all()) {
    get(r.m).write_off_reversals_paisa += r.amount;
  }

  // Depreciation and disposals are worked out per asset (few rows). A month's
  // charge counts on its last day, so a month that has not ended has none yet.
  const today = businessToday();
  const until = to < today ? to : today;
  for (const a of db.select().from(assets).where(sql`${assets.status} <> 'void'`).all()) {
    for (const row of depreciationSchedule(a)) {
      if (row.charge_date >= from && row.charge_date <= until) get(row.month).depreciation_paisa += row.charge_paisa;
    }
    if (a.status === 'disposed' && a.disposal_date && a.disposal_date >= from && a.disposal_date <= to) {
      get(a.disposal_date.slice(0, 7)).asset_gain_paisa += disposalGainLoss(a) ?? 0;
    }
  }

  for (const f of out.values()) finish(f);
  return out;
}

/** Adds up figures (e.g. the months of a year). */
export function sumFigures(list: Iterable<Figures>, depreciationIncluded: boolean): Figures {
  const t = empty(depreciationIncluded);
  for (const f of list) {
    t.sales_net_paisa += f.sales_net_paisa;
    t.sales_cost_paisa += f.sales_cost_paisa;
    t.returns_net_paisa += f.returns_net_paisa;
    t.returns_cost_paisa += f.returns_cost_paisa;
    t.expenses_paisa += f.expenses_paisa;
    for (const [k, v] of Object.entries(f.expenses_by_category)) t.expenses_by_category[k] = (t.expenses_by_category[k] ?? 0) + v;
    t.depreciation_paisa += f.depreciation_paisa;
    t.write_offs_paisa += f.write_offs_paisa;
    t.write_off_reversals_paisa += f.write_off_reversals_paisa;
    t.asset_gain_paisa += f.asset_gain_paisa;
  }
  return finish(t);
}

/** Figures for one period (both dates included). */
export function periodFigures(db: DbOrTx, from: string, to: string): Figures {
  return sumFigures(figuresByMonth(db, from, to).values(), getSetting(db, 'include_depreciation_in_profit'));
}
