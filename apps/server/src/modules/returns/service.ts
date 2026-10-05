import { and, asc, desc, eq, gte, lte, sql, type SQL } from 'drizzle-orm';
import { createSalesReturnSchema, returnListQuerySchema, type PurchaseReturnRow, type SalesReturn } from '@shopledger/shared';
import type { z } from 'zod';
import { writeTx, type DB, type DbOrTx } from '../../db/client';
import {
  customers,
  payments,
  product_variants,
  products,
  purchase_returns,
  purchases,
  sale_items,
  sales,
  sales_return_items,
  sales_returns,
  suppliers,
  users,
} from '../../db/schema';
import { recalcAllocations } from '../../lib/allocation';
import { writeAudit } from '../../lib/audit';
import { businessToday, nowIso } from '../../lib/dates';
import { badRequest, notFound } from '../../lib/errors';
import { postEntry } from '../../lib/ledger';
import { formatPaisa } from '../../lib/money';
import { nextDocNo } from '../../lib/numbering';
import type { SessionUser } from '../../lib/permissions';
import { returnedNetForLine } from '../../lib/profit';
import { postMovement, recomputeAverageCosts } from '../../lib/stock';
import { auditActor } from '../auth/service';
import { getSale } from '../sales/service';

type CreateInput = z.output<typeof createSalesReturnSchema>;
type ListQuery = z.output<typeof returnListQuerySchema>;

// --- Reading ---------------------------------------------------------------------

const headerSelect = {
  r: sales_returns,
  sale_doc_no: sales.doc_no,
  customer_name: customers.name,
  customer_code: customers.code,
  created_by_name: users.display_name,
  profit_reversed: sql<number>`coalesce((SELECT sum(i.profit_reversed_paisa) FROM sales_return_items i WHERE i.return_id = "sales_returns"."id"), 0)`,
  refunded: sql<number>`coalesce((SELECT sum(p.amount_paisa) FROM payments p WHERE p.sales_return_id = "sales_returns"."id" AND p.kind = 'refund' AND p.status = 'posted'), 0)`,
  total_qty: sql<number>`coalesce((SELECT sum(i.qty) FROM sales_return_items i WHERE i.return_id = "sales_returns"."id"), 0)`,
};

type HeaderRow = {
  r: typeof sales_returns.$inferSelect;
  sale_doc_no: string;
  customer_name: string;
  customer_code: string;
  created_by_name: string | null;
  profit_reversed: number;
  refunded: number;
  total_qty: number;
};

function headerQuery(db: DbOrTx) {
  return db
    .select(headerSelect)
    .from(sales_returns)
    .innerJoin(sales, eq(sales.id, sales_returns.sale_id))
    .innerJoin(customers, eq(customers.id, sales_returns.customer_id))
    .leftJoin(users, eq(users.id, sales_returns.created_by));
}

function toReturn(h: HeaderRow): SalesReturn {
  return {
    id: h.r.id,
    doc_no: h.r.doc_no,
    sale_id: h.r.sale_id,
    sale_doc_no: h.sale_doc_no,
    customer_id: h.r.customer_id,
    customer_name: h.customer_name,
    customer_code: h.customer_code,
    date: h.r.date,
    reason: h.r.reason,
    total_paisa: h.r.total_paisa,
    profit_reversed_paisa: h.profit_reversed,
    refunded_paisa: h.refunded,
    status: h.r.status,
    created_at: h.r.created_at,
    created_by_name: h.created_by_name,
    total_qty: h.total_qty,
  };
}

export function getSalesReturn(db: DbOrTx, id: number): SalesReturn {
  const h = headerQuery(db).where(eq(sales_returns.id, id)).get();
  if (!h) throw notFound('Sales return not found.');
  const lines = db
    .select({ i: sales_return_items, v: product_variants, p: products })
    .from(sales_return_items)
    .innerJoin(product_variants, eq(product_variants.id, sales_return_items.variant_id))
    .innerJoin(products, eq(products.id, product_variants.product_id))
    .where(eq(sales_return_items.return_id, id))
    .orderBy(asc(sales_return_items.id))
    .all()
    .map(({ i, v, p }) => ({
      id: i.id,
      sale_item_id: i.sale_item_id,
      item_code: p.item_code,
      name: p.name,
      color: v.color,
      size: v.size,
      qty: i.qty,
      line_net_paisa: i.line_net_paisa,
      unit_cost_paisa: i.unit_cost_paisa,
      line_cost_paisa: i.line_cost_paisa,
      profit_reversed_paisa: i.profit_reversed_paisa,
    }));
  return { ...toReturn(h), lines };
}

function likeAny(q: string, cols: SQL[]): SQL[] {
  return q
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => {
      const like = `%${word.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
      return sql`(${sql.join(
        cols.map((c) => sql`coalesce(${c}, '') LIKE ${like} ESCAPE '\\'`),
        sql` OR `,
      )})`;
    });
}

export function listSalesReturns(db: DB, q: ListQuery): { returns: SalesReturn[]; total: number } {
  const conds: (SQL | undefined)[] = [];
  if (q.from) conds.push(gte(sales_returns.date, q.from));
  if (q.to) conds.push(lte(sales_returns.date, q.to));
  if (q.customer_id) conds.push(eq(sales_returns.customer_id, q.customer_id));
  if (q.q) conds.push(...likeAny(q.q, [sql`${sales_returns.doc_no}`, sql`${sales.doc_no}`, sql`${customers.name}`, sql`${customers.code}`]));
  const where = and(...conds);
  const total =
    db
      .select({ n: sql<number>`count(*)` })
      .from(sales_returns)
      .innerJoin(sales, eq(sales.id, sales_returns.sale_id))
      .innerJoin(customers, eq(customers.id, sales_returns.customer_id))
      .where(where)
      .get()?.n ?? 0;
  const rows = headerQuery(db).where(where).orderBy(desc(sales_returns.date), desc(sales_returns.id)).limit(q.limit).offset(q.offset).all();
  return { returns: rows.map(toReturn), total };
}

export function listPurchaseReturns(db: DB, q: ListQuery): { returns: PurchaseReturnRow[]; total: number } {
  const conds: (SQL | undefined)[] = [];
  if (q.from) conds.push(gte(purchase_returns.date, q.from));
  if (q.to) conds.push(lte(purchase_returns.date, q.to));
  if (q.q) conds.push(...likeAny(q.q, [sql`${purchase_returns.doc_no}`, sql`${purchases.doc_no}`, sql`${purchases.supplier_ref}`]));
  const where = and(...conds);
  const base = db
    .select({
      r: purchase_returns,
      purchase_doc_no: purchases.doc_no,
      supplier_name: suppliers.name,
      created_by_name: users.display_name,
      total_qty: sql<number>`coalesce((SELECT sum(i.qty) FROM purchase_return_items i WHERE i.return_id = "purchase_returns"."id"), 0)`,
    })
    .from(purchase_returns)
    .innerJoin(purchases, eq(purchases.id, purchase_returns.purchase_id))
    .innerJoin(suppliers, eq(suppliers.id, purchase_returns.supplier_id))
    .leftJoin(users, eq(users.id, purchase_returns.created_by));
  const total =
    db
      .select({ n: sql<number>`count(*)` })
      .from(purchase_returns)
      .innerJoin(purchases, eq(purchases.id, purchase_returns.purchase_id))
      .where(where)
      .get()?.n ?? 0;
  const rows = base.where(where).orderBy(desc(purchase_returns.date), desc(purchase_returns.id)).limit(q.limit).offset(q.offset).all();
  return {
    returns: rows.map((x) => ({
      id: x.r.id,
      doc_no: x.r.doc_no,
      purchase_id: x.r.purchase_id,
      purchase_doc_no: x.purchase_doc_no,
      supplier_name: x.supplier_name,
      date: x.r.date,
      reason: x.r.reason,
      total_qty: x.total_qty,
      total_cost_paisa: x.r.total_cost_paisa,
      status: x.r.status,
      created_by_name: x.created_by_name,
    })),
    total,
  };
}

// --- Posting a sales return --------------------------------------------------------

/**
 * Goods back from a customer (CLAUDE.md 8.7), in one transaction:
 *  - at most the quantity sold minus what was already returned;
 *  - stock back in at the line's original unit cost;
 *  - the customer is credited what they actually paid for those goods
 *    (returned qty × line net ÷ qty; the last return of a line takes exactly
 *    what is left, so the credits add up to the line net);
 *  - profit reversed = returned net − returned cost, stored on each line;
 *  - the credit goes to the original invoice first, then FIFO;
 *  - optionally cash is paid back now (a refund, at most the credit).
 */
export function createSalesReturn(db: DB, user: SessionUser, saleId: number, input: CreateInput): SalesReturn {
  if (input.date > businessToday()) throw badRequest('The return date cannot be in the future.');

  return writeTx(db, (tx) => {
    const sale = getSale(tx, saleId);
    if (sale.status !== 'posted') throw badRequest('This invoice is void.');
    if (input.date < sale.date) throw badRequest('The return cannot be dated before the invoice.');
    const byId = new Map((sale.lines ?? []).map((l) => [l.id, l]));
    const wanted = new Map<number, number>();
    for (const l of input.lines) wanted.set(l.sale_item_id, (wanted.get(l.sale_item_id) ?? 0) + l.qty);

    // Net already credited per line, so the last return takes exactly what is left.
    const creditedNet = new Map(
      tx
        .select({ id: sales_return_items.sale_item_id, n: sql<number>`sum(${sales_return_items.line_net_paisa})` })
        .from(sales_return_items)
        .innerJoin(sales_returns, eq(sales_returns.id, sales_return_items.return_id))
        .where(and(eq(sales_returns.sale_id, saleId), eq(sales_returns.status, 'posted')))
        .groupBy(sales_return_items.sale_item_id)
        .all()
        .map((r) => [r.id, r.n]),
    );
    const items = [...wanted.entries()].map(([itemId, qty]) => {
      const line = byId.get(itemId);
      if (!line) throw badRequest('One of the items is not on this invoice.');
      const left = line.qty - line.returned_qty;
      const label = [line.item_code, line.color, line.size].filter(Boolean).join(' ');
      if (qty > left) throw badRequest(`${label}: only ${left} can still be returned (sold ${line.qty}, already returned ${line.returned_qty}).`);
      const unitCost = tx.select({ c: sale_items.unit_cost_paisa }).from(sale_items).where(eq(sale_items.id, itemId)).get()?.c ?? 0;
      const net = returnedNetForLine({ line_net_paisa: line.line_net_paisa, qty: line.qty }, qty, left, creditedNet.get(itemId) ?? 0);
      const cost = qty * unitCost;
      return { line, qty, unit_cost_paisa: unitCost, line_net_paisa: net, line_cost_paisa: cost, profit_reversed_paisa: net - cost };
    });
    const total = items.reduce((a, i) => a + i.line_net_paisa, 0);
    if (input.refund && input.refund.amount_paisa > total) {
      throw badRequest(`The refund cannot be more than the credit for these goods (${formatPaisa(total)}).`);
    }

    const now = nowIso();
    const header = tx
      .insert(sales_returns)
      .values({
        doc_no: nextDocNo(tx, 'sales_return'),
        sale_id: saleId,
        customer_id: sale.customer_id,
        date: input.date,
        reason: input.reason,
        total_paisa: total,
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
      tx.insert(sales_return_items)
        .values({
          return_id: header.id,
          sale_item_id: i.line.id,
          variant_id: i.line.variant_id,
          qty: i.qty,
          unit_cost_paisa: i.unit_cost_paisa,
          line_net_paisa: i.line_net_paisa,
          line_cost_paisa: i.line_cost_paisa,
          profit_reversed_paisa: i.profit_reversed_paisa,
        })
        .run();
      postMovement(tx, {
        variant_id: i.line.variant_id,
        date: input.date,
        qty_change: i.qty,
        unit_cost_paisa: i.unit_cost_paisa,
        source_type: 'sales_return',
        source_id: header.id,
      });
    }
    recomputeAverageCosts(
      tx,
      items.map((i) => i.line.variant_id),
    );
    if (total > 0) {
      postEntry(tx, {
        party_type: 'customer',
        party_id: sale.customer_id,
        date: input.date,
        credit_paisa: total,
        entry_type: 'sales_return',
        source_type: 'sales_return',
        source_id: header.id,
        narration: `Return ${header.doc_no} against ${sale.doc_no}`,
      });
    }

    writeAudit(tx, auditActor(user), {
      action: 'create',
      entity: 'sales_return',
      entity_id: header.id,
      doc_no: header.doc_no,
      version_after: 1,
      after: {
        ...header,
        sale_doc_no: sale.doc_no,
        lines: items.map((i) => ({
          sale_item_id: i.line.id,
          variant_id: i.line.variant_id,
          item_code: i.line.item_code,
          color: i.line.color,
          size: i.line.size,
          qty: i.qty,
          line_net_paisa: i.line_net_paisa,
          line_cost_paisa: i.line_cost_paisa,
          profit_reversed_paisa: i.profit_reversed_paisa,
        })),
      },
      summary: {
        sale_doc_no: sale.doc_no,
        customer_id: sale.customer_id,
        customer_name: sale.customer_name,
        total_paisa: total,
        profit_reversed_paisa: items.reduce((a, i) => a + i.profit_reversed_paisa, 0),
        refund_paisa: input.refund?.amount_paisa ?? 0,
      },
      flags: user.role === 'operator' ? ['by_operator'] : [],
      reason: input.reason,
    });

    if (input.refund) {
      const refund = tx
        .insert(payments)
        .values({
          doc_no: nextDocNo(tx, 'refund'),
          kind: 'refund',
          party_type: 'customer',
          party_id: sale.customer_id,
          date: input.date,
          amount_paisa: input.refund.amount_paisa,
          method: input.refund.method,
          status: 'posted',
          sales_return_id: header.id,
          version: 1,
          notes: `Refund for return ${header.doc_no}`,
          created_by: user.id,
          updated_by: user.id,
          created_at: now,
          updated_at: now,
        })
        .returning()
        .get();
      postEntry(tx, {
        party_type: 'customer',
        party_id: sale.customer_id,
        date: input.date,
        debit_paisa: input.refund.amount_paisa,
        entry_type: 'refund',
        source_type: 'payment',
        source_id: refund.id,
        narration: `Refund ${refund.doc_no} for return ${header.doc_no} (${input.refund.method})`,
      });
      writeAudit(tx, auditActor(user), {
        action: 'create',
        entity: 'payment',
        entity_id: refund.id,
        doc_no: refund.doc_no,
        version_after: 1,
        after: refund,
        summary: { customer_id: sale.customer_id, customer_name: sale.customer_name, amount_paisa: input.refund.amount_paisa, sales_return_doc_no: header.doc_no },
        flags: user.role === 'operator' ? ['by_operator'] : [],
      });
    }

    recalcAllocations(tx, sale.customer_id);
    return getSalesReturn(tx, header.id);
  });
}
