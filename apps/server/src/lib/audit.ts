import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';
import { desc } from 'drizzle-orm';
import type { AuditVerifyResult } from '@shopledger/shared';
import type { DbOrTx } from '../db/client';
import { audit_log } from '../db/schema';
import { nowIso } from './dates';

/**
 * Append-only audit writer with a SHA-256 hash chain (CLAUDE.md 8.14).
 *
 *   row_hash = SHA-256(prev_hash + canonical JSON of the row's content)
 *
 * The content includes the row id, so a deleted row in the middle breaks the
 * chain. Rows deleted from the end are caught by comparing with the last id
 * and hash recorded in backup_log.
 */

export const GENESIS_HASH = '0'.repeat(64);

export interface AuditActor {
  id: number | null;
  /** 'superuser' | 'owner' | 'operator', or 'system' / 'cli' for non-user events. */
  role: string | null;
}

export const SYSTEM_ACTOR: AuditActor = { id: null, role: 'system' };

export interface AuditEntry {
  action: string;
  entity: string;
  entity_id?: number | null;
  doc_no?: string | null;
  version_before?: number | null;
  version_after?: number | null;
  before?: unknown;
  after?: unknown;
  summary?: unknown;
  flags?: string[];
  reason?: string | null;
}

/** The hashed part of an audit row (everything except prev_hash and row_hash). */
interface AuditContent {
  id: number;
  at: string;
  user_id: number | null;
  user_role: string | null;
  action: string;
  entity: string;
  entity_id: number | null;
  doc_no: string | null;
  version_before: number | null;
  version_after: number | null;
  before_json: string | null;
  after_json: string | null;
  summary_json: string | null;
  flags: string;
  reason: string | null;
}

/** JSON with object keys sorted at every level, so the same data always gives the same text. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(value).sort()) {
      const v = (value as Record<string, unknown>)[k];
      if (v !== undefined) out[k] = sortKeys(v);
    }
    return out;
  }
  return value;
}

export function computeRowHash(prevHash: string, content: AuditContent): string {
  return createHash('sha256').update(prevHash).update(canonicalJson(content)).digest('hex');
}

function contentOf(row: AuditContent): AuditContent {
  return {
    id: row.id,
    at: row.at,
    user_id: row.user_id,
    user_role: row.user_role,
    action: row.action,
    entity: row.entity,
    entity_id: row.entity_id,
    doc_no: row.doc_no,
    version_before: row.version_before,
    version_after: row.version_after,
    before_json: row.before_json,
    after_json: row.after_json,
    summary_json: row.summary_json,
    flags: row.flags,
    reason: row.reason,
  };
}

const toJson = (v: unknown): string | null => (v === undefined || v === null ? null : canonicalJson(v));

/**
 * Appends one audit row. Call it inside the same transaction as the change it
 * records, so both are saved together or not at all.
 */
export function writeAudit(tx: DbOrTx, actor: AuditActor, entry: AuditEntry): { id: number; row_hash: string } {
  const last = tx
    .select({ id: audit_log.id, row_hash: audit_log.row_hash })
    .from(audit_log)
    .orderBy(desc(audit_log.id))
    .limit(1)
    .get();

  const prevHash = last?.row_hash ?? GENESIS_HASH;
  const content: AuditContent = {
    id: (last?.id ?? 0) + 1,
    at: nowIso(),
    user_id: actor.id,
    user_role: actor.role,
    action: entry.action,
    entity: entry.entity,
    entity_id: entry.entity_id ?? null,
    doc_no: entry.doc_no ?? null,
    version_before: entry.version_before ?? null,
    version_after: entry.version_after ?? null,
    before_json: toJson(entry.before),
    after_json: toJson(entry.after),
    summary_json: toJson(entry.summary),
    flags: canonicalJson(entry.flags ?? []),
    reason: entry.reason?.trim() || null,
  };
  const rowHash = computeRowHash(prevHash, content);
  tx.insert(audit_log)
    .values({ ...content, prev_hash: prevHash, row_hash: rowHash })
    .run();
  return { id: content.id, row_hash: rowHash };
}

/** The last audit row's id and hash, read straight from a database file or connection. */
export function auditTail(sqlite: Database.Database): { id: number | null; hash: string | null } {
  const row = sqlite.prepare('SELECT id, row_hash FROM audit_log ORDER BY id DESC LIMIT 1').get() as
    | { id: number; row_hash: string }
    | undefined;
  return { id: row?.id ?? null, hash: row?.row_hash ?? null };
}

const MAX_PROBLEMS = 50;

/**
 * Checks the whole chain: ids are consecutive from 1, each row links to the
 * previous hash, each row's hash matches its content, and nothing is missing
 * from the end compared with the audit positions recorded in backup_log.
 * Works on the live database or on a backup file opened read-only.
 */
export function verifyAudit(sqlite: Database.Database): AuditVerifyResult {
  const problems: string[] = [];
  const add = (p: string) => {
    if (problems.length < MAX_PROBLEMS) problems.push(p);
  };

  let prevHash = GENESIS_HASH;
  let expectedId = 1;
  let rowsChecked = 0;
  let lastId: number | null = null;

  const rows = sqlite.prepare('SELECT * FROM audit_log ORDER BY id').iterate() as IterableIterator<
    AuditContent & { prev_hash: string; row_hash: string }
  >;
  for (const row of rows) {
    rowsChecked++;
    if (row.id !== expectedId) {
      add(`Rows ${expectedId}–${row.id - 1} are missing (the log jumps from ${expectedId - 1} to ${row.id}).`);
    }
    if (row.prev_hash !== prevHash) {
      add(`Row ${row.id} does not link to the row before it.`);
    }
    if (computeRowHash(row.prev_hash, contentOf(row)) !== row.row_hash) {
      add(`Row ${row.id} has been changed after it was written.`);
    }
    prevHash = row.row_hash;
    expectedId = row.id + 1;
    lastId = row.id;
  }

  // Truncated tail: compare against the positions recorded at each good backup.
  const hasBackupLog = sqlite
    .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'backup_log'")
    .get();
  if (hasBackupLog) {
    const marks = sqlite
      .prepare(
        `SELECT started_at, audit_last_id, audit_last_hash FROM backup_log
         WHERE status = 'ok' AND audit_last_id IS NOT NULL ORDER BY audit_last_id DESC`,
      )
      .all() as { started_at: string; audit_last_id: number; audit_last_hash: string }[];
    const hashAt = sqlite.prepare('SELECT row_hash FROM audit_log WHERE id = ?');
    for (const m of marks) {
      if (lastId === null || m.audit_last_id > lastId) {
        add(
          `Rows are missing from the end of the log: the backup taken at ${m.started_at} contained rows up to ${m.audit_last_id}, but the log now ends at ${lastId ?? 'nothing'}.`,
        );
        break;
      }
      const at = hashAt.get(m.audit_last_id) as { row_hash: string } | undefined;
      if (!at || at.row_hash !== m.audit_last_hash) {
        add(`Row ${m.audit_last_id} differs from the copy recorded by the backup taken at ${m.started_at}.`);
        break;
      }
    }
  }

  return { ok: problems.length === 0, rows_checked: rowsChecked, last_id: lastId, last_hash: lastId ? prevHash : null, problems };
}
