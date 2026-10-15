import { formatPhone, overdueQuerySchema, type OverdueList } from '@shopledger/shared';
import type { z } from 'zod';
import type { AppInstance } from '../../app';
import { rupeesCell, toCsv } from '../../lib/csv';
import { requirePermission } from '../../lib/permissions';
import { renderOverduePdf } from '../../pdf/overdue';
import { getSettings } from '../settings/service';
import { listOverdue, overdueCount } from './service';

const BAD_DEBT_TEXT = { exclude: null, include: 'incl. bad debt', only: 'bad debt only' } as const;

/** "Filters: wholesalers · Lahore · 30+ days" for the report footer. */
function filterText(q: z.output<typeof overdueQuerySchema>): string {
  const parts = [
    q.type ? `${q.type}s` : null,
    q.city ?? null,
    q.min_days ? `${q.min_days}+ days` : null,
    BAD_DEBT_TEXT[q.bad_debt],
    q.q ? `“${q.q}”` : null,
  ].filter(Boolean);
  return parts.length ? `Filters: ${parts.join(' · ')}` : '';
}

function csv(list: OverdueList): string {
  return toCsv(
    ['Customer', 'Code', 'Phone', 'City', 'Type', 'Status', 'Terms (days)', 'Overdue invoices', 'Overdue (Rs)', 'Outstanding (Rs)', 'Oldest due date', 'Max days overdue', 'Last payment date', 'Last payment (Rs)'],
    list.rows.map((r) => [
      r.name,
      r.code,
      formatPhone(r.phone),
      r.city,
      r.type,
      r.status,
      r.payment_terms_days,
      r.overdue_count,
      rupeesCell(r.overdue_paisa),
      rupeesCell(r.balance_paisa),
      r.oldest_due_date,
      r.max_days_overdue,
      r.last_payment_date,
      r.last_payment_paisa === null ? null : rupeesCell(r.last_payment_paisa),
    ]),
  );
}

export async function overdueRoutes(app: AppInstance) {
  const { ctx } = app;
  const view = requirePermission('overdue.view');

  app.get('/api/overdue', { ...view, schema: { querystring: overdueQuerySchema } }, async (req) => listOverdue(ctx.dbh.db, req.query));

  // Menu badge: number of overdue customers (bad debt excluded).
  app.get('/api/overdue/count', { ...view }, async () => ({ count: overdueCount(ctx.dbh.db) }));

  app.get('/api/overdue/export.csv', { ...view, schema: { querystring: overdueQuerySchema } }, async (req, reply) => {
    const list = listOverdue(ctx.dbh.db, req.query);
    return reply
      .header('Content-Type', 'text/csv; charset=utf-8')
      .header('Content-Disposition', `attachment; filename="overdue-${list.as_of}.csv"`)
      .header('Cache-Control', 'no-store')
      .send(csv(list));
  });

  app.get('/api/overdue/report.pdf', { ...view, schema: { querystring: overdueQuerySchema } }, async (req, reply) => {
    const db = ctx.dbh.db;
    const list = listOverdue(db, req.query);
    const pdf = await renderOverduePdf(list, getSettings(db), filterText(req.query));
    return reply
      .header('Content-Type', 'application/pdf')
      .header('Content-Disposition', `inline; filename="overdue-${list.as_of}.pdf"`)
      .header('Cache-Control', 'no-store')
      .send(pdf);
  });
}
