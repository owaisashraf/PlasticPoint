import { and, asc, desc, eq, gte, lte, sql, type SQL } from 'drizzle-orm';
import {
  createExpenseCategorySchema,
  createExpenseSchema,
  expenseListQuerySchema,
  updateExpenseCategorySchema,
  updateExpenseSchema,
  type Expense,
  type ExpenseCategory,
  type ExpenseList,
} from '@shopledger/shared';
import type { z } from 'zod';
import { writeTx, type DB, type DbOrTx } from '../../db/client';
import { expense_categories, expenses, users } from '../../db/schema';
import { writeAudit } from '../../lib/audit';
import { businessToday, nowIso } from '../../lib/dates';
import { assertCanEdit, assertCanVoid, changeFlags, diffSnapshots, diffSummary, totalFlags, uniqueFlags } from '../../lib/documents';
import { badRequest, conflict, notFound } from '../../lib/errors';
import { nextDocNo } from '../../lib/numbering';
import type { SessionUser } from '../../lib/permissions';
import { auditActor } from '../auth/service';

type CreateInput = z.output<typeof createExpenseSchema>;
type UpdateInput = z.output<typeof updateExpenseSchema>;
type ListQuery = z.output<typeof expenseListQuerySchema>;
type CategoryRow = typeof expense_categories.$inferSelect;

/**
 * Expenses (CLAUDE.md 8.12), owner and superuser only: money spent running
 * the business. They reduce net profit and appear in the cash/bank book; they
 * never touch customer or supplier ledgers.
 */

// --- Categories ---------------------------------------------------------------------

export function listCategories(db: DbOrTx): ExpenseCategory[] {
  return db
    .select({
      id: expense_categories.id,
      name: expense_categories.name,
      active: expense_categories.active,
      expense_count: sql<number>`(SELECT count(*) FROM expenses e WHERE e.category_id = "expense_categories"."id" AND e.status = 'posted')`,
    })
    .from(expense_categories)
    .orderBy(asc(expense_categories.name))
    .all();
}

function loadCategory(tx: DbOrTx, id: number): CategoryRow {
  const c = tx.select().from(expense_categories).where(eq(expense_categories.id, id)).get();
  if (!c) throw notFound('Expense category not found.');
  return c;
}

function assertNameFree(tx: DbOrTx, name: string, exceptId?: number): void {
  const clash = tx
    .select({ id: expense_categories.id })
    .from(expense_categories)
    .where(sql`lower(${expense_categories.name}) = lower(${name})`)
    .get();
  if (clash && clash.id !== exceptId) throw conflict(`There is already a category called “${name}”.`);
}

export function createCategory(db: DB, user: SessionUser, input: z.output<typeof createExpenseCategorySchema>): ExpenseCategory {
  return writeTx(db, (tx) => {
    assertNameFree(tx, input.name);
    const now = nowIso();
    const row = tx.insert(expense_categories).values({ name: input.name, active: true, created_at: now, updated_at: now }).returning().get();
    writeAudit(tx, auditActor(user), { action: 'create', entity: 'expense_category', entity_id: row.id, doc_no: row.name, after: row });
    return listCategories(tx).find((c) => c.id === row.id) as ExpenseCategory;
  });
}

/** Rename or (de)activate a category. Deactivated categories keep their expenses but cannot be picked. */
export function updateCategory(db: DB, user: SessionUser, id: number, input: z.output<typeof updateExpenseCategorySchema>): ExpenseCategory {
  return writeTx(db, (tx) => {
    const before = loadCategory(tx, id);
    if (input.name !== undefined) assertNameFree(tx, input.name, id);
    const after = tx
      .update(expense_categories)
      .set({ name: input.name ?? before.name, active: input.active ?? before.active, updated_at: nowIso() })
      .where(eq(expense_categories.id, id))
      .returning()
      .get();
    writeAudit(tx, auditActor(user), {
      action: after.active !== before.active ? (after.active ? 'activate' : 'deactivate') : 'update',
      entity: 'expense_category',
      entity_id: id,
      doc_no: after.name,
      before,
      after,
    });
    return listCategories(tx).find((c) => c.id === id) as ExpenseCategory;
  });
}

/** Only a category that has never been used can be deleted; otherwise deactivate it. */
export function deleteCategory(db: DB, user: SessionUser, id: number): void {
  writeTx(db, (tx) => {
    const row = loadCategory(tx, id);
    const used = tx.select({ n: sql<number>`count(*)` }).from(expenses).where(eq(expenses.category_id, id)).get()?.n ?? 0;
    if (used > 0) throw badRequest(`“${row.name}” has expenses, so it cannot be deleted. Deactivate it instead.`);
    tx.delete(expense_categories).where(eq(expense_categories.id, id)).run();
    writeAudit(tx, auditActor(user), { action: 'delete', entity: 'expense_category', entity_id: id, doc_no: row.name, before: row });
  });
}

// --- Reading -----------------------------------------------------------------------

const selectExpense = { e: expenses, category_name: expense_categories.name, created_by_name: users.display_name };

function toExpense(r: { e: typeof expenses.$inferSelect; category_name: string; created_by_name: string | null }): Expense {
  const { created_by, updated_by: _u, updated_at: _ua, ...e } = r.e;
  return { ...e, category_name: r.category_name, created_by_id: created_by, created_by_name: r.created_by_name };
}

function baseQuery(db: DbOrTx) {
  return db
    .select(selectExpense)
    .from(expenses)
    .innerJoin(expense_categories, eq(expense_categories.id, expenses.category_id))
    .leftJoin(users, eq(users.id, expenses.created_by));
}

export function getExpense(db: DbOrTx, id: number): Expense {
  const r = baseQuery(db).where(eq(expenses.id, id)).get();
  if (!r) throw notFound('Expense not found.');
  return toExpense(r);
}

export function listExpenses(db: DB, q: ListQuery): ExpenseList {
  const conds: (SQL | undefined)[] = [];
  if (q.from) conds.push(gte(expenses.date, q.from));
  if (q.to) conds.push(lte(expenses.date, q.to));
  if (q.category_id) conds.push(eq(expenses.category_id, q.category_id));
  if (q.method) conds.push(eq(expenses.method, q.method));
  if (q.q) {
    for (const word of q.q.split(/\s+/).filter(Boolean)) {
      const like = `%${word.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
      conds.push(
        sql`(${expenses.doc_no} LIKE ${like} ESCAPE '\\' OR coalesce(${expenses.paid_to}, '') LIKE ${like} ESCAPE '\\' OR coalesce(${expenses.reference}, '') LIKE ${like} ESCAPE '\\' OR coalesce(${expenses.notes}, '') LIKE ${like} ESCAPE '\\')`,
      );
    }
  }
  const listWhere = and(...conds, q.status === 'all' ? undefined : eq(expenses.status, q.status));
  // Totals count posted expenses only, whatever the status filter.
  const postedWhere = and(...conds, eq(expenses.status, 'posted'));

  const total = db.select({ n: sql<number>`count(*)` }).from(expenses).where(listWhere).get()?.n ?? 0;
  const rows = baseQuery(db).where(listWhere).orderBy(desc(expenses.date), desc(expenses.id)).limit(q.limit).offset(q.offset).all();
  const byCategory = db
    .select({ category_id: expenses.category_id, name: expense_categories.name, total_paisa: sql<number>`sum(${expenses.amount_paisa})`, count: sql<number>`count(*)` })
    .from(expenses)
    .innerJoin(expense_categories, eq(expense_categories.id, expenses.category_id))
    .where(postedWhere)
    .groupBy(expenses.category_id)
    .orderBy(desc(sql`sum(${expenses.amount_paisa})`))
    .all();
  const byMonth = db
    .select({ month: sql<string>`substr(${expenses.date}, 1, 7)`, total_paisa: sql<number>`sum(${expenses.amount_paisa})`, count: sql<number>`count(*)` })
    .from(expenses)
    .where(postedWhere)
    .groupBy(sql`substr(${expenses.date}, 1, 7)`)
    .orderBy(desc(sql`substr(${expenses.date}, 1, 7)`))
    .all();
  return {
    expenses: rows.map(toExpense),
    total,
    total_paisa: byCategory.reduce((a, c) => a + c.total_paisa, 0),
    by_category: byCategory,
    by_month: byMonth,
  };
}

// --- Writing ------------------------------------------------------------------------

function assertUsableCategory(tx: DbOrTx, id: number, allowInactiveId?: number): void {
  const c = tx.select().from(expense_categories).where(eq(expense_categories.id, id)).get();
  if (!c) throw badRequest('Pick a category.');
  if (!c.active && c.id !== allowInactiveId) throw badRequest(`The category “${c.name}” is no longer in use. Pick another.`);
}

export function createExpense(db: DB, user: SessionUser, input: CreateInput): Expense {
  if (input.date > businessToday()) throw badRequest('The date cannot be in the future.');
  return writeTx(db, (tx) => {
    assertUsableCategory(tx, input.category_id);
    const now = nowIso();
    const row = tx
      .insert(expenses)
      .values({
        doc_no: nextDocNo(tx, 'expense'),
        date: input.date,
        category_id: input.category_id,
        amount_paisa: input.amount_paisa,
        method: input.method,
        paid_to: input.paid_to,
        reference: input.reference,
        notes: input.notes,
        status: 'posted',
        version: 1,
        created_by: user.id,
        updated_by: user.id,
        created_at: now,
        updated_at: now,
      })
      .returning()
      .get();
    const after = getExpense(tx, row.id);
    writeAudit(tx, auditActor(user), {
      action: 'create',
      entity: 'expense',
      entity_id: row.id,
      doc_no: row.doc_no,
      version_after: 1,
      after,
      summary: { category: after.category_name, amount_paisa: row.amount_paisa, method: row.method },
    });
    return after;
  });
}

export function updateExpense(db: DB, user: SessionUser, id: number, input: UpdateInput): Expense {
  if (input.date > businessToday()) throw badRequest('The date cannot be in the future.');
  return writeTx(db, (tx) => {
    const row = tx.select().from(expenses).where(eq(expenses.id, id)).get();
    if (!row) throw notFound('Expense not found.');
    assertCanEdit(user, row, 'expenses.manage');
    assertUsableCategory(tx, input.category_id, row.category_id);
    const before = getExpense(tx, id);
    tx.update(expenses)
      .set({
        date: input.date,
        category_id: input.category_id,
        amount_paisa: input.amount_paisa,
        method: input.method,
        paid_to: input.paid_to,
        reference: input.reference,
        notes: input.notes,
        version: row.version + 1,
        updated_by: user.id,
        updated_at: nowIso(),
      })
      .where(eq(expenses.id, id))
      .run();
    const after = getExpense(tx, id);
    const diff = diffSnapshots(before, after, (l) => String(l.id), (l) => String(l.id));
    writeAudit(tx, auditActor(user), {
      action: 'edit',
      entity: 'expense',
      entity_id: id,
      doc_no: row.doc_no,
      version_before: row.version,
      version_after: row.version + 1,
      before,
      after,
      summary: { ...diffSummary(diff), amount_before_paisa: row.amount_paisa, amount_after_paisa: input.amount_paisa },
      flags: uniqueFlags(changeFlags(tx, user, 'expense', id, row.created_at), totalFlags(row.amount_paisa, input.amount_paisa)),
      reason: input.change_reason,
    });
    return after;
  });
}

export function voidExpense(db: DB, user: SessionUser, id: number, reason: string): Expense {
  return writeTx(db, (tx) => {
    const row = tx.select().from(expenses).where(eq(expenses.id, id)).get();
    if (!row) throw notFound('Expense not found.');
    assertCanVoid(user, row);
    const before = getExpense(tx, id);
    tx.update(expenses).set({ status: 'void', version: row.version + 1, updated_by: user.id, updated_at: nowIso() }).where(eq(expenses.id, id)).run();
    const after = getExpense(tx, id);
    writeAudit(tx, auditActor(user), {
      action: 'void',
      entity: 'expense',
      entity_id: id,
      doc_no: row.doc_no,
      version_before: row.version,
      version_after: row.version + 1,
      before,
      after,
      summary: { amount_before_paisa: row.amount_paisa, amount_after_paisa: 0 },
      flags: uniqueFlags(changeFlags(tx, user, 'expense', id, row.created_at), ['voided']),
      reason,
    });
    return after;
  });
}
