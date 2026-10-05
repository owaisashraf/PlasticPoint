import { and, asc, eq, sql } from 'drizzle-orm';
import type { LowStockRow, StockMovement, StockValuationRow } from '@shopledger/shared';
import type { DB } from '../../db/client';
import { product_variants, products, stock_movements } from '../../db/schema';
import { notFound } from '../../lib/errors';

const stockSql = sql<number>`coalesce((SELECT sum(sm.qty_change) FROM stock_movements sm WHERE sm.variant_id = "product_variants"."id"), 0)`;

/** Active variants with a threshold whose stock is at or below it. */
export function lowStock(db: DB): LowStockRow[] {
  return db
    .select({ v: product_variants, p: products, stock_qty: stockSql })
    .from(product_variants)
    .innerJoin(products, eq(products.id, product_variants.product_id))
    .where(and(eq(product_variants.active, true), eq(products.active, true), sql`${product_variants.low_stock_threshold} > 0`, sql`${stockSql} <= ${product_variants.low_stock_threshold}`))
    .orderBy(asc(products.item_code), asc(product_variants.id))
    .all()
    .map(({ v, p, stock_qty }) => ({
      variant_id: v.id,
      product_id: p.id,
      item_code: p.item_code,
      name: p.name,
      category: p.category,
      color: v.color,
      size: v.size,
      sku: v.sku,
      unit: p.unit,
      stock_qty,
      low_stock_threshold: v.low_stock_threshold,
    }));
}

/** A variant's movements, oldest first, with a running quantity and the document number. */
export function variantMovements(db: DB, variantId: number): StockMovement[] {
  const v = db.select({ id: product_variants.id }).from(product_variants).where(eq(product_variants.id, variantId)).get();
  if (!v) throw notFound('Variant not found.');
  const docNo = sql<string | null>`CASE ${stock_movements.source_type}
    WHEN 'purchase' THEN (SELECT doc_no FROM purchases WHERE id = ${stock_movements.source_id})
    WHEN 'purchase_return' THEN (SELECT doc_no FROM purchase_returns WHERE id = ${stock_movements.source_id})
    WHEN 'sale' THEN (SELECT doc_no FROM sales WHERE id = ${stock_movements.source_id})
    ELSE NULL END`;
  let running = 0;
  return db
    .select({ m: stock_movements, doc_no: docNo })
    .from(stock_movements)
    .where(eq(stock_movements.variant_id, variantId))
    .orderBy(asc(stock_movements.date), asc(stock_movements.id))
    .all()
    .map(({ m, doc_no }) => {
      running += m.qty_change;
      return {
        id: m.id,
        date: m.date,
        qty_change: m.qty_change,
        balance_qty: running,
        source_type: m.source_type,
        source_id: m.source_id,
        doc_no,
        unit_cost_paisa: m.unit_cost_paisa,
      };
    });
}

/** Owner+: stock on hand × average cost, per product, with a grand total. */
export function stockValuation(db: DB): { rows: StockValuationRow[]; total_qty: number; total_value_paisa: number } {
  const rows = db
    .select({
      product_id: products.id,
      item_code: products.item_code,
      name: products.name,
      category: products.category,
      stock_qty: sql<number>`coalesce(sum(${stockSql}), 0)`,
      stock_value_paisa: sql<number>`coalesce(sum(CASE WHEN ${stockSql} > 0 THEN ${stockSql} * coalesce(${product_variants.avg_cost_paisa}, 0) ELSE 0 END), 0)`,
    })
    .from(products)
    .innerJoin(product_variants, eq(product_variants.product_id, products.id))
    .groupBy(products.id)
    .having(sql`sum(${stockSql}) <> 0`)
    .orderBy(asc(products.item_code))
    .all();
  return {
    rows,
    total_qty: rows.reduce((a, r) => a + r.stock_qty, 0),
    total_value_paisa: rows.reduce((a, r) => a + r.stock_value_paisa, 0),
  };
}
