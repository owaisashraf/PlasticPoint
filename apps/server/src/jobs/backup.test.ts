import { existsSync, mkdirSync, readdirSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTestContext, type TestContext } from '../../test/helpers';
import { auditTail, verifyAudit } from '../lib/audit';
import { readSingleEntryZip } from '../../test/zip';
import { getSettings, updateSettings } from '../modules/settings/service';
import { KEEP_DAILY, KEEP_MONTHLY, validateBackupFile } from './backup';

let t: TestContext;
afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  await t.close();
});

const OWNER = () => ({ id: t.users.owner.id, role: 'owner' as const });

describe('taking a backup', () => {
  it('writes a checked single-file copy and records the audit position', async () => {
    t = await createTestContext({ fileDb: true });
    const tailBefore = auditTail(t.dbh.sqlite);
    const entry = await t.backups.runBackup('manual', OWNER());

    expect(entry.status).toBe('ok');
    expect(entry.file_name).toMatch(/^shopledger-\d{4}-\d{2}-\d{2}_\d{4}\.db$/);
    expect(entry.audit_last_id).toBe(tailBefore.id);
    expect(entry.audit_last_hash).toBe(tailBefore.hash);
    expect(entry.size_bytes).toBeGreaterThan(0);

    const path = join(t.config.backupsDir, entry.file_name);
    expect(existsSync(path)).toBe(true);
    expect(existsSync(`${path}-wal`)).toBe(false);
    const copy = new Database(path, { readonly: true });
    expect(copy.pragma('integrity_check', { simple: true })).toBe('ok');
    expect(copy.pragma('journal_mode', { simple: true })).toBe('delete');
    copy.close();

    // One backup_log row and one audit row; the chain still verifies.
    const last = t.dbh.sqlite.prepare('SELECT action, entity FROM audit_log ORDER BY id DESC LIMIT 1').get();
    expect(last).toEqual({ action: 'backup', entity: 'backup' });
    expect(verifyAudit(t.dbh.sqlite).ok).toBe(true);
    expect(t.backups.status()).toMatchObject({ stale: false, last_failed_at: null });
  });

  it('works while the app keeps writing (WAL)', async () => {
    t = await createTestContext({ fileDb: true });
    const run = t.backups.runBackup('manual');
    updateSettings(t.dbh.db, OWNER(), { grace_days: 3 });
    expect((await run).status).toBe('ok');
  });

  it('gives two backups in the same minute different names', async () => {
    t = await createTestContext({ fileDb: true });
    const a = await t.backups.runBackup('manual');
    const b = await t.backups.runBackup('manual');
    expect(a.file_name).not.toBe(b.file_name);
  });

  it('records a failure, deletes the bad file and shows it in the status', async () => {
    t = await createTestContext({ fileDb: true });
    vi.spyOn(t.dbh.sqlite, 'backup').mockRejectedValueOnce(new Error('disk full'));
    const entry = await t.backups.runBackup('scheduled');
    expect(entry.status).toBe('failed');
    expect(entry.error).toMatch(/disk full/);
    expect(readdirSync(t.config.backupsDir)).toEqual([]);
    expect(t.backups.status()).toMatchObject({ last_ok_at: null, stale: true, last_error: 'disk full' });
    const last = t.dbh.sqlite.prepare('SELECT action FROM audit_log ORDER BY id DESC LIMIT 1').get();
    expect(last).toEqual({ action: 'backup_failed' });
  });

  it('copies to the second folder when set, and reports a missing folder', async () => {
    t = await createTestContext({ fileDb: true });
    const second = join(t.tmp, 'usb');
    mkdirSync(second);
    updateSettings(t.dbh.db, OWNER(), { backup_second_folder: second });
    const ok = await t.backups.runBackup('manual');
    expect(ok.second_copy_status).toBe('ok');
    expect(existsSync(join(second, ok.file_name))).toBe(true);

    updateSettings(t.dbh.db, OWNER(), { backup_second_folder: join(t.tmp, 'unplugged') });
    const missing = await t.backups.runBackup('manual');
    expect(missing.status).toBe('ok');
    expect(missing.second_copy_status).toBe('failed');
    expect(missing.second_copy_error).toMatch(/Folder not found/);
  });

  it('a startup backup only runs when the last good one is over 12 hours old', async () => {
    t = await createTestContext({ fileDb: true });
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-05T06:00:00Z'));
    expect(await t.backups.backupIfStale()).not.toBeNull();
    vi.setSystemTime(new Date('2026-10-05T17:00:00Z'));
    expect(await t.backups.backupIfStale()).toBeNull();
    vi.setSystemTime(new Date('2026-10-05T18:30:00Z'));
    expect(await t.backups.backupIfStale()).not.toBeNull();
  });

  it('the footer status turns stale after 36 hours', async () => {
    t = await createTestContext({ fileDb: true });
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-01T06:00:00Z'));
    await t.backups.runBackup('manual');
    vi.setSystemTime(new Date('2026-10-02T17:00:00Z'));
    expect(t.backups.status().stale).toBe(false);
    vi.setSystemTime(new Date('2026-10-02T18:30:00Z'));
    expect(t.backups.status().stale).toBe(true);
  });
});

describe('retention', () => {
  it(`keeps today, ${KEEP_DAILY} daily and ${KEEP_MONTHLY} monthly backups, and never prunes safety backups`, async () => {
    t = await createTestContext({ noUsers: true });
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-05T10:00:00Z')); // 15:00 in Karachi
    const dir = t.config.backupsDir;
    const touch = (name: string) => writeFileSync(join(dir, name), 'x');

    // Two years of daily backups at 21:00, plus three today and a safety backup.
    const day = new Date('2024-10-06T00:00:00Z');
    const names: string[] = [];
    while (day <= new Date('2026-10-04T00:00:00Z')) {
      const d = day.toISOString().slice(0, 10);
      names.push(`shopledger-${d}_2100.db`);
      day.setUTCDate(day.getUTCDate() + 1);
    }
    for (const n of names) touch(n);
    touch('shopledger-2026-10-05_0900.db');
    touch('shopledger-2026-10-05_1200.db');
    touch('shopledger-2026-10-05_1200-2.db');
    touch('shopledger-2025-01-01_1000-pre-restore.db');
    touch('notes.txt');
    // Make the "-2" file the newer one in that minute.
    utimesSync(join(dir, 'shopledger-2026-10-05_1200-2.db'), new Date(), new Date(Date.now() + 1000));

    t.backups.prune(dir);
    const left = new Set(readdirSync(dir));

    // Everything from today stays.
    for (const n of ['shopledger-2026-10-05_0900.db', 'shopledger-2026-10-05_1200.db', 'shopledger-2026-10-05_1200-2.db']) {
      expect(left.has(n), n).toBe(true);
    }
    // The 29 days before today (today counts as one of the 30).
    for (let i = 1; i <= KEEP_DAILY - 1; i++) {
      const d = new Date('2026-10-05T00:00:00Z');
      d.setUTCDate(d.getUTCDate() - i);
      expect(left.has(`shopledger-${d.toISOString().slice(0, 10)}_2100.db`), `day -${i}`).toBe(true);
    }
    const day31 = new Date('2026-10-05T00:00:00Z');
    day31.setUTCDate(day31.getUTCDate() - KEEP_DAILY - 1);
    expect(left.has(`shopledger-${day31.toISOString().slice(0, 10)}_2100.db`)).toBe(false);

    // Newest of each of the last 12 months: e.g. end of May 2026 and end of Nov 2025.
    expect(left.has('shopledger-2026-05-31_2100.db')).toBe(true);
    expect(left.has('shopledger-2025-11-30_2100.db')).toBe(true);
    expect(left.has('shopledger-2025-10-31_2100.db')).toBe(false); // 13th month back
    expect(left.has('shopledger-2026-05-30_2100.db')).toBe(false);

    expect(left.has('shopledger-2025-01-01_1000-pre-restore.db')).toBe(true);
    expect(left.has('notes.txt')).toBe(true);
    const kept = [...left].filter((n) => /^shopledger-.*\.db$/.test(n) && !n.includes('pre-restore'));
    expect(kept.length).toBeLessThanOrEqual(3 + KEEP_DAILY + KEEP_MONTHLY);
  });
});

describe('restore', () => {
  it('swaps in the backup, keeps a safety backup and records the restore as the first new audit row', async () => {
    t = await createTestContext({ fileDb: true });
    updateSettings(t.dbh.db, OWNER(), { business_name: 'Before backup' });
    const backup = await t.backups.runBackup('manual', OWNER());
    const backupTail = backup.audit_last_id;

    // Changes after the backup that the restore will roll back.
    updateSettings(t.dbh.db, OWNER(), { business_name: 'After backup' });
    const cookie = await t.cookie('owner');

    const res = await t.app.inject({
      method: 'POST',
      url: '/api/backups/restore',
      headers: { cookie },
      payload: { file_name: backup.file_name, reason: 'testing restore' },
    });
    expect(res.statusCode, res.body).toBe(200);
    const { safety_backup } = res.json() as { safety_backup: string };
    expect(safety_backup).toMatch(/pre-restore/);
    expect(existsSync(join(t.config.backupsDir, safety_backup))).toBe(true);

    // The data is back to the backup's state.
    expect(getSettings(t.dbh.db).business_name).toBe('Before backup');

    // The restore event is the first row after the backup's last audit row.
    const rows = t.dbh.sqlite.prepare('SELECT id, action, entity, reason, summary_json FROM audit_log WHERE id > ? ORDER BY id').all(backupTail) as {
      id: number;
      action: string;
      reason: string;
      summary_json: string;
    }[];
    expect(rows[0]).toMatchObject({ id: (backupTail ?? 0) + 1, action: 'restore', reason: 'testing restore' });
    expect(JSON.parse(rows[0]?.summary_json ?? '{}')).toMatchObject({ restored_from: backup.file_name, safety_backup });
    expect(verifyAudit(t.dbh.sqlite).ok).toBe(true);

    // Everyone must log in again.
    expect((await t.app.inject({ method: 'GET', url: '/api/me', headers: { cookie } })).statusCode).toBe(401);
    expect(existsSync(t.config.restoreMarkerFile)).toBe(false);

    // The safety backup holds the newer data, so the restore can be undone.
    const safety = new Database(join(t.config.backupsDir, safety_backup), { readonly: true });
    const v = safety.prepare("SELECT value_json FROM settings WHERE key = 'business_name'").get() as { value_json: string };
    expect(JSON.parse(v.value_json)).toBe('After backup');
    safety.close();
  });

  it('refuses files that are not healthy ShopLedger backups', async () => {
    t = await createTestContext({ fileDb: true });
    const dir = t.config.backupsDir;

    writeFileSync(join(dir, 'shopledger-2026-01-01_0000.db'), 'this is not a database at all, just some text to fill pages');
    const other = new Database(join(dir, 'shopledger-2026-01-02_0000.db'));
    other.exec('CREATE TABLE something (x)');
    other.close();

    for (const f of ['shopledger-2026-01-01_0000.db', 'shopledger-2026-01-02_0000.db']) {
      expect(validateBackupFile(join(dir, f), t.config.migrationsDir).ok).toBe(false);
      await expect(t.backups.restore(f, OWNER(), 'x')).rejects.toThrow(/cannot be restored/);
    }
    await expect(t.backups.restore('../shopledger.db', OWNER(), 'x')).rejects.toThrow();
    await expect(t.backups.restore('shopledger-2020-01-01_0000.db', OWNER(), 'x')).rejects.toThrow(/no longer exists/);
  });

  it('refuses a backup whose audit log was tampered with', async () => {
    t = await createTestContext({ fileDb: true });
    const b = await t.backups.runBackup('manual');
    const path = join(t.config.backupsDir, b.file_name);
    const db = new Database(path);
    db.exec("DROP TRIGGER audit_log_no_update; UPDATE audit_log SET reason = 'edited' WHERE id = 1;");
    db.close();
    const v = validateBackupFile(path, t.config.migrationsDir);
    expect(v.ok).toBe(false);
    expect(v.detail).toMatch(/audit log/);
  });

  it('operators cannot list, take or restore backups', async () => {
    t = await createTestContext({ fileDb: true });
    const cookie = await t.cookie('operator');
    expect((await t.app.inject({ method: 'GET', url: '/api/backups', headers: { cookie } })).statusCode).toBe(403);
    expect((await t.app.inject({ method: 'POST', url: '/api/backups', headers: { cookie } })).statusCode).toBe(403);
    expect(
      (
        await t.app.inject({
          method: 'POST',
          url: '/api/backups/restore',
          headers: { cookie },
          payload: { file_name: 'shopledger-2026-01-01_0000.db', reason: 'x' },
        })
      ).statusCode,
    ).toBe(403);
    // Everyone sees the footer status.
    expect((await t.app.inject({ method: 'GET', url: '/api/backups/status', headers: { cookie } })).statusCode).toBe(200);
  });
});

describe('download', () => {
  it('gives the owner and superuser a compressed .zip of the backup, and audits it', async () => {
    t = await createTestContext({ fileDb: true });
    const entry = await t.backups.runBackup('manual', OWNER());
    const before = t.auditCount();
    for (const role of ['owner', 'superuser'] as const) {
      const res = await t.app.inject({ method: 'GET', url: `/api/backups/download?file=${entry.file_name}`, headers: { cookie: await t.cookie(role) } });
      expect(res.statusCode, res.body).toBe(200);
      expect(res.headers['content-type']).toBe('application/zip');
      expect(res.headers['content-disposition']).toBe(`attachment; filename="${entry.file_name.replace(/\.db$/, '.zip')}"`);
      const zipped = readSingleEntryZip(res.rawPayload);
      expect(zipped.name).toBe(entry.file_name);
      expect(zipped.data.equals(readFileSync(join(t.config.backupsDir, entry.file_name)))).toBe(true);
      expect(res.rawPayload.length).toBeLessThan(zipped.data.length);
    }
    expect(t.auditCount()).toBe(before + 2);
    const last = t.dbh.sqlite.prepare("SELECT action, entity, user_role, summary_json FROM audit_log ORDER BY id DESC LIMIT 1").get() as Record<string, string>;
    expect(last).toMatchObject({ action: 'download', entity: 'backup', user_role: 'superuser' });
    expect(JSON.parse(last.summary_json as string)).toMatchObject({ file_name: entry.file_name, size_bytes: entry.size_bytes });
    expect(verifyAudit(t.dbh.sqlite).ok).toBe(true);
  });

  it('only files in the backup list can be downloaded, and operators cannot download at all', async () => {
    t = await createTestContext({ fileDb: true });
    const entry = await t.backups.runBackup('manual', OWNER());
    const get = async (role: 'owner' | 'operator', file: string) =>
      t.app.inject({ method: 'GET', url: `/api/backups/download?file=${encodeURIComponent(file)}`, headers: { cookie: await t.cookie(role) } });
    expect((await get('operator', entry.file_name)).statusCode).toBe(403);
    expect((await get('owner', '../shopledger.db')).statusCode).toBe(400);
    expect((await get('owner', 'shopledger.db')).statusCode).toBe(404);
    expect((await get('owner', 'shopledger-2020-01-01_0000.db')).statusCode).toBe(404);
  });
});
