import { and, asc, eq, gte, lt, lte, sql } from 'drizzle-orm';
import type { LedgerEntryType, PartyType, Statement } from '@shopledger/shared';
import type { DbOrTx } from '../db/client';
import { ledger_entries } from '../db/schema';

/**
 * Customer and supplier ledgers (CLAUDE.md 8.3).
 *
 *   Customer: debit = they owe more (sale, opening balance, bounced cheque, write-off reversal)
 *             credit = they owe less (receipt, sales return, write-off)
 *             balance = Σdebit − Σcredit   (positive: receivable; negative: advance)
 *   Supplier: credit = we owe more (purchase, opening balance)
 *             debit = we owe less (payment, purchase return)
 *             balance = Σcredit − Σdebit   (positive: payable)
 */

export interface LedgerPosting {
  party_type: PartyType;
  party_id: number;
  date: string;
  debit_paisa?: number;
  credit_paisa?: number;
  entry_type: LedgerEntryType;
  source_type: string;
  source_id: number;
  narration?: string | null;
}

/** Posts one entry. Exactly one of debit or credit must be a positive integer. */
export function postEntry(tx: DbOrTx, e: LedgerPosting): number {
  const debit = e.debit_paisa ?? 0;
  const credit = e.credit_paisa ?? 0;
  if (!Number.isSafeInteger(debit) || !Number.isSafeInteger(credit) || debit < 0 || credit < 0) {
    throw new Error('Ledger amounts must be non-negative whole paisa');
  }
  if ((debit === 0) === (credit === 0)) throw new Error('A ledger entry needs exactly one of debit or credit');
  const row = tx
    .insert(ledger_entries)
    .values({
      party_type: e.party_type,
      party_id: e.party_id,
      date: e.date,
      debit_paisa: debit,
      credit_paisa: credit,
      entry_type: e.entry_type,
      source_type: e.source_type,
      source_id: e.source_id,
      narration: e.narration ?? null,
    })
    .returning({ id: ledger_entries.id })
    .get();
  return row.id;
}

/** Removes every entry a document created (used by edit and void). */
export function removeEntriesForSource(tx: DbOrTx, sourceType: string, sourceId: number, entryType?: LedgerEntryType): void {
  const conds = [eq(ledger_entries.source_type, sourceType), eq(ledger_entries.source_id, sourceId)];
  if (entryType) conds.push(eq(ledger_entries.entry_type, entryType));
  tx.delete(ledger_entries).where(and(...conds)).run();
}

/** Positive means "owed to us" for customers and "owed by us" for suppliers. */
function signedSql(partyType: PartyType) {
  return partyType === 'customer'
    ? sql<number>`coalesce(sum(${ledger_entries.debit_paisa}) - sum(${ledger_entries.credit_paisa}), 0)`
    : sql<number>`coalesce(sum(${ledger_entries.credit_paisa}) - sum(${ledger_entries.debit_paisa}), 0)`;
}

/** Current balance of one party (optionally up to and including a date). */
export function partyBalance(db: DbOrTx, partyType: PartyType, partyId: number, asOf?: string): number {
  const conds = [eq(ledger_entries.party_type, partyType), eq(ledger_entries.party_id, partyId)];
  if (asOf) conds.push(lte(ledger_entries.date, asOf));
  return db.select({ b: signedSql(partyType) }).from(ledger_entries).where(and(...conds)).get()?.b ?? 0;
}

/**
 * SQL expression for a party's balance, for use as a column in list queries
 * on the customers or suppliers table. The outer id is written out with its
 * table name: a bare "id" inside the subquery would mean ledger_entries.id.
 */
export function balanceColumnSql(partyType: PartyType) {
  const outerId = sql.raw(partyType === 'customer' ? '"customers"."id"' : '"suppliers"."id"');
  const expr =
    partyType === 'customer'
      ? sql`sum(le.debit_paisa) - sum(le.credit_paisa)`
      : sql`sum(le.credit_paisa) - sum(le.debit_paisa)`;
  return sql<number>`coalesce((SELECT ${expr} FROM ledger_entries le WHERE le.party_type = ${partyType} AND le.party_id = ${outerId}), 0)`;
}

/**
 * Sets a party's opening balance as one 'opening_balance' entry (replacing any
 * earlier one). Positive amounts mean the customer owes us / we owe the
 * supplier; negative amounts are advances. Zero removes it.
 */
export function setOpeningBalance(tx: DbOrTx, partyType: PartyType, partyId: number, amountPaisa: number, date: string): void {
  removeEntriesForSource(tx, partyType, partyId, 'opening_balance');
  if (amountPaisa === 0) return;
  const owedSide = partyType === 'customer' ? 'debit_paisa' : 'credit_paisa';
  const advanceSide = partyType === 'customer' ? 'credit_paisa' : 'debit_paisa';
  postEntry(tx, {
    party_type: partyType,
    party_id: partyId,
    date,
    [amountPaisa > 0 ? owedSide : advanceSide]: Math.abs(amountPaisa),
    entry_type: 'opening_balance',
    source_type: partyType,
    source_id: partyId,
    narration: 'Opening balance',
  });
}

/** The current opening balance (signed as in setOpeningBalance) and its date. */
export function getOpeningBalance(db: DbOrTx, partyType: PartyType, partyId: number): { amount_paisa: number; date: string | null } {
  const row = db
    .select({ d: ledger_entries.debit_paisa, c: ledger_entries.credit_paisa, date: ledger_entries.date })
    .from(ledger_entries)
    .where(
      and(
        eq(ledger_entries.source_type, partyType),
        eq(ledger_entries.source_id, partyId),
        eq(ledger_entries.entry_type, 'opening_balance'),
      ),
    )
    .get();
  if (!row) return { amount_paisa: 0, date: null };
  const amount = partyType === 'customer' ? row.d - row.c : row.c - row.d;
  return { amount_paisa: amount, date: row.date };
}

/**
 * Ledger for a date range: balance brought forward, every entry with a
 * running balance (ordered by date, then entry order), and the closing balance.
 */
export function statement(db: DbOrTx, partyType: PartyType, partyId: number, range: { from?: string; to?: string } = {}): Statement {
  const party = and(eq(ledger_entries.party_type, partyType), eq(ledger_entries.party_id, partyId));
  const opening = range.from
    ? (db.select({ b: signedSql(partyType) }).from(ledger_entries).where(and(party, lt(ledger_entries.date, range.from))).get()?.b ?? 0)
    : 0;

  const conds = [party];
  if (range.from) conds.push(gte(ledger_entries.date, range.from));
  if (range.to) conds.push(lte(ledger_entries.date, range.to));
  const rows = db
    .select()
    .from(ledger_entries)
    .where(and(...conds))
    .orderBy(asc(ledger_entries.date), asc(ledger_entries.id))
    .all();

  let running = opening;
  const lines = rows.map((r) => {
    running += partyType === 'customer' ? r.debit_paisa - r.credit_paisa : r.credit_paisa - r.debit_paisa;
    return {
      id: r.id,
      date: r.date,
      entry_type: r.entry_type as LedgerEntryType,
      source_type: r.source_type,
      source_id: r.source_id,
      narration: r.narration,
      debit_paisa: r.debit_paisa,
      credit_paisa: r.credit_paisa,
      balance_paisa: running,
    };
  });
  return { opening_balance_paisa: opening, lines, closing_balance_paisa: running };
}
