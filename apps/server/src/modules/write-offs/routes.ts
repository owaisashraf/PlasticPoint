import { createWriteOffSchema, idParamSchema, reverseWriteOffSchema, updateWriteOffSchema, voidSchema } from '@shopledger/shared';
import type { AppInstance } from '../../app';
import { currentUser, requirePermission } from '../../lib/permissions';
import { getCustomer } from '../customers/service';
import { createWriteOff, listWriteOffs, reverseWriteOff, updateWriteOff, voidWriteOff } from './service';

export async function writeOffRoutes(app: AppInstance) {
  const { ctx } = app;
  const manage = requirePermission('write_offs.manage');

  // Write-offs are part of the customer's account (they show on the ledger too).
  app.get('/api/customers/:id/write-offs', { ...requirePermission('customers.view'), schema: { params: idParamSchema } }, async (req) => {
    getCustomer(ctx.dbh.db, req.params.id);
    return { write_offs: listWriteOffs(ctx.dbh.db, req.params.id) };
  });

  app.post('/api/customers/:id/write-offs', { ...manage, schema: { params: idParamSchema, body: createWriteOffSchema } }, async (req) => ({
    write_off: createWriteOff(ctx.dbh.db, currentUser(req), req.params.id, req.body),
  }));

  app.put('/api/write-offs/:id', { ...manage, schema: { params: idParamSchema, body: updateWriteOffSchema } }, async (req) => ({
    write_off: updateWriteOff(ctx.dbh.db, currentUser(req), req.params.id, req.body),
  }));
  app.post('/api/write-offs/:id/void', { ...requirePermission('documents.edit_any'), schema: { params: idParamSchema, body: voidSchema } }, async (req) => ({
    write_off: voidWriteOff(ctx.dbh.db, currentUser(req), req.params.id, req.body.reason),
  }));

  app.post('/api/write-offs/:id/reverse', { ...manage, schema: { params: idParamSchema, body: reverseWriteOffSchema } }, async (req) => ({
    write_off: reverseWriteOff(ctx.dbh.db, currentUser(req), req.params.id, req.body),
  }));
}
