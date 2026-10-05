import { idParamSchema } from '@shopledger/shared';
import type { AppInstance } from '../../app';
import { requirePermission } from '../../lib/permissions';
import { redact } from '../../lib/redact';
import { lowStock, stockValuation, variantMovements } from './service';

export async function stockRoutes(app: AppInstance) {
  const { ctx } = app;
  const view = requirePermission('products.view');

  // Quantities are for everyone; unit costs and valuation are owner+ only.
  app.get('/api/stock/low', { ...view }, async () => ({ rows: lowStock(ctx.dbh.db) }));

  app.get('/api/variants/:id/movements', { ...view, schema: { params: idParamSchema } }, async (req) =>
    redact({ movements: variantMovements(ctx.dbh.db, req.params.id) }, req.user),
  );

  app.get('/api/stock/valuation', { ...requirePermission('finance.view') }, async () => stockValuation(ctx.dbh.db));
}
