import { sql, type SQL } from 'drizzle-orm';
import type { ReportRow } from '@shopledger/shared';
import { roundDiv } from '../../lib/money';
import { openItemsWithAge } from '../../lib/overdue';
import { col, daysBetween, filterText, period, periodText, subtitle, total, type ReportBuilder, type ReportCtx } from './engine';

/**
 * Customer reports (CLAUDE.md 11.1). All roles; profit columns only for
 * finance.view.
 */

interface CustomerRow {
  id: number;
  code: string;
  name: string;
  type: string;
  city: string | null;
  status: string;
  created_at: string;
  balance: number;
}

/** Customers matching the type/city filters (and one customer, if asked), with their balance. */
function customersFor(ctx: ReportCtx): Map<number, CustomerRow> {
  const conds: SQL[] = [sql`1 = 1`];
  if (ctx.q.type) conds.push(sql`c.type = ${ctx.q.type}`);
  if (ctx.q.city) conds.push(sql`lower(c.city) = lower(${ctx.q.city})`);
  if (ctx.q.customer_id) conds.push(sql`c.id = ${ctx.q.customer_id}`);
  const rows = ctx.db.all<CustomerRow>(sql`
    SELECT c.id, c.code, c.name, c.type, c.city, c.status, c.created_at,
           coalesce((SELECT sum(le.debit_paisa) - sum(le.credit_paisa) FROM ledger_entries le WHERE le.party_type = 'customer' AND le.party_id = c.id), 0) AS balance
    FROM customers c WHERE ${sql.join(conds, sql` AND `)} ORDER BY c.name`);
  return new Map(rows.map((r) => [r.id, r]));
}

const typeLabel = (t: string) => (t === 'retailer' ? 'Retailer' : 'Wholesaler');

// --- Customer summary ------------------------------------------------------------------

export const customerSummary: ReportBuilder = (ctx) => {
  const p = period(ctx, 'fiscal_year');
  const customers = customersFor(ctx);
  const sum = (q: SQL) => new Map(ctx.db.all<{ id: number; v: number; n?: number; g?: number; d?: number }>(q).map((r) => [r.id, r]));
  const sales = sum(sql`
    SELECT s.customer_id AS id, sum(s.total_paisa) AS v, count(*) AS n,
           (SELECT sum(i.line_gross_paisa) FROM sale_items i JOIN sales s2 ON s2.id = i.sale_id WHERE s2.customer_id = s.customer_id AND s2.status = 'posted' AND s2.date BETWEEN ${p.from} AND ${p.to}) AS g,
           (SELECT sum(i.line_discount_paisa) FROM sale_items i JOIN sales s2 ON s2.id = i.sale_id WHERE s2.customer_id = s.customer_id AND s2.status = 'posted' AND s2.date BETWEEN ${p.from} AND ${p.to}) AS d
    FROM sales s WHERE s.status = 'posted' AND s.date BETWEEN ${p.from} AND ${p.to} GROUP BY s.customer_id`);
  const returns = sum(sql`SELECT customer_id AS id, sum(total_paisa) AS v FROM sales_returns WHERE status = 'posted' AND date BETWEEN ${p.from} AND ${p.to} GROUP BY customer_id`);
  const receipts = sum(sql`SELECT party_id AS id, sum(amount_paisa) AS v FROM payments WHERE kind = 'receipt' AND party_type = 'customer' AND status = 'posted' AND date BETWEEN ${p.from} AND ${p.to} GROUP BY party_id`);
  const writeOffs = sum(sql`SELECT customer_id AS id, sum(amount_paisa) AS v FROM write_offs WHERE status = 'posted' AND date BETWEEN ${p.from} AND ${p.to} GROUP BY customer_id`);
  const profit = ctx.finance
    ? sum(sql`
        SELECT id, sum(v) AS v FROM (
          SELECT s.customer_id AS id, sum(i.profit_paisa) AS v FROM sale_items i JOIN sales s ON s.id = i.sale_id
          WHERE s.status = 'posted' AND s.date BETWEEN ${p.from} AND ${p.to} GROUP BY s.customer_id
          UNION ALL
          SELECT r.customer_id, -sum(ri.profit_reversed_paisa) FROM sales_return_items ri JOIN sales_returns r ON r.id = ri.return_id
          WHERE r.status = 'posted' AND r.date BETWEEN ${p.from} AND ${p.to} GROUP BY r.customer_id
        ) GROUP BY id`)
    : new Map();

  const rows: ReportRow[] = [];
  for (const c of customers.values()) {
    const s = sales.get(c.id);
    const salesTotal = s?.v ?? 0;
    const ret = returns.get(c.id)?.v ?? 0;
    const rec = receipts.get(c.id)?.v ?? 0;
    const wo = writeOffs.get(c.id)?.v ?? 0;
    if (!salesTotal && !ret && !rec && !wo && !c.balance) continue;
    const net = salesTotal - ret;
    const gp = profit.get(c.id)?.v ?? 0;
    rows.push({
      code: c.code,
      name: c.name,
      type: typeLabel(c.type),
      city: c.city,
      invoices: s?.n ?? 0,
      sales_paisa: salesTotal,
      returns_paisa: ret,
      net_sales_paisa: net,
      receipts_paisa: rec,
      write_offs_paisa: wo,
      balance_paisa: c.balance,
      avg_invoice_paisa: s?.n ? roundDiv(salesTotal, s.n) : null,
      avg_discount_bp: s?.g ? roundDiv((s.d ?? 0) * 10_000, s.g) : null,
      ...(ctx.finance ? { gross_profit_paisa: gp, profit_bp: net ? roundDiv(gp * 10_000, net) : null } : {}),
      _link: `/customers/${c.id}`,
    });
  }
  rows.sort((a, b) => (b.net_sales_paisa as number) - (a.net_sales_paisa as number));
  const sums = ['invoices', 'sales_paisa', 'returns_paisa', 'net_sales_paisa', 'receipts_paisa', 'write_offs_paisa', 'balance_paisa', ...(ctx.finance ? ['gross_profit_paisa'] : [])];
  return {
    subtitle: subtitle(periodText(p), filterText(ctx)),
    columns: [
      col('code', 'Code'),
      col('name', 'Customer'),
      col('type', 'Type'),
      col('city', 'City'),
      col('invoices', 'Invoices', 'int'),
      col('sales_paisa', 'Sales', 'money'),
      col('returns_paisa', 'Returns', 'money'),
      col('net_sales_paisa', 'Net sales', 'money'),
      col('receipts_paisa', 'Received', 'money'),
      col('write_offs_paisa', 'Written off', 'money'),
      col('balance_paisa', 'Balance now', 'money'),
      col('avg_invoice_paisa', 'Avg invoice', 'money'),
      col('avg_discount_bp', 'Avg discount', 'percent'),
      ...(ctx.finance ? [col('gross_profit_paisa', 'Gross profit', 'money'), col('profit_bp', 'Profit %', 'percent')] : []),
    ],
    rows,
    totals: Object.fromEntries(sums.map((k) => [k, total(rows, k)])),
    summary: [
      { label: 'Customers', value: rows.length, kind: 'int' },
      { label: 'Net sales', value: total(rows, 'net_sales_paisa'), kind: 'money' },
      { label: 'Received', value: total(rows, 'receipts_paisa'), kind: 'money' },
    ],
    notes: [],
  };
};

// --- Aging -------------------------------------------------------------------------------

const BUCKETS = [
  { key: 'not_due_paisa', label: 'Not due', test: (d: number) => d <= 0 },
  { key: 'd1_30_paisa', label: '1–30 days', test: (d: number) => d >= 1 && d <= 30 },
  { key: 'd31_60_paisa', label: '31–60 days', test: (d: number) => d >= 31 && d <= 60 },
  { key: 'd61_90_paisa', label: '61–90 days', test: (d: number) => d >= 61 && d <= 90 },
  { key: 'd90_plus_paisa', label: 'Over 90 days', test: (d: number) => d > 90 },
];

/** What each customer owes, split by how long it is past its due date (CLAUDE.md 11.1 #3). */
export const customerAging: ReportBuilder = (ctx) => {
  const customers = customersFor(ctx);
  const byCustomer = new Map<number, ReportRow>();
  for (const it of openItemsWithAge(ctx.db, { today: ctx.today, customerIds: [...customers.keys()] })) {
    const c = customers.get(it.customer_id);
    if (!c) continue;
    let row = byCustomer.get(c.id);
    if (!row) {
      row = { code: c.code, name: c.name, type: typeLabel(c.type), city: c.city, ...Object.fromEntries(BUCKETS.map((b) => [b.key, 0])), total_paisa: 0, _link: `/customers/${c.id}` };
      byCustomer.set(c.id, row);
    }
    const bucket = BUCKETS.find((b) => b.test(it.days_overdue)) ?? BUCKETS[0];
    if (bucket) row[bucket.key] = (row[bucket.key] as number) + it.outstanding_paisa;
    row.total_paisa = (row.total_paisa as number) + it.outstanding_paisa;
  }
  const rows = [...byCustomer.values()].sort((a, b) => (b.total_paisa as number) - (a.total_paisa as number));
  return {
    subtitle: subtitle(`As of ${ctx.today}`, filterText(ctx)),
    columns: [col('code', 'Code'), col('name', 'Customer'), col('type', 'Type'), col('city', 'City'), ...BUCKETS.map((b) => col(b.key, b.label, 'money')), col('total_paisa', 'Total', 'money')],
    rows,
    totals: Object.fromEntries([...BUCKETS.map((b) => b.key), 'total_paisa'].map((k) => [k, total(rows, k)])),
    summary: [
      { label: 'Owed to us', value: total(rows, 'total_paisa'), kind: 'money' },
      { label: 'Past due', value: total(rows, 'total_paisa') - total(rows, 'not_due_paisa'), kind: 'money' },
    ],
    notes: ['Days past the due date (payment terms). An owed opening balance is due on its date plus the customer’s terms.'],
  };
};

// --- Payment behaviour ---------------------------------------------------------------------

/**
 * Per customer, for invoices dated in the period: average days to pay, % paid
 * on time and the longest delay (CLAUDE.md 11.1 #4). "Days to pay" = the
 * date the invoice became fully paid − its date, from the allocations.
 * Invoices cleared by a write-off do not count as paid.
 */
export const paymentBehaviour: ReportBuilder = (ctx) => {
  const p = period(ctx, 'fiscal_year');
  const customers = customersFor(ctx);
  const invoices = ctx.db.all<{ id: number; customer_id: number; date: string; due_date: string; total_paisa: number }>(sql`
    SELECT id, customer_id, date, due_date, total_paisa FROM sales
    WHERE status = 'posted' AND total_paisa > 0 AND date BETWEEN ${p.from} AND ${p.to}`);
  const allocs = ctx.db.all<{ sale_id: number; amount: number; date: string | null }>(sql`
    SELECT pa.sale_id, pa.amount_paisa AS amount,
           CASE pa.source_type
             WHEN 'payment' THEN (SELECT date FROM payments WHERE id = pa.source_id)
             WHEN 'sales_return' THEN (SELECT date FROM sales_returns WHERE id = pa.source_id)
             WHEN 'opening_balance' THEN (SELECT min(date) FROM ledger_entries WHERE entry_type = 'opening_balance' AND party_type = 'customer' AND party_id = pa.customer_id)
             ELSE NULL END AS date
    FROM payment_allocations pa
    WHERE pa.sale_id IS NOT NULL AND pa.source_type <> 'write_off'`);
  const bySale = new Map<number, { amount: number; date: string }[]>();
  for (const a of allocs) if (a.date) bySale.set(a.sale_id, [...(bySale.get(a.sale_id) ?? []), { amount: a.amount, date: a.date }]);

  const stats = new Map<number, { invoices: number; paid: number; daysSum: number; onTime: number; due: number; longest: number }>();
  for (const inv of invoices) {
    if (!customers.has(inv.customer_id)) continue;
    const s = stats.get(inv.customer_id) ?? { invoices: 0, paid: 0, daysSum: 0, onTime: 0, due: 0, longest: 0 };
    s.invoices++;
    let running = 0;
    let paidOn: string | null = null;
    for (const a of (bySale.get(inv.id) ?? []).sort((x, y) => x.date.localeCompare(y.date))) {
      running += a.amount;
      if (running >= inv.total_paisa) {
        paidOn = a.date < inv.date ? inv.date : a.date;
        break;
      }
    }
    if (paidOn) {
      s.paid++;
      s.due++;
      s.daysSum += daysBetween(inv.date, paidOn);
      if (paidOn <= inv.due_date) s.onTime++;
      s.longest = Math.max(s.longest, daysBetween(inv.due_date, paidOn));
    } else if (ctx.today > inv.due_date) {
      // Still unpaid after its due date: late so far.
      s.due++;
      s.longest = Math.max(s.longest, daysBetween(inv.due_date, ctx.today));
    }
    stats.set(inv.customer_id, s);
  }

  const rows: ReportRow[] = [...stats.entries()].map(([id, s]) => {
    const c = customers.get(id) as CustomerRow;
    return {
      code: c.code,
      name: c.name,
      city: c.city,
      invoices: s.invoices,
      paid: s.paid,
      avg_days_to_pay: s.paid ? Math.round(s.daysSum / s.paid) : null,
      on_time_bp: s.due ? roundDiv(s.onTime * 10_000, s.due) : null,
      longest_delay: s.longest || null,
      _link: `/customers/${id}`,
    };
  });
  rows.sort((a, b) => ((b.longest_delay as number) ?? 0) - ((a.longest_delay as number) ?? 0));
  return {
    subtitle: subtitle(`Invoices dated ${periodText(p)}`, filterText(ctx)),
    columns: [
      col('code', 'Code'),
      col('name', 'Customer'),
      col('city', 'City'),
      col('invoices', 'Invoices', 'int'),
      col('paid', 'Paid in full', 'int'),
      col('avg_days_to_pay', 'Avg days to pay', 'days'),
      col('on_time_bp', 'Paid on time', 'percent'),
      col('longest_delay', 'Longest delay', 'days'),
    ],
    rows,
    totals: null,
    summary: [],
    notes: ['On time = fully paid by the due date. Invoices not yet due and unpaid are left out of “paid on time”. Longest delay includes invoices still unpaid after their due date.'],
  };
};

// --- Items bought by customer -----------------------------------------------------------------

export const itemsBought: ReportBuilder = (ctx) => {
  const p = period(ctx, 'fiscal_year');
  const customers = customersFor(ctx);
  const one = ctx.q.customer_id ? customers.get(ctx.q.customer_id) : undefined;
  const sold = ctx.db.all<{ customer_id: number; variant_id: number; qty: number; net: number; profit: number }>(sql`
    SELECT s.customer_id, i.variant_id, sum(i.qty) AS qty, sum(i.line_net_paisa) AS net, sum(i.profit_paisa) AS profit
    FROM sale_items i JOIN sales s ON s.id = i.sale_id
    WHERE s.status = 'posted' AND s.date BETWEEN ${p.from} AND ${p.to} GROUP BY s.customer_id, i.variant_id`);
  const returned = ctx.db.all<{ customer_id: number; variant_id: number; qty: number; net: number; profit: number }>(sql`
    SELECT r.customer_id, ri.variant_id, sum(ri.qty) AS qty, sum(ri.line_net_paisa) AS net, sum(ri.profit_reversed_paisa) AS profit
    FROM sales_return_items ri JOIN sales_returns r ON r.id = ri.return_id
    WHERE r.status = 'posted' AND r.date BETWEEN ${p.from} AND ${p.to} GROUP BY r.customer_id, ri.variant_id`);
  const variants = new Map(
    ctx.db
      .all<{ id: number; item_code: string; name: string; color: string; size: string; unit: string }>(sql`SELECT v.id, p.item_code, p.name, v.color, v.size, p.unit FROM product_variants v JOIN products p ON p.id = v.product_id`)
      .map((v) => [v.id, v]),
  );
  const rows = new Map<string, ReportRow>();
  const add = (r: { customer_id: number; variant_id: number; qty: number; net: number; profit: number }, sign: 1 | -1) => {
    const c = customers.get(r.customer_id);
    const v = variants.get(r.variant_id);
    if (!c || !v) return;
    const k = `${c.id}:${v.id}`;
    const row = rows.get(k) ?? { customer: c.name, item_code: v.item_code, item: v.name, color: v.color, size: v.size, qty: 0, returned_qty: 0, net_qty: 0, net_value_paisa: 0, profit_paisa: 0, _link: `/customers/${c.id}` };
    if (sign === 1) row.qty = (row.qty as number) + r.qty;
    else row.returned_qty = (row.returned_qty as number) + r.qty;
    row.net_qty = (row.net_qty as number) + sign * r.qty;
    row.net_value_paisa = (row.net_value_paisa as number) + sign * r.net;
    row.profit_paisa = (row.profit_paisa as number) + sign * r.profit;
    rows.set(k, row);
  };
  for (const r of sold) add(r, 1);
  for (const r of returned) add(r, -1);
  const list = [...rows.values()]
    .map((r) => (ctx.finance ? r : (({ profit_paisa: _p, ...rest }) => rest)(r)))
    .sort((a, b) => String(a.customer).localeCompare(String(b.customer)) || (b.net_value_paisa as number) - (a.net_value_paisa as number));
  return {
    subtitle: subtitle(periodText(p), one ? one.name : filterText(ctx)),
    columns: [
      ...(one ? [] : [col('customer', 'Customer')]),
      col('item_code', 'Item'),
      col('item', 'Description'),
      col('color', 'Color'),
      col('size', 'Size'),
      col('qty', 'Bought', 'int'),
      col('returned_qty', 'Returned', 'int'),
      col('net_qty', 'Net qty', 'int'),
      col('net_value_paisa', 'Net value', 'money'),
      ...(ctx.finance ? [col('profit_paisa', 'Profit', 'money')] : []),
    ],
    rows: list,
    totals: Object.fromEntries(['qty', 'returned_qty', 'net_qty', 'net_value_paisa', ...(ctx.finance ? ['profit_paisa'] : [])].map((k) => [k, total(list, k)])),
    summary: [],
    notes: [],
  };
};

// --- Customer activity ---------------------------------------------------------------------

export const customerActivity: ReportBuilder = (ctx) => {
  const p = period(ctx, 'month');
  const show = ctx.q.show ?? 'all';
  const n = ctx.q.inactive_days;
  const rows = ctx.db.all<{ id: number; code: string; name: string; type: string; city: string | null; status: string; created_at: string; last_sale: string | null; last_payment: string | null; last_payment_paisa: number | null }>(sql`
    SELECT c.id, c.code, c.name, c.type, c.city, c.status, c.created_at,
           (SELECT max(date) FROM sales s WHERE s.customer_id = c.id AND s.status = 'posted') AS last_sale,
           (SELECT max(date) FROM payments pm WHERE pm.party_type = 'customer' AND pm.party_id = c.id AND pm.kind = 'receipt' AND pm.status = 'posted') AS last_payment,
           (SELECT pm.amount_paisa FROM payments pm WHERE pm.party_type = 'customer' AND pm.party_id = c.id AND pm.kind = 'receipt' AND pm.status = 'posted' ORDER BY pm.date DESC, pm.id DESC LIMIT 1) AS last_payment_paisa
    FROM customers c ORDER BY c.name`);
  // created_at is UTC; Karachi is UTC+5.
  const since = (iso: string) => new Date(Date.parse(iso) + 5 * 3_600_000).toISOString().slice(0, 10);
  const allowed = customersFor(ctx);
  const list: ReportRow[] = rows
    .filter((c) => allowed.has(c.id))
    .map((c) => {
      const joined = since(c.created_at);
      const idle = c.last_sale ? daysBetween(c.last_sale, ctx.today) : null;
      const isNew = joined >= p.from && joined <= p.to;
      const inactive = c.status !== 'inactive' && (idle === null ? daysBetween(joined, ctx.today) >= n : idle >= n);
      return {
        code: c.code,
        name: c.name,
        type: typeLabel(c.type),
        city: c.city,
        joined,
        last_sale: c.last_sale,
        days_since_sale: idle,
        last_payment: c.last_payment,
        last_payment_paisa: c.last_payment_paisa,
        note: [isNew ? 'New' : null, inactive ? `No purchase in ${n}+ days` : null, c.status === 'bad_debt' ? 'Bad debt' : c.status === 'inactive' ? 'Deactivated' : null].filter(Boolean).join(' · '),
        _new: isNew ? 1 : 0,
        _inactive: inactive ? 1 : 0,
        _link: `/customers/${c.id}`,
      };
    })
    .filter((r) => (show === 'new' ? r._new : show === 'inactive' ? r._inactive : true))
    .map(({ _new: _n, _inactive: _i, ...r }) => r);
  return {
    subtitle: subtitle(show === 'new' ? `Joined ${periodText(p)}` : show === 'inactive' ? `No purchase in the last ${n} days` : `As of ${ctx.today}`, filterText(ctx)),
    columns: [
      col('code', 'Code'),
      col('name', 'Customer'),
      col('type', 'Type'),
      col('city', 'City'),
      col('joined', 'Customer since', 'date'),
      col('last_sale', 'Last sale', 'date'),
      col('days_since_sale', 'Days since', 'days'),
      col('last_payment', 'Last payment', 'date'),
      col('last_payment_paisa', 'Amount', 'money'),
      col('note', 'Note'),
    ],
    rows: list,
    totals: null,
    summary: [{ label: 'Customers', value: list.length, kind: 'int' }],
    notes: [],
  };
};
