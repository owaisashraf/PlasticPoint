import { idParamSchema, whatsappHistoryQuerySchema, whatsappStatementSchema, type CloudApiCheck } from '@shopledger/shared';
import type { AppInstance } from '../../app';
import { AppError, badRequest } from '../../lib/errors';
import { currentUser, requirePermission } from '../../lib/permissions';
import { getSettings } from '../settings/service';
import { checkConnection, CloudApiError } from './cloud-api';
import { cloudConfig, createWhatsAppSender, explorerOpener, openLogFolder, whatsappHistory, type FolderOpener } from './service';

export async function whatsappRoutes(app: AppInstance) {
  const { ctx } = app;
  const send = requirePermission('whatsapp.send');
  const sender = (req: Parameters<typeof currentUser>[0]) =>
    createWhatsAppSender({ db: ctx.dbh.db, config: ctx.config, user: currentUser(req), fetch: ctx.whatsappFetch });
  // Tests inject an opener (or null); otherwise Explorer, which exists only on Windows.
  const folderOpener = (): FolderOpener | null => {
    if (ctx.folderOpener !== undefined) return ctx.folderOpener;
    return process.platform === 'win32' ? explorerOpener : null;
  };

  app.post('/api/whatsapp/invoice/:id', { ...send, schema: { params: idParamSchema } }, async (req) => sender(req).sendInvoice(req.params.id));

  app.post('/api/whatsapp/statement/:id', { ...send, schema: { params: idParamSchema, body: whatsappStatementSchema } }, async (req) =>
    sender(req).sendStatement(req.params.id, req.body.from, req.body.to),
  );

  app.post('/api/whatsapp/reminder/:id', { ...send, schema: { params: idParamSchema } }, async (req) => sender(req).sendReminder(req.params.id));

  // "Sent on WhatsApp at …" on the invoice and customer pages.
  app.get('/api/whatsapp/history', { ...send, schema: { querystring: whatsappHistoryQuerySchema } }, async (req) => ({
    entries: whatsappHistory(ctx.dbh.db, req.query),
  }));

  // "PDF saved — Open folder": Explorer on the shop laptop, with the PDF selected.
  app.post('/api/whatsapp/log/:id/open-folder', { ...send, schema: { params: idParamSchema } }, async (req) =>
    openLogFolder(ctx.dbh.db, ctx.config, req.params.id, req.ip, folderOpener()),
  );

  // Settings → WhatsApp → Test connection (uses the saved Cloud API details).
  app.post('/api/whatsapp/test', { ...requirePermission('settings.manage') }, async (): Promise<CloudApiCheck> => {
    const cfg = cloudConfig(getSettings(ctx.dbh.db));
    if (!cfg.phoneNumberId || !cfg.token) throw badRequest('Save the phone number ID and the access token first.');
    try {
      return { ok: true, ...(await checkConnection(ctx.whatsappFetch ?? fetch, cfg)) };
    } catch (e) {
      if (e instanceof CloudApiError) throw new AppError(502, e.message, 'WHATSAPP_FAILED');
      throw e;
    }
  });
}
