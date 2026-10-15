import { backupDownloadQuerySchema, restoreBackupSchema } from '@shopledger/shared';
import type { AppInstance } from '../../app';
import { authenticated, currentUser, requirePermission } from '../../lib/permissions';
import { auditActor } from '../auth/service';
import { SESSION_COOKIE } from '../auth/sessions';

export async function backupRoutes(app: AppInstance) {
  const { ctx } = app;

  // Footer "Last backup: ..." for everyone.
  app.get('/api/backups/status', { ...authenticated }, async () => ctx.backups.status());

  app.get('/api/backups', { ...requirePermission('backups.manage') }, async () => ({
    files: ctx.backups.listFiles(),
    log: ctx.backups.logEntries(),
  }));

  app.post('/api/backups', { ...requirePermission('backups.manage') }, async (req) => ({
    entry: await ctx.backups.runBackup('manual', auditActor(currentUser(req))),
  }));

  // Download a backup as a .zip (owner+ only: the file is the whole database,
  // with cost, profit, expenses and password hashes in it).
  app.get('/api/backups/download', { ...requirePermission('backups.manage'), schema: { querystring: backupDownloadQuerySchema } }, async (req, reply) => {
    const { zip_name, zip } = await ctx.backups.zipForDownload(req.query.file, auditActor(currentUser(req)));
    return reply
      .header('Content-Type', 'application/zip')
      .header('Content-Disposition', `attachment; filename="${zip_name}"`)
      .header('Cache-Control', 'no-store')
      .send(zip);
  });

  app.post(
    '/api/backups/restore',
    { ...requirePermission('backups.manage'), schema: { body: restoreBackupSchema } },
    async (req, reply) => {
      const actor = auditActor(currentUser(req));
      const result = await ctx.backups.restore(req.body.file_name, actor, req.body.reason);
      // All sessions were cleared by the restore; everyone logs in again.
      reply.clearCookie(SESSION_COOKIE, { path: '/' });
      return { ok: true, ...result };
    },
  );
}
