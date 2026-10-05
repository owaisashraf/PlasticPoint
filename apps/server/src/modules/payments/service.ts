import { and, asc, desc, eq, gte, lte, sql, type SQL } from 'drizzle-orm';
import { alias } from 'drizzle-orm/sqlite-core';
import { bounceChequeSchema, createReceiptSchema, createSupplierPaymentSchema, paymentListQuerySchema, type Payment } from '@shopledger/shared';
import type { z } from 'zod';
import { writeTx, type DB, type DbOrTx } from '../../db/client';
import { customers, payment_allocations, payments, sales, suppliers, users } from '../../db/schema';
import { loadTargets, recalcAllocations, removeAllocationsFromSource } from '../../lib/allocation';
import { writeAudit } from '../../lib/audit';
import { businessToday, nowIso } from '../../lib/dates';
import { badRequest, notFound } from '../../lib/errors';
import { postEntry } from '../../lib/ledger';
import { formatPaisa } from '../../lib/money';
import { nextDocNo } from '../../lib/numbering';
import type { SessionUser } from '../../lib/permissions';
import { auditActor } from '../auth/service';

type ReceiptInput = z.output<typeof createReceiptSchema>;
type SupplierPaymentInput = z.output<typeof createSupplierPaymentSchema>;
type BounceInput = z.output<typeof bounceChequeSchema>;
type ListQuery = z.output<typeof paymentListQuerySchema>;
type PaymentRow = typeof payments.$inferSelect;

// --- Reading ---------------------------------------------------------------------

const createdBy = alias(users, 'created_by_user');

// Outer columns are written with their table name: a bare "id" inside a
// subquery would bind to the subquery's own table.
const partyName = sql<string>`CASE ${payments.party_type}
  WHEN 'customer' THEN (SELECT c.name FROM customers c WHERE c.id = "payments"."party_id")
  ELSE (SELECT s.name FROM suppliers s WHERE s.id = "payments"."party_id") END`;
const partyCode = sql<string | null>`CASE ${payments.party_type} WHEN 'customer' THEN (SELECT c.code FROM customers c WHERE c.id = "payments"."party_id") ELSE NULL END`;
const allocatedSql = sql<number>`coalesce((SELECT sum(pa.amount_paisa) FROM payment_allocations pa WHERE pa.source_type = 'payment' AND pa.source_id = "payments"."id"), 0)`;

const listSelect = { p: payments, party_name: partyName, party_code: partyCode, allocated: allocatedSql, created_by_name: createdBy.display_name };

function toPayment(r: { p: PaymentRow; party_name: string; party_code: string | null; allocated: number; created_by_name: string | null }): Payment {
  const { created_by: _c, updated_by: _u, updated_at: _ua, ...p } = r.p;
  return { ...p, party_name: r.party_name, party_code: r.party_code, allocated_paisa: r.allocated, created_by_name: r.created_by_name };
}

export function getPayment(db: DbOrTx, id: number): Payment {
  const r = db.select(listSelect).from(payments).leftJoin(createdBy, eq(createdBy.id, payments.created_by)).where(eq(payments.id, id)).get();
  if (!r) throw notFound('Payment not found.');
  const allocations = db
    .select({
      source_type: payment_allocations.source_type,
      source_id: payment_allocations.source_id,
      sale_id: payment_allocations.sale_id,
      sale_doc_no: sales.doc_no,
      amount_paisa: payment_allocations.amount_paisa,
      is_manual: payment_allocations.is_manual,
    })
    .from(payment_allocations)
    .leftJoin(sales, eq(sales.id, payment_allocations.sale_id))
    .where(and(eq(payment_allocations.source_type, 'payment'), eq(payment_allocations.source_id, id)))
    .orderBy(asc(payment_allocations.id))
    .all();
  return { ...toPayment(r), allocations };
}

export function listPayments(db: DB, q: ListQuery): { payments: Payment[]; total: number } {
  const conds: (SQL | undefined)[] = [];
  if (q.kind) conds.push(eq(payments.kind, q.kind));
  if (q.customer_id) conds.push(and(eq(payments.party_type, 'customer'), eq(payments.party_id, q.customer_id)));
  if (q.supplier_id) conds.push(and(eq(payments.party_type, 'supplier'), eq(payments.party_id, q.supplier_id)));
  if (q.from) conds.push(gte(payments.date, q.from));
  if (q.to) conds.push(lte(payments.date, q.to));
  if (q.q) {
    for (const word of q.q.split(/\s+/).filter(Boolean)) {
      const like = `%${word.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
      conds.push(
        sql`(${payments.doc_no} LIKE ${like} ESCAPE '\\' OR coalesce(${payments.reference}, '') LIKE ${like} ESCAPE '\\' OR coalesce(${payments.cheque_no}, '') LIKE ${like} ESCAPE '\\' OR ${partyName} LIKE ${like} ESCAPE '\\' OR coalesce(${partyCode}, '') LIKE ${like} ESCAPE '\\')`,
      );
    }
  }
  const where = and(...conds);
  const total = db.select({ n: sql<number>`count(*)` }).from(payments).where(where).get()?.n ?? 0;
  const rows = db
    .select(listSelect)
    .from(payments)
    .leftJoin(createdBy, eq(createdBy.id, payments.created_by))
    .where(where)
    .orderBy(desc(payments.date), desc(payments.id))
    .limit(q.limit)
    .offset(q.offset)
    .all();
  return { payments: rows.map(toPayment), total };
}

// --- Receipts --------------------------------------------------------------------

/**
 * Money received from a customer, in one transaction: the receipt, a ledger
 * credit, any allocations the user picked (kept as manual), FIFO for the
 * rest, and one audit row. Anything not linked to an invoice is an advance.
 */
export function createReceipt(db: DB, user: SessionUser, input: ReceiptInput): Payment {
  if (input.date > businessToday()) throw badRequest('The payment date cannot be in the future.');

  return writeTx(db, (tx) => {
    const customer = tx.select().from(customers).where(eq(customers.id, input.customer_id)).get();
    if (!customer) throw badRequest('Pick the customer.');

    // Manual allocations: merged per invoice, each within what the invoice is worth.
    const manual = new Map<number | null, number>();
    for (const a of input.allocations) manual.set(a.sale_id, (manual.get(a.sale_id) ?? 0) + a.amount_paisa);
    const manualTotal = [...manual.values()].reduce((a, b) => a + b, 0);
    if (manualTotal > input.amount_paisa) throw badRequest(`The amounts picked add up to ${formatPaisa(manualTotal)}, more than the ${formatPaisa(input.amount_paisa)} received.`);
    const targets = new Map(loadTargets(tx, customer.id).map((t) => [t.sale_id, t]));
    for (const saleId of manual.keys()) {
      if (!targets.has(saleId)) throw badRequest(saleId === null ? 'This customer has no opening balance to pay.' : 'One of the picked invoices is not an open invoice of this customer.');
    }

    const now = nowIso();
    const payment = tx
      .insert(payments)
      .values({
        doc_no: nextDocNo(tx, 'receipt'),
        kind: 'receipt',
        party_type: 'customer',
        party_id: customer.id,
        date: input.date,
        amount_paisa: input.amount_paisa,
        method: input.method,
        reference: input.reference,
        cheque_no: input.method === 'cheque' ? input.cheque_no : null,
        cheque_bank: input.method === 'cheque' ? input.cheque_bank : null,
        cheque_date: input.method === 'cheque' ? input.cheque_date : null,
        status: 'posted',
        version: 1,
        notes: input.notes,
        created_by: user.id,
        updated_by: user.id,
        created_at: now,
        updated_at: now,
      })
      .returning()
      .get();

    for (const [saleId, amount] of manual) {
      tx.insert(payment_allocations).values({ customer_id: customer.id, source_type: 'payment', source_id: payment.id, sale_id: saleId, amount_paisa: amount, is_manual: true, created_at: now }).run();
    }
    postEntry(tx, {
      party_type: 'customer',
      party_id: customer.id,
      date: input.date,
      credit_paisa: input.amount_paisa,
      entry_type: 'receipt',
      source_type: 'payment',
      source_id: payment.id,
      narration: `Receipt ${payment.doc_no} (${input.method}${input.method === 'cheque' && input.cheque_no ? ` ${input.cheque_no}` : input.reference ? ` ${input.reference}` : ''})`,
    });
    recalcAllocations(tx, customer.id);

    const result = getPayment(tx, payment.id);
    writeAudit(tx, auditActor(user), {
      action: 'create',
      entity: 'payment',
      entity_id: payment.id,
      doc_no: payment.doc_no,
      version_after: 1,
      after: { ...payment, allocations: result.allocations },
      summary: {
        customer_id: customer.id,
        customer_name: customer.name,
        amount_paisa: input.amount_paisa,
        method: input.method,
        allocation: manual.size ? 'manual' : 'fifo',
        advance_paisa: input.amount_paisa - result.allocated_paisa,
      },
      flags: user.role === 'operator' ? ['by_operator'] : [],
    });
    return result;
  });
}

// --- Supplier payments -------------------------------------------------------------

/** Money paid to the supplier: a debit on the supplier ledger (we owe less). */
export function createSupplierPayment(db: DB, user: SessionUser, input: SupplierPaymentInput): Payment {
  if (input.date > businessToday()) throw badRequest('The payment date cannot be in the future.');

  return writeTx(db, (tx) => {
    const supplier = tx.select().from(suppliers).where(eq(suppliers.id, input.supplier_id)).get();
    if (!supplier) throw badRequest('Pick the supplier.');
    const now = nowIso();
    const payment = tx
      .insert(payments)
      .values({
        doc_no: nextDocNo(tx, 'supplier_payment'),
        kind: 'supplier_payment',
        party_type: 'supplier',
        party_id: supplier.id,
        date: input.date,
        amount_paisa: input.amount_paisa,
        method: input.method,
        reference: input.reference,
        cheque_no: input.method === 'cheque' ? input.cheque_no : null,
        cheque_bank: input.method === 'cheque' ? input.cheque_bank : null,
        cheque_date: input.method === 'cheque' ? input.cheque_date : null,
        status: 'posted',
        version: 1,
        notes: input.notes,
        created_by: user.id,
        updated_by: user.id,
        created_at: now,
        updated_at: now,
      })
      .returning()
      .get();
    postEntry(tx, {
      party_type: 'supplier',
      party_id: supplier.id,
      date: input.date,
      debit_paisa: input.amount_paisa,
      entry_type: 'supplier_payment',
      source_type: 'payment',
      source_id: payment.id,
      narration: `Payment ${payment.doc_no} (${input.method}${input.method === 'cheque' && input.cheque_no ? ` ${input.cheque_no}` : input.reference ? ` ${input.reference}` : ''})`,
    });
    writeAudit(tx, auditActor(user), {
      action: 'create',
      entity: 'payment',
      entity_id: payment.id,
      doc_no: payment.doc_no,
      version_after: 1,
      after: payment,
      summary: { supplier_id: supplier.id, supplier_name: supplier.name, amount_paisa: input.amount_paisa, method: input.method },
      flags: user.role === 'operator' ? ['by_operator'] : [],
    });
    return getPayment(tx, payment.id);
  });
}

// --- Bounced cheques -----------------------------------------------------------------

/**
 * Owner+: a customer's cheque came back unpaid. The receipt is marked
 * bounced (it stays visible), its links to invoices are removed, and the
 * customer is debited with a 'bounced_cheque' entry, so the ledger shows both
 * the receipt and its reversal. Invoices it paid become outstanding again.
 */
export function bounceCheque(db: DB, user: SessionUser, id: number, input: BounceInput): Payment {
  const date = input.date ?? businessToday();
  if (date > businessToday()) throw badRequest('The date cannot be in the future.');

  return writeTx(db, (tx) => {
    const before = tx.select().from(payments).where(eq(payments.id, id)).get();
    if (!before) throw notFound('Payment not found.');
    if (before.kind !== 'receipt' || before.method !== 'cheque') throw badRequest('Only a cheque received from a customer can be marked as bounced.');
    if (before.status !== 'posted') throw badRequest(before.status === 'bounced' ? 'This cheque is already marked as bounced.' : 'This receipt is void.');
    if (date < before.date) throw badRequest('The cheque cannot bounce before it was received.');

    const allocationsBefore = getPayment(tx, id).allocations;
    const now = nowIso();
    const after = tx
      .update(payments)
      .set({ status: 'bounced', bounced_at: now, bounce_reason: input.reason, version: before.version + 1, updated_by: user.id, updated_at: now })
      .where(eq(payments.id, id))
      .returning()
      .get();
    removeAllocationsFromSource(tx, 'payment', id);
    postEntry(tx, {
      party_type: 'customer',
      party_id: before.party_id,
      date,
      debit_paisa: before.amount_paisa,
      entry_type: 'bounced_cheque',
      source_type: 'payment',
      source_id: id,
      narration: `Cheque${before.cheque_no ? ` ${before.cheque_no}` : ''} bounced (${before.doc_no})`,
    });
    recalcAllocations(tx, before.party_id);

    writeAudit(tx, auditActor(user), {
      action: 'bounce',
      entity: 'payment',
      entity_id: id,
      doc_no: before.doc_no,
      version_before: before.version,
      version_after: after.version,
      before: { ...before, allocations: allocationsBefore },
      after,
      summary: { customer_id: before.party_id, amount_paisa: before.amount_paisa, cheque_no: before.cheque_no, bounce_date: date },
      reason: input.reason,
    });
    return getPayment(tx, id);
  });
}
