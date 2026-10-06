import { and, asc, desc, eq, gte, inArray, lt, lte, or, sql, type SQL } from 'drizzle-orm';
import { alias } from 'drizzle-orm/sqlite-core';
import {
  bpToPercentString,
  can,
  createSaleSchema,
  formatPaisa,
  saleCheckSchema,
  saleListQuerySchema,
  updateSaleSchema,
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
import { assertCanEdit, assertCanVoid, changeFlags, diffSnapshots, diffSummary, dryRun, totalFlags, uniqueFlags } from '../../lib/documents';
import { badRequest, conflict, notFound } from '../../lib/errors';
import { partyBalance, postEntry, removeEntriesForSource } from '../../lib/ledger';
import { nextDocNo } from '../../lib/numbering';
import type { SessionUser } from '../../lib/permissions';
import { addDaysToDate, defaultDiscountBp, pricingRuleHits, saleLineAmounts, type PricingRule, type PricingRuleHit } from '../../lib/pricing';
import { computeSale, profitBp, saleUnitCost, type CostSource, type SaleLineResult } from '../../lib/profit';
import { postMovement, recomputeAverageCosts, removeMovementsForSource, stockOnHandMany } from '../../lib/stock';
import { auditActor } from '../auth/service';
import { voidPaymentTx } from '../payments/service';
import { getSetting, getSettings } from '../settings/service';

type CreateInput = z.output<typeof createSaleSchema>;
type CheckInput = z.output<typeof saleCheckSchema>;
type UpdateInput = z.output<typeof updateSaleSchema>;
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
 * What a line already on an invoice keeps when the invoice is edited: the
 * price and cost it was sold at, and (same customer only) the suggested
 * discount. Newly added items use today's price and cost.
 */
export interface KeptLine {
  list_price_paisa: number;
  unit_cost_paisa: number;
  cost_source: CostSource;
  default_discount_bp: number | null;
}

/**
 * Prices a draft sale and runs every safety rule. Prices always come from the
 * product (or, when editing, the price the item was originally sold at),
 * never from the request. Messages are worded for `user`: only holders of
 * finance.view get the detailed pricing reasons.
 */
export function evaluateSale(db: DbOrTx, user: SessionUser, input: CheckInput, keep: ReadonlyMap<number, KeptLine> = new Map()): Evaluation {
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
    const kept = keep.get(l.variant_id);
    // Items already on an edited invoice may stay even if they were deactivated since.
    if (!kept && (!r.v.active || !r.p.active)) throw badRequest(`${r.v.sku} is inactive and cannot be sold.`);
    const def =
      kept?.default_discount_bp ??
      defaultDiscountBp({
        productDiscountBp: r.p.default_customer_discount_bp,
        settingsDiscountBp: settings.default_customer_discount_bp,
        customerType: customer?.type ?? 'wholesaler',
        retailReductionBp: settings.retail_discount_reduction_bp,
      });
    return {
      variant: r.v,
      product: r.p,
      qty: l.qty,
      list_price_paisa: kept?.list_price_paisa ?? r.p.list_price_paisa,
      default_discount_bp: def,
      discount_bp: l.discount_bp,
      discount_overridden: l.discount_bp !== def,
      ...(kept ? { unit_cost_paisa: kept.unit_cost_paisa, cost_source: kept.cost_source } : saleUnitCost(r.v.avg_cost_paisa, r.p.list_price_paisa, r.p.supplier_margin_bp)),
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

function toCheckResult(ev: Evaluation): SaleCheckResult {
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

/** The live check for the New Sale screen. The route redacts cost and profit for operators. */
export function checkSale(db: DB, user: SessionUser, input: CheckInput): SaleCheckResult {
  return toCheckResult(evaluateSale(db, user, input));
}

/**
 * The live check while editing an invoice: worked out as if the invoice's
 * own stock and ledger effects were already taken off, then rolled back.
 */
export function checkSaleEdit(db: DB, user: SessionUser, id: number, input: CheckInput): SaleCheckResult {
  return dryRun(db, (tx) => {
    const prep = prepareEdit(tx, id, input.customer_id ?? null);
    return toCheckResult(evaluateSale(tx, user, { ...input, cash_received_paisa: prep.counterTotal }, prep.keep));
  });
}

// --- Snapshots (audit log and change history) ---------------------------------------

/** A sale as stored: header, customer and lines with item names. Used for before/after in the audit log. */
export function saleSnapshot(db: DbOrTx, id: number) {
  const s = db.select().from(sales).where(eq(sales.id, id)).get();
  if (!s) throw notFound('Sale not found.');
  const c = db.select({ code: customers.code, name: customers.name }).from(customers).where(eq(customers.id, s.customer_id)).get();
  const lines = db
    .select({ i: sale_items, v: product_variants, p: products })
    .from(sale_items)
    .innerJoin(product_variants, eq(product_variants.id, sale_items.variant_id))
    .innerJoin(products, eq(products.id, product_variants.product_id))
    .where(eq(sale_items.sale_id, id))
    .orderBy(asc(sale_items.line_no))
    .all()
    .map(({ i, v, p }) => {
      const { sale_id: _s, ...item } = i;
      return { ...item, item_code: p.item_code, name: p.name, color: v.color, size: v.size, unit: p.unit };
    });
  return { ...s, customer_code: c?.code ?? null, customer_name: c?.name ?? null, lines };
}
export type SaleSnapshot = ReturnType<typeof saleSnapshot>;

const saleLineKey = (l: Record<string, unknown>) => String(l.variant_id);
const saleLineLabel = (l: Record<string, unknown>) => [l.item_code, l.color, l.size].filter(Boolean).join(' ');

// --- Posting pieces shared by create and edit ---------------------------------------------

type SaleItemRow = typeof sale_items.$inferSelect;

/**
 * Writes the invoice lines. When editing, existing rows are reused by item
 * (so returns that point at them stay linked); rows for items no longer on
 * the invoice are removed.
 */
function writeSaleItems(tx: DbOrTx, saleId: number, ev: Evaluation, existing: readonly SaleItemRow[] = []): void {
  const pool = new Map<number, SaleItemRow[]>();
  for (const row of existing) pool.set(row.variant_id, [...(pool.get(row.variant_id) ?? []), row]);
  ev.lines.forEach((l, i) => {
    const values = {
      sale_id: saleId,
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
    };
    const reuse = pool.get(l.variant.id)?.shift();
    if (reuse) tx.update(sale_items).set(values).where(eq(sale_items.id, reuse.id)).run();
    else tx.insert(sale_items).values(values).run();
  });
  const gone = [...pool.values()].flat();
  if (gone.length) {
    const referenced = tx
      .select({ id: sales_return_items.sale_item_id })
      .from(sales_return_items)
      .where(inArray(sales_return_items.sale_item_id, gone.map((g) => g.id)))
      .get();
    if (referenced) throw badRequest('An item that was returned (on a void return) cannot be removed from the invoice. Change its quantity instead.');
    tx.delete(sale_items).where(inArray(sale_items.id, gone.map((g) => g.id))).run();
  }
}

/** Stock out for every line and the customer ledger debit. */
function postSaleEffects(tx: DbOrTx, sale: { id: number; doc_no: string; customer_id: number; date: string; total_paisa: number }, ev: Evaluation): void {
  for (const l of ev.lines) {
    postMovement(tx, { variant_id: l.variant.id, date: sale.date, qty_change: -l.qty, unit_cost_paisa: l.unit_cost_paisa, source_type: 'sale', source_id: sale.id });
  }
  if (sale.total_paisa > 0) {
    postEntry(tx, {
      party_type: 'customer',
      party_id: sale.customer_id,
      date: sale.date,
      debit_paisa: sale.total_paisa,
      entry_type: 'sale',
      source_type: 'sale',
      source_id: sale.id,
      narration: `Invoice ${sale.doc_no}`,
    });
  }
}

/** Takes off everything a sale posted (stock and its ledger debit). Returns the variants touched. */
function removeSaleEffects(tx: DbOrTx, saleId: number): number[] {
  removeEntriesForSource(tx, 'sale', saleId, 'sale');
  return removeMovementsForSource(tx, 'sale', saleId);
}

function postedReturnsOf(tx: DbOrTx, saleId: number): string[] {
  return tx
    .select({ doc_no: sales_returns.doc_no })
    .from(sales_returns)
    .where(and(eq(sales_returns.sale_id, saleId), eq(sales_returns.status, 'posted')))
    .all()
    .map((r) => r.doc_no);
}

/** Cash taken at the counter with this sale that is still posted. */
function counterReceiptsOf(tx: DbOrTx, saleId: number) {
  return tx
    .select()
    .from(payments)
    .where(and(eq(payments.sale_id, saleId), eq(payments.status, 'posted')))
    .all();
}

/**
 * Checks an invoice can be edited and takes its effects off, ready to post
 * the new version. Shared by the edit and its live check.
 */
function prepareEdit(tx: DbOrTx, id: number, newCustomerId: number | null) {
  const before = tx.select().from(sales).where(eq(sales.id, id)).get();
  if (!before) throw notFound('Sale not found.');
  const returned = postedReturnsOf(tx, id);
  if (returned.length) throw badRequest(`This invoice has returns (${returned.join(', ')}). Void or edit the return first.`);
  const counter = counterReceiptsOf(tx, id);
  if (newCustomerId !== null && newCustomerId !== before.customer_id && counter.length) {
    throw badRequest(`Cash was taken at the counter with this invoice (${counter.map((c) => c.doc_no).join(', ')}). Void that receipt before changing the customer.`);
  }
  const existing = tx.select().from(sale_items).where(eq(sale_items.sale_id, id)).all();
  const sameCustomer = newCustomerId === null || newCustomerId === before.customer_id;
  const keep = new Map<number, KeptLine>(
    existing.map((i) => [i.variant_id, { list_price_paisa: i.list_price_paisa, unit_cost_paisa: i.unit_cost_paisa, cost_source: i.cost_source, default_discount_bp: sameCustomer ? i.default_discount_bp : null }]),
  );
  const variantsBefore = removeSaleEffects(tx, id);
  return { before, existing, keep, variantsBefore, counterTotal: counter.reduce((a, c) => a + c.amount_paisa, 0), counter };
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

    writeSaleItems(tx, header.id, ev);
    postSaleEffects(tx, header, ev);
    recomputeAverageCosts(
      tx,
      ev.lines.map((l) => l.variant.id),
    );

    writeAudit(tx, auditActor(user), {
      action: 'create',
      entity: 'sale',
      entity_id: header.id,
      doc_no: header.doc_no,
      version_after: 1,
      after: saleSnapshot(tx, header.id),
      summary: {
        customer_id: customer.id,
        customer_name: customer.name,
        total_paisa: ev.total_paisa,
        profit_paisa: ev.profit_paisa,
        lines: ev.lines.length,
        qty: ev.lines.reduce((a, l) => a + l.qty, 0),
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

// --- Editing and voiding (CLAUDE.md 8.6) ---------------------------------------------

/**
 * Edits a posted invoice in one transaction: its stock and ledger effects
 * are taken off, the new version is priced (items already on it keep their
 * original price and cost) and posted, allocations are recalculated, and one
 * audit row records before and after. The same approval rules apply as for
 * a new sale.
 */
export function updateSale(db: DB, user: SessionUser, id: number, input: UpdateInput, approver: AuditActor | null): Sale {
  if (input.date > businessToday()) throw badRequest('The sale date cannot be in the future.');

  return writeTx(db, (tx) => {
    const current = tx.select().from(sales).where(eq(sales.id, id)).get();
    if (!current) throw notFound('Sale not found.');
    assertCanEdit(user, current, 'sales.create');
    const beforeSnap = saleSnapshot(tx, id);
    const prep = prepareEdit(tx, id, input.customer_id);
    const { before } = prep;

    const ev = evaluateSale(tx, user, { ...input, cash_received_paisa: prep.counterTotal }, prep.keep);
    const customer = ev.customer as CustomerRow;
    if (customer.id !== before.customer_id && customer.status === 'inactive') throw badRequest(`${customer.name} is inactive. Make the customer active first.`);
    if (input.expected_total_paisa !== undefined && input.expected_total_paisa !== ev.total_paisa) {
      throw conflict(`A price changed while you were editing. The total is now ${formatPaisa(ev.total_paisa)}. Check the lines and save again.`, 'PRICE_CHANGED');
    }
    if (prep.counterTotal > ev.total_paisa) {
      throw badRequest(`Cash taken at the counter (${formatPaisa(prep.counterTotal)}) is more than the new total. Edit the receipt (${prep.counter.map((c) => c.doc_no).join(', ')}) first.`);
    }
    if (ev.needs_approval && !approver) throw conflict('This change needs owner approval.', 'APPROVAL_REQUIRED', { issues: ev.issues });

    const after = tx
      .update(sales)
      .set({
        customer_id: customer.id,
        date: input.date,
        payment_terms_days: ev.payment_terms_days,
        due_date: ev.due_date as string,
        gross_paisa: ev.gross_paisa,
        line_discount_paisa: ev.line_discount_paisa,
        extra_discount_paisa: ev.extra_discount_paisa,
        tax_paisa: ev.tax_paisa,
        total_paisa: ev.total_paisa,
        notes: input.notes,
        approved_by: ev.needs_approval ? (approver?.id ?? null) : null,
        version: before.version + 1,
        updated_by: user.id,
        updated_at: nowIso(),
      })
      .where(eq(sales.id, id))
      .returning()
      .get();
    writeSaleItems(tx, id, ev, prep.existing);
    postSaleEffects(tx, after, ev);
    recomputeAverageCosts(tx, [...prep.variantsBefore, ...ev.lines.map((l) => l.variant.id)]);

    if (customer.id !== before.customer_id) {
      // Money from the old customer can no longer pay this invoice.
      tx.delete(payment_allocations).where(eq(payment_allocations.sale_id, id)).run();
      recalcAllocations(tx, before.customer_id);
    }
    recalcAllocations(tx, customer.id);

    const afterSnap = saleSnapshot(tx, id);
    const diff = diffSnapshots(beforeSnap, afterSnap, saleLineKey, saleLineLabel);
    const profitBefore = beforeSnap.lines.reduce((a, l) => a + l.profit_paisa, 0);
    writeAudit(tx, auditActor(user), {
      action: 'edit',
      entity: 'sale',
      entity_id: id,
      doc_no: before.doc_no,
      version_before: before.version,
      version_after: after.version,
      before: beforeSnap,
      after: afterSnap,
      summary: {
        ...diffSummary(diff),
        customer_id: customer.id,
        customer_name: customer.name,
        total_before_paisa: before.total_paisa,
        total_after_paisa: after.total_paisa,
        profit_before_paisa: profitBefore,
        profit_after_paisa: ev.profit_paisa,
        ...(ev.needs_approval && approver ? { approved_by: approver.id } : {}),
      },
      flags: uniqueFlags(
        changeFlags(tx, user, 'sale', id, before.created_at),
        totalFlags(before.total_paisa, after.total_paisa),
        customer.id !== before.customer_id ? ['customer_changed'] : [],
        ev.flags,
      ),
      reason: input.change_reason,
    });
    return getSale(tx, id);
  });
}

/**
 * Owner+: voids an invoice. It stays visible with a VOID stamp; its stock,
 * ledger debit and allocations are taken off. Cash taken at the counter with
 * it is voided in the same step (its own audit row). Returns must be voided
 * first.
 */
export function voidSale(db: DB, user: SessionUser, id: number, reason: string): Sale {
  return writeTx(db, (tx) => {
    const before = tx.select().from(sales).where(eq(sales.id, id)).get();
    if (!before) throw notFound('Sale not found.');
    assertCanVoid(user, before);
    const returned = postedReturnsOf(tx, id);
    if (returned.length) throw badRequest(`This invoice has returns (${returned.join(', ')}). Void them first.`);
    const beforeSnap = saleSnapshot(tx, id);

    for (const p of counterReceiptsOf(tx, id)) voidPaymentTx(tx, user, p.id, `Voided with invoice ${before.doc_no}: ${reason}`);
    const variants = removeSaleEffects(tx, id);
    tx.delete(payment_allocations).where(eq(payment_allocations.sale_id, id)).run();
    tx.update(sales).set({ status: 'void', version: before.version + 1, updated_by: user.id, updated_at: nowIso() }).where(eq(sales.id, id)).run();
    recomputeAverageCosts(tx, variants);
    recalcAllocations(tx, before.customer_id);

    writeAudit(tx, auditActor(user), {
      action: 'void',
      entity: 'sale',
      entity_id: id,
      doc_no: before.doc_no,
      version_before: before.version,
      version_after: before.version + 1,
      before: beforeSnap,
      after: saleSnapshot(tx, id),
      summary: { customer_id: before.customer_id, customer_name: beforeSnap.customer_name, total_before_paisa: before.total_paisa, total_after_paisa: 0 },
      flags: uniqueFlags(changeFlags(tx, user, 'sale', id, before.created_at), ['voided']),
      reason,
    });
    return getSale(tx, id);
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
    created_by_id: s.created_by,
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
