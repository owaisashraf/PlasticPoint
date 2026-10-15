import { asc, eq } from 'drizzle-orm';
import { createSupplierSchema, updateSupplierSchema, type Statement, type Supplier } from '@shopledger/shared';
import type { z } from 'zod';
import { writeTx, type DB, type DbOrTx } from '../../db/client';
import { suppliers } from '../../db/schema';
import { writeAudit, type AuditActor } from '../../lib/audit';
import { businessToday, nowIso } from '../../lib/dates';
import { notFound } from '../../lib/errors';
import { balanceColumnSql, getOpeningBalance, setOpeningBalance, statement } from '../../lib/ledger';

type SupplierRow = typeof suppliers.$inferSelect;
type CreateInput = z.output<typeof createSupplierSchema>;
type UpdateInput = z.output<typeof updateSupplierSchema>;

const balanceCol = balanceColumnSql('supplier');

function openingFields(db: DbOrTx, id: number) {
  const opening = getOpeningBalance(db, 'supplier', id);
  return { opening_balance_paisa: opening.amount_paisa, opening_balance_date: opening.date };
}

function toSupplier(db: DbOrTx, row: SupplierRow, balance: number): Supplier {
  return { ...row, balance_paisa: balance, ...openingFields(db, row.id) };
}

function snapshot(db: DbOrTx, row: SupplierRow) {
  return { ...row, ...openingFields(db, row.id) };
}

export function listSuppliers(db: DbOrTx): Supplier[] {
  return db
    .select({ s: suppliers, balance: balanceCol })
    .from(suppliers)
    .orderBy(asc(suppliers.id))
    .all()
    .map((r) => toSupplier(db, r.s, r.balance));
}

export function getSupplier(db: DbOrTx, id: number): Supplier {
  const r = db.select({ s: suppliers, balance: balanceCol }).from(suppliers).where(eq(suppliers.id, id)).get();
  if (!r) throw notFound('Supplier not found.');
  return toSupplier(db, r.s, r.balance);
}

export function createSupplier(db: DB, actor: AuditActor, input: CreateInput): Supplier {
  return writeTx(db, (tx) => {
    const now = nowIso();
    const row = tx
      .insert(suppliers)
      .values({ name: input.name, phone: input.phone, address: input.address, ntn: input.ntn, notes: input.notes, created_at: now, updated_at: now })
      .returning()
      .get();
    setOpeningBalance(tx, 'supplier', row.id, input.opening_balance_paisa, input.opening_balance_date ?? businessToday());
    writeAudit(tx, actor, {
      action: 'create',
      entity: 'supplier',
      entity_id: row.id,
      after: snapshot(tx, row),
      summary: { name: row.name, opening_balance_paisa: input.opening_balance_paisa },
    });
    return getSupplier(tx, row.id);
  });
}

export function updateSupplier(db: DB, actor: AuditActor, id: number, input: UpdateInput): Supplier {
  return writeTx(db, (tx) => {
    const before = tx.select().from(suppliers).where(eq(suppliers.id, id)).get();
    if (!before) throw notFound('Supplier not found.');
    const beforeSnap = snapshot(tx, before);

    const set: Partial<SupplierRow> = {};
    for (const k of ['name', 'phone', 'address', 'ntn', 'notes', 'active'] as const) {
      const v = input[k];
      if (v !== undefined && v !== before[k]) (set as Record<string, unknown>)[k] = v;
    }
    const opening = getOpeningBalance(tx, 'supplier', id);
    const newOpening = input.opening_balance_paisa ?? opening.amount_paisa;
    const newDate = input.opening_balance_date ?? opening.date ?? businessToday();
    const openingChanged = newOpening !== opening.amount_paisa || (newOpening !== 0 && newDate !== opening.date);
    if (Object.keys(set).length === 0 && !openingChanged) return getSupplier(tx, id);

    let after = before;
    if (Object.keys(set).length) {
      set.updated_at = nowIso();
      after = tx.update(suppliers).set(set).where(eq(suppliers.id, id)).returning().get();
    }
    if (openingChanged) setOpeningBalance(tx, 'supplier', id, newOpening, newDate);

    writeAudit(tx, actor, {
      action: set.active === false ? 'deactivate' : set.active === true ? 'activate' : 'update',
      entity: 'supplier',
      entity_id: id,
      before: beforeSnap,
      after: snapshot(tx, after),
      summary: { changed_fields: [...Object.keys(set).filter((k) => k !== 'updated_at'), ...(openingChanged ? ['opening_balance'] : [])] },
      reason: input.reason ?? null,
    });
    return getSupplier(tx, id);
  });
}

export function supplierStatement(db: DbOrTx, id: number, range: { from?: string; to?: string }): Statement {
  getSupplier(db, id);
  return statement(db, 'supplier', id, range);
}
