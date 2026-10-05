import { z } from 'zod';
import { bulkUpdateSchema, createProductSchema, idParamSchema, productListQuerySchema, updateProductSchema } from '@shopledger/shared';
import type { AppInstance } from '../../app';
import { currentUser, requirePermission } from '../../lib/permissions';
import { redact } from '../../lib/redact';
import { bulkUpdate, createProduct, getProduct, listCategories, listProducts, priceHistory, updateProduct, updateVariant } from './service';

const updateVariantSchema = z.object({ low_stock_threshold: z.number().int().min(0).max(1_000_000) }).strict();

export async function productRoutes(app: AppInstance) {
  const { ctx } = app;
  const view = requirePermission('products.view');
  const manage = requirePermission('products.manage');

  // Supplier margin and average cost are stripped for users without finance.view.
  app.get('/api/products', { ...view, schema: { querystring: productListQuerySchema } }, async (req) =>
    redact(listProducts(ctx.dbh.db, req.query), req.user),
  );

  app.get('/api/products/categories', { ...view }, async () => ({ categories: listCategories(ctx.dbh.db) }));

  app.get('/api/products/:id', { ...view, schema: { params: idParamSchema } }, async (req) =>
    redact({ product: getProduct(ctx.dbh.db, req.params.id) }, req.user),
  );

  app.get('/api/products/:id/price-history', { ...requirePermission('finance.view'), schema: { params: idParamSchema } }, async (req) => ({
    history: priceHistory(ctx.dbh.db, req.params.id),
  }));

  // Operators may create products with an initial price; the service refuses
  // margin/discount from them and any later price change.
  app.post('/api/products', { ...manage, schema: { body: createProductSchema } }, async (req) =>
    redact({ product: createProduct(ctx.dbh.db, currentUser(req), req.body) }, req.user),
  );

  app.patch('/api/products/:id', { ...manage, schema: { params: idParamSchema, body: updateProductSchema } }, async (req) =>
    redact({ product: updateProduct(ctx.dbh.db, currentUser(req), req.params.id, req.body) }, req.user),
  );

  app.patch('/api/variants/:id', { ...manage, schema: { params: idParamSchema, body: updateVariantSchema } }, async (req) =>
    redact({ variant: updateVariant(ctx.dbh.db, currentUser(req), req.params.id, req.body) }, req.user),
  );

  app.post('/api/products/bulk-update', { ...requirePermission('pricing.manage'), schema: { body: bulkUpdateSchema } }, async (req) =>
    bulkUpdate(ctx.dbh.db, currentUser(req), req.body),
  );
}
