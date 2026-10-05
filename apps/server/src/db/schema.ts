import { sql } from 'drizzle-orm';
import { index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';

// Conventions (CLAUDE.md section 7): money columns end in _paisa (integers),
// percentages end in _bp (integers), business dates are TEXT 'YYYY-MM-DD',
// timestamps are ISO-8601 UTC TEXT.

const nowIso = sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`;

/** Key/value settings. Only values that differ from the defaults are stored. */
export const settings = sqliteTable('settings', {
  key: text().primaryKey(),
  value_json: text().notNull(),
  updated_at: text().notNull().default(nowIso),
  updated_by: integer().references(() => users.id),
});

export const users = sqliteTable(
  'users',
  {
    id: integer().primaryKey({ autoIncrement: true }),
    username: text().notNull(),
    display_name: text().notNull(),
    password_hash: text().notNull(),
    role: text({ enum: ['superuser', 'owner', 'operator'] }).notNull(),
    active: integer({ mode: 'boolean' }).notNull().default(true),
    created_by: integer(),
    created_at: text().notNull().default(nowIso),
    updated_at: text().notNull().default(nowIso),
  },
  (t) => [
    uniqueIndex('users_username_uq').on(t.username),
    // At most one superuser, enforced by the database itself.
    uniqueIndex('users_single_superuser_uq').on(t.role).where(sql`role = 'superuser'`),
  ],
);

/** Login sessions. `id` is the SHA-256 of the cookie token, never the token itself. */
export const sessions = sqliteTable(
  'sessions',
  {
    id: text().primaryKey(),
    user_id: integer()
      .notNull()
      .references(() => users.id),
    created_at: text().notNull(),
    last_seen_at: text().notNull(),
    ip: text(),
    user_agent: text(),
  },
  (t) => [index('sessions_user_idx').on(t.user_id)],
);

/**
 * Append-only audit log (CLAUDE.md 8.14). A migration adds triggers that abort
 * any UPDATE or DELETE. user_id is not a foreign key on purpose: the log must
 * stay writable even when the acting user does not exist in this database
 * (failed logins, CLI resets, restores).
 */
export const audit_log = sqliteTable(
  'audit_log',
  {
    id: integer().primaryKey({ autoIncrement: true }),
    at: text().notNull(),
    user_id: integer(),
    user_role: text(),
    action: text().notNull(),
    entity: text().notNull(),
    entity_id: integer(),
    doc_no: text(),
    version_before: integer(),
    version_after: integer(),
    before_json: text(),
    after_json: text(),
    summary_json: text(),
    flags: text().notNull().default('[]'),
    reason: text(),
    prev_hash: text().notNull(),
    row_hash: text().notNull(),
  },
  (t) => [
    index('audit_log_entity_idx').on(t.entity, t.entity_id),
    index('audit_log_at_idx').on(t.at),
    index('audit_log_user_idx').on(t.user_id),
    uniqueIndex('audit_log_row_hash_uq').on(t.row_hash),
  ],
);

/** Superuser review marks, kept apart so the audit log itself never changes. */
export const audit_reviews = sqliteTable(
  'audit_reviews',
  {
    id: integer().primaryKey({ autoIncrement: true }),
    audit_id: integer()
      .notNull()
      .references(() => audit_log.id),
    reviewed_by: integer()
      .notNull()
      .references(() => users.id),
    reviewed_at: text().notNull(),
    note: text(),
  },
  (t) => [index('audit_reviews_audit_idx').on(t.audit_id)],
);

export const backup_log = sqliteTable(
  'backup_log',
  {
    id: integer().primaryKey({ autoIncrement: true }),
    started_at: text().notNull(),
    finished_at: text(),
    /** File name only (inside DATA_DIR/backups), so the data folder stays portable. */
    file_name: text().notNull(),
    size_bytes: integer(),
    trigger: text({ enum: ['scheduled', 'startup', 'shutdown', 'manual', 'pre_restore'] }).notNull(),
    status: text({ enum: ['ok', 'failed'] }).notNull(),
    error: text(),
    /** Last audit row contained in the backup, to detect a truncated audit tail. */
    audit_last_id: integer(),
    audit_last_hash: text(),
    second_copy_status: text({ enum: ['ok', 'failed', 'skipped'] })
      .notNull()
      .default('skipped'),
    second_copy_error: text(),
  },
  (t) => [index('backup_log_started_idx').on(t.started_at)],
);
