import { and, asc, eq, isNotNull, ne, sql, type SQL } from 'drizzle-orm';
import {
  createCustomerSchema,
  updateCustomerSchema,
  type Customer,
  type CustomerListQuery,
  type Statement,
} from '@shopledger/shared';
import type { z } from 'zod';
import { writeTx, type DB, type DbOrTx } from '../../db/client';
import { customers } from '../../db/schema';
import { writeAudit, type AuditActor } from '../../lib/audit';
import { businessToday, nowIso } from '../../lib/dates';
import { badRequest, notFound } from '../../lib/errors';
import { recalcAllocations } from '../../lib/allocation';
import { overdueSummaries, type OverdueSummary } from '../../lib/overdue';
import { balanceColumnSql, getOpeningBalance, setOpeningBalance, statement } from '../../lib/ledger';
import { nextCustomerCode } from '../../lib/numbering';
import { getSetting } from '../settings/service';

type CustomerRow = typeof customers.$inferSelect;
type CreateInput = z.output<typeof createCustomerSchema>;
type UpdateInput = z.output<typeof updateCustomerSchema>;

const balanceCol = balanceColumnSql('customer');
// Outer columns are written with their table name: a bare "id" inside a
// subquery would bind to the subquery's own table.
const lastSaleSql = sql<string | null>`(SELECT max(s.date) FROM sales s WHERE s.customer_id = "customers"."id" AND s.status = 'posted')`;
const lastPaymentSql = sql<string | null>`(SELECT max(p.date) FROM payments p WHERE p.party_type = 'customer' AND p.party_id = "customers"."id" AND p.kind = 'receipt' AND p.status = 'posted')`;
const listSelect = { c: customers, balance: balanceCol, last_sale: lastSaleSql, last_payment: lastPaymentSql };

interface ListRow {
  c: CustomerRow;
  balance: number;
  last_sale: string | null;
  last_payment: string | null;
}

function toCustomer(db: DbOrTx, r: ListRow, overdue: OverdueSummary | undefined): Customer {
  const opening = getOpeningBalance(db, 'customer', r.c.id);
  const { created_by: _cb, ...rest } = r.c;
  return {
    ...rest,
    balance_paisa: r.balance,
    opening_balance_paisa: opening.amount_paisa,
    opening_balance_date: opening.date,
    overdue_paisa: overdue?.overdue_paisa ?? 0,
    overdue_days: overdue?.max_days_overdue ?? 0,
    last_sale_date: r.last_sale,
    last_payment_date: r.last_payment,
  };
}

/** Audit snapshot: the stored fields plus the opening balance (not the derived balance). */
function snapshot(db: DbOrTx, row: CustomerRow) {
  const opening = getOpeningBalance(db, 'customer', row.id);
  return { ...row, opening_balance_paisa: opening.amount_paisa, opening_balance_date: opening.date };
}

function loadRow(db: DbOrTx, id: number): CustomerRow {
  const row = db.select().from(customers).where(eq(customers.id, id)).get();
  if (!row) throw notFound('Customer not found.');
  return row;
}

export function getCustomer(db: DbOrTx, id: number): Customer {
  const row = db.select(listSelect).from(customers).where(eq(customers.id, id)).get();
  if (!row) throw notFound('Customer not found.');
  return toCustomer(db, row, overdueSummaries(db, { customerIds: [id] }).get(id));
}

// --- Search --------------------------------------------------------------------

/** Turns "Ahmed 0300-12" into conditions: trigram FTS for 3+ characters, LIKE for shorter words. */
export function searchCondition(q: string): SQL | undefined {
  const words = q
    .split(/\s+/)
    .map((w) => (/^[\d+()-]+$/.test(w) ? w.replace(/[^\d+]/g, '') : w))
    .filter(Boolean);
  if (words.length === 0) return undefined;
  const conds: SQL[] = [];
  const ftsWords = words.filter((w) => w.length >= 3);
  if (ftsWords.length) {
    const match = ftsWords.map((w) => `"${w.replace(/"/g, '""')}"`).join(' AND ');
    conds.push(sql`${customers.id} IN (SELECT rowid FROM customers_fts WHERE customers_fts MATCH ${match})`);
  }
  for (const w of words.filter((x) => x.length < 3)) {
    const like = `%${w.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    conds.push(
      sql`(${customers.code} LIKE ${like} ESCAPE '\\' OR ${customers.name} LIKE ${like} ESCAPE '\\' OR coalesce(${customers.business_name}, '') LIKE ${like} ESCAPE '\\' OR coalesce(${customers.city}, '') LIKE ${like} ESCAPE '\\')`,
    );
  }
  return and(...conds);
}

export function listCustomers(db: DB, query: CustomerListQuery & { limit: number; offset: number }): { customers: Customer[]; total: number } {
  const conds: (SQL | undefined)[] = [];
  if (query.q) conds.push(searchCondition(query.q));
  if (query.type) conds.push(eq(customers.type, query.type));
  if (query.city) conds.push(sql`lower(${customers.city}) = lower(${query.city})`);
  if (query.status && query.status !== 'all') conds.push(eq(customers.status, query.status));
  const where = and(...conds);

  const total = db.select({ n: sql<number>`count(*)` }).from(customers).where(where).get()?.n ?? 0;
  const rows = db
    .select(listSelect)
    .from(customers)
    .where(where)
    .orderBy(asc(customers.name), asc(customers.id))
    .limit(query.limit)
    .offset(query.offset)
    .all();
  const overdue = overdueSummaries(db, { customerIds: rows.map((r) => r.c.id) });
  return { customers: rows.map((r) => toCustomer(db, r, overdue.get(r.c.id))), total };
}

/** Distinct cities, for the list filter. */
export function listCities(db: DB): string[] {
  return db
    .selectDistinct({ city: customers.city })
    .from(customers)
    .where(and(isNotNull(customers.city), ne(customers.city, '')))
    .orderBy(asc(customers.city))
    .all()
    .map((r) => r.city ?? '');
}

// --- Writes --------------------------------------------------------------------

export function createCustomer(db: DB, actor: AuditActor, input: CreateInput): Customer {
  return writeTx(db, (tx) => {
    const now = nowIso();
    const row = tx
      .insert(customers)
      .values({
        code: nextCustomerCode(tx),
        name: input.name,
        business_name: input.business_name,
        type: input.type,
        phone: input.phone,
        alt_phone: input.alt_phone,
        city: input.city,
        area: input.area,
        address: input.address,
        ntn: input.ntn,
        credit_limit_paisa: input.credit_limit_paisa,
        payment_terms_days: input.payment_terms_days ?? getSetting(tx, 'default_payment_terms_days'),
        notes: input.notes,
        created_by: actor.id,
        created_at: now,
        updated_at: now,
      })
      .returning()
      .get();
    setOpeningBalance(tx, 'customer', row.id, input.opening_balance_paisa, input.opening_balance_date ?? businessToday());
    writeAudit(tx, actor, {
      action: 'create',
      entity: 'customer',
      entity_id: row.id,
      doc_no: row.code,
      after: snapshot(tx, row),
      summary: { name: row.name, opening_balance_paisa: input.opening_balance_paisa },
    });
    return getCustomer(tx, row.id);
  });
}

const EDITABLE = [
  'name',
  'business_name',
  'type',
  'phone',
  'alt_phone',
  'city',
  'area',
  'address',
  'ntn',
  'credit_limit_paisa',
  'payment_terms_days',
  'notes',
] as const;

export function updateCustomer(db: DB, actor: AuditActor, id: number, input: UpdateInput): Customer {
  return writeTx(db, (tx) => {
    const before = loadRow(tx, id);
    const beforeSnap = snapshot(tx, before);

    const set: Partial<CustomerRow> = {};
    for (const k of EDITABLE) {
      const v = input[k];
      if (v !== undefined && v !== before[k]) (set as Record<string, unknown>)[k] = v;
    }
    if (input.active === false && before.status !== 'inactive') set.status = 'inactive';
    if (input.active === true && before.status === 'inactive') set.status = before.bad_debt_marked_at ? 'bad_debt' : 'active';

    const opening = getOpeningBalance(tx, 'customer', id);
    const newOpening = input.opening_balance_paisa ?? opening.amount_paisa;
    const newOpeningDate = input.opening_balance_date ?? opening.date ?? businessToday();
    const openingChanged = newOpening !== opening.amount_paisa || (newOpening !== 0 && newOpeningDate !== opening.date);

    if (Object.keys(set).length === 0 && !openingChanged) return getCustomer(tx, id);

    let after = before;
    if (Object.keys(set).length) {
      set.updated_at = nowIso();
      after = tx.update(customers).set(set).where(eq(customers.id, id)).returning().get();
    }
    if (openingChanged) {
      setOpeningBalance(tx, 'customer', id, newOpening, newOpeningDate);
      // The opening balance is the oldest debt (or an advance) in allocation.
      recalcAllocations(tx, id);
    }

    const changed = [...Object.keys(set).filter((k) => k !== 'updated_at'), ...(openingChanged ? ['opening_balance'] : [])];
    writeAudit(tx, actor, {
      action: set.status === 'inactive' ? 'deactivate' : set.status && before.status === 'inactive' ? 'activate' : 'update',
      entity: 'customer',
      entity_id: id,
      doc_no: before.code,
      before: beforeSnap,
      after: snapshot(tx, after),
      summary: { changed_fields: changed },
      reason: input.reason ?? null,
    });
    return getCustomer(tx, id);
  });
}

/** Owner+: flag a customer as unlikely to pay (CLAUDE.md 8.8). */
export function markBadDebt(db: DB, actor: AuditActor, id: number, reason: string): Customer {
  return writeTx(db, (tx) => {
    const before = loadRow(tx, id);
    if (before.status === 'bad_debt') throw badRequest('This customer is already marked as bad debt.');
    const after = tx
      .update(customers)
      .set({ status: 'bad_debt', bad_debt_marked_at: nowIso(), bad_debt_reason: reason, updated_at: nowIso() })
      .where(eq(customers.id, id))
      .returning()
      .get();
    writeAudit(tx, actor, {
      action: 'mark_bad_debt',
      entity: 'customer',
      entity_id: id,
      doc_no: before.code,
      before: snapshot(tx, before),
      after: snapshot(tx, after),
      summary: { changed_fields: ['status'] },
      reason,
    });
    return getCustomer(tx, id);
  });
}

export function unmarkBadDebt(db: DB, actor: AuditActor, id: number, reason: string): Customer {
  return writeTx(db, (tx) => {
    const before = loadRow(tx, id);
    if (before.status !== 'bad_debt') throw badRequest('This customer is not marked as bad debt.');
    const after = tx
      .update(customers)
      .set({ status: 'active', bad_debt_marked_at: null, bad_debt_reason: null, updated_at: nowIso() })
      .where(eq(customers.id, id))
      .returning()
      .get();
    writeAudit(tx, actor, {
      action: 'unmark_bad_debt',
      entity: 'customer',
      entity_id: id,
      doc_no: before.code,
      before: snapshot(tx, before),
      after: snapshot(tx, after),
      summary: { changed_fields: ['status'] },
      reason,
    });
    return getCustomer(tx, id);
  });
}

export function customerStatement(db: DbOrTx, id: number, range: { from?: string; to?: string }): Statement {
  loadRow(db, id);
  return statement(db, 'customer', id, range);
}
