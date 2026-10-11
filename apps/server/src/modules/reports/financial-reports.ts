import { sql, type SQL } from 'drizzle-orm';
import { bpToPercentString, fiscalYear, fiscalYearStartOf, monthRange, type ReportColumn, type ReportRow } from '@shopledger/shared';
import { depreciationSchedule } from '../../lib/depreciation';
import { roundDiv } from '../../lib/money';
import { figuresByMonth, periodFigures, sumFigures, type Figures } from '../../lib/profit-loss';
import { listAssets } from '../assets/service';
import { stockValuation } from '../stock/service';
import { col, filterText, period, periodText, subtitle, total, type ReportBuilder, type ReportCtx } from './engine';

/** Financial and profit reports (CLAUDE.md 11.3): owner and superuser only (reports.financial). */

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const monthLabel = (m: string) => `${MONTHS[Number(m.slice(5, 7)) - 1]} ${m.slice(2, 4)}`;
const pct = (part: number, whole: number) => (whole ? roundDiv(part * 10_000, whole) : null);

/** The fiscal year asked for (or the current one); calendar year with ?calendar=1. */
function yearOf(ctx: ReportCtx) {
  const startMonth = ctx.q.calendar ? 1 : ctx.settings.fiscal_year_start_month;
  return fiscalYear(ctx.q.fiscal_year ?? fiscalYearStartOf(ctx.today, startMonth), startMonth);
}

// --- Profit & loss -------------------------------------------------------------------------

/**
 * The year month by month (CLAUDE.md 11.3 #1): net sales, cost of sales,
 * gross profit, expenses by category, depreciation, net bad debts, asset
 * gain/loss, net profit and net margin. Optionally the previous year's total.
 */
export const profitLoss: ReportBuilder = (ctx) => {
  const fy = yearOf(ctx);
  const byMonth = figuresByMonth(ctx.db, fy.start, fy.end);
  const included = ctx.settings.include_depreciation_in_profit;
  const months = fy.months.map((m) => byMonth.get(m) ?? sumFigures([], included));
  const yearTotal = sumFigures(months, included);
  const prevFy = ctx.q.compare ? fiscalYear(Number(fy.start.slice(0, 4)) - 1, Number(fy.start.slice(5, 7))) : null;
  const prev = prevFy ? sumFigures(figuresByMonth(ctx.db, prevFy.start, prevFy.end).values(), included) : null;
  const categories = [...new Set([...months, ...(prev ? [prev] : [])].flatMap((f) => Object.keys(f.expenses_by_category)))].sort();

  type Line = { label: string; value: (f: Figures) => number | null; strong?: boolean; kind?: string };
  const lines: Line[] = [
    { label: 'Net sales', value: (f) => f.net_sales_paisa },
    { label: 'Cost of sales', value: (f) => -f.cost_of_sales_paisa },
    { label: 'Gross profit', value: (f) => f.gross_profit_paisa, strong: true },
    ...categories.map((c) => ({ label: `   ${c}`, value: (f: Figures) => -(f.expenses_by_category[c] ?? 0) })),
    { label: 'Total expenses', value: (f) => -f.expenses_paisa, strong: true },
    { label: included ? 'Depreciation' : 'Depreciation (not counted)', value: (f) => -f.depreciation_paisa },
    { label: 'Net bad debts', value: (f) => -f.net_bad_debt_paisa },
    { label: 'Gain / loss on assets sold', value: (f) => f.asset_gain_paisa },
    { label: 'Net profit', value: (f) => f.net_profit_paisa, strong: true },
    { label: 'Net margin', value: (f) => pct(f.net_profit_paisa, f.net_sales_paisa), kind: 'percent' },
  ];
  const columns: ReportColumn[] = [
    col('line', ''),
    ...fy.months.map((m) => col(`m_${m}`, monthLabel(m), 'money')),
    col('total', `Total ${fy.label}`, 'money'),
    ...(prev && prevFy ? [col('prev', `Total ${prevFy.label}`, 'money')] : []),
  ];
  const rows: ReportRow[] = lines.map((l) => ({
    line: l.label,
    ...Object.fromEntries(fy.months.map((m, i) => [`m_${m}`, l.value(months[i] as Figures)])),
    total: l.value(yearTotal),
    ...(prev ? { prev: l.value(prev) } : {}),
    _strong: l.strong ? 1 : null,
    _kind: l.kind ?? null,
  }));
  return {
    subtitle: subtitle(`${ctx.q.calendar ? 'Calendar year' : 'Fiscal year'} ${fy.label}`, `${monthRange(fy.months[0] as string).from} – ${fy.end}`),
    columns,
    rows,
    totals: null,
    summary: [
      { label: 'Net sales', value: yearTotal.net_sales_paisa, kind: 'money' },
      { label: 'Gross profit', value: yearTotal.gross_profit_paisa, kind: 'money' },
      { label: 'Net profit', value: yearTotal.net_profit_paisa, kind: 'money' },
      ...(prev ? [{ label: `Net profit ${prevFy?.label}`, value: prev.net_profit_paisa, kind: 'money' as const }] : []),
    ],
    notes: included ? [] : ['Depreciation is shown but not taken off net profit (Settings).'],
  };
};

// --- Net profit summary ---------------------------------------------------------------------

export const netProfit: ReportBuilder = (ctx) => {
  const p = period(ctx, 'month');
  const f = periodFigures(ctx.db, p.from, p.to);
  const rows: ReportRow[] = [
    { line: 'Sales (after discounts)', amount: f.sales_net_paisa },
    { line: 'Less returns', amount: -f.returns_net_paisa },
    { line: 'Net sales', amount: f.net_sales_paisa, _strong: 1 },
    { line: 'Cost of goods sold', amount: -f.cost_of_sales_paisa },
    { line: 'Gross profit', amount: f.gross_profit_paisa, _strong: 1 },
    ...Object.entries(f.expenses_by_category)
      .sort((a, b) => b[1] - a[1])
      .map(([name, v]) => ({ line: `   ${name}`, amount: -v })),
    { line: 'Total expenses', amount: -f.expenses_paisa, _strong: 1 },
    { line: f.depreciation_included ? 'Depreciation' : 'Depreciation (not counted)', amount: -f.depreciation_paisa },
    { line: 'Written off (bad debts)', amount: -f.write_offs_paisa },
    { line: 'Recovered write-offs', amount: f.write_off_reversals_paisa },
    { line: 'Gain / loss on assets sold', amount: f.asset_gain_paisa },
    { line: 'Net profit', amount: f.net_profit_paisa, _strong: 1 },
    { line: 'Net margin', amount: pct(f.net_profit_paisa, f.net_sales_paisa), _kind: 'percent' },
  ];
  return {
    subtitle: periodText(p),
    columns: [col('line', ''), col('amount', 'Amount', 'money')],
    rows,
    totals: null,
    summary: [
      { label: 'You made', value: f.net_profit_paisa, kind: 'money' },
      { label: 'Gross profit', value: f.gross_profit_paisa, kind: 'money' },
      { label: 'Expenses', value: f.expenses_paisa, kind: 'money' },
    ],
    notes: [],
  };
};

// --- Gross profit by … -------------------------------------------------------------------------

/** Group key and label for sales and returns, by the original sale's attributes. */
function grossGroup(groupBy: string): { key: SQL; label: SQL; title: string } {
  switch (groupBy) {
    case 'item':
      return { key: sql`p.id`, label: sql`p.item_code || ' ' || p.name`, title: 'Item' };
    case 'variant':
      return { key: sql`v.id`, label: sql`p.item_code || ' ' || p.name || ' ' || v.color || ' ' || v.size`, title: 'Item, color and size' };
    case 'customer':
      return { key: sql`c.id`, label: sql`c.name`, title: 'Customer' };
    case 'customer_type':
      return { key: sql`c.type`, label: sql`CASE c.type WHEN 'retailer' THEN 'Retailers' ELSE 'Wholesalers' END`, title: 'Customer type' };
    case 'city':
      return { key: sql`coalesce(c.city, '')`, label: sql`coalesce(nullif(c.city, ''), '(no city)')`, title: 'City' };
    case 'operator':
      return { key: sql`s.created_by`, label: sql`coalesce((SELECT display_name FROM users WHERE id = s.created_by), '—')`, title: 'Operator' };
    default:
      return { key: sql`substr(d.date, 1, 7)`, label: sql`substr(d.date, 1, 7)`, title: 'Month' };
  }
}

export const grossProfit: ReportBuilder = (ctx) => {
  const p = period(ctx, 'fiscal_year');
  const g = grossGroup(ctx.q.group_by ?? 'month');
  const cust = ctx.q.customer_id ? sql`AND s.customer_id = ${ctx.q.customer_id}` : sql``;
  // Returns count in the period of the return, against the original sale's item, customer and operator.
  const rows = ctx.db.all<{ k: string; label: string; net: number; cost: number; profit: number }>(sql`
    SELECT k, max(label) AS label, sum(net) AS net, sum(cost) AS cost, sum(profit) AS profit FROM (
      SELECT ${g.key} AS k, ${g.label} AS label, i.line_net_paisa AS net, i.line_cost_paisa AS cost, i.profit_paisa AS profit
      FROM sale_items i JOIN sales s ON s.id = i.sale_id JOIN sales d ON d.id = s.id
      JOIN customers c ON c.id = s.customer_id JOIN product_variants v ON v.id = i.variant_id JOIN products p ON p.id = v.product_id
      WHERE s.status = 'posted' AND s.date BETWEEN ${p.from} AND ${p.to} ${cust}
      UNION ALL
      SELECT ${g.key}, ${g.label}, -ri.line_net_paisa, -ri.line_cost_paisa, -ri.profit_reversed_paisa
      FROM sales_return_items ri JOIN sales_returns d ON d.id = ri.return_id JOIN sales s ON s.id = d.sale_id
      JOIN customers c ON c.id = s.customer_id JOIN product_variants v ON v.id = ri.variant_id JOIN products p ON p.id = v.product_id
      WHERE d.status = 'posted' AND d.date BETWEEN ${p.from} AND ${p.to} ${cust}
    ) GROUP BY k ORDER BY ${ctx.q.group_by && ctx.q.group_by !== 'month' ? sql`sum(profit) DESC` : sql`k`}`);
  const list: ReportRow[] = rows.map((r) => ({ group: r.label, net_sales_paisa: r.net, cost_paisa: r.cost, gross_profit_paisa: r.profit, margin_bp: pct(r.profit, r.net) }));
  const t = { net_sales_paisa: total(list, 'net_sales_paisa'), cost_paisa: total(list, 'cost_paisa'), gross_profit_paisa: total(list, 'gross_profit_paisa') };
  return {
    subtitle: subtitle(periodText(p), `by ${g.title.toLowerCase()}`),
    columns: [col('group', g.title), col('net_sales_paisa', 'Net sales', 'money'), col('cost_paisa', 'Cost', 'money'), col('gross_profit_paisa', 'Gross profit', 'money'), col('margin_bp', 'Margin', 'percent')],
    rows: list,
    totals: { ...t, margin_bp: pct(t.gross_profit_paisa, t.net_sales_paisa) },
    summary: [
      { label: 'Gross profit', value: t.gross_profit_paisa, kind: 'money' },
      { label: 'Margin on net sales', value: pct(t.gross_profit_paisa, t.net_sales_paisa), kind: 'percent' },
    ],
    notes: ['Net sales and cost are after returns; returns count on the day they came back.'],
  };
};

// --- Discounts ------------------------------------------------------------------------------

export const discountReport: ReportBuilder = (ctx) => {
  const p = period(ctx, 'month');
  const by = ctx.q.group_by ?? 'item';
  if (by === 'changed') {
    const rows = ctx.db.all<{ sale_id: number; date: string; doc_no: string; customer: string; operator: string | null; item: string; qty: number; def: number; given: number; net: number; profit: number }>(sql`
      SELECT s.id AS sale_id, s.date, s.doc_no, c.name AS customer, u.display_name AS operator,
             p.item_code || ' ' || v.color || ' ' || v.size AS item, i.qty, i.default_discount_bp AS def, i.discount_bp AS given, i.line_net_paisa AS net, i.profit_paisa AS profit
      FROM sale_items i JOIN sales s ON s.id = i.sale_id JOIN customers c ON c.id = s.customer_id LEFT JOIN users u ON u.id = s.created_by
      JOIN product_variants v ON v.id = i.variant_id JOIN products p ON p.id = v.product_id
      WHERE s.status = 'posted' AND i.discount_overridden = 1 AND s.date BETWEEN ${p.from} AND ${p.to}
      ORDER BY s.date DESC, s.id DESC, i.line_no`);
    return {
      subtitle: subtitle(periodText(p), 'changed discounts'),
      columns: [col('date', 'Date', 'date'), col('doc_no', 'Invoice'), col('customer', 'Customer'), col('operator', 'Operator'), col('item', 'Item'), col('qty', 'Qty', 'int'), col('default_bp', 'Usual', 'percent'), col('given_bp', 'Given', 'percent'), col('line_net_paisa', 'Line net', 'money'), col('profit_paisa', 'Profit', 'money')],
      rows: rows.map((r) => ({ date: r.date, doc_no: r.doc_no, customer: r.customer, operator: r.operator, item: r.item.trim(), qty: r.qty, default_bp: r.def, given_bp: r.given, line_net_paisa: r.net, profit_paisa: r.profit, _link: `/sales/${r.sale_id}` })),
      totals: null,
      summary: [{ label: 'Changed lines', value: rows.length, kind: 'int' }],
      notes: [],
    };
  }
  const g =
    by === 'customer'
      ? { key: sql`c.id`, label: sql`c.name`, title: 'Customer' }
      : by === 'operator'
        ? { key: sql`s.created_by`, label: sql`coalesce(u.display_name, '—')`, title: 'Operator' }
        : { key: sql`p.id`, label: sql`p.item_code || ' ' || p.name`, title: 'Item' };
  const rows = ctx.db.all<{ label: string; lines: number; gross: number; disc: number; def_w: number; changed: number }>(sql`
    SELECT max(${g.label}) AS label, count(*) AS lines, sum(i.line_gross_paisa) AS gross, sum(i.line_discount_paisa) AS disc,
           sum(i.line_gross_paisa * i.default_discount_bp) AS def_w, sum(i.discount_overridden) AS changed
    FROM sale_items i JOIN sales s ON s.id = i.sale_id JOIN customers c ON c.id = s.customer_id LEFT JOIN users u ON u.id = s.created_by
    JOIN product_variants v ON v.id = i.variant_id JOIN products p ON p.id = v.product_id
    WHERE s.status = 'posted' AND s.date BETWEEN ${p.from} AND ${p.to}
    GROUP BY ${g.key} ORDER BY sum(i.line_discount_paisa) DESC`);
  const list: ReportRow[] = rows.map((r) => {
    const usual = r.gross ? roundDiv(r.def_w, r.gross) : null;
    const given = r.gross ? roundDiv(r.disc * 10_000, r.gross) : null;
    return { group: r.label, lines: r.lines, gross_paisa: r.gross, discount_paisa: r.disc, usual_bp: usual, given_bp: given, difference_bp: usual !== null && given !== null ? given - usual : null, changed: r.changed };
  });
  return {
    subtitle: subtitle(periodText(p), `by ${g.title.toLowerCase()}`),
    columns: [col('group', g.title), col('lines', 'Lines', 'int'), col('gross_paisa', 'Gross', 'money'), col('discount_paisa', 'Discount given', 'money'), col('usual_bp', 'Usual %', 'percent'), col('given_bp', 'Given %', 'percent'), col('difference_bp', 'Difference', 'percent'), col('changed', 'Changed lines', 'int')],
    rows: list,
    totals: { lines: total(list, 'lines'), gross_paisa: total(list, 'gross_paisa'), discount_paisa: total(list, 'discount_paisa'), changed: total(list, 'changed') },
    summary: [],
    notes: ['Percentages are weighted by the line amount (qty × price).'],
  };
};

// --- Profit check -------------------------------------------------------------------------------

export const profitCheck: ReportBuilder = (ctx) => {
  const p = period(ctx, 'month');
  const minBp = ctx.settings.min_profit_bp;
  const lines = ctx.db.all<{ sale_id: number; date: string; doc_no: string; customer: string; item: string; qty: number; net: number; cost: number; profit: number; gross: number; source: string }>(sql`
    SELECT s.id AS sale_id, s.date, s.doc_no, c.name AS customer, p.item_code || ' ' || v.color || ' ' || v.size AS item, i.qty,
           i.line_net_paisa AS net, i.line_cost_paisa AS cost, i.profit_paisa AS profit, i.line_gross_paisa AS gross, i.cost_source AS source
    FROM sale_items i JOIN sales s ON s.id = i.sale_id JOIN customers c ON c.id = s.customer_id
    JOIN product_variants v ON v.id = i.variant_id JOIN products p ON p.id = v.product_id
    WHERE s.status = 'posted' AND s.date BETWEEN ${p.from} AND ${p.to}
      AND (i.profit_paisa < 0 OR i.profit_paisa * 10000 < ${minBp} * i.line_gross_paisa OR i.cost_source = 'estimated')
    ORDER BY s.date DESC, s.id DESC`);
  const rows: ReportRow[] = [];
  for (const l of lines) {
    const base = { date: l.date, document: l.doc_no, customer: l.customer, item: l.item.trim(), qty: l.qty, line_net_paisa: l.net, line_cost_paisa: l.cost, profit_paisa: l.profit, _link: `/sales/${l.sale_id}` };
    if (l.profit < 0) rows.push({ problem: 'Sold below cost', ...base });
    else if (l.profit * 10_000 < minBp * l.gross) rows.push({ problem: 'Below minimum profit', ...base });
    if (l.source === 'estimated') rows.push({ problem: 'Estimated cost (nothing bought yet)', ...base });
  }
  // Products that lose money on every sale at their usual discount.
  for (const pr of ctx.db.all<{ id: number; item_code: string; name: string; margin: number; discount: number }>(sql`
    SELECT id, item_code, name, supplier_margin_bp AS margin, default_customer_discount_bp AS discount FROM products
    WHERE active = 1 AND supplier_margin_bp < default_customer_discount_bp ORDER BY item_code`)) {
    rows.push({ problem: `Supplier margin ${bpToPercentString(pr.margin)}% < usual discount ${bpToPercentString(pr.discount)}%`, date: null, document: null, customer: null, item: `${pr.item_code} ${pr.name}`, qty: null, line_net_paisa: null, line_cost_paisa: null, profit_paisa: null, _link: `/products/${pr.id}` });
  }
  return {
    subtitle: periodText(p),
    columns: [col('problem', 'Problem'), col('date', 'Date', 'date'), col('document', 'Invoice'), col('customer', 'Customer'), col('item', 'Item'), col('qty', 'Qty', 'int'), col('line_net_paisa', 'Line net', 'money'), col('line_cost_paisa', 'Cost', 'money'), col('profit_paisa', 'Profit', 'money')],
    rows,
    totals: null,
    summary: [
      { label: 'Below cost', value: rows.filter((r) => r.problem === 'Sold below cost').length, kind: 'int' },
      { label: 'Below minimum', value: rows.filter((r) => r.problem === 'Below minimum profit').length, kind: 'int' },
      { label: 'Estimated cost', value: rows.filter((r) => String(r.problem).startsWith('Estimated')).length, kind: 'int' },
    ],
    notes: [`Minimum profit is ${bpToPercentString(minBp)}% of price (Settings).`],
  };
};

// --- Expenses --------------------------------------------------------------------------------

export const expenseReport: ReportBuilder = (ctx) => {
  const p = period(ctx, 'fiscal_year');
  const by = ctx.q.group_by ?? 'category';
  const cat = ctx.q.expense_category_id ? sql`AND e.category_id = ${ctx.q.expense_category_id}` : sql``;
  const base = sql`FROM expenses e JOIN expense_categories c ON c.id = e.category_id WHERE e.status = 'posted' AND e.date BETWEEN ${p.from} AND ${p.to} ${cat}`;
  let columns: ReportColumn[];
  let rows: ReportRow[];
  if (by === 'list') {
    rows = ctx.db
      .all<{ date: string; doc_no: string; category: string; paid_to: string | null; method: string; reference: string | null; amount: number }>(sql`SELECT e.date, e.doc_no, c.name AS category, e.paid_to, e.method, e.reference, e.amount_paisa AS amount ${base} ORDER BY e.date, e.id`)
      .map((r) => ({ date: r.date, doc_no: r.doc_no, category: r.category, paid_to: r.paid_to, method: r.method === 'bank' ? 'Bank' : 'Cash', reference: r.reference, amount_paisa: r.amount }));
    columns = [col('date', 'Date', 'date'), col('doc_no', 'Number'), col('category', 'Category'), col('paid_to', 'Paid to'), col('method', 'By'), col('reference', 'Reference'), col('amount_paisa', 'Amount', 'money')];
  } else if (by === 'month') {
    rows = ctx.db.all<{ month: string; count: number; amount: number }>(sql`SELECT substr(e.date, 1, 7) AS month, count(*) AS count, sum(e.amount_paisa) AS amount ${base} GROUP BY 1 ORDER BY 1`).map((r) => ({ group: monthLabel(r.month), count: r.count, amount_paisa: r.amount }));
    columns = [col('group', 'Month'), col('count', 'Expenses', 'int'), col('amount_paisa', 'Amount', 'money')];
  } else {
    rows = ctx.db.all<{ name: string; count: number; amount: number }>(sql`SELECT c.name, count(*) AS count, sum(e.amount_paisa) AS amount ${base} GROUP BY c.id ORDER BY 3 DESC`).map((r) => ({ group: r.name, count: r.count, amount_paisa: r.amount }));
    columns = [col('group', 'Category'), col('count', 'Expenses', 'int'), col('amount_paisa', 'Amount', 'money')];
  }
  return {
    subtitle: subtitle(periodText(p), `by ${by === 'list' ? 'date' : by}`),
    columns,
    rows,
    totals: { amount_paisa: total(rows, 'amount_paisa'), ...(by === 'list' ? {} : { count: total(rows, 'count') }) },
    summary: [{ label: 'Total expenses', value: total(rows, 'amount_paisa'), kind: 'money' }],
    notes: [],
  };
};

// --- Assets ------------------------------------------------------------------------------------

export const assetRegister: ReportBuilder = (ctx) => {
  const asOf = ctx.q.as_of ?? ctx.today;
  const { assets, totals } = listAssets(ctx.db, { status: 'all', as_of: asOf });
  const rows: ReportRow[] = assets
    .filter((a) => a.status !== 'void')
    .map((a) => ({
      doc_no: a.doc_no,
      name: a.name,
      category: a.category,
      purchase_date: a.purchase_date,
      cost_paisa: a.cost_paisa,
      method: a.depreciation_method === 'straight_line' ? `${a.useful_life_months} months` : 'None',
      accumulated_paisa: a.accumulated_depreciation_paisa,
      book_paisa: a.book_value_paisa,
      status: a.status === 'disposed' ? `Disposed ${a.disposal_date}` : 'In use',
      _link: `/assets/${a.id}`,
    }));
  return {
    subtitle: `Book values on ${asOf}`,
    columns: [col('doc_no', 'Number'), col('name', 'Asset'), col('category', 'Type'), col('purchase_date', 'Bought', 'date'), col('cost_paisa', 'Cost', 'money'), col('method', 'Depreciation'), col('accumulated_paisa', 'Accumulated', 'money'), col('book_paisa', 'Book value', 'money'), col('status', 'Status')],
    rows,
    totals: { cost_paisa: totals.cost_paisa, accumulated_paisa: totals.accumulated_depreciation_paisa, book_paisa: totals.book_value_paisa },
    summary: [{ label: 'Book value of assets held', value: totals.book_value_paisa, kind: 'money' }],
    notes: ['Totals are for assets held on that date.'],
  };
};

export const depreciationScheduleReport: ReportBuilder = (ctx) => {
  const fy = yearOf(ctx);
  const assets = ctx.db.all<{ id: number; doc_no: string; name: string; purchase_date: string; cost_paisa: number; salvage_value_paisa: number; depreciation_method: 'none' | 'straight_line'; useful_life_months: number | null; disposal_date: string | null }>(sql`
    SELECT id, doc_no, name, purchase_date, cost_paisa, salvage_value_paisa, depreciation_method, useful_life_months, disposal_date FROM assets
    WHERE status <> 'void' AND depreciation_method = 'straight_line' ORDER BY purchase_date, id`);
  const rows: ReportRow[] = [];
  for (const a of assets) {
    const charges = new Map(depreciationSchedule(a).map((r) => [r.month, r.charge_paisa]));
    const row: ReportRow = { asset: `${a.doc_no} ${a.name}`, _link: `/assets/${a.id}` };
    let sum = 0;
    for (const m of fy.months) {
      const v = charges.get(m) ?? 0;
      row[`m_${m}`] = v || null;
      sum += v;
    }
    row.total = sum;
    if (sum) rows.push(row);
  }
  const keys = [...fy.months.map((m) => `m_${m}`), 'total'];
  return {
    subtitle: `${ctx.q.calendar ? 'Calendar year' : 'Fiscal year'} ${fy.label}`,
    columns: [col('asset', 'Asset'), ...fy.months.map((m) => col(`m_${m}`, monthLabel(m), 'money')), col('total', 'Total', 'money')],
    rows,
    totals: Object.fromEntries(keys.map((k) => [k, total(rows, k)])),
    summary: [{ label: 'Depreciation for the year', value: total(rows, 'total'), kind: 'money' }],
    notes: ['Each month is charged on its last day.'],
  };
};

// --- Cash and bank book -------------------------------------------------------------------------

/**
 * Money in and out (CLAUDE.md 11.3 #8): receipts, supplier payments,
 * refunds, expenses, asset purchases and sales. "Cash" is cash only; "Bank"
 * is everything else (bank transfers, cheques, online).
 */
export const cashBankBook: ReportBuilder = (ctx) => {
  const p = period(ctx, 'month');
  const book = ctx.q.method === 'cash' ? 'cash' : ctx.q.method ? 'bank' : null;
  const bookOf = (method: string) => (method === 'cash' ? 'Cash' : 'Bank');
  const entries = ctx.db.all<{ date: string; doc_no: string; type: string; party: string | null; method: string; inp: number | null; outp: number | null }>(sql`
    SELECT pm.date, pm.doc_no,
           CASE pm.kind WHEN 'receipt' THEN 'Received from customer' WHEN 'refund' THEN 'Refund to customer' ELSE 'Paid to supplier' END AS type,
           CASE pm.party_type WHEN 'customer' THEN (SELECT name FROM customers WHERE id = pm.party_id) ELSE (SELECT name FROM suppliers WHERE id = pm.party_id) END AS party,
           pm.method, CASE pm.kind WHEN 'receipt' THEN pm.amount_paisa END AS inp, CASE pm.kind WHEN 'receipt' THEN NULL ELSE pm.amount_paisa END AS outp
    FROM payments pm WHERE pm.status IN ('posted', 'bounced') AND pm.date BETWEEN ${p.from} AND ${p.to}
    UNION ALL
    SELECT le.date, pm.doc_no, 'Cheque bounced', (SELECT name FROM customers WHERE id = pm.party_id), pm.method, NULL, le.debit_paisa
    FROM ledger_entries le JOIN payments pm ON pm.id = le.source_id
    WHERE le.entry_type = 'bounced_cheque' AND le.source_type = 'payment' AND le.date BETWEEN ${p.from} AND ${p.to}
    UNION ALL
    SELECT e.date, e.doc_no, 'Expense: ' || c.name, e.paid_to, e.method, NULL, e.amount_paisa
    FROM expenses e JOIN expense_categories c ON c.id = e.category_id WHERE e.status = 'posted' AND e.date BETWEEN ${p.from} AND ${p.to}
    UNION ALL
    SELECT a.purchase_date, a.doc_no, 'Asset bought: ' || a.name, a.vendor, a.method, NULL, a.cost_paisa
    FROM assets a WHERE a.status <> 'void' AND a.purchase_date BETWEEN ${p.from} AND ${p.to}
    UNION ALL
    SELECT a.disposal_date, a.doc_no, 'Asset sold: ' || a.name, NULL, coalesce(a.disposal_method, 'cash'), a.disposal_amount_paisa, NULL
    FROM assets a WHERE a.status = 'disposed' AND a.disposal_amount_paisa > 0 AND a.disposal_date BETWEEN ${p.from} AND ${p.to}
    ORDER BY 1, 2`);
  let running = 0;
  const rows: ReportRow[] = entries
    .filter((e) => !book || (book === 'cash' ? e.method === 'cash' : e.method !== 'cash'))
    .map((e) => {
      running += (e.inp ?? 0) - (e.outp ?? 0);
      return { date: e.date, doc_no: e.doc_no, type: e.type, party: e.party, book: bookOf(e.method), in_paisa: e.inp, out_paisa: e.outp, running_paisa: running };
    });
  const inT = total(rows, 'in_paisa');
  const outT = total(rows, 'out_paisa');
  return {
    subtitle: subtitle(periodText(p), book ? `${bookOf(book)} only` : 'Cash and bank'),
    columns: [col('date', 'Date', 'date'), col('doc_no', 'Number'), col('type', 'Details'), col('party', 'Customer / supplier / payee'), col('book', 'Cash/bank'), col('in_paisa', 'In', 'money'), col('out_paisa', 'Out', 'money'), col('running_paisa', 'Net so far', 'money')],
    rows,
    totals: { in_paisa: inT, out_paisa: outT, running_paisa: inT - outT },
    summary: [
      { label: 'Money in', value: inT, kind: 'money' },
      { label: 'Money out', value: outT, kind: 'money' },
      { label: 'Net', value: inT - outT, kind: 'money' },
    ],
    notes: ['“Net so far” starts from zero on the first day of the period (opening cash is not recorded in ShopLedger).'],
  };
};

// --- Stock valuation ---------------------------------------------------------------------------

export const stockValuationReport: ReportBuilder = (ctx) => {
  const v = stockValuation(ctx.db);
  const rows: ReportRow[] = v.rows
    .filter((r) => !ctx.q.category || (r.category ?? '').toLowerCase() === ctx.q.category.toLowerCase())
    .map((r) => ({ item_code: r.item_code, name: r.name, category: r.category, stock_qty: r.stock_qty, stock_value_paisa: r.stock_value_paisa, _link: `/products/${r.product_id}` }));
  return {
    subtitle: subtitle(`As of ${ctx.today}`, filterText(ctx)),
    columns: [col('item_code', 'Item'), col('name', 'Description'), col('category', 'Category'), col('stock_qty', 'In stock', 'int'), col('stock_value_paisa', 'Value at average cost', 'money')],
    rows,
    totals: { stock_qty: total(rows, 'stock_qty'), stock_value_paisa: total(rows, 'stock_value_paisa') },
    summary: [{ label: 'Stock value', value: total(rows, 'stock_value_paisa'), kind: 'money' }],
    notes: ['Items with stock below zero are not valued.'],
  };
};
