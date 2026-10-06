import { and, eq, inArray, ne, sql, type SQL } from 'drizzle-orm';
import { overdueQuerySchema, type OverdueList, type OverdueRow } from '@shopledger/shared';
import type { z } from 'zod';
import type { DbOrTx } from '../../db/client';
import { customers } from '../../db/schema';
import { businessToday } from '../../lib/dates';
import { balanceColumnSql } from '../../lib/ledger';
import { overdueItems, overdueSummaries } from '../../lib/overdue';
import { searchCondition } from '../customers/service';
import { getSetting } from '../settings/service';

type Query = z.output<typeof overdueQuerySchema>;

// Outer columns are written with their table name: a bare "id" inside a
// subquery would bind to the subquery's own table.
const lastPayment = (col: 'date' | 'amount_paisa') =>
  sql.raw(
    `(SELECT p.${col} FROM payments p WHERE p.party_type = 'customer' AND p.party_id = "customers"."id" AND p.kind = 'receipt' AND p.status = 'posted' ORDER BY p.date DESC, p.id DESC LIMIT 1)`,
  );

/**
 * The Overdue tab (CLAUDE.md 10.3): every customer with at least one overdue
 * invoice (or overdue opening balance), most days overdue first, with their
 * overdue invoices. Bad-debt customers are left out unless asked for.
 */
export function listOverdue(db: DbOrTx, q: Query): OverdueList {
  const today = businessToday();
  const grace = getSetting(db, 'grace_days');
  const items = overdueItems(db, { today, grace });
  const byCustomer = new Map<number, typeof items>();
  for (const i of items) byCustomer.set(i.customer_id, [...(byCustomer.get(i.customer_id) ?? []), i]);

  const ids = [...byCustomer.keys()];
  const conds: (SQL | undefined)[] = [inArray(customers.id, ids.length ? ids : [-1])];
  if (q.type) conds.push(eq(customers.type, q.type));
  if (q.city) conds.push(sql`lower(${customers.city}) = lower(${q.city})`);
  if (q.bad_debt === 'exclude') conds.push(ne(customers.status, 'bad_debt'));
  if (q.bad_debt === 'only') conds.push(eq(customers.status, 'bad_debt'));
  // Same search as the customer list: name, business, phone (any format), city, code.
  if (q.q) conds.push(searchCondition(q.q));
  const found = db
    .select({ c: customers, balance: balanceColumnSql('customer'), last_payment_date: sql<string | null>`${lastPayment('date')}`, last_payment_paisa: sql<number | null>`${lastPayment('amount_paisa')}` })
    .from(customers)
    .where(and(...conds))
    .all();

  const rows: OverdueRow[] = found
    .map(({ c, balance, last_payment_date, last_payment_paisa }) => {
      const its = byCustomer.get(c.id) ?? [];
      return {
        customer_id: c.id,
        code: c.code,
        name: c.name,
        business_name: c.business_name,
        phone: c.phone,
        city: c.city,
        type: c.type,
        status: c.status,
        payment_terms_days: c.payment_terms_days,
        overdue_count: its.length,
        overdue_paisa: its.reduce((a, i) => a + i.outstanding_paisa, 0),
        balance_paisa: balance,
        oldest_due_date: its.reduce((m, i) => (i.due_date < m ? i.due_date : m), its[0]?.due_date ?? today),
        max_days_overdue: Math.max(...its.map((i) => i.days_overdue)),
        last_payment_date,
        last_payment_paisa,
        invoices: its
          .map(({ sale_id, doc_no, date, due_date, total_paisa, paid_paisa, outstanding_paisa, days_overdue }) => ({ sale_id, doc_no, date, due_date, total_paisa, paid_paisa, outstanding_paisa, days_overdue }))
          .sort((a, b) => b.days_overdue - a.days_overdue),
      };
    })
    .filter((r) => q.min_days === undefined || r.max_days_overdue >= q.min_days)
    .sort((a, b) => b.max_days_overdue - a.max_days_overdue || b.overdue_paisa - a.overdue_paisa || a.name.localeCompare(b.name));

  return {
    rows,
    totals: { customers: rows.length, overdue_paisa: rows.reduce((a, r) => a + r.overdue_paisa, 0), balance_paisa: rows.reduce((a, r) => a + r.balance_paisa, 0) },
    as_of: today,
  };
}

/** Number of overdue customers for the menu badge (bad-debt customers have their own sub-tab). */
export function overdueCount(db: DbOrTx): number {
  const ids = [...overdueSummaries(db).keys()];
  if (!ids.length) return 0;
  return db.select({ n: sql<number>`count(*)` }).from(customers).where(and(inArray(customers.id, ids), ne(customers.status, 'bad_debt'))).get()?.n ?? 0;
}
