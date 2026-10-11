import { REPORTS, reportQuerySchema } from '@shopledger/shared';
import type { AppInstance } from '../../app';
import { currentUser, requirePermission } from '../../lib/permissions';
import { BUILDERS } from './builders';
import { dashboard } from './dashboard';
import { finalize, makeCtx, reportCsv, reportPdf } from './engine';

/**
 * One route per report (CLAUDE.md 11), each guarded by its own permission:
 * customer and operational reports for everyone, financial reports for the
 * owner and superuser. ?format=csv or pdf downloads the same table.
 */
export async function reportRoutes(app: AppInstance) {
  const { ctx } = app;

  for (const def of REPORTS) {
    const build = BUILDERS[def.key];
    if (!build) throw new Error(`No builder for report ${def.key}`);
    app.get(`/api/reports/${def.key}`, { ...requirePermission(def.permission), schema: { querystring: reportQuerySchema } }, async (req, reply) => {
      const db = ctx.dbh.db;
      const rctx = makeCtx(db, currentUser(req), req.query);
      const result = finalize(def, build(rctx), rctx);
      const name = `${def.key}-${rctx.today}`;
      if (req.query.format === 'csv') {
        return reply.header('Content-Type', 'text/csv; charset=utf-8').header('Content-Disposition', `attachment; filename="${name}.csv"`).header('Cache-Control', 'no-store').send(reportCsv(result));
      }
      if (req.query.format === 'pdf') {
        const pdf = await reportPdf(result, def, rctx.settings);
        return reply.header('Content-Type', 'application/pdf').header('Content-Disposition', `inline; filename="${name}.pdf"`).header('Cache-Control', 'no-store').send(pdf);
      }
      return result;
    });
  }

  // Operators see sales, receipts, overdue and low stock; owner+ also profit and expenses.
  app.get('/api/dashboard', { ...requirePermission('dashboard.view') }, async (req) => dashboard(ctx.dbh.db, currentUser(req)));
}
