import { loadConfig, type AppConfig } from '../config';
import { DbHolder } from '../db/client';
import type { BackupLogger } from '../jobs/backup';

/** Opens the DATA_DIR database for a command-line tool (applies migrations). */
export function openForCli(): { config: AppConfig; dbh: DbHolder } {
  const config = loadConfig();
  const dbh = new DbHolder(config.dbFile, config.migrationsDir);
  return { config, dbh };
}

export const consoleLogger: BackupLogger = {
  info: () => {},
  warn: (obj, msg) => console.warn(msg ?? '', obj instanceof Error ? obj.message : ''),
  error: (obj, msg) => console.error(msg ?? '', obj instanceof Error ? obj.message : ''),
};

export function runCli(main: () => Promise<number> | number): void {
  Promise.resolve()
    .then(main)
    .then((code) => process.exit(code))
    .catch((e) => {
      console.error(e instanceof Error ? e.message : e);
      process.exit(1);
    });
}
