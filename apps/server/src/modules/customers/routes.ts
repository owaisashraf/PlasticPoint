import {
  badDebtSchema,
  createCustomerSchema,
  customerListQuerySchema,
  idParamSchema,
  statementQuerySchema,
  updateCustomerSchema,
} from '@shopledger/shared';
import type { AppInstance } from '../../app';
import { currentUser, requirePermission } from '../../lib/permissions';
import { redact } from '../../lib/redact';
import { auditActor } from '../auth/service';
import {
  createCustomer,
  customerStatement,
  getCustomer,
  listCities,
  listCustomers,
  markBadDebt,
  unmarkBadDebt,
  updateCustomer,
} from './service';

export async function customerRoutes(app: AppInstance) {
  const { ctx } = app;
  const view = requirePermission('customers.view');
  const manage = requirePermission('customers.manage');
  const badDebt = requirePermission('customers.bad_debt');

  app.get('/api/customers', { ...view, schema: { querystring: customerListQuerySchema } }, async (req) =>
    redact(listCustomers(ctx.dbh.db, req.query), req.user),
  );

  app.get('/api/customers/cities', { ...view }, async () => ({ cities: listCities(ctx.dbh.db) }));

  app.get('/api/customers/:id', { ...view, schema: { params: idParamSchema } }, async (req) =>
    redact({ customer: getCustomer(ctx.dbh.db, req.params.id) }, req.user),
  );

  app.get('/api/customers/:id/ledger', { ...view, schema: { params: idParamSchema, querystring: statementQuerySchema } }, async (req) =>
    redact(customerStatement(ctx.dbh.db, req.params.id, req.query), req.user),
  );

  app.post('/api/customers', { ...manage, schema: { body: createCustomerSchema } }, async (req) => ({
    customer: redact(createCustomer(ctx.dbh.db, auditActor(currentUser(req)), req.body), req.user),
  }));

  app.patch('/api/customers/:id', { ...manage, schema: { params: idParamSchema, body: updateCustomerSchema } }, async (req) => ({
    customer: redact(updateCustomer(ctx.dbh.db, auditActor(currentUser(req)), req.params.id, req.body), req.user),
  }));

  app.post('/api/customers/:id/bad-debt', { ...badDebt, schema: { params: idParamSchema, body: badDebtSchema } }, async (req) => ({
    customer: markBadDebt(ctx.dbh.db, auditActor(currentUser(req)), req.params.id, req.body.reason),
  }));

  app.post('/api/customers/:id/bad-debt/clear', { ...badDebt, schema: { params: idParamSchema, body: badDebtSchema } }, async (req) => ({
    customer: unmarkBadDebt(ctx.dbh.db, auditActor(currentUser(req)), req.params.id, req.body.reason),
  }));
}
