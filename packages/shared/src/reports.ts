import { z } from 'zod';
import { businessDateSchema } from './common';
import { CUSTOMER_TYPES } from './customers';
import type { KnownPermission } from './permissions';

/**
 * Reports (CLAUDE.md 11). Every report returns the same table shape, so the
 * screen, the PDF and the CSV are drawn by one generic piece each.
 */

// --- Fiscal year (settings.fiscal_year_start_month, default 7 = July–June) ------------------

export interface FiscalYear {
  /** e.g. '2026-27', or '2026' for a calendar year. */
  label: string;
  start: string;
  end: string;
  /** 'YYYY-MM' for each of the 12 months, in order. */
  months: string[];
}

function lastDay(year: number, month1to12: number): string {
  return new Date(Date.UTC(year, month1to12, 0)).toISOString().slice(0, 10);
}

/** The fiscal year that starts in `startYear` (calendar year when startMonth is 1). */
export function fiscalYear(startYear: number, startMonth: number): FiscalYear {
  const months: string[] = [];
  for (let i = 0; i < 12; i++) {
    const m = ((startMonth - 1 + i) % 12) + 1;
    const y = startYear + Math.floor((startMonth - 1 + i) / 12);
    months.push(`${y}-${String(m).padStart(2, '0')}`);
  }
  const endYear = startMonth === 1 ? startYear : startYear + 1;
  const endMonth = startMonth === 1 ? 12 : startMonth - 1;
  return {
    label: startMonth === 1 ? String(startYear) : `${startYear}-${String(endYear).slice(2)}`,
    start: `${startYear}-${String(startMonth).padStart(2, '0')}-01`,
    end: lastDay(endYear, endMonth),
    months,
  };
}

/** The start year of the fiscal year a date falls in. */
export function fiscalYearStartOf(date: string, startMonth: number): number {
  const y = Number(date.slice(0, 4));
  const m = Number(date.slice(5, 7));
  return m >= startMonth ? y : y - 1;
}

/** First and last day of a 'YYYY-MM' month. */
export function monthRange(month: string): { from: string; to: string } {
  const y = Number(month.slice(0, 4));
  const m = Number(month.slice(5, 7));
  return { from: `${month}-01`, to: lastDay(y, m) };
}

// --- The catalogue ----------------------------------------------------------------------

export const REPORT_PARAMS = ['period', 'as_of', 'party', 'type', 'city', 'customer', 'group_by', 'category', 'expense_category', 'method', 'inactive_days', 'show', 'fiscal_year', 'compare'] as const;
export type ReportParam = (typeof REPORT_PARAMS)[number];

export interface ReportDef {
  key: string;
  title: string;
  group: 'customer' | 'operational' | 'financial';
  permission: KnownPermission;
  description: string;
  params: ReportParam[];
  /** Choices for group_by, first is the default. */
  groupBy?: { value: string; label: string }[];
  /** Choices for show, first is the default. */
  show?: { value: string; label: string }[];
  /** Print landscape (wide tables). */
  landscape?: boolean;
}

export const REPORTS: ReportDef[] = [
  // 11.1 Customer reports (profit columns only for finance.view)
  {
    key: 'balances',
    title: 'Balances on a date',
    group: 'customer',
    permission: 'reports.operational',
    description: 'Every customer’s and supplier’s balance on any date you pick.',
    params: ['as_of', 'party', 'type', 'city', 'show', 'group_by'],
    show: [
      { value: 'owing', label: 'Hide zero balances' },
      { value: 'all', label: 'Show zero balances' },
    ],
    groupBy: [
      { value: 'name', label: 'Name' },
      { value: 'balance', label: 'Balance, largest first' },
    ],
    landscape: true,
  },
  { key: 'customer-summary', title: 'Customer summary', group: 'customer', permission: 'reports.operational', description: 'Sales, returns, receipts, write-offs, balance and average discount per customer.', params: ['period', 'type', 'city'], landscape: true },
  { key: 'customer-aging', title: 'Customer aging', group: 'customer', permission: 'reports.operational', description: 'What each customer owes, by how long it is past due.', params: ['type', 'city'], landscape: true },
  { key: 'payment-behaviour', title: 'Payment behaviour', group: 'customer', permission: 'reports.operational', description: 'Average days to pay, invoices paid on time and the longest delay.', params: ['period', 'type', 'city'] },
  { key: 'items-bought', title: 'Items bought by customer', group: 'customer', permission: 'reports.operational', description: 'Quantity and value by product, color and size.', params: ['period', 'customer', 'type', 'city'], landscape: true },
  {
    key: 'customer-activity',
    title: 'Customer activity',
    group: 'customer',
    permission: 'reports.operational',
    description: 'Last sale and payment; inactive customers; new customers in the period.',
    params: ['period', 'inactive_days', 'show'],
    show: [
      { value: 'all', label: 'All customers' },
      { value: 'inactive', label: 'Inactive (no purchase in N days)' },
      { value: 'new', label: 'New in the period' },
    ],
  },
  // 11.2 Operational reports
  { key: 'day-book', title: 'Daily sales and purchases book', group: 'operational', permission: 'reports.operational', description: 'Every sale, purchase and return, day by day.', params: ['period'] },
  { key: 'money-book', title: 'Receipts and supplier payments', group: 'operational', permission: 'reports.operational', description: 'Money received from customers, paid to the supplier and refunded.', params: ['period', 'method'] },
  {
    key: 'sales-by-item',
    title: 'Sales quantity by item',
    group: 'operational',
    permission: 'reports.operational',
    description: 'Quantity sold, returned and net, by item, color and size.',
    params: ['period', 'category', 'group_by'],
    groupBy: [
      { value: 'variant', label: 'Item, color and size' },
      { value: 'item', label: 'Item' },
    ],
  },
  {
    key: 'stock-on-hand',
    title: 'Stock on hand',
    group: 'operational',
    permission: 'reports.operational',
    description: 'Quantities in stock (no values) and the low stock list.',
    params: ['category', 'show'],
    show: [
      { value: 'all', label: 'All items' },
      { value: 'low', label: 'Low stock only' },
    ],
  },
  { key: 'price-list', title: 'Price list', group: 'operational', permission: 'reports.operational', description: 'Prices with the usual customer discount, to give to customers.', params: ['category'] },
  // 11.3 Financial and profit reports (finance.view)
  { key: 'profit-loss', title: 'Profit & loss', group: 'financial', permission: 'reports.financial', description: 'The year month by month: sales, cost, gross profit, expenses, depreciation, bad debts and net profit.', params: ['fiscal_year', 'compare'], landscape: true },
  { key: 'net-profit', title: 'Net profit summary', group: 'financial', permission: 'reports.financial', description: '“How much did I actually make?” for any period, with the breakdown.', params: ['period'] },
  {
    key: 'gross-profit',
    title: 'Gross profit',
    group: 'financial',
    permission: 'reports.financial',
    description: 'By month, item, customer, customer type, city or operator.',
    params: ['period', 'group_by', 'customer'],
    groupBy: [
      { value: 'month', label: 'Month' },
      { value: 'item', label: 'Item' },
      { value: 'variant', label: 'Item, color and size' },
      { value: 'customer', label: 'Customer' },
      { value: 'customer_type', label: 'Customer type' },
      { value: 'city', label: 'City' },
      { value: 'operator', label: 'Operator (who made the sale)' },
    ],
  },
  {
    key: 'discount-report',
    title: 'Discounts given',
    group: 'financial',
    permission: 'reports.financial',
    description: 'Average discount compared with the usual one, and every changed discount.',
    params: ['period', 'group_by'],
    groupBy: [
      { value: 'item', label: 'Item' },
      { value: 'customer', label: 'Customer' },
      { value: 'operator', label: 'Operator' },
      { value: 'changed', label: 'List of changed discounts' },
    ],
  },
  { key: 'profit-check', title: 'Profit check', group: 'financial', permission: 'reports.financial', description: 'Sales below cost or minimum profit, lines with estimated cost, and products that lose money on every sale.', params: ['period'], landscape: true },
  {
    key: 'expense-report',
    title: 'Expenses',
    group: 'financial',
    permission: 'reports.financial',
    description: 'By category and month, with the full list.',
    params: ['period', 'expense_category', 'group_by'],
    groupBy: [
      { value: 'category', label: 'Category' },
      { value: 'month', label: 'Month' },
      { value: 'list', label: 'Full list' },
    ],
  },
  { key: 'asset-register', title: 'Asset register', group: 'financial', permission: 'reports.financial', description: 'Cost, depreciation and book value of every asset on a date.', params: ['as_of'], landscape: true },
  { key: 'depreciation-schedule', title: 'Depreciation schedule', group: 'financial', permission: 'reports.financial', description: 'Monthly depreciation of each asset for a fiscal year.', params: ['fiscal_year'], landscape: true },
  { key: 'cash-bank-book', title: 'Cash and bank book', group: 'financial', permission: 'reports.financial', description: 'Receipts, supplier payments, refunds, expenses, asset purchases and sales.', params: ['period', 'method'], landscape: true },
  { key: 'stock-valuation', title: 'Stock valuation', group: 'financial', permission: 'reports.financial', description: 'Stock on hand at average cost.', params: ['category'] },
];

export const REPORT_KEYS = REPORTS.map((r) => r.key);

// --- Query and result -----------------------------------------------------------------

const boolParam = z
  .enum(['true', 'false', '1', '0'])
  .optional()
  .transform((v) => v === 'true' || v === '1');

export const reportQuerySchema = z.object({
  from: businessDateSchema.optional(),
  to: businessDateSchema.optional(),
  as_of: businessDateSchema.optional(),
  /** Balances on a date: customers, suppliers or both. */
  party: z.enum(['all', 'customers', 'suppliers']).default('all'),
  type: z.enum(CUSTOMER_TYPES).optional(),
  city: z.string().trim().max(60).optional(),
  customer_id: z.coerce.number().int().positive().optional(),
  group_by: z.string().trim().max(30).optional(),
  category: z.string().trim().max(60).optional(),
  expense_category_id: z.coerce.number().int().positive().optional(),
  method: z.enum(['cash', 'bank', 'cheque', 'online']).optional(),
  inactive_days: z.coerce.number().int().min(1).max(3650).default(60),
  show: z.string().trim().max(30).optional(),
  /** Start year of the fiscal year (e.g. 2026 for 2026-27). */
  fiscal_year: z.coerce.number().int().min(2000).max(2100).optional(),
  /** Profit & loss: calendar year instead of fiscal year. */
  calendar: boolParam,
  compare: boolParam,
  format: z.enum(['json', 'csv', 'pdf']).default('json'),
});
export type ReportQuery = z.input<typeof reportQuerySchema>;

export const REPORT_KINDS = ['text', 'money', 'int', 'percent', 'date', 'days'] as const;
export type ReportKind = (typeof REPORT_KINDS)[number];

export interface ReportColumn {
  key: string;
  label: string;
  kind: ReportKind;
}

export type ReportCell = string | number | null;
export type ReportRow = Record<string, ReportCell> & {
  /** Optional link for the row on screen, e.g. '/customers/12'. */
  _link?: string | null;
  /** Shown bold (subtotals, headings in the profit & loss). */
  _strong?: number | null;
  /** This row's numbers are of another kind (e.g. a margin % row in a money table). */
  _kind?: string | null;
};

export interface ReportResult {
  key: string;
  title: string;
  /** e.g. "1 Jul 2026 – 30 Jun 2027 · Wholesalers" */
  subtitle: string;
  columns: ReportColumn[];
  rows: ReportRow[];
  totals: Record<string, ReportCell> | null;
  /** Key figures shown above the table. */
  summary: { label: string; value: ReportCell; kind: ReportKind }[];
  notes: string[];
}

// --- Dashboard (CLAUDE.md 11.3 #10 and the operator dashboard) ------------------------------

export const dashboardSchema = z.object({
  today: z.string(),
  sales_today_count: z.number().int(),
  sales_today_paisa: z.number().int(),
  receipts_today_paisa: z.number().int(),
  overdue_customers: z.number().int(),
  low_stock_count: z.number().int(),
  /** Owner+ only from here. */
  profit_today_paisa: z.number().int().optional(),
  profit_month_paisa: z.number().int().optional(),
  net_profit_fy_paisa: z.number().int().optional(),
  month_expenses_paisa: z.number().int().optional(),
  fiscal_year_label: z.string().optional(),
  profit_trend: z
    .array(z.object({ month: z.string(), gross_profit_paisa: z.number().int(), net_profit_paisa: z.number().int() }))
    .optional(),
});
export type Dashboard = z.infer<typeof dashboardSchema>;
