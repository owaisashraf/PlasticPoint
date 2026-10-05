import type { AppInstance } from '../../app';
import { verifyAudit } from '../../lib/audit';
import { requirePermission } from '../../lib/permissions';

// Phase 1 only exposes the integrity check. The Change History screen
// (CLAUDE.md 10.6) is built in Phase 7.
export async function changelogRoutes(app: AppInstance) {
  const { ctx } = app;

  app.get('/api/audit/verify', { ...requirePermission('changelog.verify') }, async () => verifyAudit(ctx.dbh.sqlite));
}
