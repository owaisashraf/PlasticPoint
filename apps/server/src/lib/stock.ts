import { and, asc, eq, inArray, lte, sql } from 'drizzle-orm';
import type { DbOrTx } from '../db/client';
import { product_variants, stock_movements } from '../db/schema';
import { nowIso } from './dates';
import { roundDiv } from './money';

/**
 * Stock (CLAUDE.md 8.9). Stock on hand = Σ qty_change; it is never stored.
 * The weighted average cost is kept on the variant and recalculated by
 * replaying the variant's movements whenever they change.
 */

export interface MovementPosting {
  variant_id: number;
  date: string;
  qty_change: number;
  unit_cost_paisa: number | null;
  source_type: string;
  source_id: number;
}

export function postMovement(tx: DbOrTx, m: MovementPosting): void {
  if (!Number.isInteger(m.qty_change) || m.qty_change === 0) throw new Error('Stock movement quantity must be a non-zero whole number');
  tx.insert(stock_movements).values({ ...m, created_at: nowIso() }).run();
}

/** Removes every movement a document created (edit and void), returning the variants affected. */
export function removeMovementsForSource(tx: DbOrTx, sourceType: string, sourceId: number): number[] {
  const rows = tx
    .delete(stock_movements)
    .where(and(eq(stock_movements.source_type, sourceType), eq(stock_movements.source_id, sourceId)))
    .returning({ variant_id: stock_movements.variant_id })
    .all();
  return [...new Set(rows.map((r) => r.variant_id))];
}

export function stockOnHand(db: DbOrTx, variantId: number, asOf?: string): number {
  const conds = [eq(stock_movements.variant_id, variantId)];
  if (asOf) conds.push(lte(stock_movements.date, asOf));
  return db.select({ q: sql<number>`coalesce(sum(${stock_movements.qty_change}), 0)` }).from(stock_movements).where(and(...conds)).get()?.q ?? 0;
}

export function stockOnHandMany(db: DbOrTx, variantIds: number[]): Map<number, number> {
  const out = new Map<number, number>(variantIds.map((id) => [id, 0]));
  if (variantIds.length === 0) return out;
  const rows = db
    .select({ id: stock_movements.variant_id, q: sql<number>`sum(${stock_movements.qty_change})` })
    .from(stock_movements)
    .where(inArray(stock_movements.variant_id, variantIds))
    .groupBy(stock_movements.variant_id)
    .all();
  for (const r of rows) out.set(r.id, r.q);
  return out;
}

/** Movements that take stock out at a specific cost (and so change the average). */
const OUT_AT_COST = new Set(['purchase_return']);

/**
 * Weighted average cost from the movement history, in date order:
 *  - stock coming in with a cost (purchases, sales returns) is averaged in;
 *    if stock was zero or negative, the new cost replaces the average;
 *  - purchase returns go out at the cost they came in at;
 *  - other stock going out (sales) lowers the quantity only.
 * Returns null if nothing with a cost has ever come in.
 */
export function replayAverageCost(
  movements: readonly { qty_change: number; unit_cost_paisa: number | null; source_type: string }[],
): number | null {
  let qty = 0;
  let avg: number | null = null;
  for (const m of movements) {
    const q = m.qty_change;
    const c = m.unit_cost_paisa;
    if (q > 0 && c !== null) {
      avg = qty <= 0 || avg === null ? c : roundDiv(qty * avg + q * c, qty + q);
    } else if (q < 0 && c !== null && OUT_AT_COST.has(m.source_type) && avg !== null) {
      const left = qty + q;
      if (left > 0) avg = Math.max(0, roundDiv(qty * avg + q * c, left));
    }
    qty += q;
  }
  return avg;
}

/** Recalculates and saves the average cost of each variant. Call inside the posting transaction. */
export function recomputeAverageCosts(tx: DbOrTx, variantIds: Iterable<number>): void {
  const now = nowIso();
  for (const id of new Set(variantIds)) {
    const movements = tx
      .select({ qty_change: stock_movements.qty_change, unit_cost_paisa: stock_movements.unit_cost_paisa, source_type: stock_movements.source_type })
      .from(stock_movements)
      .where(eq(stock_movements.variant_id, id))
      .orderBy(asc(stock_movements.date), asc(stock_movements.id))
      .all();
    tx.update(product_variants).set({ avg_cost_paisa: replayAverageCost(movements), updated_at: now }).where(eq(product_variants.id, id)).run();
  }
}
