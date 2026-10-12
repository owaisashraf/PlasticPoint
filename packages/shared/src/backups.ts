import { z } from 'zod';

export const BACKUP_TRIGGERS = ['scheduled', 'startup', 'shutdown', 'manual', 'pre_restore'] as const;
export type BackupTrigger = (typeof BACKUP_TRIGGERS)[number];

/** A backup older than this many hours turns the footer red. */
export const BACKUP_STALE_HOURS = 36;

export const backupLogEntrySchema = z.object({
  id: z.number().int(),
  started_at: z.string(),
  finished_at: z.string().nullable(),
  file_name: z.string(),
  size_bytes: z.number().int().nullable(),
  trigger: z.enum(BACKUP_TRIGGERS),
  status: z.enum(['ok', 'failed']),
  error: z.string().nullable(),
  audit_last_id: z.number().int().nullable(),
  audit_last_hash: z.string().nullable(),
  second_copy_status: z.enum(['ok', 'failed', 'skipped']),
  second_copy_error: z.string().nullable(),
});
export type BackupLogEntry = z.infer<typeof backupLogEntrySchema>;

export const backupFileSchema = z.object({
  file_name: z.string(),
  size_bytes: z.number().int(),
  modified_at: z.string(),
  is_pre_restore: z.boolean(),
});
export type BackupFile = z.infer<typeof backupFileSchema>;

export const backupStatusSchema = z.object({
  last_ok_at: z.string().nullable(),
  last_failed_at: z.string().nullable(),
  last_error: z.string().nullable(),
  stale: z.boolean(),
});
export type BackupStatus = z.infer<typeof backupStatusSchema>;

export const restoreBackupSchema = z.object({
  file_name: z.string().regex(/^shopledger-[\w-]+\.db$/, 'Pick a backup from the list'),
  reason: z.string().trim().min(3, 'Enter a reason for the restore').max(300),
});
export type RestoreBackupInput = z.infer<typeof restoreBackupSchema>;

/** GET /api/backups/download?file=… — a file name from the backup list, nothing else. */
export const backupDownloadQuerySchema = z.object({
  file: z.string().regex(/^[A-Za-z0-9_.-]+\.db$/, 'Pick a backup from the list.'),
});
