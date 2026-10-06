import { z } from 'zod';
import { changelogQuerySchema, changeReviewInputSchema, discountOverrideQuerySchema, idParamSchema, timelineQuerySchema, type ChangeRow } from '@shopledger/shared';
import type { AppInstance } from '../../app';
import { verifyAudit } from '../../lib/audit';
import { rupeesCell, toCsv } from '../../lib/csv';
import { badRequest } from '../../lib/errors';
import { currentUser, requirePermission } from '../../lib/permissions';
import { renderInvoicePdf } from '../../pdf/invoice';
import { getSettings } from '../settings/service';
import { invoiceBalances } from '../sales/service';
import { discountOverrides, documentTimeline, getChange, listChanges, reviewChange, saleFromSnapshot, snapshotOf, unreviewedFlaggedCount } from './service';

/** Change History (CLAUDE.md 10.6): superuser only. */
export async function changelogRoutes(app: AppInstance) {
  const { ctx } = app;
  const view = requirePermission('changelog.view');

  app.get('/api/audit/verify', { ...requirePermission('changelog.verify') }, async () => verifyAudit(ctx.dbh.sqlite));

  app.get('/api/changelog', { ...view, schema: { querystring: changelogQuerySchema } }, async (req) => listChanges(ctx.dbh.db, req.query));

  app.get('/api/changelog/unreviewed-count', { ...view }, async () => ({ count: unreviewedFlaggedCount(ctx.dbh.db) }));

  app.get('/api/changelog/timeline', { ...view, schema: { querystring: timelineQuerySchema } }, async (req) => ({
    rows: documentTimeline(ctx.dbh.db, req.query.entity, req.query.entity_id),
  }));

  app.get('/api/changelog/discount-overrides', { ...view, schema: { querystring: discountOverrideQuerySchema } }, async (req) => ({
    rows: discountOverrides(ctx.dbh.db, req.query),
  }));

  app.get('/api/changelog/export.csv', { ...view, schema: { querystring: changelogQuerySchema } }, async (req, reply) => {
    const { rows } = listChanges(ctx.dbh.db, { ...req.query, limit: 500, offset: 0 });
    const money = (p: number | null) => (p === null ? null : rupeesCell(p));
    const csv = toCsv(
      ['Date/time (UTC)', 'User', 'Role', 'Action', 'Document', 'Number', 'Customer/supplier', 'Version', 'Total before (Rs)', 'Total after (Rs)', 'Balance impact (Rs)', 'Reason', 'Flags', 'Reviewed'],
      rows.map((r: ChangeRow) => [
        r.at,
        r.user_name,
        r.user_role,
        r.action,
        r.entity,
        r.doc_no,
        r.party_name,
        r.version_after === null ? null : `${r.version_before ?? '-'} > ${r.version_after}`,
        money(r.total_before_paisa),
        money(r.total_after_paisa),
        money(r.balance_impact_paisa),
        r.reason,
        r.flags.join(' '),
        r.review ? `${r.review.reviewed_by_name ?? ''} ${r.review.reviewed_at}` : null,
      ]),
    );
    return reply
      .header('Content-Type', 'text/csv; charset=utf-8')
      .header('Content-Disposition', 'attachment; filename="change-history.csv"')
      .header('Cache-Control', 'no-store')
      .send(csv);
  });

  app.get('/api/changelog/:id', { ...view, schema: { params: idParamSchema } }, async (req) => ({ change: getChange(ctx.dbh.db, req.params.id) }));

  app.post('/api/changelog/:id/review', { ...requirePermission('changelog.review'), schema: { params: idParamSchema, body: changeReviewInputSchema } }, async (req) => ({
    change: reviewChange(ctx.dbh.db, currentUser(req), req.params.id, req.body.note ?? null),
  }));

  // Re-create the invoice PDF of any version from its snapshot.
  app.get(
    '/api/changelog/:id/pdf',
    { ...view, schema: { params: idParamSchema, querystring: z.object({ which: z.enum(['before', 'after']).default('after') }) } },
    async (req, reply) => {
      const db = ctx.dbh.db;
      const { entity, snap } = snapshotOf(db, req.params.id, req.query.which);
      if (entity !== 'sale') throw badRequest('Only invoices can be printed from the change history.');
      const sale = saleFromSnapshot(db, snap);
      const settings = getSettings(db);
      const pdf = await renderInvoicePdf(sale, invoiceBalances(db, sale), settings, 'A4', `Re-created from the change history: ${sale.doc_no} version ${sale.version}`);
      return reply
        .header('Content-Type', 'application/pdf')
        .header('Content-Disposition', `inline; filename="${sale.doc_no}-v${sale.version}.pdf"`)
        .header('Cache-Control', 'no-store')
        .send(pdf);
    },
  );
}
