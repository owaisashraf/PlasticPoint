import { sql } from 'drizzle-orm';
import { can, fiscalYear, fiscalYearStartOf, type Dashboard } from '@shopledger/shared';
import type { DB } from '../../db/client';
import { businessToday } from '../../lib/dates';
import { figuresByMonth, periodFigures, sumFigures } from '../../lib/profit-loss';
import type { SessionUser } from '../../lib/permissions';
import { redact } from '../../lib/redact';
import { overdueCount } from '../overdue/service';
import { getSettings } from '../settings/service';
import { lowStock } from '../stock/service';

/** The 12 months up to and including `month` ('YYYY-MM'), oldest first. */
function lastTwelveMonths(month: string): string[] {
  const out: string[] = [];
  let y = Number(month.slice(0, 4));
  let m = Number(month.slice(5, 7));
  for (let i = 0; i < 12; i++) {
    out.unshift(`${y}-${String(m).padStart(2, '0')}`);
    m--;
    if (m === 0) {
      m = 12;
      y--;
    }
  }
  return out;
}

/**
 * Dashboard figures (CLAUDE.md 11.3 #10). Everyone: today's sales and
 * receipts, overdue customers and low stock. Owner+: profit today and this
 * month, net profit for the fiscal year so far, this month's expenses and a
 * 12-month profit trend.
 */
export function dashboard(db: DB, user: SessionUser): Dashboard {
  const today = businessToday();
  const sales = db.get<{ n: number; v: number }>(sql`SELECT count(*) AS n, coalesce(sum(total_paisa), 0) AS v FROM sales WHERE status = 'posted' AND date = ${today}`);
  const receipts = db.get<{ v: number }>(sql`SELECT coalesce(sum(amount_paisa), 0) AS v FROM payments WHERE kind = 'receipt' AND status = 'posted' AND date = ${today}`);
  const base: Dashboard = {
    today,
    sales_today_count: sales?.n ?? 0,
    sales_today_paisa: sales?.v ?? 0,
    receipts_today_paisa: receipts?.v ?? 0,
    overdue_customers: overdueCount(db),
    low_stock_count: lowStock(db).length,
  };
  if (!can(user, 'finance.view')) return redact(base, user);

  const settings = getSettings(db);
  const startMonth = settings.fiscal_year_start_month;
  const fy = fiscalYear(fiscalYearStartOf(today, startMonth), startMonth);
  const month = today.slice(0, 7);
  const months = lastTwelveMonths(month);
  const byMonth = figuresByMonth(db, `${months[0]}-01`, today);
  const thisMonth = byMonth.get(month) ?? sumFigures([], settings.include_depreciation_in_profit);
  return {
    ...base,
    profit_today_paisa: periodFigures(db, today, today).gross_profit_paisa,
    profit_month_paisa: thisMonth.gross_profit_paisa,
    net_profit_fy_paisa: periodFigures(db, fy.start, today).net_profit_paisa,
    month_expenses_paisa: thisMonth.expenses_paisa,
    fiscal_year_label: fy.label,
    profit_trend: months.map((m) => {
      const f = byMonth.get(m);
      return { month: m, gross_profit_paisa: f?.gross_profit_paisa ?? 0, net_profit_paisa: f?.net_profit_paisa ?? 0 };
    }),
  };
}
