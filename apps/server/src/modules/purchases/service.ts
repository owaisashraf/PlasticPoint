import { and, asc, desc, eq, gte, inArray, lte, sql, type SQL } from 'drizzle-orm';
import {
  can,
  createPurchaseReturnSchema,
  createPurchaseSchema,
  purchaseListQuerySchema,
  updatePurchaseReturnSchema,
  updatePurchaseSchema,
  type Purchase,
  type PurchaseLineInput,
  type PurchaseLine,
  type PurchaseReturn,
} from '@shopledger/shared';
import type { z } from 'zod';
import { writeTx, type DB, type DbOrTx } from '../../db/client';
import { product_variants, products, purchase_items, purchase_return_items, purchase_returns, purchases, suppliers, users } from '../../db/schema';
import { writeAudit } from '../../lib/audit';
import { businessToday, nowIso } from '../../lib/dates';
import { assertCanEdit, assertCanVoid, changeFlags, diffSnapshots, diffSummary, totalFlags, uniqueFlags } from '../../lib/documents';
import { badRequest, forbidden, notFound } from '../../lib/errors';
import { postEntry, removeEntriesForSource } from '../../lib/ledger';
import { roundDiv } from '../../lib/money';
import { nextDocNo } from '../../lib/numbering';
import type { SessionUser } from '../../lib/permissions';
import { purchaseLineAmounts, type PurchaseLineAmounts } from '../../lib/pricing';
import { postMovement, recomputeAverageCosts, removeMovementsForSource, stockOnHandMany } from '../../lib/stock';
import { auditActor } from '../auth/service';
import { setProductPricing } from '../products/service';

type CreateInput = z.output<typeof createPurchaseSchema>;
type ReturnInput = z.output<typeof createPurchaseReturnSchema>;
type ListQuery = z.output<typeof purchaseListQuerySchema>;
type UpdateInput = z.output<typeof updatePurchaseSchema>;
type UpdateReturnInput = z.output<typeof updatePurchaseReturnSchema>;

// --- Reading ---------------------------------------------------------------------

function returnedQtyByItem(db: DbOrTx, itemIds: number[]): Map<number, number> {
  const out = new Map<number, number>();
  if (!itemIds.length) return out;
  const rows = db
    .select({ id: purchase_return_items.purchase_item_id, q: sql<number>`sum(${purchase_return_items.qty})` })
    .from(purchase_return_items)
    .innerJoin(purchase_returns, eq(purchase_returns.id, purchase_return_items.return_id))
    .where(and(inArray(purchase_return_items.purchase_item_id, itemIds), eq(purchase_returns.status, 'posted')))
    .groupBy(purchase_return_items.purchase_item_id)
    .all();
  for (const r of rows) out.set(r.id, r.q);
  return out;
}

function loadLines(db: DbOrTx, purchaseId: number): (PurchaseLine & { line_cost_paisa: number; unit_cost_paisa: number })[] {
  const rows = db
    .select({ i: purchase_items, v: product_variants, p: products })
    .from(purchase_items)
    .innerJoin(product_variants, eq(product_variants.id, purchase_items.variant_id))
    .innerJoin(products, eq(products.id, product_variants.product_id))
    .where(eq(purchase_items.purchase_id, purchaseId))
    .orderBy(asc(purchase_items.line_no))
    .all();
  const returned = returnedQtyByItem(
    db,
    rows.map((r) => r.i.id),
  );
  return rows.map(({ i, v, p }) => ({
    id: i.id,
    line_no: i.line_no,
    variant_id: i.variant_id,
    product_id: p.id,
    item_code: p.item_code,
    name: p.name,
    color: v.color,
    size: v.size,
    unit: p.unit,
    qty: i.qty,
    returned_qty: returned.get(i.id) ?? 0,
    list_price_paisa: i.list_price_paisa,
    supplier_margin_bp: i.supplier_margin_bp,
    line_gross_paisa: i.line_gross_paisa,
    line_margin_paisa: i.line_margin_paisa,
    line_cost_paisa: i.line_cost_paisa,
    unit_cost_paisa: i.unit_cost_paisa,
  }));
}

const headerSelect = {
  p: purchases,
  supplier_name: suppliers.name,
  created_by_name: users.display_name,
  item_count: sql<number>`(SELECT count(*) FROM purchase_items pi WHERE pi.purchase_id = "purchases"."id")`,
  total_qty: sql<number>`(SELECT coalesce(sum(pi.qty), 0) FROM purchase_items pi WHERE pi.purchase_id = "purchases"."id")`,
};

type HeaderRow = {
  p: typeof purchases.$inferSelect;
  supplier_name: string;
  created_by_name: string | null;
  item_count: number;
  total_qty: number;
};

function toPurchase(r: HeaderRow): Purchase {
  const { created_by, updated_by: _u, updated_at: _ua, ...p } = r.p;
  return { ...p, supplier_name: r.supplier_name, created_by_id: created_by, created_by_name: r.created_by_name, item_count: r.item_count, total_qty: r.total_qty };
}

export function getPurchase(db: DbOrTx, id: number): Purchase {
  const r = db
    .select(headerSelect)
    .from(purchases)
    .innerJoin(suppliers, eq(suppliers.id, purchases.supplier_id))
    .leftJoin(users, eq(users.id, purchases.created_by))
    .where(eq(purchases.id, id))
    .get();
  if (!r) throw notFound('Purchase not found.');
  const returns = db
    .select({
      id: purchase_returns.id,
      doc_no: purchase_returns.doc_no,
      date: purchase_returns.date,
      reason: purchase_returns.reason,
      total_cost_paisa: purchase_returns.total_cost_paisa,
      status: purchase_returns.status,
    })
    .from(purchase_returns)
    .where(eq(purchase_returns.purchase_id, id))
    .orderBy(asc(purchase_returns.id))
    .all();
  return { ...toPurchase(r), lines: loadLines(db, id), returns };
}

export function listPurchases(db: DB, q: ListQuery): { purchases: Purchase[]; total: number } {
  const conds: (SQL | undefined)[] = [];
  if (q.from) conds.push(gte(purchases.date, q.from));
  if (q.to) conds.push(lte(purchases.date, q.to));
  if (q.q) {
    const like = `%${q.q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    conds.push(sql`(${purchases.doc_no} LIKE ${like} ESCAPE '\\' OR coalesce(${purchases.supplier_ref}, '') LIKE ${like} ESCAPE '\\')`);
  }
  const where = and(...conds);
  const total = db.select({ n: sql<number>`count(*)` }).from(purchases).where(where).get()?.n ?? 0;
  const rows = db
    .select(headerSelect)
    .from(purchases)
    .innerJoin(suppliers, eq(suppliers.id, purchases.supplier_id))
    .leftJoin(users, eq(users.id, purchases.created_by))
    .where(where)
    .orderBy(desc(purchases.date), desc(purchases.id))
    .limit(q.limit)
    .offset(q.offset)
    .all();
  return { purchases: rows.map(toPurchase), total };
}

// --- Snapshots (audit log and change history) ---------------------------------------

/** A purchase as stored, with supplier and line names. Used for before/after in the audit log. */
export function purchaseSnapshot(db: DbOrTx, id: number) {
  const p = db.select().from(purchases).where(eq(purchases.id, id)).get();
  if (!p) throw notFound('Purchase not found.');
  const s = db.select({ name: suppliers.name }).from(suppliers).where(eq(suppliers.id, p.supplier_id)).get();
  const lines = db
    .select({ i: purchase_items, v: product_variants, pr: products })
    .from(purchase_items)
    .innerJoin(product_variants, eq(product_variants.id, purchase_items.variant_id))
    .innerJoin(products, eq(products.id, product_variants.product_id))
    .where(eq(purchase_items.purchase_id, id))
    .orderBy(asc(purchase_items.line_no))
    .all()
    .map(({ i, v, pr }) => {
      const { purchase_id: _p, ...item } = i;
      return { ...item, item_code: pr.item_code, name: pr.name, color: v.color, size: v.size };
    });
  return { ...p, supplier_name: s?.name ?? null, lines };
}

export function purchaseReturnSnapshot(db: DbOrTx, id: number) {
  const r = db.select().from(purchase_returns).where(eq(purchase_returns.id, id)).get();
  if (!r) throw notFound('Purchase return not found.');
  const p = db.select({ doc_no: purchases.doc_no }).from(purchases).where(eq(purchases.id, r.purchase_id)).get();
  const lines = db
    .select({ i: purchase_return_items, v: product_variants, pr: products })
    .from(purchase_return_items)
    .innerJoin(product_variants, eq(product_variants.id, purchase_return_items.variant_id))
    .innerJoin(products, eq(products.id, product_variants.product_id))
    .where(eq(purchase_return_items.return_id, id))
    .orderBy(asc(purchase_return_items.id))
    .all()
    .map(({ i, v, pr }) => {
      const { return_id: _r, ...item } = i;
      return { ...item, item_code: pr.item_code, name: pr.name, color: v.color, size: v.size };
    });
  return { ...r, purchase_doc_no: p?.doc_no ?? null, lines };
}

const lineKey = (l: Record<string, unknown>) => String(l.variant_id);
const lineLabel = (l: Record<string, unknown>) => [l.item_code, l.color, l.size].filter(Boolean).join(' ');

// --- Posting pieces ------------------------------------------------------------------

type ItemRow = typeof purchase_items.$inferSelect;
type PricedLine = PurchaseLineInput & PurchaseLineAmounts & { line_no: number };

function priceLines(lines: readonly PurchaseLineInput[]): PricedLine[] {
  return lines.map((l, i) => ({ ...l, line_no: i + 1, ...purchaseLineAmounts(l.qty, l.list_price_paisa, l.supplier_margin_bp) }));
}

/** Checks the supplier and items. Items already on an edited purchase may stay even if deactivated since. */
function loadSupplierAndVariants(tx: DbOrTx, supplierId: number, lines: readonly PurchaseLineInput[], allowInactive: ReadonlySet<number> = new Set()) {
  const supplier = tx.select().from(suppliers).where(eq(suppliers.id, supplierId)).get();
  if (!supplier) throw badRequest('Pick the supplier.');
  const variantIds = [...new Set(lines.map((l) => l.variant_id))];
  const variants = new Map(
    tx
      .select({ v: product_variants, p: products })
      .from(product_variants)
      .innerJoin(products, eq(products.id, product_variants.product_id))
      .where(inArray(product_variants.id, variantIds))
      .all()
      .map((r) => [r.v.id, r]),
  );
  for (const l of lines) {
    const found = variants.get(l.variant_id);
    if (!found) throw badRequest('One of the items no longer exists. Reload and try again.');
    if ((!found.v.active || !found.p.active) && !allowInactive.has(l.variant_id)) throw badRequest(`${found.v.sku} is inactive and cannot be bought.`);
  }
  return { supplier, variants };
}

/** Writes purchase lines; when editing, rows are reused by item so returns stay linked. */
function writePurchaseItems(tx: DbOrTx, purchaseId: number, lines: readonly PricedLine[], existing: readonly ItemRow[] = []): void {
  const pool = new Map<number, ItemRow[]>();
  for (const row of existing) pool.set(row.variant_id, [...(pool.get(row.variant_id) ?? []), row]);
  for (const l of lines) {
    const values = {
      purchase_id: purchaseId,
      line_no: l.line_no,
      variant_id: l.variant_id,
      qty: l.qty,
      list_price_paisa: l.list_price_paisa,
      supplier_margin_bp: l.supplier_margin_bp,
      line_gross_paisa: l.line_gross_paisa,
      line_margin_paisa: l.line_margin_paisa,
      line_cost_paisa: l.line_cost_paisa,
      unit_cost_paisa: l.unit_cost_paisa,
    };
    const reuse = pool.get(l.variant_id)?.shift();
    if (reuse) tx.update(purchase_items).set(values).where(eq(purchase_items.id, reuse.id)).run();
    else tx.insert(purchase_items).values(values).run();
  }
  const gone = [...pool.values()].flat();
  if (gone.length) {
    const referenced = tx
      .select({ id: purchase_return_items.purchase_item_id })
      .from(purchase_return_items)
      .where(inArray(purchase_return_items.purchase_item_id, gone.map((g) => g.id)))
      .get();
    if (referenced) throw badRequest('An item that was returned (on a void return) cannot be removed from the purchase. Change its quantity instead.');
    tx.delete(purchase_items).where(inArray(purchase_items.id, gone.map((g) => g.id))).run();
  }
}

function postPurchaseEffects(tx: DbOrTx, p: { id: number; doc_no: string; supplier_id: number; date: string; supplier_ref: string | null; total_cost_paisa: number }, lines: readonly PricedLine[]): void {
  for (const l of lines) {
    postMovement(tx, { variant_id: l.variant_id, date: p.date, qty_change: l.qty, unit_cost_paisa: l.unit_cost_paisa, source_type: 'purchase', source_id: p.id });
  }
  if (p.total_cost_paisa > 0) {
    postEntry(tx, {
      party_type: 'supplier',
      party_id: p.supplier_id,
      date: p.date,
      credit_paisa: p.total_cost_paisa,
      entry_type: 'purchase',
      source_type: 'purchase',
      source_id: p.id,
      narration: `Purchase ${p.doc_no}${p.supplier_ref ? ` (bill ${p.supplier_ref})` : ''}`,
    });
  }
}

/**
 * Taking stock back out (editing or voiding a purchase, or returning to the
 * supplier) must not push an item below zero. Already-negative stock may stay
 * as it is, as long as the change does not make it worse.
 */
function assertStockNotBelowZero(tx: DbOrTx, before: ReadonlyMap<number, number>): void {
  const now = stockOnHandMany(tx, [...before.keys()]);
  for (const [variantId, was] of before) {
    const left = now.get(variantId) ?? 0;
    if (left < 0 && left < was) {
      const v = tx.select({ sku: product_variants.sku }).from(product_variants).where(eq(product_variants.id, variantId)).get();
      throw badRequest(`${v?.sku ?? 'An item'}: stock would go below zero (${left}). Some of it has already been sold.`);
    }
  }
}

function postedReturnsOf(tx: DbOrTx, purchaseId: number): string[] {
  return tx
    .select({ doc_no: purchase_returns.doc_no })
    .from(purchase_returns)
    .where(and(eq(purchase_returns.purchase_id, purchaseId), eq(purchase_returns.status, 'posted')))
    .all()
    .map((r) => r.doc_no);
}

// --- Posting a purchase ----------------------------------------------------------

/**
 * Posts a purchase in one transaction: number, document and lines, supplier
 * ledger credit for the cost total, stock in at each line's unit cost,
 * average cost recalculated, optional product price updates (owner+), and one
 * audit row.
 */
export function createPurchase(db: DB, user: SessionUser, input: CreateInput): Purchase {
  if (input.date > businessToday()) throw badRequest('The purchase date cannot be in the future.');
  if (input.update_products.length && !can(user, 'pricing.manage')) {
    throw forbidden('Only the owner can change product prices.');
  }

  return writeTx(db, (tx) => {
    const { supplier, variants } = loadSupplierAndVariants(tx, input.supplier_id, input.lines);
    if (!supplier.active) throw badRequest('This supplier is inactive.');
    const productIdsInLines = new Set([...variants.values()].map((r) => r.p.id));
    for (const u of input.update_products) {
      if (!productIdsInLines.has(u.product_id)) throw badRequest('A price update refers to a product that is not on this purchase.');
    }

    const lines = priceLines(input.lines);
    const gross = lines.reduce((a, l) => a + l.line_gross_paisa, 0);
    const margin = lines.reduce((a, l) => a + l.line_margin_paisa, 0);
    const cost = gross - margin;
    const now = nowIso();

    const header = tx
      .insert(purchases)
      .values({
        doc_no: nextDocNo(tx, 'purchase'),
        supplier_id: supplier.id,
        date: input.date,
        supplier_ref: input.supplier_ref,
        notes: input.notes,
        gross_paisa: gross,
        margin_paisa: margin,
        total_cost_paisa: cost,
        status: 'posted',
        version: 1,
        created_by: user.id,
        updated_by: user.id,
        created_at: now,
        updated_at: now,
      })
      .returning()
      .get();

    writePurchaseItems(tx, header.id, lines);
    postPurchaseEffects(tx, header, lines);
    recomputeAverageCosts(
      tx,
      lines.map((l) => l.variant_id),
    );

    writeAudit(tx, auditActor(user), {
      action: 'create',
      entity: 'purchase',
      entity_id: header.id,
      doc_no: header.doc_no,
      version_after: 1,
      after: purchaseSnapshot(tx, header.id),
      summary: { total_cost_paisa: cost, lines: lines.length, qty: lines.reduce((a, l) => a + l.qty, 0) },
      flags: user.role === 'operator' ? ['by_operator'] : [],
    });

    for (const u of input.update_products) {
      setProductPricing(tx, user, u.product_id, u, `Updated from purchase ${header.doc_no}`);
    }

    return getPurchase(tx, header.id);
  });
}

/**
 * Edits a posted purchase (CLAUDE.md 8.6): stock and the supplier credit are
 * taken off, the new version is posted, average costs are recalculated, and
 * one audit row records before and after. Not while it has returns.
 */
export function updatePurchase(db: DB, user: SessionUser, id: number, input: UpdateInput): Purchase {
  if (input.date > businessToday()) throw badRequest('The purchase date cannot be in the future.');
  return writeTx(db, (tx) => {
    const before = tx.select().from(purchases).where(eq(purchases.id, id)).get();
    if (!before) throw notFound('Purchase not found.');
    assertCanEdit(user, before, 'purchases.create');
    const returned = postedReturnsOf(tx, id);
    if (returned.length) throw badRequest(`This purchase has returns (${returned.join(', ')}). Void or edit the return first.`);
    const beforeSnap = purchaseSnapshot(tx, id);
    const existing = tx.select().from(purchase_items).where(eq(purchase_items.purchase_id, id)).all();
    const { supplier } = loadSupplierAndVariants(tx, input.supplier_id, input.lines, new Set(existing.map((e) => e.variant_id)));
    if (supplier.id !== before.supplier_id && !supplier.active) throw badRequest('This supplier is inactive.');

    const touched = [...new Set([...existing.map((e) => e.variant_id), ...input.lines.map((l) => l.variant_id)])];
    const stockBefore = stockOnHandMany(tx, touched);
    removeEntriesForSource(tx, 'purchase', id);
    removeMovementsForSource(tx, 'purchase', id);

    const lines = priceLines(input.lines);
    const gross = lines.reduce((a, l) => a + l.line_gross_paisa, 0);
    const margin = lines.reduce((a, l) => a + l.line_margin_paisa, 0);
    const after = tx
      .update(purchases)
      .set({
        supplier_id: supplier.id,
        date: input.date,
        supplier_ref: input.supplier_ref,
        notes: input.notes,
        gross_paisa: gross,
        margin_paisa: margin,
        total_cost_paisa: gross - margin,
        version: before.version + 1,
        updated_by: user.id,
        updated_at: nowIso(),
      })
      .where(eq(purchases.id, id))
      .returning()
      .get();
    writePurchaseItems(tx, id, lines, existing);
    postPurchaseEffects(tx, after, lines);
    assertStockNotBelowZero(tx, stockBefore);
    recomputeAverageCosts(tx, touched);

    const afterSnap = purchaseSnapshot(tx, id);
    const diff = diffSnapshots(beforeSnap, afterSnap, lineKey, lineLabel);
    writeAudit(tx, auditActor(user), {
      action: 'edit',
      entity: 'purchase',
      entity_id: id,
      doc_no: before.doc_no,
      version_before: before.version,
      version_after: after.version,
      before: beforeSnap,
      after: afterSnap,
      summary: { ...diffSummary(diff), total_before_paisa: before.total_cost_paisa, total_after_paisa: after.total_cost_paisa },
      flags: uniqueFlags(changeFlags(tx, user, 'purchase', id, before.created_at), totalFlags(before.total_cost_paisa, after.total_cost_paisa)),
      reason: input.change_reason,
    });
    return getPurchase(tx, id);
  });
}

/** Owner+: voids a purchase. Its stock and supplier credit are taken off; returns must be voided first. */
export function voidPurchase(db: DB, user: SessionUser, id: number, reason: string): Purchase {
  return writeTx(db, (tx) => {
    const before = tx.select().from(purchases).where(eq(purchases.id, id)).get();
    if (!before) throw notFound('Purchase not found.');
    assertCanVoid(user, before);
    const returned = postedReturnsOf(tx, id);
    if (returned.length) throw badRequest(`This purchase has returns (${returned.join(', ')}). Void them first.`);
    const beforeSnap = purchaseSnapshot(tx, id);
    const touched = beforeSnap.lines.map((l) => l.variant_id);
    const stockBefore = stockOnHandMany(tx, touched);
    removeEntriesForSource(tx, 'purchase', id);
    removeMovementsForSource(tx, 'purchase', id);
    assertStockNotBelowZero(tx, stockBefore);
    tx.update(purchases).set({ status: 'void', version: before.version + 1, updated_by: user.id, updated_at: nowIso() }).where(eq(purchases.id, id)).run();
    recomputeAverageCosts(tx, touched);
    writeAudit(tx, auditActor(user), {
      action: 'void',
      entity: 'purchase',
      entity_id: id,
      doc_no: before.doc_no,
      version_before: before.version,
      version_after: before.version + 1,
      before: beforeSnap,
      after: purchaseSnapshot(tx, id),
      summary: { total_before_paisa: before.total_cost_paisa, total_after_paisa: 0 },
      flags: uniqueFlags(changeFlags(tx, user, 'purchase', id, before.created_at), ['voided']),
      reason,
    });
    return getPurchase(tx, id);
  });
}

// --- Purchase returns ------------------------------------------------------------

export function getPurchaseReturn(db: DbOrTx, id: number): PurchaseReturn {
  const r = db
    .select({ r: purchase_returns, purchase_doc_no: purchases.doc_no, supplier_name: suppliers.name, created_by_name: users.display_name })
    .from(purchase_returns)
    .innerJoin(purchases, eq(purchases.id, purchase_returns.purchase_id))
    .innerJoin(suppliers, eq(suppliers.id, purchase_returns.supplier_id))
    .leftJoin(users, eq(users.id, purchase_returns.created_by))
    .where(eq(purchase_returns.id, id))
    .get();
  if (!r) throw notFound('Purchase return not found.');
  const lines = db
    .select({ ri: purchase_return_items, v: product_variants, p: products })
    .from(purchase_return_items)
    .innerJoin(product_variants, eq(product_variants.id, purchase_return_items.variant_id))
    .innerJoin(products, eq(products.id, product_variants.product_id))
    .where(eq(purchase_return_items.return_id, id))
    .orderBy(asc(purchase_return_items.id))
    .all()
    .map(({ ri, v, p }) => ({
      id: ri.id,
      purchase_item_id: ri.purchase_item_id,
      item_code: p.item_code,
      name: p.name,
      color: v.color,
      size: v.size,
      qty: ri.qty,
      unit_cost_paisa: ri.unit_cost_paisa,
      line_cost_paisa: ri.line_cost_paisa,
    }));
  return {
    id: r.r.id,
    doc_no: r.r.doc_no,
    purchase_id: r.r.purchase_id,
    purchase_doc_no: r.purchase_doc_no,
    supplier_name: r.supplier_name,
    date: r.r.date,
    reason: r.r.reason,
    total_cost_paisa: r.r.total_cost_paisa,
    status: r.r.status,
    version: r.r.version,
    created_at: r.r.created_at,
    created_by_id: r.r.created_by,
    created_by_name: r.created_by_name,
    lines,
  };
}

/**
 * Works out the lines of a return to the supplier (CLAUDE.md 8.7, in
 * reverse): at most the quantity bought minus what other posted returns
 * took, and only what is still in stock. Stock goes out at the line's
 * original unit cost; the last return of a line takes exactly its remaining
 * cost.
 */
function buildPurchaseReturnItems(tx: DbOrTx, purchaseId: number, wantedLines: ReturnInput['lines']) {
  const lines = loadLines(tx, purchaseId);
  const byId = new Map(lines.map((l) => [l.id, l]));
  const wanted = new Map<number, number>();
  for (const l of wantedLines) wanted.set(l.purchase_item_id, (wanted.get(l.purchase_item_id) ?? 0) + l.qty);

  const stock = stockOnHandMany(
    tx,
    [...wanted.keys()].map((id) => byId.get(id)?.variant_id ?? 0),
  );
  const returnedCost = new Map<number, number>(
    tx
      .select({ id: purchase_return_items.purchase_item_id, c: sql<number>`sum(${purchase_return_items.line_cost_paisa})` })
      .from(purchase_return_items)
      .innerJoin(purchase_returns, eq(purchase_returns.id, purchase_return_items.return_id))
      .where(and(eq(purchase_returns.purchase_id, purchaseId), eq(purchase_returns.status, 'posted')))
      .groupBy(purchase_return_items.purchase_item_id)
      .all()
      .map((r) => [r.id, r.c]),
  );

  return [...wanted.entries()].map(([itemId, qty]) => {
    const line = byId.get(itemId);
    if (!line) throw badRequest('One of the items is not on this purchase.');
    const label = [line.item_code, line.color, line.size].filter(Boolean).join(' ');
    const left = line.qty - line.returned_qty;
    if (qty > left) throw badRequest(`${label}: only ${left} can still be returned (bought ${line.qty}, already returned ${line.returned_qty}).`);
    const inStock = stock.get(line.variant_id) ?? 0;
    if (qty > inStock) throw badRequest(`${label}: only ${inStock} in stock. You can only send back items you still have.`);
    const lineCost = qty === left ? line.line_cost_paisa - (returnedCost.get(itemId) ?? 0) : roundDiv(line.line_cost_paisa * qty, line.qty);
    return { line, qty, unit_cost_paisa: line.unit_cost_paisa, line_cost_paisa: lineCost };
  });
}

type ReturnItem = ReturnType<typeof buildPurchaseReturnItems>[number];

function postPurchaseReturnLines(tx: DbOrTx, header: { id: number; doc_no: string; date: string; supplier_id: number; total_cost_paisa: number }, purchaseDocNo: string, items: readonly ReturnItem[]): void {
  for (const i of items) {
    tx.insert(purchase_return_items)
      .values({ return_id: header.id, purchase_item_id: i.line.id, variant_id: i.line.variant_id, qty: i.qty, unit_cost_paisa: i.unit_cost_paisa, line_cost_paisa: i.line_cost_paisa })
      .run();
    postMovement(tx, { variant_id: i.line.variant_id, date: header.date, qty_change: -i.qty, unit_cost_paisa: i.unit_cost_paisa, source_type: 'purchase_return', source_id: header.id });
  }
  if (header.total_cost_paisa > 0) {
    postEntry(tx, {
      party_type: 'supplier',
      party_id: header.supplier_id,
      date: header.date,
      debit_paisa: header.total_cost_paisa,
      entry_type: 'purchase_return',
      source_type: 'purchase_return',
      source_id: header.id,
      narration: `Return ${header.doc_no} against ${purchaseDocNo}`,
    });
  }
}

/** Takes off a purchase return's lines, stock and supplier debit. Returns the variants touched. */
function removePurchaseReturnEffects(tx: DbOrTx, returnId: number): number[] {
  removeEntriesForSource(tx, 'purchase_return', returnId);
  const variants = removeMovementsForSource(tx, 'purchase_return', returnId);
  tx.delete(purchase_return_items).where(eq(purchase_return_items.return_id, returnId)).run();
  return variants;
}

/**
 * Sends goods back to the supplier, in one transaction: lines, stock out at
 * their original cost, supplier debit, average cost, one audit row.
 */
export function createPurchaseReturn(db: DB, user: SessionUser, purchaseId: number, input: ReturnInput): PurchaseReturn {
  if (input.date > businessToday()) throw badRequest('The return date cannot be in the future.');

  return writeTx(db, (tx) => {
    const purchase = tx.select().from(purchases).where(eq(purchases.id, purchaseId)).get();
    if (!purchase) throw notFound('Purchase not found.');
    if (purchase.status !== 'posted') throw badRequest('This purchase is void.');
    if (input.date < purchase.date) throw badRequest('The return cannot be dated before the purchase.');

    const items = buildPurchaseReturnItems(tx, purchaseId, input.lines);
    const total = items.reduce((a, i) => a + i.line_cost_paisa, 0);
    const now = nowIso();
    const header = tx
      .insert(purchase_returns)
      .values({
        doc_no: nextDocNo(tx, 'purchase_return'),
        purchase_id: purchaseId,
        supplier_id: purchase.supplier_id,
        date: input.date,
        reason: input.reason,
        total_cost_paisa: total,
        status: 'posted',
        version: 1,
        created_by: user.id,
        updated_by: user.id,
        created_at: now,
        updated_at: now,
      })
      .returning()
      .get();
    postPurchaseReturnLines(tx, header, purchase.doc_no, items);
    recomputeAverageCosts(
      tx,
      items.map((i) => i.line.variant_id),
    );

    writeAudit(tx, auditActor(user), {
      action: 'create',
      entity: 'purchase_return',
      entity_id: header.id,
      doc_no: header.doc_no,
      version_after: 1,
      after: purchaseReturnSnapshot(tx, header.id),
      summary: { purchase_doc_no: purchase.doc_no, total_cost_paisa: total },
      flags: user.role === 'operator' ? ['by_operator'] : [],
      reason: input.reason,
    });
    return getPurchaseReturn(tx, header.id);
  });
}

/** Edits a return to the supplier: date, reason and quantities, re-checked like a new return. */
export function updatePurchaseReturn(db: DB, user: SessionUser, id: number, input: UpdateReturnInput): PurchaseReturn {
  if (input.date > businessToday()) throw badRequest('The return date cannot be in the future.');
  return writeTx(db, (tx) => {
    const before = tx.select().from(purchase_returns).where(eq(purchase_returns.id, id)).get();
    if (!before) throw notFound('Purchase return not found.');
    assertCanEdit(user, before, 'purchases.create');
    const purchase = tx.select().from(purchases).where(eq(purchases.id, before.purchase_id)).get();
    if (!purchase || purchase.status !== 'posted') throw badRequest('The purchase is void.');
    if (input.date < purchase.date) throw badRequest('The return cannot be dated before the purchase.');
    const beforeSnap = purchaseReturnSnapshot(tx, id);

    const variantsBefore = removePurchaseReturnEffects(tx, id);
    const items = buildPurchaseReturnItems(tx, purchase.id, input.lines);
    const total = items.reduce((a, i) => a + i.line_cost_paisa, 0);
    const after = tx
      .update(purchase_returns)
      .set({ date: input.date, reason: input.reason, total_cost_paisa: total, version: before.version + 1, updated_by: user.id, updated_at: nowIso() })
      .where(eq(purchase_returns.id, id))
      .returning()
      .get();
    postPurchaseReturnLines(tx, after, purchase.doc_no, items);
    recomputeAverageCosts(tx, [...variantsBefore, ...items.map((i) => i.line.variant_id)]);

    const afterSnap = purchaseReturnSnapshot(tx, id);
    const diff = diffSnapshots(beforeSnap, afterSnap, lineKey, lineLabel);
    writeAudit(tx, auditActor(user), {
      action: 'edit',
      entity: 'purchase_return',
      entity_id: id,
      doc_no: before.doc_no,
      version_before: before.version,
      version_after: after.version,
      before: beforeSnap,
      after: afterSnap,
      summary: { ...diffSummary(diff), purchase_doc_no: purchase.doc_no, total_before_paisa: before.total_cost_paisa, total_after_paisa: total },
      flags: uniqueFlags(changeFlags(tx, user, 'purchase_return', id, before.created_at), totalFlags(before.total_cost_paisa, total)),
      reason: input.change_reason,
    });
    return getPurchaseReturn(tx, id);
  });
}

/** Owner+: voids a return to the supplier; its stock comes back in and the supplier debit is taken off. */
export function voidPurchaseReturn(db: DB, user: SessionUser, id: number, reason: string): PurchaseReturn {
  return writeTx(db, (tx) => {
    const before = tx.select().from(purchase_returns).where(eq(purchase_returns.id, id)).get();
    if (!before) throw notFound('Purchase return not found.');
    assertCanVoid(user, before);
    const beforeSnap = purchaseReturnSnapshot(tx, id);
    // The lines stay on the void return (as a record); only their effects go.
    removeEntriesForSource(tx, 'purchase_return', id);
    const variants = removeMovementsForSource(tx, 'purchase_return', id);
    tx.update(purchase_returns).set({ status: 'void', version: before.version + 1, updated_by: user.id, updated_at: nowIso() }).where(eq(purchase_returns.id, id)).run();
    recomputeAverageCosts(tx, variants);
    writeAudit(tx, auditActor(user), {
      action: 'void',
      entity: 'purchase_return',
      entity_id: id,
      doc_no: before.doc_no,
      version_before: before.version,
      version_after: before.version + 1,
      before: beforeSnap,
      after: purchaseReturnSnapshot(tx, id),
      summary: { purchase_doc_no: beforeSnap.purchase_doc_no, total_before_paisa: before.total_cost_paisa, total_after_paisa: 0 },
      flags: uniqueFlags(changeFlags(tx, user, 'purchase_return', id, before.created_at), ['voided']),
      reason,
    });
    return getPurchaseReturn(tx, id);
  });
}
