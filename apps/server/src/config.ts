import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface AppConfig {
  /** Root of the app folder (where the root package.json lives). */
  appRoot: string;
  port: number;
  /** Explicit HOST from the environment; null means "use the allow_lan_access setting". */
  hostOverride: string | null;
  dataDir: string;
  dbFile: string;
  backupsDir: string;
  invoicesDir: string;
  /** Customer statements saved for sending on WhatsApp. */
  statementsDir: string;
  logsDir: string;
  /** Written before a restore swaps files; consumed at the next open. */
  restoreMarkerFile: string;
  sessionSecret: string;
  migrationsDir: string;
  /** Built web UI, or null if it has not been built. */
  webDistDir: string | null;
  bcryptRounds: number;
  isProduction: boolean;
}

const here = dirname(fileURLToPath(import.meta.url));

/** Walks up from `start` until `test(dir)` is true. */
function findUp(start: string, test: (dir: string) => boolean): string | null {
  let dir = start;
  for (;;) {
    if (test(dir)) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function isAppRoot(dir: string): boolean {
  const pkg = join(dir, 'package.json');
  if (!existsSync(pkg)) return false;
  try {
    return (JSON.parse(readFileSync(pkg, 'utf8')) as { name?: string }).name === 'shopledger';
  } catch {
    return false;
  }
}

/**
 * Migrations live in src/db/migrations during development and are copied to
 * dist/migrations by the build. This works from the source tree, the server
 * bundle and the CLI bundles.
 */
function findMigrationsDir(): string {
  const serverDir = findUp(here, (d) => existsSync(join(d, 'src/db/migrations')) || existsSync(join(d, 'dist/migrations')));
  if (!serverDir) throw new Error('Cannot find the database migrations folder.');
  const src = join(serverDir, 'src/db/migrations');
  return existsSync(src) ? src : join(serverDir, 'dist/migrations');
}

function loadOrCreateSecret(file: string): string {
  if (existsSync(file)) {
    const s = readFileSync(file, 'utf8').trim();
    if (s.length >= 32) return s;
  }
  const s = randomBytes(48).toString('base64url');
  writeFileSync(file, s, { encoding: 'utf8', mode: 0o600 });
  return s;
}

/**
 * Reads the environment (and `.env` in the app folder, if present) and
 * resolves every path from DATA_DIR. Creates the data folders if missing.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const appRoot = findUp(here, isAppRoot) ?? process.cwd();

  const envFile = join(appRoot, '.env');
  if (env === process.env && existsSync(envFile)) process.loadEnvFile(envFile);

  const dataDirRaw = env.DATA_DIR?.trim() || './data';
  const dataDir = isAbsolute(dataDirRaw) ? dataDirRaw : resolve(appRoot, dataDirRaw);
  const backupsDir = join(dataDir, 'backups');
  const invoicesDir = join(dataDir, 'invoices');
  const statementsDir = join(dataDir, 'statements');
  const logsDir = join(dataDir, 'logs');
  for (const d of [dataDir, backupsDir, invoicesDir, statementsDir, logsDir]) mkdirSync(d, { recursive: true });

  const port = Number(env.PORT?.trim() || 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`Invalid PORT: ${env.PORT}`);

  const sessionSecret = env.SESSION_SECRET?.trim() || loadOrCreateSecret(join(dataDir, 'secret.key'));

  const webDist = resolve(appRoot, 'apps/web/dist');

  return {
    appRoot,
    port,
    hostOverride: env.HOST?.trim() || null,
    dataDir,
    dbFile: join(dataDir, 'shopledger.db'),
    backupsDir,
    invoicesDir,
    statementsDir,
    logsDir,
    restoreMarkerFile: join(dataDir, 'restore-pending.json'),
    sessionSecret,
    migrationsDir: findMigrationsDir(),
    webDistDir: existsSync(join(webDist, 'index.html')) ? webDist : null,
    bcryptRounds: 10,
    isProduction: env.NODE_ENV === 'production',
  };
}

/** Migrations folder only (for tests and tools that don't need a data folder). */
export function migrationsDir(): string {
  return findMigrationsDir();
}
