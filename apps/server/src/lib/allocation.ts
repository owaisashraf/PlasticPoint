import { and, asc, eq, sql } from 'drizzle-orm';
import type { AllocationSource, OpenItems } from '@shopledger/shared';
import type { DbOrTx } from '../db/client';
import { payment_allocations, payments, sales, sales_returns, write_offs } from '../db/schema';
import { nowIso } from './dates';
import { badRequest } from './errors';
import { getOpeningBalance } from './ledger';
import { formatPaisa } from './money';

/**
 * Payment-to-invoice allocation (CLAUDE.md 8.5).
 *
 * Targets are what a customer owes: posted invoices and, as the oldest debt,
 * an owed opening balance (sale_id null). Sources are what reduces it:
 * receipts, sales returns (less any cash refunded), write-offs (less
 * reversals) and an opening advance.
 *
 * Manual allocations (picked on the receipt screen, or cash taken with a
 * sale) are kept as they are. Everything else is recalculated from scratch
 * after any change: sources in date order pay the oldest outstanding target
 * first (FIFO); a sales return pays its own invoice first. Whatever is left
 * stays as an advance and is applied automatically to the next invoice.
 */

export interface AllocTarget {
  /** Null: the opening balance. */
  sale_id: number | null;
  date: string;
  total_paisa: number;
}

export interface AllocSourceInput {
  source_type: AllocationSource;
  source_id: number;
  date: string;
  amount_paisa: number;
  /** Sales returns pay their own invoice first. */
  preferred_sale_id?: number | null;
}

export interface Allocation {
  source_type: AllocationSource;
  source_id: number;
  sale_id: number | null;
  amount_paisa: number;
}

const SOURCE_ORDER: Record<AllocationSource, number> = { opening_balance: 0, payment: 1, sales_return: 2, write_off: 3 };

const targetKey = (saleId: number | null) => (saleId === null ? 'opening' : `sale:${saleId}`);
const sourceKey = (s: { source_type: string; source_id: number }) => `${s.source_type}:${s.source_id}`;

/**
 * The automatic allocations for one customer, given the manual ones. Pure:
 * throws if a manual allocation is more than its invoice (or source) allows.
 */
export function planAutoAllocations(targets: readonly AllocTarget[], sources: readonly AllocSourceInput[], manual: readonly Allocation[]): Allocation[] {
  const remaining = new Map(targets.map((t) => [targetKey(t.sale_id), t.total_paisa]));
  const available = new Map(sources.map((s) => [sourceKey(s), s.amount_paisa]));

  for (const m of manual) {
    const tk = targetKey(m.sale_id);
    const left = remaining.get(tk);
    if (left === undefined || left < m.amount_paisa) {
      throw badRequest(
        left === undefined
          ? 'Money is linked to an invoice that is no longer open. Ask the owner to check the payments on it.'
          : `More money is linked to ${m.sale_id === null ? 'the opening balance' : 'an invoice'} than it is worth (${formatPaisa(m.amount_paisa)} against ${formatPaisa(left)} left). Change the payments linked to it first.`,
        'ALLOCATION_EXCEEDS',
      );
    }
    remaining.set(tk, left - m.amount_paisa);
    const sk = sourceKey(m);
    const avail = available.get(sk);
    if (avail === undefined || avail < m.amount_paisa) throw badRequest('A payment is linked to more invoices than its amount.', 'ALLOCATION_EXCEEDS');
    available.set(sk, avail - m.amount_paisa);
  }

  // Oldest first; the opening balance before an invoice on the same day.
  const fifo = [...targets].sort((a, b) => a.date.localeCompare(b.date) || (a.sale_id === null ? -1 : b.sale_id === null ? 1 : a.sale_id - b.sale_id));
  const ordered = [...sources].sort((a, b) => a.date.localeCompare(b.date) || SOURCE_ORDER[a.source_type] - SOURCE_ORDER[b.source_type] || a.source_id - b.source_id);

  const out: Allocation[] = [];
  for (const s of ordered) {
    let left = available.get(sourceKey(s)) ?? 0;
    const order = s.preferred_sale_id ? [...fifo.filter((t) => t.sale_id === s.preferred_sale_id), ...fifo.filter((t) => t.sale_id !== s.preferred_sale_id)] : fifo;
    for (const t of order) {
      if (left <= 0) break;
      const tk = targetKey(t.sale_id);
      const open = remaining.get(tk) ?? 0;
      if (open <= 0) continue;
      const amount = Math.min(open, left);
      out.push({ source_type: s.source_type, source_id: s.source_id, sale_id: t.sale_id, amount_paisa: amount });
      remaining.set(tk, open - amount);
      left -= amount;
    }
  }
  return out;
}

// --- Loading a customer's targets and sources ------------------------------------

export function loadTargets(db: DbOrTx, customerId: number): AllocTarget[] {
  const opening = getOpeningBalance(db, 'customer', customerId);
  const invoices = db
    .select({ sale_id: sales.id, date: sales.date, total_paisa: sales.total_paisa })
    .from(sales)
    .where(and(eq(sales.customer_id, customerId), eq(sales.status, 'posted'), sql`${sales.total_paisa} > 0`))
    .orderBy(asc(sales.date), asc(sales.id))
    .all();
  return [...(opening.amount_paisa > 0 ? [{ sale_id: null, date: opening.date ?? '0000-00-00', total_paisa: opening.amount_paisa }] : []), ...invoices];
}

export function loadSources(db: DbOrTx, customerId: number): AllocSourceInput[] {
  const out: AllocSourceInput[] = [];
  const opening = getOpeningBalance(db, 'customer', customerId);
  if (opening.amount_paisa < 0) out.push({ source_type: 'opening_balance', source_id: customerId, date: opening.date ?? '0000-00-00', amount_paisa: -opening.amount_paisa });

  for (const p of db
    .select({ id: payments.id, date: payments.date, amount: payments.amount_paisa })
    .from(payments)
    .where(and(eq(payments.party_type, 'customer'), eq(payments.party_id, customerId), eq(payments.kind, 'receipt'), eq(payments.status, 'posted')))
    .all()) {
    out.push({ source_type: 'payment', source_id: p.id, date: p.date, amount_paisa: p.amount });
  }

  // A return's credit, less the cash paid back for it.
  for (const r of db
    .select({
      id: sales_returns.id,
      date: sales_returns.date,
      sale_id: sales_returns.sale_id,
      credit: sql<number>`${sales_returns.total_paisa} - coalesce((SELECT sum(p.amount_paisa) FROM payments p WHERE p.sales_return_id = "sales_returns"."id" AND p.kind = 'refund' AND p.status = 'posted'), 0)`,
    })
    .from(sales_returns)
    .where(and(eq(sales_returns.customer_id, customerId), eq(sales_returns.status, 'posted')))
    .all()) {
    if (r.credit > 0) out.push({ source_type: 'sales_return', source_id: r.id, date: r.date, amount_paisa: r.credit, preferred_sale_id: r.sale_id });
  }

  // A write-off, less what was taken back.
  for (const w of db
    .select({
      id: write_offs.id,
      date: write_offs.date,
      left: sql<number>`${write_offs.amount_paisa} - coalesce((SELECT sum(r.amount_paisa) FROM write_off_reversals r WHERE r.write_off_id = "write_offs"."id"), 0)`,
    })
    .from(write_offs)
    .where(and(eq(write_offs.customer_id, customerId), eq(write_offs.status, 'posted')))
    .all()) {
    if (w.left > 0) out.push({ source_type: 'write_off', source_id: w.id, date: w.date, amount_paisa: w.left });
  }
  return out;
}

function loadManual(db: DbOrTx, customerId: number): Allocation[] {
  return db
    .select({ source_type: payment_allocations.source_type, source_id: payment_allocations.source_id, sale_id: payment_allocations.sale_id, amount_paisa: payment_allocations.amount_paisa })
    .from(payment_allocations)
    .where(and(eq(payment_allocations.customer_id, customerId), eq(payment_allocations.is_manual, true)))
    .all();
}

/**
 * Recalculates every automatic allocation of one customer. Call it inside
 * the posting transaction after anything that changes what they owe or paid.
 */
export function recalcAllocations(tx: DbOrTx, customerId: number): void {
  const plan = planAutoAllocations(loadTargets(tx, customerId), loadSources(tx, customerId), loadManual(tx, customerId));
  tx.delete(payment_allocations)
    .where(and(eq(payment_allocations.customer_id, customerId), eq(payment_allocations.is_manual, false)))
    .run();
  const now = nowIso();
  for (const a of plan) tx.insert(payment_allocations).values({ ...a, customer_id: customerId, is_manual: false, created_at: now }).run();
}

/** Removes every allocation made from one source (e.g. a bounced cheque), manual ones included. */
export function removeAllocationsFromSource(tx: DbOrTx, sourceType: AllocationSource, sourceId: number): void {
  tx.delete(payment_allocations)
    .where(and(eq(payment_allocations.source_type, sourceType), eq(payment_allocations.source_id, sourceId)))
    .run();
}

/**
 * What a customer still owes, oldest first (opening balance, then invoices),
 * and any advance not yet linked to anything. Used by the receipt screen.
 */
export function openItems(db: DbOrTx, customerId: number): OpenItems {
  const targets = loadTargets(db, customerId);
  const paid = new Map<string, number>();
  let allocatedTotal = 0;
  for (const a of db
    .select({ sale_id: payment_allocations.sale_id, amount: sql<number>`sum(${payment_allocations.amount_paisa})` })
    .from(payment_allocations)
    .where(eq(payment_allocations.customer_id, customerId))
    .groupBy(payment_allocations.sale_id)
    .all()) {
    paid.set(targetKey(a.sale_id), a.amount);
    allocatedTotal += a.amount;
  }
  const saleInfo = new Map(
    db
      .select({ id: sales.id, doc_no: sales.doc_no, due_date: sales.due_date })
      .from(sales)
      .where(eq(sales.customer_id, customerId))
      .all()
      .map((s) => [s.id, s]),
  );
  const items = targets
    .map((t) => {
      const p = paid.get(targetKey(t.sale_id)) ?? 0;
      const info = t.sale_id === null ? null : saleInfo.get(t.sale_id);
      return { sale_id: t.sale_id, doc_no: info?.doc_no ?? null, date: t.date, due_date: info?.due_date ?? null, total_paisa: t.total_paisa, paid_paisa: p, outstanding_paisa: t.total_paisa - p };
    })
    .filter((i) => i.outstanding_paisa > 0)
    .sort((a, b) => a.date.localeCompare(b.date) || (a.sale_id ?? 0) - (b.sale_id ?? 0));
  const sourceTotal = loadSources(db, customerId).reduce((a, s) => a + s.amount_paisa, 0);
  return { items, advance_paisa: sourceTotal - allocatedTotal };
}
