import { createUserSchema, idParamSchema, resetPasswordSchema, updateUserSchema } from '@shopledger/shared';
import type { AppInstance } from '../../app';
import { currentUser, requirePermission } from '../../lib/permissions';
import { createUser, listUsers, resetPassword, updateUser } from './service';

// The route key lets owners in; the service then checks whether the actor may
// manage the target's role (owners: operators only; superuser: owners and
// operators; the superuser account itself is never managed here).
// There is deliberately no DELETE route: accounts are deactivated, never deleted.
export async function userRoutes(app: AppInstance) {
  const { ctx } = app;
  const guard = requirePermission('users.manage_operators');

  app.get('/api/users', { ...guard }, async (req) => ({ users: listUsers(ctx.dbh.db, currentUser(req)) }));

  app.post('/api/users', { ...guard, schema: { body: createUserSchema } }, async (req) => ({
    user: await createUser(ctx.dbh.db, currentUser(req), req.body, ctx.config.bcryptRounds),
  }));

  app.patch('/api/users/:id', { ...guard, schema: { params: idParamSchema, body: updateUserSchema } }, async (req) => ({
    user: updateUser(ctx.dbh.db, currentUser(req), req.params.id, req.body),
  }));

  app.post(
    '/api/users/:id/password',
    { ...guard, schema: { params: idParamSchema, body: resetPasswordSchema } },
    async (req) => {
      await resetPassword(ctx.dbh.db, currentUser(req), req.params.id, req.body, ctx.config.bcryptRounds);
      return { ok: true };
    },
  );
}
