import { settingsPatchSchema } from '@shopledger/shared';
import type { AppInstance } from '../../app';
import { auditActor } from '../auth/service';
import { authenticated, currentUser, requirePermission } from '../../lib/permissions';
import { redact } from '../../lib/redact';
import { getPublicSettings, getSettings, settingsView, updateSettings } from './service';

export async function settingsRoutes(app: AppInstance) {
  const { ctx } = app;

  app.get('/api/settings/public', { ...authenticated }, async () => getPublicSettings(ctx.dbh.db));

  app.get('/api/settings', { ...requirePermission('settings.manage') }, async (req) =>
    // The WhatsApp access token never leaves the server.
    redact(settingsView(getSettings(ctx.dbh.db)), req.user),
  );

  app.patch(
    '/api/settings',
    { ...requirePermission('settings.manage'), schema: { body: settingsPatchSchema } },
    async (req) => {
      const user = currentUser(req);
      const result = updateSettings(ctx.dbh.db, auditActor(user), req.body.changes);
      if (result.changed.includes('backup_time')) ctx.backups.reschedule();
      return redact(result, req.user);
    },
  );
}
