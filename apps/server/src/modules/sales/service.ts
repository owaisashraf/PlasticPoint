import { and, asc, desc, eq, gte, inArray, lt, lte, or, sql, type SQL } from 'drizzle-orm';
import { alias } from 'drizzle-orm/sqlite-core';
import {
  bpToPercentString,
  can,
  createSaleSchema,
  formatPaisa,
  saleCheckSchema,
  saleListQuerySchema,
  type Sale,
  type SaleCheckResult,
  type SaleIssue,
  type SaleLine,
  type Settings,
} from '@shopledger/shared';
import type { z } from 'zod';
import { writeTx, type DB, type DbOrTx } from '../../db/client';
import { customers, ledger_entries, payment_allocations, payments, product_variants, products, sale_items, sales, sales_return_items, sales_returns, users } from '../../db/schema';
import { recalcAllocations } from '../../lib/allocation';
import { daysPastDueSql, overdueSummaries } from '../../lib/overdue';
import { writeAudit, type AuditActor } from '../../lib/audit';
import { businessToday, nowIso } from '../../lib/dates';
import { badRequest, conflict, notFound } from '../../lib/errors';
import { partyBalance, postEntry } from '../../lib/ledger';
import { nextDocNo } from '../../lib/numbering';
import type { SessionUser } from '../../lib/permissions';
import { addDaysToDate, defaultDiscountBp, pricingRuleHits, saleLineAmounts, type PricingRule, type PricingRuleHit } from '../../lib/pricing';
import { computeSale, profitBp, saleUnitCost, type CostSource, type SaleLineResult } from '../../lib/profit';
import { postMovement, recomputeAverageCosts, stockOnHandMany } from '../../lib/stock';
import { auditActor } from '../auth/service';
import { getSetting, getSettings } from '../settings/service';

type CreateInput = z.output<typeof createSaleSchema>;
type CheckInput = z.output<typeof saleCheckSchema>;
type ListQuery = z.output<typeof saleListQuerySchema>;
type CustomerRow = typeof customers.$inferSelect;
type ProductRow = typeof products.$inferSelect;
type VariantRow = typeof product_variants.$inferSelect;

// --- Evaluating a sale (shared by the live check and posting) ----------------------

interface EvaluatedLine extends SaleLineResult {
  variant: VariantRow;
  product: ProductRow;
  qty: number;
  list_price_paisa: number;
  default_discount_bp: number;
  discount_bp: number;
  discount_overridden: boolean;
  unit_cost_paisa: number;
  cost_source: CostSource;
  rules: PricingRuleHit[];
}

interface Evaluation {
  customer: CustomerRow | null;
  payment_terms_days: number;
  due_date: string | null;
  lines: EvaluatedLine[];
  gross_paisa: number;
  line_discount_paisa: number;
  extra_discount_paisa: number;
  tax_paisa: number;
  total_paisa: number;
  profit_paisa: number;
  issues: SaleIssue[];
  needs_approval: boolean;
  flags: string[];
}

const lineLabel = (l: Pick<EvaluatedLine, 'product' | 'variant'>) => [l.product.item_code, l.variant.color, l.variant.size].filter(Boolean).join(' ');

/**
 * Operators never see why a discount needs approval: the message must not
 * reveal cost or supplier margin (CLAUDE.md 8.10).
 */
const OPERATOR_APPROVAL_MESSAGE = 'This discount needs owner approval.';
const OPERATOR_WARNING_MESSAGE = 'This discount is higher than usual. Please check it.';

function detailedMessage(rule: PricingRule, l: EvaluatedLine, settings: Settings): string {
  switch (rule) {
    case 'discount_above_max':
      return `Discount ${bpToPercentString(l.discount_bp)}% is above the maximum of ${bpToPercentString(l.product.max_customer_discount_bp ?? 0)}% for ${l.product.item_code}.`;
    case 'below_cost':
      return `Below cost: this line loses ${formatPaisa(-l.profit_paisa)}.`;
    case 'below_min_profit':
      return `Profit ${bpToPercentString(profitBp(l.profit_paisa, l.line_gross_paisa))}% is below the minimum of ${bpToPercentString(settings.min_profit_bp)}%.`;
  }
}

/**
 * Prices a draft sale and runs every safety rule. Prices always come from the
 * product, never from the request. Messages are worded for `user`: only
 * holders of finance.view get the detailed pricing reasons.
 */
export function evaluateSale(db: DbOrTx, user: SessionUser, input: CheckInput): Evaluation {
  const settings = getSettings(db);
  const customer = input.customer_id ? (db.select().from(customers).where(eq(customers.id, input.customer_id)).get() ?? null) : null;
  if (input.customer_id && !customer) throw badRequest('Pick the customer.');

  const variantIds = [...new Set(input.lines.map((l) => l.variant_id))];
  const found = new Map(
    variantIds.length
      ? db
          .select({ v: product_variants, p: products })
          .from(product_variants)
          .innerJoin(products, eq(products.id, product_variants.product_id))
          .where(inArray(product_variants.id, variantIds))
          .all()
          .map((r) => [r.v.id, r])
      : [],
  );

  const priced = input.lines.map((l) => {
    const r = found.get(l.variant_id);
    if (!r) throw badRequest('One of the items no longer exists. Reload and try again.');
    if (!r.v.active || !r.p.active) throw badRequest(`${r.v.sku} is inactive and cannot be sold.`);
    const def = defaultDiscountBp({
      productDiscountBp: r.p.default_customer_discount_bp,
      settingsDiscountBp: settings.default_customer_discount_bp,
      customerType: customer?.type ?? 'wholesaler',
      retailReductionBp: settings.retail_discount_reduction_bp,
    });
    return {
      variant: r.v,
      product: r.p,
      qty: l.qty,
      list_price_paisa: r.p.list_price_paisa,
      default_discount_bp: def,
      discount_bp: l.discount_bp,
      discount_overridden: l.discount_bp !== def,
      ...saleUnitCost(r.v.avg_cost_paisa, r.p.list_price_paisa, r.p.supplier_margin_bp),
    };
  });

  const amountBeforeExtra = priced.reduce((a, l) => a + saleLineAmounts(l.qty, l.list_price_paisa, l.discount_bp).line_amount_paisa, 0);
  if (input.extra_discount_paisa > amountBeforeExtra) throw badRequest('The extra discount cannot be more than the invoice amount.');
  const computed = computeSale(priced, input.extra_discount_paisa);

  const lines: EvaluatedLine[] = priced.map((p, i) => {
    const c = computed.lines[i] as SaleLineResult;
    const rules = pricingRuleHits(
      {
        discount_bp: p.discount_bp,
        max_customer_discount_bp: p.product.max_customer_discount_bp,
        line_gross_paisa: c.line_gross_paisa,
        line_net_paisa: c.line_net_paisa,
        line_cost_paisa: c.line_cost_paisa,
      },
      settings,
    );
    return { ...p, ...c, rules };
  });
  const tax = 0;
  const total = computed.net_paisa + tax;

  // --- Issues ---
  const detailed = can(user, 'finance.view');
  const issues: SaleIssue[] = [];
  lines.forEach((l, i) => {
    const hits = l.rules;
    if (detailed) {
      for (const h of hits) issues.push({ kind: h.rule, severity: h.severity, line_index: i, message: detailedMessage(h.rule, l, settings) });
    } else if (hits.some((h) => h.severity === 'approval')) {
      issues.push({ kind: 'discount_needs_approval', severity: 'approval', line_index: i, message: OPERATOR_APPROVAL_MESSAGE });
    } else if (hits.length) {
      issues.push({ kind: 'discount_warning', severity: 'warning', line_index: i, message: OPERATOR_WARNING_MESSAGE });
    }
  });

  // Stock: all lines for a variant together, reported on its first line.
  const wanted = new Map<number, number>();
  for (const l of lines) wanted.set(l.variant.id, (wanted.get(l.variant.id) ?? 0) + l.qty);
  const stock = stockOnHandMany(db, [...wanted.keys()]);
  for (const [variantId, qty] of wanted) {
    const have = stock.get(variantId) ?? 0;
    if (qty <= have) continue;
    const i = lines.findIndex((l) => l.variant.id === variantId);
    const l = lines[i] as EvaluatedLine;
    issues.push({
      kind: 'stock_short',
      severity: settings.allow_negative_stock ? 'warning' : 'approval',
      line_index: i,
      message: `${lineLabel(l)}: only ${have} in stock, selling ${qty}.${settings.allow_negative_stock ? '' : ' Selling more than stock needs owner approval.'}`,
    });
  }

  if (customer) {
    const cash = input.cash_received_paisa;
    if (customer.status === 'bad_debt' && cash < total) {
      issues.push({ kind: 'bad_debt_credit', severity: 'approval', line_index: null, message: `${customer.name} is marked as bad debt. A credit sale needs owner approval; a fully paid cash sale does not.` });
    }
    const overdue = overdueSummaries(db, { customerIds: [customer.id] }).get(customer.id);
    if (overdue) {
      issues.push({
        kind: 'overdue',
        severity: 'warning',
        line_index: null,
        message: `${customer.name} has ${overdue.overdue_count === 1 ? 'an overdue invoice' : `${overdue.overdue_count} overdue invoices`}: ${formatPaisa(overdue.overdue_paisa)}, up to ${overdue.max_days_overdue} days late.`,
      });
    }
    if (customer.credit_limit_paisa > 0) {
      const after = partyBalance(db, 'customer', customer.id) + total - cash;
      if (after > customer.credit_limit_paisa) {
        issues.push({
          kind: 'credit_limit',
          severity: 'warning',
          line_index: null,
          message: `This sale takes ${customer.name} over their credit limit of ${formatPaisa(customer.credit_limit_paisa)} (balance after this sale: ${formatPaisa(after)}).`,
        });
      }
    }
  }

  const terms = input.payment_terms_days ?? customer?.payment_terms_days ?? settings.default_payment_terms_days;
  const allRules = new Set(lines.flatMap((l) => l.rules.map((h) => h.rule)));
  const flags = [
    ...(lines.some((l) => l.discount_bp > l.default_discount_bp) ? ['discount_above_default'] : []),
    ...(allRules.has('below_min_profit') ? ['profit_below_minimum'] : []),
    ...(allRules.has('below_cost') ? ['sold_below_cost'] : []),
    ...(input.extra_discount_paisa > 0 ? ['extra_discount_added'] : []),
    ...(user.role === 'operator' ? ['by_operator'] : []),
  ];

  return {
    customer,
    payment_terms_days: terms,
    due_date: addDaysToDate(input.date, terms),
    lines,
    gross_paisa: computed.gross_paisa,
    line_discount_paisa: computed.line_discount_paisa,
    extra_discount_paisa: computed.extra_discount_paisa,
    tax_paisa: tax,
    total_paisa: total,
    profit_paisa: computed.profit_paisa,
    issues,
    needs_approval: issues.some((i) => i.severity === 'approval'),
    flags,
  };
}

/** The live check for the New Sale screen. The route redacts cost and profit for operators. */
export function checkSale(db: DB, user: SessionUser, input: CheckInput): SaleCheckResult {
  const ev = evaluateSale(db, user, input);
  return {
    lines: ev.lines.map((l) => ({
      variant_id: l.variant.id,
      qty: l.qty,
      list_price_paisa: l.list_price_paisa,
      default_discount_bp: l.default_discount_bp,
      discount_bp: l.discount_bp,
      discount_overridden: l.discount_overridden,
      line_gross_paisa: l.line_gross_paisa,
      line_discount_paisa: l.line_discount_paisa,
      line_amount_paisa: l.line_amount_paisa,
      line_net_paisa: l.line_net_paisa,
      unit_cost_paisa: l.unit_cost_paisa,
      cost_source: l.cost_source,
      line_cost_paisa: l.line_cost_paisa,
      profit_paisa: l.profit_paisa,
    })),
    totals: {
      gross_paisa: ev.gross_paisa,
      line_discount_paisa: ev.line_discount_paisa,
      extra_discount_paisa: ev.extra_discount_paisa,
      tax_paisa: ev.tax_paisa,
      total_paisa: ev.total_paisa,
      profit_paisa: ev.profit_paisa,
      profit_bp: profitBp(ev.profit_paisa, ev.gross_paisa),
    },
    due_date: ev.due_date,
    issues: ev.issues,
    needs_approval: ev.needs_approval,
  };
}

// --- Posting a sale --------------------------------------------------------------

/**
 * Posts a sale in one transaction (CLAUDE.md 6, 8.3, 8.10, 8.11): number,
 * document and lines with price, discount, cost and profit captured, stock
 * out, customer ledger debit, and one audit row. Cash received at the counter
 * becomes its own receipt (RCV) allocated to this invoice, with its own
 * ledger credit and audit row. Anything that needs approval is refused with
 * 409 APPROVAL_REQUIRED unless `approver` is given.
 */
export function createSale(db: DB, user: SessionUser, input: CreateInput, approver: AuditActor | null): Sale {
  if (input.date > businessToday()) throw badRequest('The sale date cannot be in the future.');

  return writeTx(db, (tx) => {
    const ev = evaluateSale(tx, user, input);
    const customer = ev.customer as CustomerRow;
    if (customer.status === 'inactive') throw badRequest(`${customer.name} is inactive. Make the customer active first.`);
    if (input.expected_total_paisa !== undefined && input.expected_total_paisa !== ev.total_paisa) {
      throw conflict(`A price changed while you were making this sale. The total is now ${formatPaisa(ev.total_paisa)}. Check the lines and save again.`, 'PRICE_CHANGED');
    }
    if (input.cash_received_paisa > ev.total_paisa) {
      throw badRequest('Cash received is more than this invoice. Enter up to the invoice total; record any extra as a separate payment.');
    }
    if (ev.needs_approval && !approver) {
      throw conflict('This sale needs owner approval.', 'APPROVAL_REQUIRED', { issues: ev.issues });
    }
    const approvedBy = ev.needs_approval ? approver : null;

    const now = nowIso();
    const header = tx
      .insert(sales)
      .values({
        doc_no: nextDocNo(tx, 'sale'),
        customer_id: customer.id,
        date: input.date,
        payment_terms_days: ev.payment_terms_days,
        due_date: ev.due_date as string,
        gross_paisa: ev.gross_paisa,
        line_discount_paisa: ev.line_discount_paisa,
        extra_discount_paisa: ev.extra_discount_paisa,
        tax_paisa: ev.tax_paisa,
        total_paisa: ev.total_paisa,
        status: 'posted',
        version: 1,
        notes: input.notes,
        approved_by: approvedBy?.id ?? null,
        created_by: user.id,
        updated_by: user.id,
        created_at: now,
        updated_at: now,
      })
      .returning()
      .get();

    const items = ev.lines.map((l, i) => ({
      sale_id: header.id,
      line_no: i + 1,
      variant_id: l.variant.id,
      qty: l.qty,
      list_price_paisa: l.list_price_paisa,
      default_discount_bp: l.default_discount_bp,
      discount_bp: l.discount_bp,
      discount_overridden: l.discount_overridden,
      line_gross_paisa: l.line_gross_paisa,
      line_discount_paisa: l.line_discount_paisa,
      line_net_paisa: l.line_net_paisa,
      unit_cost_paisa: l.unit_cost_paisa,
      cost_source: l.cost_source,
      line_cost_paisa: l.line_cost_paisa,
      profit_paisa: l.profit_paisa,
    }));
    for (const item of items) {
      tx.insert(sale_items).values(item).run();
      postMovement(tx, {
        variant_id: item.variant_id,
        date: input.date,
        qty_change: -item.qty,
        unit_cost_paisa: item.unit_cost_paisa,
        source_type: 'sale',
        source_id: header.id,
      });
    }
    recomputeAverageCosts(
      tx,
      items.map((i) => i.variant_id),
    );

    if (ev.total_paisa > 0) {
      postEntry(tx, {
        party_type: 'customer',
        party_id: customer.id,
        date: input.date,
        debit_paisa: ev.total_paisa,
        entry_type: 'sale',
        source_type: 'sale',
        source_id: header.id,
        narration: `Invoice ${header.doc_no}`,
      });
    }

    writeAudit(tx, auditActor(user), {
      action: 'create',
      entity: 'sale',
      entity_id: header.id,
      doc_no: header.doc_no,
      version_after: 1,
      after: {
        ...header,
        customer_code: customer.code,
        customer_name: customer.name,
        lines: items.map(({ sale_id: _s, ...item }, i) => {
          const l = ev.lines[i] as EvaluatedLine;
          return { ...item, item_code: l.product.item_code, name: l.product.name, color: l.variant.color, size: l.variant.size };
        }),
      },
      summary: {
        customer_id: customer.id,
        customer_name: customer.name,
        total_paisa: ev.total_paisa,
        profit_paisa: ev.profit_paisa,
        lines: items.length,
        qty: items.reduce((a, i) => a + i.qty, 0),
        cash_received_paisa: input.cash_received_paisa,
        ...(approvedBy ? { approved_by: approvedBy.id, approved_for: [...new Set(ev.issues.filter((i) => i.severity === 'approval').map((i) => i.kind))] } : {}),
      },
      flags: ev.flags,
    });

    if (input.cash_received_paisa > 0) postCounterReceipt(tx, user, header, customer, input.cash_received_paisa);
    // Any advance the customer holds is applied to this invoice.
    recalcAllocations(tx, customer.id);

    return getSale(tx, header.id);
  });
}

/** Cash at the counter (CLAUDE.md 8.3): a separate receipt, allocated to this invoice. */
function postCounterReceipt(tx: DbOrTx, user: SessionUser, sale: typeof sales.$inferSelect, customer: CustomerRow, amount: number): void {
  const now = nowIso();
  const payment = tx
    .insert(payments)
    .values({
      doc_no: nextDocNo(tx, 'receipt'),
      kind: 'receipt',
      party_type: 'customer',
      party_id: customer.id,
      date: sale.date,
      amount_paisa: amount,
      method: 'cash',
      status: 'posted',
      sale_id: sale.id,
      version: 1,
      notes: `Cash received with ${sale.doc_no}`,
      created_by: user.id,
      updated_by: user.id,
      created_at: now,
      updated_at: now,
    })
    .returning()
    .get();
  // Manual: the money was paid for this invoice, so automatic re-allocation keeps it there.
  const allocation = tx
    .insert(payment_allocations)
    .values({ customer_id: customer.id, source_type: 'payment', source_id: payment.id, sale_id: sale.id, amount_paisa: amount, is_manual: true, created_at: now })
    .returning()
    .get();
  postEntry(tx, {
    party_type: 'customer',
    party_id: customer.id,
    date: sale.date,
    credit_paisa: amount,
    entry_type: 'receipt',
    source_type: 'payment',
    source_id: payment.id,
    narration: `Cash received with ${sale.doc_no} (${payment.doc_no})`,
  });
  writeAudit(tx, auditActor(user), {
    action: 'create',
    entity: 'payment',
    entity_id: payment.id,
    doc_no: payment.doc_no,
    version_after: 1,
    after: { ...payment, allocations: [{ sale_id: sale.id, sale_doc_no: sale.doc_no, amount_paisa: allocation.amount_paisa, is_manual: true }] },
    summary: { customer_id: customer.id, customer_name: customer.name, amount_paisa: amount, sale_doc_no: sale.doc_no },
    flags: user.role === 'operator' ? ['by_operator'] : [],
  });
}

// --- Reading ---------------------------------------------------------------------

const createdBy = alias(users, 'created_by_user');
const approvedBy = alias(users, 'approved_by_user');

// Outer columns are written with their table name: a bare "id" inside a
// subquery would bind to the subquery's own table.
const paidSql = sql<number>`coalesce((SELECT sum(pa.amount_paisa) FROM payment_allocations pa WHERE pa.sale_id = "sales"."id"), 0)`;
const profitSql = sql<number>`coalesce((SELECT sum(si.profit_paisa) FROM sale_items si WHERE si.sale_id = "sales"."id"), 0)`;
const returnedProfitSql = sql<number>`coalesce((SELECT sum(ri.profit_reversed_paisa) FROM sales_return_items ri JOIN sales_returns sr ON sr.id = ri.return_id WHERE sr.sale_id = "sales"."id" AND sr.status = 'posted'), 0)`;

const headerSelect = {
  s: sales,
  c: customers,
  created_by_name: createdBy.display_name,
  approved_by_name: approvedBy.display_name,
  paid: paidSql,
  profit: profitSql,
  returned_profit: returnedProfitSql,
  item_count: sql<number>`(SELECT count(*) FROM sale_items si WHERE si.sale_id = "sales"."id")`,
  total_qty: sql<number>`(SELECT coalesce(sum(si.qty), 0) FROM sale_items si WHERE si.sale_id = "sales"."id")`,
};

interface HeaderRow {
  s: typeof sales.$inferSelect;
  c: CustomerRow;
  created_by_name: string | null;
  approved_by_name: string | null;
  paid: number;
  profit: number;
  returned_profit: number;
  item_count: number;
  total_qty: number;
  days_past_due: number;
}

function headerQuery(db: DbOrTx) {
  return db
    .select({ ...headerSelect, days_past_due: daysPastDueSql(sql`${sales.due_date}`, businessToday()) })
    .from(sales)
    .innerJoin(customers, eq(customers.id, sales.customer_id))
    .leftJoin(createdBy, eq(createdBy.id, sales.created_by))
    .leftJoin(approvedBy, eq(approvedBy.id, sales.approved_by));
}

/** `grace`: settings.grace_days. Overdue = posted, outstanding > 0 and past due by more than the grace days. */
function toSale(r: HeaderRow, grace: number): Sale {
  const { s, c } = r;
  const outstanding = s.status === 'posted' ? s.total_paisa - r.paid : 0;
  return {
    id: s.id,
    doc_no: s.doc_no,
    customer_id: c.id,
    customer_code: c.code,
    customer_name: c.name,
    customer_business_name: c.business_name,
    customer_type: c.type,
    customer_status: c.status,
    customer_phone: c.phone,
    customer_city: c.city,
    customer_address: c.address,
    date: s.date,
    payment_terms_days: s.payment_terms_days,
    due_date: s.due_date,
    gross_paisa: s.gross_paisa,
    line_discount_paisa: s.line_discount_paisa,
    extra_discount_paisa: s.extra_discount_paisa,
    tax_paisa: s.tax_paisa,
    total_paisa: s.total_paisa,
    paid_paisa: r.paid,
    outstanding_paisa: outstanding,
    days_overdue: outstanding > 0 && r.days_past_due > grace ? r.days_past_due : null,
    profit_paisa: s.status === 'posted' ? r.profit : 0,
    returned_profit_paisa: s.status === 'posted' ? r.returned_profit : 0,
    status: s.status,
    version: s.version,
    notes: s.notes,
    approved_by_name: r.approved_by_name,
    created_at: s.created_at,
    created_by_name: r.created_by_name,
    item_count: r.item_count,
    total_qty: r.total_qty,
  };
}

function loadLines(db: DbOrTx, saleId: number): SaleLine[] {
  const returned = new Map(
    db
      .select({ id: sales_return_items.sale_item_id, q: sql<number>`sum(${sales_return_items.qty})` })
      .from(sales_return_items)
      .innerJoin(sales_returns, eq(sales_returns.id, sales_return_items.return_id))
      .where(and(eq(sales_returns.sale_id, saleId), eq(sales_returns.status, 'posted')))
      .groupBy(sales_return_items.sale_item_id)
      .all()
      .map((r) => [r.id, r.q]),
  );
  return db
    .select({ i: sale_items, v: product_variants, p: products })
    .from(sale_items)
    .innerJoin(product_variants, eq(product_variants.id, sale_items.variant_id))
    .innerJoin(products, eq(products.id, product_variants.product_id))
    .where(eq(sale_items.sale_id, saleId))
    .orderBy(asc(sale_items.line_no))
    .all()
    .map(({ i, v, p }) => ({
      id: i.id,
      line_no: i.line_no,
      returned_qty: returned.get(i.id) ?? 0,
      variant_id: i.variant_id,
      product_id: p.id,
      item_code: p.item_code,
      name: p.name,
      color: v.color,
      size: v.size,
      unit: p.unit,
      qty: i.qty,
      list_price_paisa: i.list_price_paisa,
      default_discount_bp: i.default_discount_bp,
      discount_bp: i.discount_bp,
      discount_overridden: i.discount_overridden,
      line_gross_paisa: i.line_gross_paisa,
      line_discount_paisa: i.line_discount_paisa,
      line_amount_paisa: i.line_gross_paisa - i.line_discount_paisa,
      line_net_paisa: i.line_net_paisa,
      unit_cost_paisa: i.unit_cost_paisa,
      cost_source: i.cost_source,
      line_cost_paisa: i.line_cost_paisa,
      profit_paisa: i.profit_paisa,
    }));
}

export function getSale(db: DbOrTx, id: number): Sale {
  const r = headerQuery(db).where(eq(sales.id, id)).get();
  if (!r) throw notFound('Sale not found.');
  return { ...toSale(r, getSetting(db, 'grace_days')), lines: loadLines(db, id), allocations: saleAllocations(db, id), returns: saleReturns(db, id) };
}

/** Receipts, credit notes and write-offs that reduced this invoice. */
function saleAllocations(db: DbOrTx, saleId: number): NonNullable<Sale['allocations']> {
  const docNo = sql<string | null>`CASE ${payment_allocations.source_type}
    WHEN 'payment' THEN (SELECT doc_no FROM payments WHERE id = ${payment_allocations.source_id})
    WHEN 'sales_return' THEN (SELECT doc_no FROM sales_returns WHERE id = ${payment_allocations.source_id})
    WHEN 'write_off' THEN (SELECT doc_no FROM write_offs WHERE id = ${payment_allocations.source_id})
    ELSE NULL END`;
  const date = sql<string | null>`CASE ${payment_allocations.source_type}
    WHEN 'payment' THEN (SELECT date FROM payments WHERE id = ${payment_allocations.source_id})
    WHEN 'sales_return' THEN (SELECT date FROM sales_returns WHERE id = ${payment_allocations.source_id})
    WHEN 'write_off' THEN (SELECT date FROM write_offs WHERE id = ${payment_allocations.source_id})
    ELSE NULL END`;
  const method = sql<string | null>`CASE ${payment_allocations.source_type} WHEN 'payment' THEN (SELECT method FROM payments WHERE id = ${payment_allocations.source_id}) ELSE NULL END`;
  return db
    .select({ source_type: payment_allocations.source_type, source_id: payment_allocations.source_id, doc_no: docNo, date, method, amount_paisa: payment_allocations.amount_paisa, is_manual: payment_allocations.is_manual })
    .from(payment_allocations)
    .where(eq(payment_allocations.sale_id, saleId))
    .orderBy(asc(date), asc(payment_allocations.id))
    .all();
}

function saleReturns(db: DbOrTx, saleId: number): NonNullable<Sale['returns']> {
  return db
    .select({ id: sales_returns.id, doc_no: sales_returns.doc_no, date: sales_returns.date, reason: sales_returns.reason, total_paisa: sales_returns.total_paisa, status: sales_returns.status })
    .from(sales_returns)
    .where(eq(sales_returns.sale_id, saleId))
    .orderBy(asc(sales_returns.id))
    .all();
}

export function listSales(db: DB, q: ListQuery): { sales: Sale[]; total: number } {
  const conds: (SQL | undefined)[] = [];
  if (q.from) conds.push(gte(sales.date, q.from));
  if (q.to) conds.push(lte(sales.date, q.to));
  if (q.customer_id) conds.push(eq(sales.customer_id, q.customer_id));
  if (q.status !== 'all') conds.push(eq(sales.status, q.status));
  if (q.q) {
    for (const word of q.q.split(/\s+/).filter(Boolean)) {
      const like = `%${word.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
      conds.push(
        sql`(${sales.doc_no} LIKE ${like} ESCAPE '\\' OR ${customers.code} LIKE ${like} ESCAPE '\\' OR ${customers.name} LIKE ${like} ESCAPE '\\' OR coalesce(${customers.business_name}, '') LIKE ${like} ESCAPE '\\' OR coalesce(${customers.city}, '') LIKE ${like} ESCAPE '\\')`,
      );
    }
  }
  const where = and(...conds);
  const total = db.select({ n: sql<number>`count(*)` }).from(sales).innerJoin(customers, eq(customers.id, sales.customer_id)).where(where).get()?.n ?? 0;
  const rows = headerQuery(db).where(where).orderBy(desc(sales.date), desc(sales.id)).limit(q.limit).offset(q.offset).all();
  const grace = getSetting(db, 'grace_days');
  return { sales: rows.map((r) => toSale(r, grace)), total };
}

/**
 * "Previous balance · This invoice · Total outstanding" for the invoice
 * (CLAUDE.md 12), as at the moment the invoice was posted, so a reprint
 * shows the same figures. Previous balance is every customer ledger entry
 * before this invoice's entry; cash taken at the counter with the sale is
 * taken off the total.
 */
export function invoiceBalances(db: DbOrTx, sale: Sale): { previous_balance_paisa: number; paid_now_paisa: number; total_outstanding_paisa: number } {
  const entry = db
    .select({ id: ledger_entries.id })
    .from(ledger_entries)
    .where(and(eq(ledger_entries.source_type, 'sale'), eq(ledger_entries.source_id, sale.id), eq(ledger_entries.entry_type, 'sale')))
    .get();
  const party = and(eq(ledger_entries.party_type, 'customer'), eq(ledger_entries.party_id, sale.customer_id));
  // A fully discounted invoice has no ledger entry: take everything up to its date, except its own counter cash.
  const before = entry
    ? or(lt(ledger_entries.date, sale.date), and(eq(ledger_entries.date, sale.date), lt(ledger_entries.id, entry.id)))
    : and(lte(ledger_entries.date, sale.date), sql`NOT (${ledger_entries.source_type} = 'payment' AND ${ledger_entries.source_id} IN (SELECT id FROM payments WHERE sale_id = ${sale.id}))`);
  const previous =
    db
      .select({ b: sql<number>`coalesce(sum(${ledger_entries.debit_paisa}) - sum(${ledger_entries.credit_paisa}), 0)` })
      .from(ledger_entries)
      .where(and(party, before))
      .get()?.b ?? 0;
  const paidNow =
    db
      .select({ a: sql<number>`coalesce(sum(${payments.amount_paisa}), 0)` })
      .from(payments)
      .where(and(eq(payments.sale_id, sale.id), eq(payments.status, 'posted')))
      .get()?.a ?? 0;
  const thisInvoice = sale.status === 'posted' ? sale.total_paisa : 0;
  return { previous_balance_paisa: previous, paid_now_paisa: paidNow, total_outstanding_paisa: previous + thisInvoice - paidNow };
}
