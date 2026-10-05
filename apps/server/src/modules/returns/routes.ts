import { can, createSalesReturnSchema, idParamSchema, returnListQuerySchema } from '@shopledger/shared';
import type { AppInstance } from '../../app';
import { currentUser, requirePermission } from '../../lib/permissions';
import { redact } from '../../lib/redact';
import { createSalesReturn, getSalesReturn, listPurchaseReturns, listSalesReturns } from './service';

export async function returnRoutes(app: AppInstance) {
  const { ctx } = app;
  const view = requirePermission('returns.view');

  // Returned cost and profit reversed are stripped for users without finance.view.
  app.post('/api/sales/:id/returns', { ...requirePermission('returns.create'), schema: { params: idParamSchema, body: createSalesReturnSchema } }, async (req) =>
    redact({ sales_return: createSalesReturn(ctx.dbh.db, currentUser(req), req.params.id, req.body) }, req.user),
  );

  app.get('/api/sales-returns', { ...view, schema: { querystring: returnListQuerySchema } }, async (req) => redact(listSalesReturns(ctx.dbh.db, req.query), req.user));

  app.get('/api/sales-returns/:id', { ...view, schema: { params: idParamSchema } }, async (req) =>
    redact({ sales_return: getSalesReturn(ctx.dbh.db, req.params.id) }, req.user),
  );

  // Purchase returns show cost to those allowed to record purchases (section 6), like purchases do.
  app.get('/api/purchase-returns', { ...view, schema: { querystring: returnListQuerySchema } }, async (req) => {
    const data = listPurchaseReturns(ctx.dbh.db, req.query);
    return req.user && can(req.user, 'purchases.create') ? redact(data, req.user, { allow: ['cost'] }) : redact(data, req.user);
  });
}
