import { spawn } from 'node:child_process';
import { buildApp } from './app';
import { loadConfig } from './config';
import { DbHolder } from './db/client';
import { BackupService } from './jobs/backup';
import { createLogger } from './lib/logger';
import { purgeExpiredSessions } from './modules/auth/sessions';
import { getSetting } from './modules/settings/service';
import { hasUsers } from './modules/users/service';

function browserCommand(url: string): [string, string[]] {
  switch (process.platform) {
    case 'win32':
      return ['cmd', ['/c', 'start', '""', url]];
    case 'darwin':
      return ['open', [url]];
    default:
      return ['xdg-open', [url]];
  }
}

function openBrowser(url: string): void {
  const [cmd, args] = browserCommand(url);
  spawn(cmd, args, { detached: true, stdio: 'ignore', windowsHide: true }).unref();
}

/** True if ShopLedger is already answering on this port. */
async function alreadyRunning(port: number): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(1500) });
    const body = (await res.json()) as { app?: string };
    return body.app === 'shopledger';
  } catch {
    return false;
  }
}

async function main() {
  const config = loadConfig();
  const url = `http://localhost:${config.port}`;
  const wantsBrowser = process.argv.includes('--open');

  // Single instance: if ShopLedger is already running, just open the browser.
  if (await alreadyRunning(config.port)) {
    console.log(`ShopLedger is already running at ${url}`);
    openBrowser(url);
    return;
  }

  const logger = await createLogger(config.logsDir, config.isProduction);
  const dbh = new DbHolder(config.dbFile, config.migrationsDir);
  const backups = new BackupService(config, dbh, logger);

  // A restore that was interrupted after the file swap gets recorded now.
  backups.consumeRestoreMarker();
  purgeExpiredSessions(dbh.db);

  const app = await buildApp({ config, dbh, backups }, { logger });

  const host = config.hostOverride ?? (getSetting(dbh.db, 'allow_lan_access') ? '0.0.0.0' : '127.0.0.1');
  try {
    await app.listen({ port: config.port, host });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'EADDRINUSE') {
      const message = `Port ${config.port} is used by another program. Close it or set a different PORT in .env.`;
      logger.error(message);
      console.error(message);
      dbh.close();
      process.exit(1);
    }
    throw e;
  }
  logger.info({ url, host, dataDir: config.dataDir }, 'ShopLedger started');
  if (!config.isProduction) console.log(`ShopLedger running at ${url}`);
  if (wantsBrowser) openBrowser(url);

  backups.start();
  // Startup backup if the last good one is more than 12 hours old. Skipped on a brand-new install.
  if (hasUsers(dbh.db)) {
    void backups.backupIfStale('startup').catch((e) => logger.error({ err: e }, 'Startup backup failed'));
  }
  setInterval(() => purgeExpiredSessions(dbh.db), 60 * 60 * 1000).unref();

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'Shutting down');
    backups.stop();
    try {
      await app.close();
      if (hasUsers(dbh.db)) await backups.runBackup('shutdown');
    } catch (e) {
      logger.error({ err: e }, 'Error during shutdown');
    } finally {
      dbh.close();
      process.exit(0);
    }
  };
  // SIGHUP is what Windows sends when the console window is closed.
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) process.on(sig, () => void shutdown(sig));
}

main().catch((e) => {
  console.error('ShopLedger could not start:', e instanceof Error ? e.message : e);
  process.exit(1);
});
