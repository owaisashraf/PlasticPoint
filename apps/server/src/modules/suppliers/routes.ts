import { createSupplierSchema, idParamSchema, statementQuerySchema, updateSupplierSchema } from '@shopledger/shared';
import type { AppInstance } from '../../app';
import { currentUser, requirePermission } from '../../lib/permissions';
import { auditActor } from '../auth/service';
import { createSupplier, getSupplier, listSuppliers, supplierStatement, updateSupplier } from './service';

// Everyone who works with purchases can see the supplier; only owner+ change it.
export async function supplierRoutes(app: AppInstance) {
  const { ctx } = app;
  const view = requirePermission('purchases.view');
  const manage = requirePermission('suppliers.manage');

  app.get('/api/suppliers', { ...view }, async () => ({ suppliers: listSuppliers(ctx.dbh.db) }));

  app.get('/api/suppliers/:id', { ...view, schema: { params: idParamSchema } }, async (req) => ({
    supplier: getSupplier(ctx.dbh.db, req.params.id),
  }));

  app.get('/api/suppliers/:id/ledger', { ...view, schema: { params: idParamSchema, querystring: statementQuerySchema } }, async (req) =>
    supplierStatement(ctx.dbh.db, req.params.id, req.query),
  );

  app.post('/api/suppliers', { ...manage, schema: { body: createSupplierSchema } }, async (req) => ({
    supplier: createSupplier(ctx.dbh.db, auditActor(currentUser(req)), req.body),
  }));

  app.patch('/api/suppliers/:id', { ...manage, schema: { params: idParamSchema, body: updateSupplierSchema } }, async (req) => ({
    supplier: updateSupplier(ctx.dbh.db, auditActor(currentUser(req)), req.params.id, req.body),
  }));
}
