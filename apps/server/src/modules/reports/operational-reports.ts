import { sql, type SQL } from 'drizzle-orm';
import { applyBp, bpToPercentString, can, type ReportRow } from '@shopledger/shared';
import { col, filterText, period, periodText, subtitle, total, type ReportBuilder } from './engine';

/** Operational reports (CLAUDE.md 11.2): quantities and money, never cost or profit (except as allowed below). */

const PAYMENT_KIND = { receipt: 'Received', supplier_payment: 'Paid to supplier', refund: 'Refund' } as const;
const METHOD = { cash: 'Cash', bank: 'Bank', cheque: 'Cheque', online: 'Online' } as const;

// --- Daily sales and purchases book -----------------------------------------------------------

/**
 * Every sale, purchase and return in the period. Purchases show their cost
 * only to those allowed to record purchases (they copy the bill), else the
 * bill's gross amount.
 */
export const dayBook: ReportBuilder = (ctx) => {
  const p = period(ctx, 'today');
  const purchaseCost = can(ctx.user, 'purchases.create');
  const rows = ctx.db.all<{ date: string; type: string; doc_no: string; party: string; qty: number; amount: number; link: string }>(sql`
    SELECT s.date, 'Sale' AS type, s.doc_no, c.name AS party,
           (SELECT sum(qty) FROM sale_items WHERE sale_id = s.id) AS qty, s.total_paisa AS amount, '/sales/' || s.id AS link
    FROM sales s JOIN customers c ON c.id = s.customer_id WHERE s.status = 'posted' AND s.date BETWEEN ${p.from} AND ${p.to}
    UNION ALL
    SELECT r.date, 'Sales return', r.doc_no, c.name, (SELECT sum(qty) FROM sales_return_items WHERE return_id = r.id), -r.total_paisa, '/sales/' || r.sale_id
    FROM sales_returns r JOIN customers c ON c.id = r.customer_id WHERE r.status = 'posted' AND r.date BETWEEN ${p.from} AND ${p.to}
    UNION ALL
    SELECT pu.date, 'Purchase', pu.doc_no, su.name, (SELECT sum(qty) FROM purchase_items WHERE purchase_id = pu.id),
           ${purchaseCost ? sql`pu.total_cost_paisa` : sql`pu.gross_paisa`}, '/purchases/' || pu.id
    FROM purchases pu JOIN suppliers su ON su.id = pu.supplier_id WHERE pu.status = 'posted' AND pu.date BETWEEN ${p.from} AND ${p.to}
    UNION ALL
    SELECT pr.date, 'Purchase return', pr.doc_no, su.name, (SELECT sum(qty) FROM purchase_return_items WHERE return_id = pr.id),
           ${purchaseCost ? sql`-pr.total_cost_paisa` : sql`NULL`}, '/purchases/' || pr.purchase_id
    FROM purchase_returns pr JOIN suppliers su ON su.id = pr.supplier_id WHERE pr.status = 'posted' AND pr.date BETWEEN ${p.from} AND ${p.to}
    ORDER BY 1, 2, 3`);
  const sum = (type: string) => rows.filter((r) => r.type === type).reduce((a, r) => a + (r.amount ?? 0), 0);
  return {
    subtitle: periodText(p),
    columns: [col('date', 'Date', 'date'), col('type', 'Type'), col('doc_no', 'Number'), col('party', 'Customer / supplier'), col('qty', 'Qty', 'int'), col('amount_paisa', 'Amount', 'money')],
    rows: rows.map((r) => ({ date: r.date, type: r.type, doc_no: r.doc_no, party: r.party, qty: r.qty, amount_paisa: r.amount, _link: r.link })),
    totals: null,
    summary: [
      { label: 'Sales', value: sum('Sale'), kind: 'money' },
      { label: 'Sales returns', value: -sum('Sales return'), kind: 'money' },
      { label: purchaseCost ? 'Purchases (cost)' : 'Purchases (gross)', value: sum('Purchase'), kind: 'money' },
      ...(purchaseCost ? [{ label: 'Purchase returns', value: -sum('Purchase return'), kind: 'money' as const }] : []),
    ],
    notes: purchaseCost ? [] : ['Purchases are shown at the bill’s gross amount.'],
  };
};

// --- Receipts and supplier payments -------------------------------------------------------

export const moneyBook: ReportBuilder = (ctx) => {
  const p = period(ctx, 'month');
  const conds: SQL[] = [sql`pm.status = 'posted'`, sql`pm.date BETWEEN ${p.from} AND ${p.to}`];
  if (ctx.q.method) conds.push(sql`pm.method = ${ctx.q.method}`);
  const rows = ctx.db.all<{ date: string; doc_no: string; kind: keyof typeof PAYMENT_KIND; party: string; method: keyof typeof METHOD; ref: string | null; amount: number }>(sql`
    SELECT pm.date, pm.doc_no, pm.kind,
           CASE pm.party_type WHEN 'customer' THEN (SELECT name FROM customers WHERE id = pm.party_id) ELSE (SELECT name FROM suppliers WHERE id = pm.party_id) END AS party,
           pm.method, coalesce(pm.cheque_no, pm.reference) AS ref, pm.amount_paisa AS amount
    FROM payments pm WHERE ${sql.join(conds, sql` AND `)} ORDER BY pm.date, pm.id`);
  const list: ReportRow[] = rows.map((r) => ({
    date: r.date,
    doc_no: r.doc_no,
    type: PAYMENT_KIND[r.kind],
    party: r.party,
    method: METHOD[r.method],
    reference: r.ref,
    in_paisa: r.kind === 'receipt' ? r.amount : null,
    out_paisa: r.kind === 'receipt' ? null : r.amount,
  }));
  const byMethod = (m: string, k: 'in_paisa' | 'out_paisa') => list.filter((r) => r.method === m).reduce((a, r) => a + ((r[k] as number) ?? 0), 0);
  return {
    subtitle: subtitle(periodText(p), ctx.q.method ? METHOD[ctx.q.method] : null),
    columns: [col('date', 'Date', 'date'), col('doc_no', 'Number'), col('type', 'Type'), col('party', 'Customer / supplier'), col('method', 'Method'), col('reference', 'Cheque / reference'), col('in_paisa', 'Received', 'money'), col('out_paisa', 'Paid out', 'money')],
    rows: list,
    totals: { in_paisa: total(list, 'in_paisa'), out_paisa: total(list, 'out_paisa') },
    summary: Object.values(METHOD)
      .filter((m) => list.some((r) => r.method === m))
      .map((m) => ({ label: `${m}: in − out`, value: byMethod(m, 'in_paisa') - byMethod(m, 'out_paisa'), kind: 'money' as const })),
    notes: ['Bounced and void payments are left out.'],
  };
};

// --- Sales quantity by item -----------------------------------------------------------------

export const salesByItem: ReportBuilder = (ctx) => {
  const p = period(ctx, 'month');
  const byItem = ctx.q.group_by === 'item';
  const cat = ctx.q.category ? sql`AND lower(p.category) = lower(${ctx.q.category})` : sql``;
  const key = byItem ? sql`p.id` : sql`v.id`;
  const rows = ctx.db.all<{ k: number; item_code: string; name: string; color: string; size: string; unit: string; qty: number; returned: number; net_value: number; profit: number }>(sql`
    SELECT k, item_code, name, color, size, unit, sum(qty) AS qty, sum(returned) AS returned, sum(net_value) AS net_value, sum(profit) AS profit FROM (
      SELECT ${key} AS k, p.item_code, p.name, v.color, v.size, p.unit, i.qty AS qty, 0 AS returned, i.line_net_paisa AS net_value, i.profit_paisa AS profit
      FROM sale_items i JOIN sales s ON s.id = i.sale_id JOIN product_variants v ON v.id = i.variant_id JOIN products p ON p.id = v.product_id
      WHERE s.status = 'posted' AND s.date BETWEEN ${p.from} AND ${p.to} ${cat}
      UNION ALL
      SELECT ${key}, p.item_code, p.name, v.color, v.size, p.unit, 0, ri.qty, -ri.line_net_paisa, -ri.profit_reversed_paisa
      FROM sales_return_items ri JOIN sales_returns r ON r.id = ri.return_id JOIN product_variants v ON v.id = ri.variant_id JOIN products p ON p.id = v.product_id
      WHERE r.status = 'posted' AND r.date BETWEEN ${p.from} AND ${p.to} ${cat}
    ) GROUP BY k ORDER BY sum(qty) - sum(returned) DESC, item_code`);
  const list: ReportRow[] = rows.map((r) => ({
    item_code: r.item_code,
    name: r.name,
    ...(byItem ? {} : { color: r.color, size: r.size }),
    unit: r.unit,
    qty: r.qty,
    returned_qty: r.returned,
    net_qty: r.qty - r.returned,
    net_value_paisa: r.net_value,
    ...(ctx.finance ? { profit_paisa: r.profit } : {}),
  }));
  return {
    subtitle: subtitle(periodText(p), filterText(ctx)),
    columns: [
      col('item_code', 'Item'),
      col('name', 'Description'),
      ...(byItem ? [] : [col('color', 'Color'), col('size', 'Size')]),
      col('unit', 'Unit'),
      col('qty', 'Sold', 'int'),
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

// --- Stock on hand ------------------------------------------------------------------------------

export const stockOnHand: ReportBuilder = (ctx) => {
  const lowOnly = ctx.q.show === 'low';
  const cat = ctx.q.category ? sql`AND lower(p.category) = lower(${ctx.q.category})` : sql``;
  const rows = ctx.db.all<{ product_id: number; item_code: string; name: string; category: string | null; color: string; size: string; unit: string; stock: number; threshold: number }>(sql`
    SELECT p.id AS product_id, p.item_code, p.name, p.category, v.color, v.size, p.unit,
           coalesce((SELECT sum(qty_change) FROM stock_movements sm WHERE sm.variant_id = v.id), 0) AS stock, v.low_stock_threshold AS threshold
    FROM product_variants v JOIN products p ON p.id = v.product_id
    WHERE v.active = 1 AND p.active = 1 ${cat}
    ORDER BY p.item_code, v.id`);
  const isLow = (r: { stock: number; threshold: number }) => r.threshold > 0 && r.stock <= r.threshold;
  const stockNote = (r: { stock: number; threshold: number }) => {
    if (r.stock < 0) return 'Below zero';
    if (isLow(r)) return 'Low';
    return '';
  };
  const list: ReportRow[] = rows
    .filter((r) => !lowOnly || isLow(r))
    .map((r) => ({
      item_code: r.item_code,
      name: r.name,
      category: r.category,
      color: r.color,
      size: r.size,
      unit: r.unit,
      stock: r.stock,
      threshold: r.threshold || null,
      note: stockNote(r),
      _link: `/products/${r.product_id}`,
    }));
  return {
    subtitle: subtitle(`As of ${ctx.today}`, lowOnly ? 'Low stock only' : null, filterText(ctx)),
    columns: [col('item_code', 'Item'), col('name', 'Description'), col('category', 'Category'), col('color', 'Color'), col('size', 'Size'), col('unit', 'Unit'), col('stock', 'In stock', 'int'), col('threshold', 'Low at', 'int'), col('note', 'Note')],
    rows: list,
    totals: { stock: total(list, 'stock') },
    summary: [{ label: 'Low stock items', value: list.filter((r) => r.note === 'Low').length, kind: 'int' }],
    notes: [],
  };
};

// --- Price list -----------------------------------------------------------------------------------

/** Printable price list with the usual customer discount (CLAUDE.md 11.2). */
export const priceList: ReportBuilder = (ctx) => {
  const cat = ctx.q.category ? sql`AND lower(category) = lower(${ctx.q.category})` : sql``;
  const rows = ctx.db.all<{ item_code: string; name: string; category: string | null; unit: string; sizes: string; colors: string; price: number; discount: number }>(sql`
    SELECT item_code, name, category, unit, sizes, colors, list_price_paisa AS price, default_customer_discount_bp AS discount
    FROM products WHERE active = 1 ${cat} ORDER BY category, item_code`);
  const list: ReportRow[] = rows.map((r) => ({
    item_code: r.item_code,
    name: r.name,
    category: r.category,
    unit: r.unit,
    sizes: (JSON.parse(r.sizes) as string[]).join(', '),
    colors: (JSON.parse(r.colors) as string[]).join(', '),
    price_paisa: r.price,
    discount_bp: r.discount,
    customer_price_paisa: r.price - applyBp(r.price, r.discount),
  }));
  const retail = ctx.settings.retail_discount_reduction_bp;
  return {
    subtitle: subtitle(`Prices as of ${ctx.today}`, filterText(ctx)),
    columns: [
      col('item_code', 'Item'),
      col('name', 'Description'),
      col('category', 'Category'),
      col('unit', 'Unit'),
      col('sizes', 'Sizes'),
      col('colors', 'Colors'),
      col('price_paisa', 'Price', 'money'),
      col('discount_bp', 'Discount', 'percent'),
      col('customer_price_paisa', 'You pay', 'money'),
    ],
    rows: list,
    totals: null,
    summary: [],
    notes: retail ? [`Retail customers get ${bpToPercentString(retail)}% less discount.`] : [],
  };
};
