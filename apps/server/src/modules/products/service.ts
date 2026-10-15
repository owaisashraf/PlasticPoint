import { and, asc, desc, eq, inArray, isNotNull, ne, sql, type SQL } from 'drizzle-orm';
import {
  applyBp,
  bulkUpdateSchema,
  can,
  createProductSchema,
  PRICING_FIELDS,
  productListQuerySchema,
  updateProductSchema,
  type BulkUpdateRow,
  type PriceHistoryEntry,
  type Product,
  type Variant,
} from '@shopledger/shared';
import type { z } from 'zod';
import { writeTx, type DB, type DbOrTx, type Tx } from '../../db/client';
import { product_price_history, product_variants, products, users } from '../../db/schema';
import { writeAudit } from '../../lib/audit';
import { businessToday, nowIso } from '../../lib/dates';
import { badRequest, conflict, forbidden, notFound } from '../../lib/errors';
import type { SessionUser } from '../../lib/permissions';
import { auditActor } from '../auth/service';
import { getSetting } from '../settings/service';

type ProductRow = typeof products.$inferSelect;
type VariantRow = typeof product_variants.$inferSelect;
type CreateInput = z.output<typeof createProductSchema>;
type UpdateInput = z.output<typeof updateProductSchema>;
type ListQuery = z.output<typeof productListQuerySchema>;
type BulkInput = z.output<typeof bulkUpdateSchema>;

const PRICE_FORBIDDEN = 'Only the owner can set prices, supplier margins and discounts.';

// --- Variants ----------------------------------------------------------------

/** Every color × size combination. No sizes or colors gives one plain variant. */
export function variantCombos(sizes: readonly string[], colors: readonly string[]): { color: string; size: string }[] {
  const cs = colors.length ? colors : [''];
  const ss = sizes.length ? sizes : [''];
  return cs.flatMap((color) => ss.map((size) => ({ color, size })));
}

export function makeSku(itemCode: string, color: string, size: string): string {
  const part = (s: string) => s.trim().toUpperCase().replace(/\s+/g, '_');
  return [itemCode, color, size].map(part).filter(Boolean).join('-');
}

/**
 * Makes the variants match the product's sizes and colors: missing
 * combinations are added (or reactivated), dropped ones are deactivated —
 * never deleted, because stock and documents may point at them.
 */
function syncVariants(tx: Tx, product: ProductRow, lowStockThreshold?: number): { added: number; deactivated: number; reactivated: number } {
  const existing = tx.select().from(product_variants).where(eq(product_variants.product_id, product.id)).all();
  const key = (c: string, s: string) => `${c.toLowerCase()}\u0000${s.toLowerCase()}`;
  const wanted = variantCombos(product.sizes, product.colors);
  const wantedKeys = new Set(wanted.map((w) => key(w.color, w.size)));
  const byKey = new Map(existing.map((v) => [key(v.color, v.size), v]));
  const now = nowIso();
  let added = 0;
  let deactivated = 0;
  let reactivated = 0;

  for (const v of existing) {
    const sku = makeSku(product.item_code, v.color, v.size);
    const shouldBeActive = wantedKeys.has(key(v.color, v.size)) && product.active;
    if (v.active !== shouldBeActive || v.sku !== sku) {
      tx.update(product_variants).set({ active: shouldBeActive, sku, updated_at: now }).where(eq(product_variants.id, v.id)).run();
      if (v.active && !shouldBeActive) deactivated++;
      if (!v.active && shouldBeActive) reactivated++;
    }
  }
  for (const w of wanted) {
    if (byKey.has(key(w.color, w.size))) continue;
    tx.insert(product_variants)
      .values({
        product_id: product.id,
        color: w.color,
        size: w.size,
        sku: makeSku(product.item_code, w.color, w.size),
        low_stock_threshold: lowStockThreshold ?? 0,
        active: product.active,
        created_at: now,
        updated_at: now,
      })
      .run();
    added++;
  }
  return { added, deactivated, reactivated };
}

// --- Reading -------------------------------------------------------------------

// Outer columns are written with their table name: a bare "id" inside a
// subquery would bind to the subquery's own table.
const stockQtySql = sql<number>`coalesce((SELECT sum(sm.qty_change) FROM stock_movements sm JOIN product_variants pv ON pv.id = sm.variant_id WHERE pv.product_id = "products"."id"), 0)`;

function toProduct(row: ProductRow, stockQty: number, variants?: Variant[]): Product {
  const { created_by: _cb, ...rest } = row;
  return { ...rest, stock_qty: stockQty, ...(variants ? { variants } : {}) };
}

function loadVariants(db: DbOrTx, productId: number): Variant[] {
  return db
    .select({
      v: product_variants,
      stock_qty: sql<number>`coalesce((SELECT sum(sm.qty_change) FROM stock_movements sm WHERE sm.variant_id = "product_variants"."id"), 0)`,
    })
    .from(product_variants)
    .where(eq(product_variants.product_id, productId))
    .orderBy(asc(product_variants.id))
    .all()
    .map(({ v, stock_qty }) => ({
      id: v.id,
      product_id: v.product_id,
      color: v.color,
      size: v.size,
      sku: v.sku,
      active: v.active,
      low_stock_threshold: v.low_stock_threshold,
      avg_cost_paisa: v.avg_cost_paisa,
      stock_qty,
    }));
}

export function getProduct(db: DbOrTx, id: number): Product {
  const r = db.select({ p: products, stock: stockQtySql }).from(products).where(eq(products.id, id)).get();
  if (!r) throw notFound('Product not found.');
  return toProduct(r.p, r.stock, loadVariants(db, id));
}

export function listProducts(db: DB, q: ListQuery): { products: Product[]; total: number } {
  const conds: (SQL | undefined)[] = [];
  if (q.q) {
    for (const word of q.q.split(/\s+/).filter(Boolean)) {
      const like = `%${word.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
      conds.push(
        sql`(${products.item_code} LIKE ${like} ESCAPE '\\' OR ${products.name} LIKE ${like} ESCAPE '\\' OR coalesce(${products.category}, '') LIKE ${like} ESCAPE '\\')`,
      );
    }
  }
  if (q.category) conds.push(sql`lower(${products.category}) = lower(${q.category})`);
  if (q.status === 'active') conds.push(eq(products.active, true));
  if (q.status === 'inactive') conds.push(eq(products.active, false));
  const where = and(...conds);

  const total = db.select({ n: sql<number>`count(*)` }).from(products).where(where).get()?.n ?? 0;
  // Exact item-code matches first, so typing a code finds it at the top.
  const code = q.q?.trim().toUpperCase();
  const order = code
    ? [sql`CASE WHEN ${products.item_code} = ${code} THEN 0 WHEN ${products.item_code} LIKE ${`${code}%`} THEN 1 ELSE 2 END`, asc(products.item_code)]
    : [asc(products.item_code)];
  const rows = db
    .select({ p: products, stock: stockQtySql })
    .from(products)
    .where(where)
    .orderBy(...order)
    .limit(q.limit)
    .offset(q.offset)
    .all();
  return { products: rows.map((r) => toProduct(r.p, r.stock)), total };
}

export function listCategories(db: DB): string[] {
  return db
    .selectDistinct({ c: products.category })
    .from(products)
    .where(and(isNotNull(products.category), ne(products.category, '')))
    .orderBy(asc(products.category))
    .all()
    .map((r) => r.c ?? '');
}

export function priceHistory(db: DB, productId: number): PriceHistoryEntry[] {
  getProduct(db, productId);
  return db
    .select({ h: product_price_history, name: users.display_name })
    .from(product_price_history)
    .leftJoin(users, eq(users.id, product_price_history.changed_by))
    .where(eq(product_price_history.product_id, productId))
    .orderBy(desc(product_price_history.id))
    .all()
    .map(({ h, name }) => ({
      id: h.id,
      effective_date: h.effective_date,
      list_price_paisa: h.list_price_paisa,
      supplier_margin_bp: h.supplier_margin_bp,
      default_customer_discount_bp: h.default_customer_discount_bp,
      changed_by: h.changed_by,
      changed_by_name: name,
      created_at: h.created_at,
    }));
}

// --- Writing -------------------------------------------------------------------

function recordPrice(tx: Tx, p: ProductRow, userId: number): void {
  tx.insert(product_price_history)
    .values({
      product_id: p.id,
      effective_date: businessToday(),
      list_price_paisa: p.list_price_paisa,
      supplier_margin_bp: p.supplier_margin_bp,
      default_customer_discount_bp: p.default_customer_discount_bp,
      changed_by: userId,
      created_at: nowIso(),
    })
    .run();
}

function loadRow(tx: DbOrTx, id: number): ProductRow {
  const row = tx.select().from(products).where(eq(products.id, id)).get();
  if (!row) throw notFound('Product not found.');
  return row;
}

function assertItemCodeFree(tx: Tx, itemCode: string, exceptId?: number): void {
  const clash = tx.select({ id: products.id }).from(products).where(eq(products.item_code, itemCode)).get();
  if (clash && clash.id !== exceptId) throw conflict(`Item code ${itemCode} is already used by another product.`);
}

function translateSkuClash(e: unknown): never {
  if (e instanceof Error && /UNIQUE constraint failed: product_variants\.sku/.test(e.message)) {
    throw conflict('Two variants would get the same SKU. Check the sizes and colors for near-duplicates (e.g. "Sky Blue" and "Sky_Blue").');
  }
  throw e;
}

/**
 * Operators may create products and enter the initial price (copied from the
 * manufacturer's list); supplier margin and default discount then take the
 * settings defaults. Only owner+ may set margin and discounts.
 */
export function createProduct(db: DB, user: SessionUser, input: CreateInput): Product {
  const canPrice = can(user, 'pricing.manage');
  if (
    !canPrice &&
    (input.supplier_margin_bp !== undefined || input.default_customer_discount_bp !== undefined || input.max_customer_discount_bp != null)
  ) {
    throw forbidden(PRICE_FORBIDDEN);
  }
  try {
    return writeTx(db, (tx) => {
      assertItemCodeFree(tx, input.item_code);
      const now = nowIso();
      const row = tx
        .insert(products)
        .values({
          item_code: input.item_code,
          name: input.name,
          category: input.category,
          unit: input.unit,
          sizes: input.sizes,
          colors: input.colors,
          list_price_paisa: input.list_price_paisa,
          supplier_margin_bp: input.supplier_margin_bp ?? getSetting(tx, 'default_supplier_margin_bp'),
          default_customer_discount_bp: input.default_customer_discount_bp ?? getSetting(tx, 'default_customer_discount_bp'),
          max_customer_discount_bp: input.max_customer_discount_bp ?? null,
          active: true,
          created_by: user.id,
          created_at: now,
          updated_at: now,
        })
        .returning()
        .get();
      syncVariants(tx, row, input.low_stock_threshold);
      recordPrice(tx, row, user.id);
      writeAudit(tx, auditActor(user), {
        action: 'create',
        entity: 'product',
        entity_id: row.id,
        doc_no: row.item_code,
        after: row,
        summary: { item_code: row.item_code, variants: variantCombos(row.sizes, row.colors).length },
      });
      return getProduct(tx, row.id);
    });
  } catch (e) {
    return translateSkuClash(e);
  }
}

export function updateProduct(db: DB, user: SessionUser, id: number, input: UpdateInput): Product {
  try {
    return writeTx(db, (tx) => {
      const before = loadRow(tx, id);

      const pricingChanged = PRICING_FIELDS.filter((k) => input[k] !== undefined && input[k] !== before[k]);
      if (pricingChanged.length && !can(user, 'pricing.manage')) throw forbidden(PRICE_FORBIDDEN);
      if (input.item_code && input.item_code !== before.item_code) assertItemCodeFree(tx, input.item_code, id);

      const set: Partial<ProductRow> = {};
      for (const k of ['item_code', 'name', 'category', 'unit', 'list_price_paisa', 'supplier_margin_bp', 'default_customer_discount_bp', 'max_customer_discount_bp', 'active'] as const) {
        const v = input[k];
        if (v !== undefined && v !== before[k]) (set as Record<string, unknown>)[k] = v;
      }
      for (const k of ['sizes', 'colors'] as const) {
        const v = input[k];
        if (v !== undefined && JSON.stringify(v) !== JSON.stringify(before[k])) set[k] = v;
      }
      if (Object.keys(set).length === 0) return getProduct(tx, id);

      set.updated_at = nowIso();
      const after = tx.update(products).set(set).where(eq(products.id, id)).returning().get();
      const variantChanges = syncVariants(tx, after);
      if (pricingChanged.some((k) => k !== 'max_customer_discount_bp')) recordPrice(tx, after, user.id);

      const changed = Object.keys(set).filter((k) => k !== 'updated_at');
      writeAudit(tx, auditActor(user), {
        action: set.active === false ? 'deactivate' : set.active === true ? 'activate' : 'update',
        entity: 'product',
        entity_id: id,
        doc_no: after.item_code,
        before,
        after,
        summary: { changed_fields: changed, variants: variantChanges },
        flags: pricingChanged.length ? ['price_changed'] : [],
        reason: input.reason ?? null,
      });
      return getProduct(tx, id);
    });
  } catch (e) {
    return translateSkuClash(e);
  }
}

export function updateVariant(db: DB, user: SessionUser, variantId: number, input: { low_stock_threshold?: number }): Variant {
  return writeTx(db, (tx) => {
    const before = tx.select().from(product_variants).where(eq(product_variants.id, variantId)).get();
    if (!before) throw notFound('Variant not found.');
    const view = () => loadVariants(tx, before.product_id).find((v) => v.id === variantId) as Variant;
    if (input.low_stock_threshold === undefined || input.low_stock_threshold === before.low_stock_threshold) return view();
    const after = tx
      .update(product_variants)
      .set({ low_stock_threshold: input.low_stock_threshold, updated_at: nowIso() })
      .where(eq(product_variants.id, variantId))
      .returning()
      .get();
    writeAudit(tx, auditActor(user), {
      action: 'update',
      entity: 'product_variant',
      entity_id: variantId,
      doc_no: after.sku,
      before: { low_stock_threshold: before.low_stock_threshold },
      after: { low_stock_threshold: after.low_stock_threshold },
      summary: { changed_fields: ['low_stock_threshold'] },
    });
    return view();
  });
}

/**
 * Owner+: changes a product's price and/or supplier margin inside a caller's
 * transaction (used when a purchase bill shows new figures). Adds price
 * history and one audit row. Returns false if nothing changed.
 */
export function setProductPricing(
  tx: Tx,
  user: SessionUser,
  productId: number,
  changes: { list_price_paisa?: number; supplier_margin_bp?: number },
  reason: string,
): boolean {
  if (!can(user, 'pricing.manage')) throw forbidden(PRICE_FORBIDDEN);
  const before = loadRow(tx, productId);
  const set: Partial<ProductRow> = {};
  if (changes.list_price_paisa !== undefined && changes.list_price_paisa !== before.list_price_paisa) set.list_price_paisa = changes.list_price_paisa;
  if (changes.supplier_margin_bp !== undefined && changes.supplier_margin_bp !== before.supplier_margin_bp) set.supplier_margin_bp = changes.supplier_margin_bp;
  if (Object.keys(set).length === 0) return false;
  const after = tx.update(products).set({ ...set, updated_at: nowIso() }).where(eq(products.id, productId)).returning().get();
  recordPrice(tx, after, user.id);
  writeAudit(tx, auditActor(user), {
    action: 'update',
    entity: 'product',
    entity_id: productId,
    doc_no: after.item_code,
    before,
    after,
    summary: { changed_fields: Object.keys(set) },
    flags: ['price_changed'],
    reason,
  });
  return true;
}

// --- Bulk update (owner+) ------------------------------------------------------

function pricingOf(p: ProductRow): BulkUpdateRow['before'] {
  return { list_price_paisa: p.list_price_paisa, supplier_margin_bp: p.supplier_margin_bp, default_customer_discount_bp: p.default_customer_discount_bp };
}

function applyChange(p: ProductRow, change: BulkInput['change']): BulkUpdateRow['after'] {
  const after = pricingOf(p);
  switch (change.kind) {
    case 'price_percent':
      after.list_price_paisa = p.list_price_paisa + applyBp(p.list_price_paisa, change.bp);
      break;
    case 'price_amount':
      after.list_price_paisa = p.list_price_paisa + change.paisa;
      break;
    case 'supplier_margin':
      after.supplier_margin_bp = change.bp;
      break;
    case 'default_discount':
      after.default_customer_discount_bp = change.bp;
      break;
  }
  return after;
}

/**
 * Changes price (by % or amount), supplier margin or default discount for a
 * category or a selection, in one transaction. Each changed product gets a
 * price-history row and an audit row. With dry_run nothing is saved.
 */
export function bulkUpdate(db: DB, user: SessionUser, input: BulkInput): { rows: BulkUpdateRow[]; applied: boolean } {
  if (!can(user, 'pricing.manage')) throw forbidden(PRICE_FORBIDDEN);
  const run = (tx: DbOrTx) => {
    const target =
      input.target.kind === 'category'
        ? tx.select().from(products).where(sql`lower(${products.category}) = lower(${input.target.category})`).all()
        : tx.select().from(products).where(inArray(products.id, input.target.product_ids)).all();
    if (target.length === 0) throw badRequest('No products match.');

    const rows: BulkUpdateRow[] = [];
    for (const p of target.sort((a, b) => a.item_code.localeCompare(b.item_code))) {
      const after = applyChange(p, input.change);
      if (after.list_price_paisa < 1) throw badRequest(`${p.item_code}: the new price would be zero or less.`);
      const before = pricingOf(p);
      if (JSON.stringify(before) === JSON.stringify(after)) continue;
      rows.push({ product_id: p.id, item_code: p.item_code, name: p.name, before, after });
    }
    return { rows, target };
  };

  if (input.dry_run) return { rows: run(db).rows, applied: false };

  return writeTx(db, (tx) => {
    const { rows, target } = run(tx);
    const byId = new Map(target.map((p) => [p.id, p]));
    const now = nowIso();
    for (const r of rows) {
      const before = byId.get(r.product_id) as ProductRow;
      const after = tx.update(products).set({ ...r.after, updated_at: now }).where(eq(products.id, r.product_id)).returning().get();
      recordPrice(tx, after, user.id);
      writeAudit(tx, auditActor(user), {
        action: 'update',
        entity: 'product',
        entity_id: r.product_id,
        doc_no: r.item_code,
        before,
        after,
        summary: { changed_fields: Object.keys(r.after).filter((k) => r.after[k as keyof typeof r.after] !== r.before[k as keyof typeof r.before]), bulk: input.change },
        flags: ['price_changed'],
        reason: input.reason,
      });
    }
    return { rows, applied: true };
  });
}

/** Rows for a variant lookup (used later by sale and purchase screens). */
export function variantRows(db: DbOrTx, productId: number): VariantRow[] {
  return db.select().from(product_variants).where(eq(product_variants.product_id, productId)).all();
}
