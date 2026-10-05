import type { IncomingMessage, ServerResponse } from 'node:http';
import fastifyCookie from '@fastify/cookie';
import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyBaseLogger, type FastifyError, type FastifyInstance, type RawServerDefault } from 'fastify';
import {
  hasZodFastifySchemaValidationErrors,
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from 'fastify-type-provider-zod';
import type { AppConfig } from './config';
import type { DbHolder } from './db/client';
import type { BackupService } from './jobs/backup';
import { AppError } from './lib/errors';
import { effectivePermissions, publicRoute, type RouteAccess } from './lib/permissions';
import { authRoutes } from './modules/auth/routes';
import { SESSION_COOKIE, resolveSession } from './modules/auth/sessions';
import { backupRoutes } from './modules/backups/routes';
import { changelogRoutes } from './modules/changelog/routes';
import { customerRoutes } from './modules/customers/routes';
import { productRoutes } from './modules/products/routes';
import { getSetting } from './modules/settings/service';
import { settingsRoutes } from './modules/settings/routes';
import { supplierRoutes } from './modules/suppliers/routes';
import { userRoutes } from './modules/users/routes';

export interface AppContext {
  config: AppConfig;
  dbh: DbHolder;
  backups: BackupService;
}

export interface RouteInfo {
  method: string;
  url: string;
  access: RouteAccess;
}

declare module 'fastify' {
  interface FastifyInstance {
    ctx: AppContext;
    /** Every /api route and the access it declared (used by tests and the startup check). */
    routeAccess: RouteInfo[];
  }
  interface FastifyRequest {
    /** Raw session token from the cookie, if it was valid. */
    sessionToken: string | null;
  }
}

export type AppInstance = FastifyInstance<RawServerDefault, IncomingMessage, ServerResponse, FastifyBaseLogger, ZodTypeProvider>;

export interface BuildAppOptions {
  logger?: FastifyBaseLogger;
}

export async function buildApp(ctx: AppContext, opts: BuildAppOptions = {}): Promise<AppInstance> {
  const app = Fastify({
    ...(opts.logger ? { loggerInstance: opts.logger } : { logger: false }),
    bodyLimit: 1024 * 1024,
  }).withTypeProvider<ZodTypeProvider>();

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  app.decorate('ctx', ctx);
  app.decorate('routeAccess', [] as RouteInfo[]);
  app.decorateRequest('user', null);
  app.decorateRequest('sessionToken', null);

  await app.register(fastifyCookie, { secret: ctx.config.sessionSecret });

  // Every /api route must say who may call it. Forgetting is a startup error,
  // not a silent hole.
  app.addHook('onRoute', (route) => {
    if (!route.url.startsWith('/api/')) return;
    const methods = (Array.isArray(route.method) ? route.method : [route.method]).filter((m) => m !== 'HEAD');
    if (methods.length === 0) return;
    const access = route.config?.access;
    if (!access) throw new Error(`Route ${methods.join(',')} ${route.url} must declare its access (requirePermission, authenticated or publicRoute).`);
    for (const method of methods) app.routeAccess.push({ method, url: route.url, access });
  });

  // Identify the user from the signed session cookie.
  app.addHook('onRequest', async (req) => {
    const raw = req.cookies[SESSION_COOKIE];
    if (!raw) return;
    const unsigned = req.unsignCookie(raw);
    if (!unsigned.valid || !unsigned.value) return;
    const db = ctx.dbh.db;
    const found = resolveSession(db, unsigned.value);
    if (!found) return;
    req.sessionToken = unsigned.value;
    req.user = {
      ...found,
      permissions: effectivePermissions(found.role, getSetting(db, 'operators_can_record_purchases')),
    };
  });

  app.setErrorHandler((err: FastifyError, req, reply) => {
    if (hasZodFastifySchemaValidationErrors(err)) {
      const fields: Record<string, string> = {};
      for (const issue of err.validation) {
        const path = issue.instancePath.replace(/^\//, '').replaceAll('/', '.') || 'request';
        fields[path] ??= issue.message ?? 'Invalid value';
      }
      const first = Object.values(fields)[0] ?? 'Please check the form.';
      return reply.status(400).send({ error: first, code: 'VALIDATION', fields });
    }
    if (err instanceof AppError) {
      return reply.status(err.statusCode).send({ error: err.message, code: err.code });
    }
    const status = err.statusCode ?? 500;
    if (status < 500) {
      return reply.status(status).send({ error: friendlyClientError(status), code: err.code });
    }
    req.log.error({ err }, 'Unhandled error');
    return reply.status(500).send({
      error: 'Something went wrong. Please try again. If it keeps happening, restart ShopLedger and tell the owner.',
      code: 'INTERNAL',
    });
  });

  app.get('/api/health', { ...publicRoute }, async () => ({ app: 'shopledger', ok: true }));

  await authRoutes(app);
  await userRoutes(app);
  await settingsRoutes(app);
  await backupRoutes(app);
  await changelogRoutes(app);
  await customerRoutes(app);
  await supplierRoutes(app);
  await productRoutes(app);

  if (ctx.config.webDistDir) {
    await app.register(fastifyStatic, {
      root: ctx.config.webDistDir,
      setHeaders: (res, path) => {
        if (/[\\/]assets[\\/]/.test(path)) res.header('Cache-Control', 'public, max-age=31536000, immutable');
      },
    });
  }

  app.setNotFoundHandler((req, reply) => {
    if (req.url.startsWith('/api/') || !ctx.config.webDistDir || req.method !== 'GET') {
      return reply.status(404).send({ error: 'Not found.', code: 'NOT_FOUND' });
    }
    // Client-side routes: let the React app handle the path.
    return reply.sendFile('index.html');
  });

  return app;
}

function friendlyClientError(status: number): string {
  switch (status) {
    case 413:
      return 'That is too much data to send at once.';
    case 415:
      return 'The request was not in the expected format.';
    case 404:
      return 'Not found.';
    default:
      return 'The request could not be processed. Please check and try again.';
  }
}
