import { createReadStream } from 'node:fs';
import { createSaleSchema, idParamSchema, saleCheckSchema, saleListQuerySchema, salePdfQuerySchema, updateSaleSchema, voidSchema } from '@shopledger/shared';
import type { AppInstance } from '../../app';
import { writeTx } from '../../db/client';
import { writeAudit } from '../../lib/audit';
import { currentUser, requirePermission } from '../../lib/permissions';
import { redact } from '../../lib/redact';
import { ensureInvoicePdf, type PaperSize } from '../../pdf/invoice';
import { auditActor, verifyApproval } from '../auth/service';
import { getSettings } from '../settings/service';
import { checkSale, checkSaleEdit, createSale, getSale, invoiceBalances, listSales, updateSale, voidSale } from './service';

export async function saleRoutes(app: AppInstance) {
  const { ctx } = app;
  const view = requirePermission('sales.view');
  const create = requirePermission('sales.create');

  // Cost and profit are stripped for users without finance.view.
  app.get('/api/sales', { ...view, schema: { querystring: saleListQuerySchema } }, async (req) => redact(listSales(ctx.dbh.db, req.query), req.user));

  app.get('/api/sales/:id', { ...view, schema: { params: idParamSchema } }, async (req) =>
    redact({ sale: getSale(ctx.dbh.db, req.params.id) }, req.user),
  );

  // Live amounts and warnings while the New Sale screen is being filled in.
  app.post('/api/sales/check', { ...create, schema: { body: saleCheckSchema } }, async (req) =>
    redact(checkSale(ctx.dbh.db, currentUser(req), req.body), req.user),
  );

  app.post('/api/sales', { ...create, schema: { body: createSaleSchema } }, async (req) => {
    const user = currentUser(req);
    // Password check (async) happens before the synchronous posting transaction.
    const approver = await verifyApproval(ctx.dbh.db, user, req.body.approval, 'sale');
    return redact({ sale: createSale(ctx.dbh.db, user, req.body, approver) }, req.user);
  });

  // Editing (CLAUDE.md 8.6): operators their own same-day invoices, owner+ any. The service checks which.
  app.post('/api/sales/:id/check', { ...create, schema: { params: idParamSchema, body: saleCheckSchema } }, async (req) =>
    redact(checkSaleEdit(ctx.dbh.db, currentUser(req), req.params.id, req.body), req.user),
  );

  app.put('/api/sales/:id', { ...requirePermission('documents.edit_own_same_day'), schema: { params: idParamSchema, body: updateSaleSchema } }, async (req) => {
    const db = ctx.dbh.db;
    const user = currentUser(req);
    const approver = await verifyApproval(db, user, req.body.approval, 'sale edit');
    const sale = updateSale(db, user, req.params.id, req.body, approver);
    // The PDF of the new version is made now; earlier versions' files are kept.
    const settings = getSettings(db);
    await ensureInvoicePdf(ctx.config.invoicesDir, sale, invoiceBalances(db, sale), settings, settings.invoice_paper_size);
    return redact({ sale }, req.user);
  });

  app.post('/api/sales/:id/void', { ...requirePermission('documents.edit_any'), schema: { params: idParamSchema, body: voidSchema } }, async (req) =>
    redact({ sale: voidSale(ctx.dbh.db, currentUser(req), req.params.id, req.body.reason) }, req.user),
  );

  // Printing: the client calls /print (logged in the audit log, PDF refreshed),
  // then opens /pdf in a new tab. Invoices never show margin, cost or profit.
  app.post('/api/sales/:id/print', { ...view, schema: { params: idParamSchema, querystring: salePdfQuerySchema } }, async (req) => {
    const db = ctx.dbh.db;
    const sale = getSale(db, req.params.id);
    const settings = getSettings(db);
    const size: PaperSize = req.query.size ?? settings.invoice_paper_size;
    await ensureInvoicePdf(ctx.config.invoicesDir, sale, invoiceBalances(db, sale), settings, size, true);
    writeTx(db, (tx) =>
      writeAudit(tx, auditActor(currentUser(req)), {
        action: 'print',
        entity: 'sale',
        entity_id: sale.id,
        doc_no: sale.doc_no,
        version_before: sale.version,
        version_after: sale.version,
        summary: { paper_size: size },
      }),
    );
    return { url: `/api/sales/${sale.id}/pdf?size=${encodeURIComponent(size)}` };
  });

  app.get('/api/sales/:id/pdf', { ...view, schema: { params: idParamSchema, querystring: salePdfQuerySchema } }, async (req, reply) => {
    const db = ctx.dbh.db;
    const sale = getSale(db, req.params.id);
    const settings = getSettings(db);
    const path = await ensureInvoicePdf(ctx.config.invoicesDir, sale, invoiceBalances(db, sale), settings, req.query.size ?? settings.invoice_paper_size);
    return reply
      .header('Content-Type', 'application/pdf')
      .header('Content-Disposition', `inline; filename="${sale.doc_no}.pdf"`)
      .header('Cache-Control', 'no-store')
      .send(createReadStream(path));
  });
}
