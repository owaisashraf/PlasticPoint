import type { FastifyReply, FastifyRequest } from 'fastify';
import { changeOwnPasswordSchema, loginSchema, setupAccountSchema, type Me } from '@shopledger/shared';
import type { AppInstance } from '../../app';
import { authenticated, currentUser, publicRoute } from '../../lib/permissions';
import { changeOwnPassword, login, logout, setupOwner, setupStatus, setupSuperuser } from './service';
import { SESSION_COOKIE } from './sessions';

function setSessionCookie(reply: FastifyReply, token: string) {
  reply.setCookie(SESSION_COOKIE, token, {
    path: '/',
    httpOnly: true,
    sameSite: 'strict',
    signed: true,
  });
}

function meta(req: FastifyRequest) {
  return { ip: req.ip, userAgent: req.headers['user-agent'] };
}

export async function authRoutes(app: AppInstance) {
  const { ctx } = app;
  const rounds = () => ctx.config.bcryptRounds;

  app.get('/api/setup/status', { ...publicRoute }, async () => setupStatus(ctx.dbh.db));

  app.post('/api/setup/superuser', { ...publicRoute, schema: { body: setupAccountSchema } }, async (req, reply) => {
    const { user, token } = await setupSuperuser(ctx.dbh.db, req.body, rounds(), meta(req));
    setSessionCookie(reply, token);
    return { user };
  });

  app.post('/api/setup/owner', { ...authenticated, schema: { body: setupAccountSchema } }, async (req) => {
    const user = await setupOwner(ctx.dbh.db, currentUser(req), req.body, rounds());
    return { user };
  });

  app.post('/api/auth/login', { ...publicRoute, schema: { body: loginSchema } }, async (req, reply) => {
    const { user, token } = await login(ctx.dbh.db, req.body, meta(req));
    setSessionCookie(reply, token);
    return { user };
  });

  app.post('/api/auth/logout', { ...authenticated }, async (req, reply) => {
    const user = currentUser(req);
    if (req.sessionToken) logout(ctx.dbh.db, user, req.sessionToken);
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    return { ok: true };
  });

  app.get('/api/me', { ...authenticated }, async (req): Promise<Me> => {
    const { permissions, ...user } = currentUser(req);
    return { user, permissions };
  });

  app.post('/api/me/password', { ...authenticated, schema: { body: changeOwnPasswordSchema } }, async (req) => {
    await changeOwnPassword(ctx.dbh.db, currentUser(req), req.body, rounds(), req.sessionToken);
    return { ok: true };
  });
}
