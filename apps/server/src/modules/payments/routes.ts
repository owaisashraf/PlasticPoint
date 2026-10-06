import {
  bounceChequeSchema,
  createReceiptSchema,
  createSupplierPaymentSchema,
  idParamSchema,
  paymentListQuerySchema,
  updateReceiptSchema,
  updateRefundSchema,
  updateSupplierPaymentSchema,
  voidSchema,
} from '@shopledger/shared';
import { z } from 'zod';
import type { AppInstance } from '../../app';
import { openItems } from '../../lib/allocation';
import { currentUser, requirePermission } from '../../lib/permissions';
import { getCustomer } from '../customers/service';
import { bounceCheque, createReceipt, createSupplierPayment, getPayment, listPayments, updateReceipt, updateRefund, updateSupplierPayment, voidPayment } from './service';

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

  // Editing and voiding (CLAUDE.md 8.6). The service checks own-same-day for operators.
  const editOwn = requirePermission('documents.edit_own_same_day');
  app.put('/api/payments/receipts/:id', { ...editOwn, schema: { params: idParamSchema, body: updateReceiptSchema } }, async (req) => ({
    payment: updateReceipt(ctx.dbh.db, currentUser(req), req.params.id, req.body),
  }));
  app.put('/api/payments/supplier/:id', { ...editOwn, schema: { params: idParamSchema, body: updateSupplierPaymentSchema } }, async (req) => ({
    payment: updateSupplierPayment(ctx.dbh.db, currentUser(req), req.params.id, req.body),
  }));
  app.put('/api/payments/refunds/:id', { ...editOwn, schema: { params: idParamSchema, body: updateRefundSchema } }, async (req) => ({
    payment: updateRefund(ctx.dbh.db, currentUser(req), req.params.id, req.body),
  }));
  app.post('/api/payments/:id/void', { ...requirePermission('documents.edit_any'), schema: { params: idParamSchema, body: voidSchema } }, async (req) => ({
    payment: voidPayment(ctx.dbh.db, currentUser(req), req.params.id, req.body.reason),
  }));

  // Owner+: CLAUDE.md section 9 ("bounced cheques").
  app.post('/api/payments/:id/bounce', { ...requirePermission('cheques.mark_bounced'), schema: { params: idParamSchema, body: bounceChequeSchema } }, async (req) => ({
    payment: bounceCheque(ctx.dbh.db, currentUser(req), req.params.id, req.body),
  }));

  // What the customer still owes, oldest first, for the receipt screen.
  app.get(
    '/api/customers/:id/open-items',
    { ...requirePermission('customers.view'), schema: { params: idParamSchema, querystring: z.object({ exclude_payment_id: z.coerce.number().int().positive().optional() }) } },
    async (req) => {
      getCustomer(ctx.dbh.db, req.params.id);
      return openItems(ctx.dbh.db, req.params.id, req.query.exclude_payment_id);
    },
  );
}
