import { bounceChequeSchema, createReceiptSchema, createSupplierPaymentSchema, idParamSchema, paymentListQuerySchema } from '@shopledger/shared';
import type { AppInstance } from '../../app';
import { openItems } from '../../lib/allocation';
import { currentUser, requirePermission } from '../../lib/permissions';
import { getCustomer } from '../customers/service';
import { bounceCheque, createReceipt, createSupplierPayment, getPayment, listPayments } from './service';

export async function paymentRoutes(app: AppInstance) {
  const { ctx } = app;
  const view = requirePermission('payments.view');
  const create = requirePermission('payments.create');

  app.get('/api/payments', { ...view, schema: { querystring: paymentListQuerySchema } }, async (req) => listPayments(ctx.dbh.db, req.query));

  app.get('/api/payments/:id', { ...view, schema: { params: idParamSchema } }, async (req) => ({ payment: getPayment(ctx.dbh.db, req.params.id) }));

  app.post('/api/payments/receipts', { ...create, schema: { body: createReceiptSchema } }, async (req) => ({
    payment: createReceipt(ctx.dbh.db, currentUser(req), req.body),
  }));

  app.post('/api/payments/supplier', { ...create, schema: { body: createSupplierPaymentSchema } }, async (req) => ({
    payment: createSupplierPayment(ctx.dbh.db, currentUser(req), req.body),
  }));

  // Owner+: CLAUDE.md section 9 ("bounced cheques").
  app.post('/api/payments/:id/bounce', { ...requirePermission('cheques.mark_bounced'), schema: { params: idParamSchema, body: bounceChequeSchema } }, async (req) => ({
    payment: bounceCheque(ctx.dbh.db, currentUser(req), req.params.id, req.body),
  }));

  // What the customer still owes, oldest first, for the receipt screen.
  app.get('/api/customers/:id/open-items', { ...requirePermission('customers.view'), schema: { params: idParamSchema } }, async (req) => {
    getCustomer(ctx.dbh.db, req.params.id);
    return openItems(ctx.dbh.db, req.params.id);
  });
}
