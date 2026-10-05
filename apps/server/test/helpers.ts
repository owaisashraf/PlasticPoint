import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Role } from '@shopledger/shared';
import { buildApp, type AppInstance } from '../src/app';
import { migrationsDir, type AppConfig } from '../src/config';
import { DbHolder } from '../src/db/client';
import { BackupService, type BackupLogger } from '../src/jobs/backup';
import { setupOwner, setupSuperuser } from '../src/modules/auth/service';
import { effectivePermissions, type SessionUser } from '../src/lib/permissions';
import { createUser, findUserByUsername, toPublicUser } from '../src/modules/users/service';

export const TEST_PASSWORD = 'password-123';

export const silentLogger: BackupLogger = { info: () => {}, warn: () => {}, error: () => {} };

export interface TestContext {
  app: AppInstance;
  dbh: DbHolder;
  config: AppConfig;
  backups: BackupService;
  /** Temporary folder standing in for DATA_DIR. Never the real one. */
  tmp: string;
  users: Record<Role, SessionUser>;
  /** Logs in through the API and returns the Cookie header for that role. */
  cookie(role: Role): Promise<string>;
  auditCount(): number;
  close(): Promise<void>;
}

export interface TestOptions {
  /** Use a database file in the temp folder instead of :memory: (needed for backup/restore). */
  fileDb?: boolean;
  /** Skip creating the three standard users (for first-run setup tests). */
  noUsers?: boolean;
}

/**
 * A fresh app on an in-memory SQLite database with the real migrations,
 * plus a superuser, an owner and an operator (password TEST_PASSWORD).
 */
export async function createTestContext(opts: TestOptions = {}): Promise<TestContext> {
  const tmp = mkdtempSync(join(tmpdir(), 'shopledger-test-'));
  const dataDir = join(tmp, 'data');
  const backupsDir = join(dataDir, 'backups');
  for (const d of [dataDir, backupsDir, join(dataDir, 'logs'), join(dataDir, 'invoices')]) mkdirSync(d, { recursive: true });

  const config: AppConfig = {
    appRoot: tmp,
    port: 0,
    hostOverride: '127.0.0.1',
    dataDir,
    dbFile: opts.fileDb ? join(dataDir, 'shopledger.db') : ':memory:',
    backupsDir,
    invoicesDir: join(dataDir, 'invoices'),
    logsDir: join(dataDir, 'logs'),
    restoreMarkerFile: join(dataDir, 'restore-pending.json'),
    sessionSecret: 'test-secret-test-secret-test-secret-123456',
    migrationsDir: migrationsDir(),
    webDistDir: null,
    bcryptRounds: 4,
    isProduction: false,
  };

  const dbh = new DbHolder(config.dbFile, config.migrationsDir);
  const backups = new BackupService(config, dbh, silentLogger);
  const app = await buildApp({ config, dbh, backups });
  await app.ready();

  const users = {} as Record<Role, SessionUser>;
  if (!opts.noUsers) {
    const asSession = (username: string): SessionUser => {
      const row = findUserByUsername(dbh.db, username);
      if (!row) throw new Error(`missing test user ${username}`);
      return { ...toPublicUser(row), permissions: effectivePermissions(row.role, true) };
    };
    const account = (username: string) => ({ username, display_name: username, password: TEST_PASSWORD });
    await setupSuperuser(dbh.db, account('super'), 4, {});
    users.superuser = asSession('super');
    await setupOwner(dbh.db, users.superuser, account('owner'), 4);
    users.owner = asSession('owner');
    await createUser(dbh.db, users.owner, { ...account('operator'), role: 'operator' }, 4);
    users.operator = asSession('operator');
  }

  const cookies = new Map<Role, string>();

  const ctx: TestContext = {
    app,
    dbh,
    config,
    backups,
    tmp,
    users,
    async cookie(role) {
      const cached = cookies.get(role);
      if (cached) return cached;
      const username = role === 'superuser' ? 'super' : role;
      const res = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username, password: TEST_PASSWORD } });
      if (res.statusCode !== 200) throw new Error(`login as ${role} failed: ${res.body}`);
      const c = res.cookies.find((x) => x.name === 'sl_session');
      if (!c) throw new Error('no session cookie');
      const header = `sl_session=${c.value}`;
      cookies.set(role, header);
      return header;
    },
    auditCount() {
      return (dbh.sqlite.prepare('SELECT COUNT(*) AS n FROM audit_log').get() as { n: number }).n;
    },
    async close() {
      await app.close();
      backups.stop();
      dbh.close();
      rmSync(tmp, { recursive: true, force: true });
    },
  };

  // Log every role in now, so the login audit rows exist before a test starts counting.
  if (!opts.noUsers) for (const role of ['superuser', 'owner', 'operator'] as Role[]) await ctx.cookie(role);
  return ctx;
}
