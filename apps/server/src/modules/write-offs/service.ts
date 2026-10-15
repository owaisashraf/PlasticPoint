import { asc, desc, eq, sql } from 'drizzle-orm';
import { createWriteOffSchema, reverseWriteOffSchema, updateWriteOffSchema, type WriteOff } from '@shopledger/shared';
import type { z } from 'zod';
import { writeTx, type DB, type DbOrTx } from '../../db/client';
import { customers, users, write_off_reversals, write_offs } from '../../db/schema';
import { recalcAllocations, removeAllocationsFromSource } from '../../lib/allocation';
import { writeAudit } from '../../lib/audit';
import { businessToday, nowIso } from '../../lib/dates';
import { assertCanEdit, assertCanVoid, changeFlags, diffSnapshots, totalFlags, uniqueFlags } from '../../lib/documents';
import { badRequest, notFound } from '../../lib/errors';
import { partyBalance, postEntry, removeEntriesForSource } from '../../lib/ledger';
import { formatPaisa } from '../../lib/money';
import { nextDocNo } from '../../lib/numbering';
import type { SessionUser } from '../../lib/permissions';
import { auditActor } from '../auth/service';

type CreateInput = z.output<typeof createWriteOffSchema>;
type ReverseInput = z.output<typeof reverseWriteOffSchema>;
type UpdateInput = z.output<typeof updateWriteOffSchema>;

/**
 * Write-offs (CLAUDE.md 8.8), owner and superuser only. A write-off credits
 * the customer with any amount up to their balance and is allocated FIFO, so
 * written-off invoices stop counting as overdue. If the customer later pays,
 * all or part of it is reversed (a debit) before the receipt is recorded.
 */

function reversals(db: DbOrTx, writeOffId: number): WriteOff['reversals'] {
  return db
    .select({ id: write_off_reversals.id, date: write_off_reversals.date, amount_paisa: write_off_reversals.amount_paisa, reason: write_off_reversals.reason, created_at: write_off_reversals.created_at })
    .from(write_off_reversals)
    .where(eq(write_off_reversals.write_off_id, writeOffId))
    .orderBy(asc(write_off_reversals.id))
    .all();
}

function writeOffQuery(db: DbOrTx) {
  return db.select({ w: write_offs, created_by_name: users.display_name }).from(write_offs).leftJoin(users, eq(users.id, write_offs.created_by));
}

function toWriteOff(db: DbOrTx, r: { w: typeof write_offs.$inferSelect; created_by_name: string | null }): WriteOff {
  const revs = reversals(db, r.w.id);
  return {
    id: r.w.id,
    doc_no: r.w.doc_no,
    customer_id: r.w.customer_id,
    date: r.w.date,
    amount_paisa: r.w.amount_paisa,
    reversed_paisa: revs.reduce((a, x) => a + x.amount_paisa, 0),
    reason: r.w.reason,
    status: r.w.status,
    version: r.w.version,
    created_at: r.w.created_at,
    created_by_id: r.w.created_by,
    created_by_name: r.created_by_name,
    reversals: revs,
  };
}

export function getWriteOff(db: DbOrTx, id: number): WriteOff {
  const r = writeOffQuery(db).where(eq(write_offs.id, id)).get();
  if (!r) throw notFound('Write-off not found.');
  return toWriteOff(db, r);
}

export function listWriteOffs(db: DB, customerId: number): WriteOff[] {
  return writeOffQuery(db)
    .where(eq(write_offs.customer_id, customerId))
    .orderBy(desc(write_offs.date), desc(write_offs.id))
    .all()
    .map((r) => toWriteOff(db, r));
}

export function createWriteOff(db: DB, user: SessionUser, customerId: number, input: CreateInput): WriteOff {
  if (input.date > businessToday()) throw badRequest('The date cannot be in the future.');
  return writeTx(db, (tx) => {
    const customer = tx.select().from(customers).where(eq(customers.id, customerId)).get();
    if (!customer) throw notFound('Customer not found.');
    const balance = partyBalance(tx, 'customer', customerId);
    if (balance <= 0) throw badRequest(`${customer.name} owes nothing, so there is nothing to write off.`);
    if (input.amount_paisa > balance) throw badRequest(`You can write off at most the balance of ${formatPaisa(balance)}.`);

    const now = nowIso();
    const row = tx
      .insert(write_offs)
      .values({
        doc_no: nextDocNo(tx, 'write_off'),
        customer_id: customerId,
        date: input.date,
        amount_paisa: input.amount_paisa,
        reason: input.reason,
        status: 'posted',
        version: 1,
        created_by: user.id,
        updated_by: user.id,
        created_at: now,
        updated_at: now,
      })
      .returning()
      .get();
    postEntry(tx, {
      party_type: 'customer',
      party_id: customerId,
      date: input.date,
      credit_paisa: input.amount_paisa,
      entry_type: 'write_off',
      source_type: 'write_off',
      source_id: row.id,
      narration: `Written off ${row.doc_no}: ${input.reason}`,
    });
    recalcAllocations(tx, customerId);
    writeAudit(tx, auditActor(user), {
      action: 'create',
      entity: 'write_off',
      entity_id: row.id,
      doc_no: row.doc_no,
      version_after: 1,
      after: row,
      summary: { customer_id: customerId, customer_name: customer.name, amount_paisa: input.amount_paisa, balance_before_paisa: balance },
      reason: input.reason,
    });
    return getWriteOff(tx, row.id);
  });
}

/** Takes back all or part of a write-off when a bad-debt customer pays after all. */
export function reverseWriteOff(db: DB, user: SessionUser, writeOffId: number, input: ReverseInput): WriteOff {
  if (input.date > businessToday()) throw badRequest('The date cannot be in the future.');
  return writeTx(db, (tx) => {
    const before = getWriteOff(tx, writeOffId);
    if (before.status !== 'posted') throw badRequest('This write-off is void.');
    if (input.date < before.date) throw badRequest('The reversal cannot be dated before the write-off.');
    const left = before.amount_paisa - before.reversed_paisa;
    if (left <= 0) throw badRequest('This write-off has already been fully reversed.');
    if (input.amount_paisa > left) throw badRequest(`You can reverse at most ${formatPaisa(left)} of this write-off.`);

    const rev = tx
      .insert(write_off_reversals)
      .values({ write_off_id: writeOffId, customer_id: before.customer_id, date: input.date, amount_paisa: input.amount_paisa, reason: input.reason, created_by: user.id, created_at: nowIso() })
      .returning()
      .get();
    postEntry(tx, {
      party_type: 'customer',
      party_id: before.customer_id,
      date: input.date,
      debit_paisa: input.amount_paisa,
      entry_type: 'write_off_reversal',
      source_type: 'write_off_reversal',
      source_id: rev.id,
      narration: `Write-off ${before.doc_no} reversed: ${input.reason}`,
    });
    recalcAllocations(tx, before.customer_id);
    const after = getWriteOff(tx, writeOffId);
    writeAudit(tx, auditActor(user), {
      action: 'reverse',
      entity: 'write_off',
      entity_id: writeOffId,
      doc_no: before.doc_no,
      before,
      after,
      summary: { customer_id: before.customer_id, reversed_paisa: input.amount_paisa, still_written_off_paisa: left - input.amount_paisa },
      reason: input.reason,
    });
    return after;
  });
}

/** Net bad debt for a customer: written off less reversed (for the customer screen). */
export function netWrittenOff(db: DbOrTx, customerId: number): number {
  const w = db.select({ s: sql<number>`coalesce(sum(${write_offs.amount_paisa}), 0)` }).from(write_offs).where(eq(write_offs.customer_id, customerId)).get()?.s ?? 0;
  const r = db.select({ s: sql<number>`coalesce(sum(${write_off_reversals.amount_paisa}), 0)` }).from(write_off_reversals).where(eq(write_off_reversals.customer_id, customerId)).get()?.s ?? 0;
  return w - r;
}

// --- Editing and voiding (CLAUDE.md 8.6) ---------------------------------------------

function writeOffSnapshot(db: DbOrTx, id: number) {
  const { reversals: revs, ...w } = getWriteOff(db, id);
  return { ...w, lines: revs };
}

/**
 * Owner+: edits a write-off (date, amount, reason). The amount stays within
 * what the customer owes without it, and at least what was already taken back.
 */
export function updateWriteOff(db: DB, user: SessionUser, id: number, input: UpdateInput): WriteOff {
  if (input.date > businessToday()) throw badRequest('The date cannot be in the future.');
  return writeTx(db, (tx) => {
    const row = tx.select().from(write_offs).where(eq(write_offs.id, id)).get();
    if (!row) throw notFound('Write-off not found.');
    assertCanEdit(user, row, 'write_offs.manage');
    const before = writeOffSnapshot(tx, id);
    if (input.amount_paisa < before.reversed_paisa) throw badRequest(`${formatPaisa(before.reversed_paisa)} of this write-off was already taken back, so it cannot be less than that.`);
    if (before.lines.some((r) => r.date < input.date)) throw badRequest('A reversal of this write-off is dated before the new date.');
    removeEntriesForSource(tx, 'write_off', id);
    const balance = partyBalance(tx, 'customer', row.customer_id);
    if (input.amount_paisa > balance) throw badRequest(`You can write off at most the balance of ${formatPaisa(balance)}.`);
    tx.update(write_offs)
      .set({ date: input.date, amount_paisa: input.amount_paisa, reason: input.reason, version: row.version + 1, updated_by: user.id, updated_at: nowIso() })
      .where(eq(write_offs.id, id))
      .run();
    postEntry(tx, {
      party_type: 'customer',
      party_id: row.customer_id,
      date: input.date,
      credit_paisa: input.amount_paisa,
      entry_type: 'write_off',
      source_type: 'write_off',
      source_id: id,
      narration: `Written off ${row.doc_no}: ${input.reason}`,
    });
    recalcAllocations(tx, row.customer_id);
    const after = writeOffSnapshot(tx, id);
    writeAudit(tx, auditActor(user), {
      action: 'edit',
      entity: 'write_off',
      entity_id: id,
      doc_no: row.doc_no,
      version_before: row.version,
      version_after: row.version + 1,
      before,
      after,
      summary: { changed_fields: Object.keys(diffSnapshots(before, after, (l) => String(l.id), (l) => String(l.date)).fields), customer_id: row.customer_id, amount_before_paisa: row.amount_paisa, amount_after_paisa: input.amount_paisa },
      flags: uniqueFlags(changeFlags(tx, user, 'write_off', id, row.created_at), totalFlags(row.amount_paisa, input.amount_paisa)),
      reason: input.change_reason,
    });
    return getWriteOff(tx, id);
  });
}

/** Owner+: voids a write-off, together with any reversals of it. The customer owes the amount again. */
export function voidWriteOff(db: DB, user: SessionUser, id: number, reason: string): WriteOff {
  return writeTx(db, (tx) => {
    const row = tx.select().from(write_offs).where(eq(write_offs.id, id)).get();
    if (!row) throw notFound('Write-off not found.');
    assertCanVoid(user, row);
    const before = writeOffSnapshot(tx, id);
    removeEntriesForSource(tx, 'write_off', id);
    for (const r of before.lines) removeEntriesForSource(tx, 'write_off_reversal', r.id);
    removeAllocationsFromSource(tx, 'write_off', id);
    tx.update(write_offs).set({ status: 'void', version: row.version + 1, updated_by: user.id, updated_at: nowIso() }).where(eq(write_offs.id, id)).run();
    recalcAllocations(tx, row.customer_id);
    writeAudit(tx, auditActor(user), {
      action: 'void',
      entity: 'write_off',
      entity_id: id,
      doc_no: row.doc_no,
      version_before: row.version,
      version_after: row.version + 1,
      before,
      after: writeOffSnapshot(tx, id),
      summary: { customer_id: row.customer_id, amount_before_paisa: row.amount_paisa, amount_after_paisa: 0 },
      flags: uniqueFlags(changeFlags(tx, user, 'write_off', id, row.created_at), ['voided']),
      reason,
    });
    return getWriteOff(tx, id);
  });
}
