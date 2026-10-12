import { copyFileSync, existsSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import Database from 'better-sqlite3';
import { Cron } from 'croner';
import { desc, eq } from 'drizzle-orm';
import {
  BACKUP_STALE_HOURS,
  type BackupFile,
  type BackupLogEntry,
  type BackupStatus,
  type BackupTrigger,
} from '@shopledger/shared';
import type { AppConfig } from '../config';
import { writeTx, type DbHolder } from '../db/client';
import { backup_log } from '../db/schema';
import { auditTail, SYSTEM_ACTOR, verifyAudit, writeAudit, type AuditActor } from '../lib/audit';
import { BUSINESS_TIME_ZONE, HOUR_MS, karachiFileStamp, msSince, nowIso, toBusinessDate } from '../lib/dates';
import { AppError, badRequest, notFound } from '../lib/errors';
import { zipSingleFile } from '../lib/zip';
import { deleteAllSessions } from '../modules/auth/sessions';
import { getSetting } from '../modules/settings/service';

/** Backups (CLAUDE.md section 14). */

export const KEEP_DAILY = 30;
export const KEEP_MONTHLY = 12;
/** A backup is taken at startup if the last good one is older than this. */
export const STARTUP_BACKUP_AFTER_HOURS = 12;

const BACKUP_FILE_RE = /^shopledger-(\d{4}-\d{2}-\d{2})_(\d{4})(?:-\d+)?\.db$/;
const PRE_RESTORE_RE = /^shopledger-.*-pre-restore(?:-\d+)?\.db$/;

export interface BackupLogger {
  info(obj: unknown, msg?: string): void;
  warn(obj: unknown, msg?: string): void;
  error(obj: unknown, msg?: string): void;
}

interface RestoreMarker {
  restored_from: string;
  safety_backup: string;
  restored_audit_last_id: number | null;
  restored_audit_last_hash: string | null;
  previous_audit_last_id: number | null;
  previous_audit_last_hash: string | null;
  actor: AuditActor;
  reason: string;
  at: string;
}

type LogRow = typeof backup_log.$inferSelect;

function toEntry(r: LogRow): BackupLogEntry {
  return { ...r };
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export class BackupService {
  #cron: Cron | null = null;
  /** Backups run one at a time. */
  #queue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly config: AppConfig,
    private readonly dbh: DbHolder,
    private readonly log: BackupLogger,
  ) {}

  // --- Scheduling ------------------------------------------------------------

  /** Starts the daily backup at settings.backup_time (Karachi time). */
  start(): void {
    this.reschedule();
  }

  reschedule(): void {
    this.#cron?.stop();
    const time = getSetting(this.dbh.db, 'backup_time');
    const [h, m] = time.split(':');
    this.#cron = new Cron(`${Number(m)} ${Number(h)} * * *`, { timezone: BUSINESS_TIME_ZONE, protect: true }, () => {
      void this.runBackup('scheduled').catch((e) => this.log.error({ err: e }, 'Scheduled backup failed'));
    });
    this.log.info({ time }, 'Daily backup scheduled');
  }

  stop(): void {
    this.#cron?.stop();
    this.#cron = null;
  }

  /** Runs a backup if the last good one is older than `hours` (or there is none). */
  async backupIfStale(trigger: BackupTrigger = 'startup', hours = STARTUP_BACKUP_AFTER_HOURS): Promise<BackupLogEntry | null> {
    const last = this.lastOk();
    if (last && msSince(last.started_at) < hours * HOUR_MS) return null;
    return this.runBackup(trigger);
  }

  // --- Taking a backup -------------------------------------------------------

  /** Takes a backup, checks it, records it and prunes old files. Never throws for backup failures. */
  runBackup(trigger: BackupTrigger, actor: AuditActor = SYSTEM_ACTOR): Promise<BackupLogEntry> {
    const run = this.#queue.then(() => this.#runBackup(trigger, actor));
    this.#queue = run.catch(() => undefined);
    return run;
  }

  async #runBackup(trigger: BackupTrigger, actor: AuditActor): Promise<BackupLogEntry> {
    const started_at = nowIso();
    const fileName = this.#newFileName(trigger);
    const finalPath = join(this.config.backupsDir, fileName);
    const partialPath = `${finalPath}.partial`;

    let status: 'ok' | 'failed' = 'ok';
    let error: string | null = null;
    let size: number | null = null;
    let tail: { id: number | null; hash: string | null } = { id: null, hash: null };

    try {
      await this.dbh.sqlite.backup(partialPath);
      const check = checkBackupCopy(partialPath);
      if (!check.ok) throw new Error(`Integrity check failed: ${check.detail}`);
      tail = check.tail;
      renameSync(partialPath, finalPath);
      size = statSync(finalPath).size;
    } catch (e) {
      status = 'failed';
      error = errorMessage(e);
      for (const p of [partialPath, finalPath]) if (existsSync(p)) unlinkSync(p);
      this.log.error({ err: e, trigger }, 'Backup failed');
    }

    let second_copy_status: 'ok' | 'failed' | 'skipped' = 'skipped';
    let second_copy_error: string | null = null;
    const secondDir = getSetting(this.dbh.db, 'backup_second_folder');
    if (status === 'ok' && secondDir) {
      try {
        if (!existsSync(secondDir)) throw new Error(`Folder not found: ${secondDir}`);
        copyFileSync(finalPath, join(secondDir, fileName));
        second_copy_status = 'ok';
        this.prune(secondDir);
      } catch (e) {
        second_copy_status = 'failed';
        second_copy_error = errorMessage(e);
        this.log.warn({ err: e }, 'Copy to second backup folder failed');
      }
    }

    const entry = writeTx(this.dbh.db, (tx) => {
      const row = tx
        .insert(backup_log)
        .values({
          started_at,
          finished_at: nowIso(),
          file_name: fileName,
          size_bytes: size,
          trigger,
          status,
          error,
          audit_last_id: tail.id,
          audit_last_hash: tail.hash,
          second_copy_status,
          second_copy_error,
        })
        .returning()
        .get();
      writeAudit(tx, actor, {
        action: status === 'ok' ? 'backup' : 'backup_failed',
        entity: 'backup',
        entity_id: row.id,
        summary: { file_name: fileName, trigger, size_bytes: size, error, second_copy_status, second_copy_error },
      });
      return toEntry(row);
    });

    if (status === 'ok') {
      this.prune(this.config.backupsDir);
      this.log.info({ file: fileName, trigger }, 'Backup complete');
    }
    return entry;
  }

  #newFileName(trigger: BackupTrigger): string {
    const base = `shopledger-${karachiFileStamp()}${trigger === 'pre_restore' ? '-pre-restore' : ''}`;
    let name = `${base}.db`;
    for (let i = 2; existsSync(join(this.config.backupsDir, name)); i++) name = `${base}-${i}.db`;
    return name;
  }

  // --- Retention -------------------------------------------------------------

  /**
   * Keeps every backup from today, the newest backup of each of the last 30
   * days that have one, and the newest of each of the last 12 months. Safety
   * backups taken before a restore are never pruned.
   */
  prune(dir: string): string[] {
    const files = readdirSync(dir)
      .map((name) => ({ name, m: BACKUP_FILE_RE.exec(name) }))
      .filter((f): f is { name: string; m: RegExpExecArray } => f.m !== null && !PRE_RESTORE_RE.test(f.name))
      .map((f) => ({ name: f.name, day: f.m[1] ?? '', key: `${f.m[1]}_${f.m[2]}`, mtime: statSync(join(dir, f.name)).mtimeMs }))
      .sort((a, b) => (a.key === b.key ? b.mtime - a.mtime : a.key < b.key ? 1 : -1)); // newest first

    const today = toBusinessDate(new Date());
    const keep = new Set<string>();
    const days = new Set<string>();
    const months = new Set<string>();
    for (const f of files) {
      if (f.day === today) keep.add(f.name);
      if (!days.has(f.day) && days.size < KEEP_DAILY) {
        days.add(f.day);
        keep.add(f.name);
      }
      const month = f.day.slice(0, 7);
      if (!months.has(month) && months.size < KEEP_MONTHLY) {
        months.add(month);
        keep.add(f.name);
      }
    }

    const deleted: string[] = [];
    for (const f of files) {
      if (keep.has(f.name)) continue;
      try {
        unlinkSync(join(dir, f.name));
        deleted.push(f.name);
      } catch (e) {
        this.log.warn({ err: e, file: f.name }, 'Could not delete old backup');
      }
    }
    return deleted;
  }

  // --- Reading ---------------------------------------------------------------

  lastOk(): LogRow | undefined {
    return this.dbh.db.select().from(backup_log).where(eq(backup_log.status, 'ok')).orderBy(desc(backup_log.id)).limit(1).get();
  }

  status(): BackupStatus {
    const lastOk = this.lastOk();
    const lastFailed = this.dbh.db
      .select()
      .from(backup_log)
      .where(eq(backup_log.status, 'failed'))
      .orderBy(desc(backup_log.id))
      .limit(1)
      .get();
    const failedSinceOk = lastFailed && (!lastOk || lastFailed.id > lastOk.id) ? lastFailed : undefined;
    return {
      last_ok_at: lastOk?.started_at ?? null,
      last_failed_at: failedSinceOk?.started_at ?? null,
      last_error: failedSinceOk?.error ?? null,
      stale: !lastOk || msSince(lastOk.started_at) > BACKUP_STALE_HOURS * HOUR_MS,
    };
  }

  logEntries(limit = 50): BackupLogEntry[] {
    return this.dbh.db.select().from(backup_log).orderBy(desc(backup_log.id)).limit(limit).all().map(toEntry);
  }

  listFiles(): BackupFile[] {
    return readdirSync(this.config.backupsDir)
      .filter((n) => BACKUP_FILE_RE.test(n) || PRE_RESTORE_RE.test(n))
      .map((n) => {
        const st = statSync(join(this.config.backupsDir, n));
        return { file_name: n, size_bytes: st.size, modified_at: st.mtime.toISOString(), is_pre_restore: PRE_RESTORE_RE.test(n) };
      })
      .sort((a, b) => (a.modified_at < b.modified_at ? 1 : -1));
  }

  /**
   * A backup as a compressed .zip for the owner to download (e.g. to email
   * it). Only files in the backup list can be picked; each download is audited.
   */
  async zipForDownload(fileName: string, actor: AuditActor): Promise<{ zip_name: string; zip: Buffer }> {
    const file = this.listFiles().find((f) => f.file_name === fileName);
    if (!file) throw notFound('That backup is no longer in the backups folder.');
    const zip = await zipSingleFile(file.file_name, readFileSync(join(this.config.backupsDir, file.file_name)), new Date(file.modified_at));
    const zip_name = file.file_name.replace(/\.db$/, '.zip');
    writeTx(this.dbh.db, (tx) =>
      writeAudit(tx, actor, {
        action: 'download',
        entity: 'backup',
        summary: { file_name: file.file_name, size_bytes: file.size_bytes, zip_bytes: zip.length },
      }),
    );
    return { zip_name, zip };
  }

  // --- Restore ---------------------------------------------------------------

  /**
   * Restores a backup (owner+):
   *  1. validate it, 2. take a safety backup of the current database,
   *  3. swap the files and reopen the database in this process,
   *  4. write the restore event as the first new audit row of the restored database.
   * All sessions are cleared, so everyone logs in again.
   */
  async restore(fileName: string, actor: AuditActor, reason: string): Promise<{ safety_backup: string }> {
    if (basename(fileName) !== fileName) throw badRequest('Pick a backup from the list.');
    const source = join(this.config.backupsDir, fileName);
    if (!existsSync(source)) throw notFound('That backup file no longer exists.');

    const validation = validateBackupFile(source, this.config.migrationsDir);
    if (!validation.ok) throw badRequest(`This backup cannot be restored: ${validation.detail}`);

    const safety = await this.runBackup('pre_restore', actor);
    if (safety.status !== 'ok') {
      throw new AppError(500, `Restore stopped: the safety backup of the current data failed (${safety.error}). Nothing was changed.`);
    }

    const previousTail = auditTail(this.dbh.sqlite);
    const marker: RestoreMarker = {
      restored_from: fileName,
      safety_backup: safety.file_name,
      restored_audit_last_id: validation.tail.id,
      restored_audit_last_hash: validation.tail.hash,
      previous_audit_last_id: previousTail.id,
      previous_audit_last_hash: previousTail.hash,
      actor,
      reason,
      at: nowIso(),
    };
    writeFileSync(this.config.restoreMarkerFile, JSON.stringify(marker, null, 2), 'utf8');

    const dbFile = this.config.dbFile;
    const staging = `${dbFile}.restoring`;
    copyFileSync(source, staging);
    this.dbh.reopen(() => {
      for (const p of [dbFile, `${dbFile}-wal`, `${dbFile}-shm`]) if (existsSync(p)) unlinkSync(p);
      renameSync(staging, dbFile);
    });

    this.consumeRestoreMarker();
    this.reschedule();
    this.log.warn({ from: fileName, safety: safety.file_name }, 'Database restored from backup');
    return { safety_backup: safety.file_name };
  }

  /**
   * If a restore just happened (or was interrupted after the swap), writes
   * the restore event into the restored database and clears all sessions.
   */
  consumeRestoreMarker(): boolean {
    const file = this.config.restoreMarkerFile;
    if (!existsSync(file)) return false;
    const marker = JSON.parse(readFileSync(file, 'utf8')) as RestoreMarker;
    // Only record the restore once the restored data is actually in place.
    if (auditTail(this.dbh.sqlite).id !== marker.restored_audit_last_id) {
      this.log.warn({ marker }, 'Restore marker found but the database was not swapped; ignoring it');
      unlinkSync(file);
      return false;
    }
    writeTx(this.dbh.db, (tx) => {
      deleteAllSessions(tx);
      writeAudit(tx, marker.actor, {
        action: 'restore',
        entity: 'backup',
        summary: {
          restored_from: marker.restored_from,
          safety_backup: marker.safety_backup,
          restored_audit_last_id: marker.restored_audit_last_id,
          previous_audit_last_id: marker.previous_audit_last_id,
          previous_audit_last_hash: marker.previous_audit_last_hash,
          requested_at: marker.at,
        },
        reason: marker.reason,
      });
    });
    unlinkSync(file);
    return true;
  }
}

// --- Checks on backup files ----------------------------------------------------

interface CopyCheck {
  ok: boolean;
  detail: string;
  tail: { id: number | null; hash: string | null };
}

/**
 * Prepares a fresh backup copy: switches it to a single self-contained file
 * (rollback journal instead of WAL), runs PRAGMA integrity_check and reads the
 * last audit row it contains.
 */
export function checkBackupCopy(path: string): CopyCheck {
  const copy = new Database(path, { fileMustExist: true });
  try {
    copy.pragma('journal_mode = DELETE');
    const result = copy.pragma('integrity_check', { simple: true });
    if (result !== 'ok') return { ok: false, detail: String(result), tail: { id: null, hash: null } };
    return { ok: true, detail: 'ok', tail: auditTail(copy) };
  } catch (e) {
    return { ok: false, detail: errorMessage(e), tail: { id: null, hash: null } };
  } finally {
    copy.close();
  }
}

/** Checks that a file is a healthy ShopLedger database this version can open. */
export function validateBackupFile(path: string, migrationsDir: string): CopyCheck {
  const fail = (detail: string): CopyCheck => ({ ok: false, detail, tail: { id: null, hash: null } });
  let copy: Database.Database;
  try {
    copy = new Database(path, { readonly: true, fileMustExist: true });
  } catch (e) {
    return fail(`it could not be opened (${errorMessage(e)}).`);
  }
  try {
    const integrity = copy.pragma('integrity_check', { simple: true });
    if (integrity !== 'ok') return fail(`the file is damaged (${String(integrity)}).`);

    const tables = new Set(
      (copy.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map((r) => r.name),
    );
    for (const t of ['users', 'audit_log', 'settings', 'backup_log', '__drizzle_migrations']) {
      if (!tables.has(t)) return fail('it is not a ShopLedger database.');
    }

    const applied = (copy.prepare('SELECT COUNT(*) AS n FROM __drizzle_migrations').get() as { n: number }).n;
    const journal = JSON.parse(readFileSync(join(migrationsDir, 'meta/_journal.json'), 'utf8')) as { entries: unknown[] };
    if (applied > journal.entries.length) return fail('it was made by a newer version of ShopLedger. Update ShopLedger first.');

    const superusers = (copy.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'superuser'").get() as { n: number }).n;
    if (superusers !== 1) return fail('it does not contain a superuser account.');

    const audit = verifyAudit(copy);
    if (!audit.ok) return fail(`its audit log failed the integrity check (${audit.problems[0] ?? 'unknown problem'}).`);

    return { ok: true, detail: 'ok', tail: auditTail(copy) };
  } catch (e) {
    return fail(`it could not be read (${errorMessage(e)}).`);
  } finally {
    copy.close();
  }
}
