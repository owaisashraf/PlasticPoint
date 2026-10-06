import { sql, type SQL } from 'drizzle-orm';
import type { DbOrTx } from '../db/client';
import { businessToday } from './dates';
import { getSetting } from '../modules/settings/service';

/**
 * Overdue (CLAUDE.md 8.4), always computed with SQL, never stored.
 *
 *   outstanding  = total − Σ allocations
 *   overdue      = posted, outstanding > 0, today > due_date + grace_days
 *   days overdue = today − due_date
 *
 * Open items are posted invoices and, as the oldest debt, an owed opening
 * balance. The opening balance is due like an invoice dated on its date:
 * opening date + the customer's payment terms.
 */

export interface OpenItemRow {
  customer_id: number;
  /** Null: the opening balance. */
  sale_id: number | null;
  doc_no: string | null;
  date: string;
  due_date: string;
  total_paisa: number;
  paid_paisa: number;
  outstanding_paisa: number;
  days_overdue: number;
}

export interface OverdueSummary {
  overdue_count: number;
  overdue_paisa: number;
  oldest_due_date: string;
  max_days_overdue: number;
}

export interface OverdueOptions {
  today?: string;
  grace?: number;
  /** Only these customers. */
  customerIds?: readonly number[];
}

function resolve(db: DbOrTx, o: OverdueOptions) {
  return { today: o.today ?? businessToday(), grace: o.grace ?? getSetting(db, 'grace_days') };
}

/** Every open item (outstanding > 0) with its due date and days past due (negative = not due yet). */
function openItemsSql(today: string, customerIds?: readonly number[]): SQL {
  const only = customerIds ? sql`AND customer_id IN (${sql.join(customerIds.length ? customerIds.map((id) => sql`${id}`) : [sql`NULL`], sql`, `)})` : sql``;
  return sql`
    WITH alloc AS (
      SELECT customer_id, sale_id, sum(amount_paisa) AS paid FROM payment_allocations GROUP BY customer_id, sale_id
    ),
    items AS (
      SELECT s.customer_id AS customer_id, s.id AS sale_id, s.doc_no AS doc_no, s.date AS date, s.due_date AS due_date,
             s.total_paisa AS total_paisa, coalesce(a.paid, 0) AS paid_paisa
      FROM sales s LEFT JOIN alloc a ON a.sale_id = s.id
      WHERE s.status = 'posted' AND s.total_paisa > 0
      UNION ALL
      SELECT c.id, NULL, NULL, le.date, date(le.date, '+' || c.payment_terms_days || ' days'),
             le.debit_paisa, coalesce(a.paid, 0)
      FROM ledger_entries le
      JOIN customers c ON c.id = le.party_id
      LEFT JOIN alloc a ON a.customer_id = c.id AND a.sale_id IS NULL
      WHERE le.party_type = 'customer' AND le.entry_type = 'opening_balance' AND le.debit_paisa > 0
    )
    SELECT customer_id, sale_id, doc_no, date, due_date, total_paisa, paid_paisa,
           total_paisa - paid_paisa AS outstanding_paisa,
           CAST(julianday(${today}) - julianday(due_date) AS INTEGER) AS days_overdue
    FROM items
    WHERE total_paisa - paid_paisa > 0 ${only}`;
}

/** Overdue items, most overdue first. */
export function overdueItems(db: DbOrTx, o: OverdueOptions = {}): OpenItemRow[] {
  const { today, grace } = resolve(db, o);
  return db.all<OpenItemRow>(sql`SELECT * FROM (${openItemsSql(today, o.customerIds)}) WHERE days_overdue > ${grace} ORDER BY days_overdue DESC, date, sale_id`);
}

/** Per customer: number of overdue items, overdue amount, oldest due date and the largest days overdue. */
export function overdueSummaries(db: DbOrTx, o: OverdueOptions = {}): Map<number, OverdueSummary> {
  const { today, grace } = resolve(db, o);
  const rows = db.all<OverdueSummary & { customer_id: number }>(sql`
    SELECT customer_id, count(*) AS overdue_count, sum(outstanding_paisa) AS overdue_paisa,
           min(due_date) AS oldest_due_date, max(days_overdue) AS max_days_overdue
    FROM (${openItemsSql(today, o.customerIds)})
    WHERE days_overdue > ${grace}
    GROUP BY customer_id`);
  return new Map(rows.map(({ customer_id, ...s }) => [customer_id, s]));
}

/** SQL for whole days from a due date to today (positive once past due). */
export function daysPastDueSql(dueDate: SQL, today: string): SQL<number> {
  return sql<number>`CAST(julianday(${today}) - julianday(${dueDate}) AS INTEGER)`;
}
