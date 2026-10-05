import { and, asc, desc, eq, gte, inArray, lte, sql, type SQL } from 'drizzle-orm';
import {
  can,
  createPurchaseReturnSchema,
  createPurchaseSchema,
  purchaseListQuerySchema,
  type Purchase,
  type PurchaseLine,
  type PurchaseReturn,
} from '@shopledger/shared';
import type { z } from 'zod';
import { writeTx, type DB, type DbOrTx } from '../../db/client';
import { product_variants, products, purchase_items, purchase_return_items, purchase_returns, purchases, suppliers, users } from '../../db/schema';
import { writeAudit } from '../../lib/audit';
import { businessToday, nowIso } from '../../lib/dates';
import { badRequest, forbidden, notFound } from '../../lib/errors';
import { postEntry } from '../../lib/ledger';
import { roundDiv } from '../../lib/money';
import { nextDocNo } from '../../lib/numbering';
import type { SessionUser } from '../../lib/permissions';
import { purchaseLineAmounts } from '../../lib/pricing';
import { postMovement, recomputeAverageCosts, stockOnHandMany } from '../../lib/stock';
import { auditActor } from '../auth/service';
import { setProductPricing } from '../products/service';

type CreateInput = z.output<typeof createPurchaseSchema>;
type ReturnInput = z.output<typeof createPurchaseReturnSchema>;
type ListQuery = z.output<typeof purchaseListQuerySchema>;

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
  const { created_by: _c, updated_by: _u, updated_at: _ua, ...p } = r.p;
  return { ...p, supplier_name: r.supplier_name, created_by_name: r.created_by_name, item_count: r.item_count, total_qty: r.total_qty };
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
    const supplier = tx.select().from(suppliers).where(eq(suppliers.id, input.supplier_id)).get();
    if (!supplier) throw badRequest('Pick the supplier.');
    if (!supplier.active) throw badRequest('This supplier is inactive.');

    const variantIds = [...new Set(input.lines.map((l) => l.variant_id))];
    const variants = new Map(
      tx
        .select({ v: product_variants, p: products })
        .from(product_variants)
        .innerJoin(products, eq(products.id, product_variants.product_id))
        .where(inArray(product_variants.id, variantIds))
        .all()
        .map((r) => [r.v.id, r]),
    );
    for (const l of input.lines) {
      const found = variants.get(l.variant_id);
      if (!found) throw badRequest('One of the items no longer exists. Reload and try again.');
      if (!found.v.active || !found.p.active) throw badRequest(`${found.v.sku} is inactive and cannot be bought.`);
    }
    const productIdsInLines = new Set([...variants.values()].map((r) => r.p.id));
    for (const u of input.update_products) {
      if (!productIdsInLines.has(u.product_id)) throw badRequest('A price update refers to a product that is not on this purchase.');
    }

    const lines = input.lines.map((l, i) => ({ ...l, line_no: i + 1, ...purchaseLineAmounts(l.qty, l.list_price_paisa, l.supplier_margin_bp) }));
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

    for (const l of lines) {
      tx.insert(purchase_items)
        .values({
          purchase_id: header.id,
          line_no: l.line_no,
          variant_id: l.variant_id,
          qty: l.qty,
          list_price_paisa: l.list_price_paisa,
          supplier_margin_bp: l.supplier_margin_bp,
          line_gross_paisa: l.line_gross_paisa,
          line_margin_paisa: l.line_margin_paisa,
          line_cost_paisa: l.line_cost_paisa,
          unit_cost_paisa: l.unit_cost_paisa,
        })
        .run();
      postMovement(tx, {
        variant_id: l.variant_id,
        date: input.date,
        qty_change: l.qty,
        unit_cost_paisa: l.unit_cost_paisa,
        source_type: 'purchase',
        source_id: header.id,
      });
    }

    if (cost > 0) {
      postEntry(tx, {
        party_type: 'supplier',
        party_id: supplier.id,
        date: input.date,
        credit_paisa: cost,
        entry_type: 'purchase',
        source_type: 'purchase',
        source_id: header.id,
        narration: `Purchase ${header.doc_no}${input.supplier_ref ? ` (bill ${input.supplier_ref})` : ''}`,
      });
    }
    recomputeAverageCosts(tx, variantIds);

    const snapshot = { ...header, lines: lines.map(({ line_no, variant_id, qty, list_price_paisa, supplier_margin_bp, line_cost_paisa }) => ({ line_no, variant_id, qty, list_price_paisa, supplier_margin_bp, line_cost_paisa })) };
    writeAudit(tx, auditActor(user), {
      action: 'create',
      entity: 'purchase',
      entity_id: header.id,
      doc_no: header.doc_no,
      version_after: 1,
      after: snapshot,
      summary: { total_cost_paisa: cost, lines: lines.length, qty: lines.reduce((a, l) => a + l.qty, 0) },
      flags: user.role === 'operator' ? ['by_operator'] : [],
    });

    for (const u of input.update_products) {
      setProductPricing(tx, user, u.product_id, u, `Updated from purchase ${header.doc_no}`);
    }

    return getPurchase(tx, header.id);
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
    created_at: r.r.created_at,
    created_by_name: r.created_by_name,
    lines,
  };
}

/**
 * Sends goods back to the supplier (CLAUDE.md 8.7, in reverse): at most the
 * quantity bought minus what was already returned, and only what is still in
 * stock. Stock goes out at the line's original unit cost; the supplier is
 * debited with that share of the line cost.
 */
export function createPurchaseReturn(db: DB, user: SessionUser, purchaseId: number, input: ReturnInput): PurchaseReturn {
  if (input.date > businessToday()) throw badRequest('The return date cannot be in the future.');

  return writeTx(db, (tx) => {
    const purchase = tx.select().from(purchases).where(eq(purchases.id, purchaseId)).get();
    if (!purchase) throw notFound('Purchase not found.');
    if (purchase.status !== 'posted') throw badRequest('This purchase is void.');
    if (input.date < purchase.date) throw badRequest('The return cannot be dated before the purchase.');

    const lines = loadLines(tx, purchaseId);
    const byId = new Map(lines.map((l) => [l.id, l]));
    const wanted = new Map<number, number>();
    for (const l of input.lines) wanted.set(l.purchase_item_id, (wanted.get(l.purchase_item_id) ?? 0) + l.qty);

    const stock = stockOnHandMany(
      tx,
      [...wanted.keys()].map((id) => byId.get(id)?.variant_id ?? 0),
    );
    // Cost already returned per line, so the last return takes exactly what is left.
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

    const items = [...wanted.entries()].map(([itemId, qty]) => {
      const line = byId.get(itemId);
      if (!line) throw badRequest('One of the items is not on this purchase.');
      const label = [line.item_code, line.color, line.size].filter(Boolean).join(' ');
      const left = line.qty - line.returned_qty;
      if (qty > left) throw badRequest(`${label}: only ${left} can still be returned (bought ${line.qty}, already returned ${line.returned_qty}).`);
      const inStock = stock.get(line.variant_id) ?? 0;
      if (qty > inStock) throw badRequest(`${label}: only ${inStock} in stock. You can only send back items you still have.`);
      const lineCost =
        qty === left
          ? line.line_cost_paisa - (returnedCost.get(itemId) ?? 0)
          : roundDiv(line.line_cost_paisa * qty, line.qty);
      return { line, qty, unit_cost_paisa: line.unit_cost_paisa, line_cost_paisa: lineCost };
    });

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

    for (const i of items) {
      tx.insert(purchase_return_items)
        .values({
          return_id: header.id,
          purchase_item_id: i.line.id,
          variant_id: i.line.variant_id,
          qty: i.qty,
          unit_cost_paisa: i.unit_cost_paisa,
          line_cost_paisa: i.line_cost_paisa,
        })
        .run();
      postMovement(tx, {
        variant_id: i.line.variant_id,
        date: input.date,
        qty_change: -i.qty,
        unit_cost_paisa: i.unit_cost_paisa,
        source_type: 'purchase_return',
        source_id: header.id,
      });
    }
    if (total > 0) {
      postEntry(tx, {
        party_type: 'supplier',
        party_id: purchase.supplier_id,
        date: input.date,
        debit_paisa: total,
        entry_type: 'purchase_return',
        source_type: 'purchase_return',
        source_id: header.id,
        narration: `Return ${header.doc_no} against ${purchase.doc_no}`,
      });
    }
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
      after: { ...header, lines: items.map((i) => ({ purchase_item_id: i.line.id, variant_id: i.line.variant_id, qty: i.qty, line_cost_paisa: i.line_cost_paisa })) },
      summary: { purchase_doc_no: purchase.doc_no, total_cost_paisa: total },
      flags: user.role === 'operator' ? ['by_operator'] : [],
      reason: input.reason,
    });
    return getPurchaseReturn(tx, header.id);
  });
}
