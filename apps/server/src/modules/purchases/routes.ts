import { createReadStream } from 'node:fs';
import {
  can,
  createPurchaseReturnSchema,
  createPurchaseSchema,
  idParamSchema,
  purchaseListQuerySchema,
  updatePurchaseReturnSchema,
  updatePurchaseSchema,
  voidSchema,
} from '@shopledger/shared';
import type { AppInstance } from '../../app';
import { writeTx } from '../../db/client';
import { writeAudit } from '../../lib/audit';
import { currentUser, requirePermission, type SessionUser } from '../../lib/permissions';
import { redact } from '../../lib/redact';
import { ensurePurchasePdf } from '../../pdf/purchase';
import { auditActor } from '../auth/service';
import { getProduct } from '../products/service';
import { getSettings } from '../settings/service';
import {
  createPurchase,
  createPurchaseReturn,
  getPurchase,
  getPurchaseReturn,
  listPurchases,
  updatePurchase,
  updatePurchaseReturn,
  voidPurchase,
  voidPurchaseReturn,
} from './service';

/**
 * Purchases show supplier margin and cost to anyone allowed to record them
 * (they copy the manufacturer's bill — CLAUDE.md section 6). Everyone else
 * with purchases.view gets the same data without margin and cost.
 */
function purchaseRedact<T>(data: T, user: SessionUser | null): T {
  return user && can(user, 'purchases.create') ? redact(data, user, { allow: ['supplier_margin', 'cost'] }) : redact(data, user);
}

export async function purchaseRoutes(app: AppInstance) {
  const { ctx } = app;
  const view = requirePermission('purchases.view');
  const record = requirePermission('purchases.create');

  app.get('/api/purchases', { ...view, schema: { querystring: purchaseListQuerySchema } }, async (req) =>
    purchaseRedact(listPurchases(ctx.dbh.db, req.query), req.user),
  );

  // The purchase entry screen prefills each line with the product's supplier
  // margin, so it gets the product with the margin — but not the average cost
  // of stock already held, and never profit. Only for purchase recorders.
  app.get('/api/purchase-entry/products/:id', { ...record, schema: { params: idParamSchema } }, async (req) =>
    redact({ product: getProduct(ctx.dbh.db, req.params.id) }, req.user, { allow: ['supplier_margin'] }),
  );

  app.get('/api/purchases/:id', { ...view, schema: { params: idParamSchema } }, async (req) =>
    purchaseRedact({ purchase: getPurchase(ctx.dbh.db, req.params.id) }, req.user),
  );

  app.post('/api/purchases', { ...record, schema: { body: createPurchaseSchema } }, async (req) =>
    purchaseRedact({ purchase: createPurchase(ctx.dbh.db, currentUser(req), req.body) }, req.user),
  );

  app.post('/api/purchases/:id/returns', { ...record, schema: { params: idParamSchema, body: createPurchaseReturnSchema } }, async (req) =>
    purchaseRedact({ purchase_return: createPurchaseReturn(ctx.dbh.db, currentUser(req), req.params.id, req.body) }, req.user),
  );

  app.get('/api/purchase-returns/:id', { ...view, schema: { params: idParamSchema } }, async (req) =>
    purchaseRedact({ purchase_return: getPurchaseReturn(ctx.dbh.db, req.params.id) }, req.user),
  );

  // Editing and voiding (CLAUDE.md 8.6). The service checks own-same-day for operators.
  const editOwn = requirePermission('documents.edit_own_same_day');
  const voidAny = requirePermission('documents.edit_any');

  app.put('/api/purchases/:id', { ...editOwn, schema: { params: idParamSchema, body: updatePurchaseSchema } }, async (req) =>
    purchaseRedact({ purchase: updatePurchase(ctx.dbh.db, currentUser(req), req.params.id, req.body) }, req.user),
  );
  app.post('/api/purchases/:id/void', { ...voidAny, schema: { params: idParamSchema, body: voidSchema } }, async (req) =>
    purchaseRedact({ purchase: voidPurchase(ctx.dbh.db, currentUser(req), req.params.id, req.body.reason) }, req.user),
  );
  app.put('/api/purchase-returns/:id', { ...editOwn, schema: { params: idParamSchema, body: updatePurchaseReturnSchema } }, async (req) =>
    purchaseRedact({ purchase_return: updatePurchaseReturn(ctx.dbh.db, currentUser(req), req.params.id, req.body) }, req.user),
  );
  app.post('/api/purchase-returns/:id/void', { ...voidAny, schema: { params: idParamSchema, body: voidSchema } }, async (req) =>
    purchaseRedact({ purchase_return: voidPurchaseReturn(ctx.dbh.db, currentUser(req), req.params.id, req.body.reason) }, req.user),
  );

  // Printing: the client calls /print (logged in the audit log, PDF refreshed),
  // then opens /pdf in a new tab. The PDF shows margin and cost, so it needs
  // the same right as recording purchases.
  app.post('/api/purchases/:id/print', { ...record, schema: { params: idParamSchema } }, async (req) => {
    const db = ctx.dbh.db;
    const purchase = getPurchase(db, req.params.id);
    await ensurePurchasePdf(ctx.config.invoicesDir, purchase, getSettings(db), true);
    writeTx(db, (tx) =>
      writeAudit(tx, auditActor(currentUser(req)), {
        action: 'print',
        entity: 'purchase',
        entity_id: purchase.id,
        doc_no: purchase.doc_no,
        version_before: purchase.version,
        version_after: purchase.version,
      }),
    );
    return { url: `/api/purchases/${purchase.id}/pdf` };
  });

  app.get('/api/purchases/:id/pdf', { ...record, schema: { params: idParamSchema } }, async (req, reply) => {
    const db = ctx.dbh.db;
    const purchase = getPurchase(db, req.params.id);
    const path = await ensurePurchasePdf(ctx.config.invoicesDir, purchase, getSettings(db));
    return reply
      .header('Content-Type', 'application/pdf')
      .header('Content-Disposition', `inline; filename="${purchase.doc_no}.pdf"`)
      .header('Cache-Control', 'no-store')
      .send(createReadStream(path));
  });
}
