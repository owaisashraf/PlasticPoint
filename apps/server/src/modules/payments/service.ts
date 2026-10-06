import { and, asc, desc, eq, gte, lte, ne, sql, type SQL } from 'drizzle-orm';
import { alias } from 'drizzle-orm/sqlite-core';
import {
  bounceChequeSchema,
  createReceiptSchema,
  createSupplierPaymentSchema,
  paymentListQuerySchema,
  updateReceiptSchema,
  updateRefundSchema,
  updateSupplierPaymentSchema,
  type Payment,
  type PermissionKey,
} from '@shopledger/shared';
import type { z } from 'zod';
import { writeTx, type DB, type DbOrTx } from '../../db/client';
import { customers, payment_allocations, payments, sales, sales_returns, suppliers, users } from '../../db/schema';
import { loadTargets, recalcAllocations, removeAllocationsFromSource } from '../../lib/allocation';
import { writeAudit } from '../../lib/audit';
import { businessToday, nowIso } from '../../lib/dates';
import { assertCanEdit, assertCanVoid, changeFlags, diffSnapshots, diffSummary, totalFlags, uniqueFlags } from '../../lib/documents';
import { badRequest, notFound } from '../../lib/errors';
import { postEntry, removeEntriesForSource } from '../../lib/ledger';
import { formatPaisa } from '../../lib/money';
import { nextDocNo } from '../../lib/numbering';
import type { SessionUser } from '../../lib/permissions';
import { auditActor } from '../auth/service';

type ReceiptInput = z.output<typeof createReceiptSchema>;
type SupplierPaymentInput = z.output<typeof createSupplierPaymentSchema>;
type BounceInput = z.output<typeof bounceChequeSchema>;
type ListQuery = z.output<typeof paymentListQuerySchema>;
type UpdateReceiptInput = z.output<typeof updateReceiptSchema>;
type UpdateSupplierPaymentInput = z.output<typeof updateSupplierPaymentSchema>;
type UpdateRefundInput = z.output<typeof updateRefundSchema>;
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
  const { created_by, updated_by: _u, updated_at: _ua, ...p } = r.p;
  return { ...p, party_name: r.party_name, party_code: r.party_code, allocated_paisa: r.allocated, created_by_id: created_by, created_by_name: r.created_by_name };
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

/**
 * Manual allocations picked on the receipt screen: merged per invoice, at
 * most the amount received, and only to this customer's open items.
 */
function manualAllocations(tx: DbOrTx, customerId: number, picked: readonly { sale_id: number | null; amount_paisa: number }[], amount: number): Map<number | null, number> {
  const manual = new Map<number | null, number>();
  for (const a of picked) manual.set(a.sale_id, (manual.get(a.sale_id) ?? 0) + a.amount_paisa);
  const manualTotal = [...manual.values()].reduce((a, b) => a + b, 0);
  if (manualTotal > amount) throw badRequest(`The amounts picked add up to ${formatPaisa(manualTotal)}, more than the ${formatPaisa(amount)} received.`);
  const targets = new Map(loadTargets(tx, customerId).map((t) => [t.sale_id, t]));
  for (const saleId of manual.keys()) {
    if (!targets.has(saleId)) throw badRequest(saleId === null ? 'This customer has no opening balance to pay.' : 'One of the picked invoices is not an open invoice of this customer.');
  }
  return manual;
}

function moneyNarration(prefix: string, docNo: string, p: { method: string; cheque_no: string | null; reference: string | null }): string {
  return `${prefix} ${docNo} (${p.method}${p.method === 'cheque' && p.cheque_no ? ` ${p.cheque_no}` : p.reference ? ` ${p.reference}` : ''})`;
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

    const manual = manualAllocations(tx, customer.id, input.allocations, input.amount_paisa);

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
      narration: moneyNarration('Receipt', payment.doc_no, payment),
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
      narration: moneyNarration('Payment', payment.doc_no, payment),
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

// --- Editing and voiding (CLAUDE.md 8.6) ---------------------------------------------

const createKeyFor = (kind: PaymentRow['kind']): PermissionKey => (kind === 'refund' ? 'returns.create' : 'payments.create');

/** A payment as stored, with what it pays (for the audit log). */
export function paymentSnapshot(db: DbOrTx, id: number) {
  const row = db.select().from(payments).where(eq(payments.id, id)).get();
  if (!row) throw notFound('Payment not found.');
  return { ...row, allocations: getPayment(db, id).allocations ?? [] };
}

function loadForChange(tx: DbOrTx, id: number, kind: PaymentRow['kind']): PaymentRow {
  const row = tx.select().from(payments).where(eq(payments.id, id)).get();
  if (!row || row.kind !== kind) throw notFound('Payment not found.');
  if (row.status === 'bounced') throw badRequest('This cheque bounced and was charged back; it cannot be changed.');
  return row;
}

function writeEditAudit(tx: DbOrTx, user: SessionUser, row: PaymentRow, before: ReturnType<typeof paymentSnapshot>, reason: string): void {
  const after = paymentSnapshot(tx, row.id);
  // Allocations are compared like document lines, matched by invoice.
  const diff = diffSnapshots({ ...before, lines: before.allocations }, { ...after, lines: after.allocations }, (l) => String(l.sale_id), (l) => String(l.sale_doc_no ?? 'Opening balance'));
  writeAudit(tx, auditActor(user), {
    action: 'edit',
    entity: 'payment',
    entity_id: row.id,
    doc_no: row.doc_no,
    version_before: before.version,
    version_after: after.version,
    before,
    after,
    summary: { ...diffSummary(diff), kind: row.kind, party_type: row.party_type, party_id: row.party_id, amount_before_paisa: before.amount_paisa, amount_after_paisa: after.amount_paisa },
    flags: uniqueFlags(changeFlags(tx, user, 'payment', row.id, row.created_at), totalFlags(before.amount_paisa, after.amount_paisa)),
    reason,
  });
}

/**
 * Edits a receipt: date, amount, method, references and which invoices it
 * pays. Cash taken at the counter with a sale stays linked to that sale.
 * The customer cannot change (void it and record it again instead).
 */
export function updateReceipt(db: DB, user: SessionUser, id: number, input: UpdateReceiptInput): Payment {
  if (input.date > businessToday()) throw badRequest('The payment date cannot be in the future.');
  return writeTx(db, (tx) => {
    const row = loadForChange(tx, id, 'receipt');
    assertCanEdit(user, row, createKeyFor(row.kind));
    const before = paymentSnapshot(tx, id);
    removeAllocationsFromSource(tx, 'payment', id);
    const manual = row.sale_id !== null ? new Map([[row.sale_id, input.amount_paisa]]) : manualAllocations(tx, row.party_id, input.allocations, input.amount_paisa);
    const now = nowIso();
    const after = tx
      .update(payments)
      .set({
        date: input.date,
        amount_paisa: input.amount_paisa,
        method: input.method,
        reference: input.reference,
        cheque_no: input.method === 'cheque' ? input.cheque_no : null,
        cheque_bank: input.method === 'cheque' ? input.cheque_bank : null,
        cheque_date: input.method === 'cheque' ? input.cheque_date : null,
        notes: input.notes,
        version: row.version + 1,
        updated_by: user.id,
        updated_at: now,
      })
      .where(eq(payments.id, id))
      .returning()
      .get();
    for (const [saleId, amount] of manual) {
      tx.insert(payment_allocations).values({ customer_id: row.party_id, source_type: 'payment', source_id: id, sale_id: saleId, amount_paisa: amount, is_manual: true, created_at: now }).run();
    }
    removeEntriesForSource(tx, 'payment', id);
    postEntry(tx, {
      party_type: 'customer',
      party_id: row.party_id,
      date: input.date,
      credit_paisa: input.amount_paisa,
      entry_type: 'receipt',
      source_type: 'payment',
      source_id: id,
      narration: moneyNarration('Receipt', row.doc_no, after),
    });
    recalcAllocations(tx, row.party_id);
    writeEditAudit(tx, user, row, before, input.change_reason);
    return getPayment(tx, id);
  });
}

/** Edits a payment made to the supplier. */
export function updateSupplierPayment(db: DB, user: SessionUser, id: number, input: UpdateSupplierPaymentInput): Payment {
  if (input.date > businessToday()) throw badRequest('The payment date cannot be in the future.');
  return writeTx(db, (tx) => {
    const row = loadForChange(tx, id, 'supplier_payment');
    assertCanEdit(user, row, createKeyFor(row.kind));
    const before = paymentSnapshot(tx, id);
    const after = tx
      .update(payments)
      .set({
        date: input.date,
        amount_paisa: input.amount_paisa,
        method: input.method,
        reference: input.reference,
        cheque_no: input.method === 'cheque' ? input.cheque_no : null,
        cheque_bank: input.method === 'cheque' ? input.cheque_bank : null,
        cheque_date: input.method === 'cheque' ? input.cheque_date : null,
        notes: input.notes,
        version: row.version + 1,
        updated_by: user.id,
        updated_at: nowIso(),
      })
      .where(eq(payments.id, id))
      .returning()
      .get();
    removeEntriesForSource(tx, 'payment', id);
    postEntry(tx, {
      party_type: 'supplier',
      party_id: row.party_id,
      date: input.date,
      debit_paisa: input.amount_paisa,
      entry_type: 'supplier_payment',
      source_type: 'payment',
      source_id: id,
      narration: moneyNarration('Payment', row.doc_no, after),
    });
    writeEditAudit(tx, user, row, before, input.change_reason);
    return getPayment(tx, id);
  });
}

/** Edits money paid back for a return: at most the return's credit less other refunds for it. */
export function updateRefund(db: DB, user: SessionUser, id: number, input: UpdateRefundInput): Payment {
  if (input.date > businessToday()) throw badRequest('The refund date cannot be in the future.');
  return writeTx(db, (tx) => {
    const row = loadForChange(tx, id, 'refund');
    assertCanEdit(user, row, createKeyFor(row.kind));
    const ret = row.sales_return_id === null ? undefined : tx.select().from(sales_returns).where(eq(sales_returns.id, row.sales_return_id)).get();
    if (!ret || ret.status !== 'posted') throw badRequest('The return this refund was for is void. Void the refund instead.');
    const others =
      tx
        .select({ s: sql<number>`coalesce(sum(${payments.amount_paisa}), 0)` })
        .from(payments)
        .where(and(eq(payments.sales_return_id, ret.id), eq(payments.kind, 'refund'), eq(payments.status, 'posted'), ne(payments.id, id)))
        .get()?.s ?? 0;
    if (input.amount_paisa > ret.total_paisa - others) throw badRequest(`The refund cannot be more than ${formatPaisa(ret.total_paisa - others)} (the credit for ${ret.doc_no}).`);
    if (input.date < ret.date) throw badRequest('The refund cannot be dated before the return.');
    const before = paymentSnapshot(tx, id);
    tx.update(payments)
      .set({ date: input.date, amount_paisa: input.amount_paisa, method: input.method, version: row.version + 1, updated_by: user.id, updated_at: nowIso() })
      .where(eq(payments.id, id))
      .run();
    removeEntriesForSource(tx, 'payment', id);
    postEntry(tx, {
      party_type: 'customer',
      party_id: row.party_id,
      date: input.date,
      debit_paisa: input.amount_paisa,
      entry_type: 'refund',
      source_type: 'payment',
      source_id: id,
      narration: `Refund ${row.doc_no} for return ${ret.doc_no} (${input.method})`,
    });
    recalcAllocations(tx, row.party_id);
    writeEditAudit(tx, user, row, before, input.change_reason);
    return getPayment(tx, id);
  });
}

/**
 * Voids a payment inside an open transaction (also used when its invoice or
 * return is voided): its ledger entry and links to invoices are taken off,
 * the customer's allocations are recalculated, and one audit row is written.
 * Permission is checked by the caller.
 */
export function voidPaymentTx(tx: DbOrTx, user: SessionUser, id: number, reason: string): void {
  const row = tx.select().from(payments).where(eq(payments.id, id)).get();
  if (!row) throw notFound('Payment not found.');
  if (row.status === 'bounced') throw badRequest('This cheque bounced and was already charged back.');
  if (row.status !== 'posted') throw badRequest(`${row.doc_no} is already void.`);
  const before = paymentSnapshot(tx, id);
  removeAllocationsFromSource(tx, 'payment', id);
  removeEntriesForSource(tx, 'payment', id);
  tx.update(payments).set({ status: 'void', version: row.version + 1, updated_by: user.id, updated_at: nowIso() }).where(eq(payments.id, id)).run();
  if (row.party_type === 'customer') recalcAllocations(tx, row.party_id);
  writeAudit(tx, auditActor(user), {
    action: 'void',
    entity: 'payment',
    entity_id: id,
    doc_no: row.doc_no,
    version_before: row.version,
    version_after: row.version + 1,
    before,
    after: paymentSnapshot(tx, id),
    summary: { kind: row.kind, party_type: row.party_type, party_id: row.party_id, amount_before_paisa: row.amount_paisa, amount_after_paisa: 0 },
    flags: uniqueFlags(changeFlags(tx, user, 'payment', id, row.created_at), ['voided']),
    reason,
  });
}

/** Owner+: voids a receipt, supplier payment or refund. */
export function voidPayment(db: DB, user: SessionUser, id: number, reason: string): Payment {
  return writeTx(db, (tx) => {
    const row = tx.select().from(payments).where(eq(payments.id, id)).get();
    if (!row) throw notFound('Payment not found.');
    if (row.status === 'bounced') throw badRequest('This cheque bounced and was already charged back.');
    assertCanVoid(user, row);
    voidPaymentTx(tx, user, id, reason);
    return getPayment(tx, id);
  });
}
