import { and, eq, inArray } from 'drizzle-orm';
import { can, type PermissionKey } from '@shopledger/shared';
import type { DB, DbOrTx, Tx } from '../db/client';
import { audit_log } from '../db/schema';
import { businessToday, toBusinessDate } from './dates';
import { badRequest, forbidden } from './errors';
import type { SessionUser } from './permissions';

/**
 * Editing and voiding documents (CLAUDE.md 8.6). Documents are never
 * deleted: they are edited (version + 1) or voided (status 'void'), always
 * with a reason and one audit row holding the before and after snapshots.
 *
 *   Operators: their own documents, on the day they entered them (edit only).
 *   Owner and superuser: any document, edit or void.
 */

export interface ChangeableDoc {
  doc_no: string;
  status: string;
  created_by: number | null;
  created_at: string;
}

/** Throws unless `user` may edit this document. `createKey` is the right to make this kind of document. */
export function assertCanEdit(user: SessionUser, doc: ChangeableDoc, createKey: PermissionKey): void {
  if (doc.status !== 'posted') throw badRequest(`${doc.doc_no} is ${doc.status} and cannot be changed.`);
  if (can(user, 'documents.edit_any')) return;
  const ownToday = doc.created_by === user.id && toBusinessDate(new Date(doc.created_at)) === businessToday();
  if (!can(user, createKey) || !can(user, 'documents.edit_own_same_day') || !ownToday) {
    throw forbidden('You can only change documents you entered yourself, on the same day. Ask the owner to change this one.');
  }
}

/** Throws unless `user` may void this document (owner and superuser only). */
export function assertCanVoid(user: SessionUser, doc: ChangeableDoc): void {
  if (doc.status !== 'posted') throw badRequest(`${doc.doc_no} is already ${doc.status}.`);
  if (!can(user, 'documents.edit_any')) throw forbidden('Only the owner can void documents.');
}

/**
 * Flags every edit or void gets automatically (CLAUDE.md 8.14):
 * edited after it was printed or shared, edited on a later day than it was
 * entered, and made by an operator.
 */
export function changeFlags(db: DbOrTx, user: SessionUser, entity: string, entityId: number, createdAt: string): string[] {
  const done = new Set(
    db
      .select({ action: audit_log.action })
      .from(audit_log)
      .where(and(eq(audit_log.entity, entity), eq(audit_log.entity_id, entityId), inArray(audit_log.action, ['print', 'share'])))
      .all()
      .map((r) => r.action),
  );
  return [
    ...(done.has('share') ? ['edited_after_shared'] : []),
    ...(done.has('print') ? ['edited_after_printed'] : []),
    ...(businessToday() > toBusinessDate(new Date(createdAt)) ? ['edited_later_day'] : []),
    ...(user.role === 'operator' ? ['by_operator'] : []),
  ];
}

/** total_reduced / total_increased from two totals. */
export function totalFlags(before: number, after: number): string[] {
  if (after < before) return ['total_reduced'];
  if (after > before) return ['total_increased'];
  return [];
}

/** Puts flags in a stable order without duplicates. */
export function uniqueFlags(...lists: string[][]): string[] {
  return [...new Set(lists.flat())];
}

// --- Diffs (for the audit summary and the Change History screen) ---------------------

export interface LineDiff {
  added: Record<string, unknown>[];
  removed: Record<string, unknown>[];
  changed: { key: string; label: string; fields: Record<string, [unknown, unknown]> }[];
}

export interface DocDiff {
  /** Header fields that changed: field → [before, after]. */
  fields: Record<string, [unknown, unknown]>;
  lines: LineDiff;
}

const IGNORED = new Set(['version', 'updated_at', 'updated_by', 'lines', 'created_at', 'created_by', 'id']);

/**
 * Compares two document snapshots: header fields, and lines matched by
 * `lineKey` (for example the variant). Only plain values are compared.
 */
export function diffSnapshots(
  before: Record<string, unknown> | null,
  after: Record<string, unknown> | null,
  lineKey: (l: Record<string, unknown>) => string,
  lineLabel: (l: Record<string, unknown>) => string,
): DocDiff {
  const fields: Record<string, [unknown, unknown]> = {};
  if (before && after) {
    for (const k of new Set([...Object.keys(before), ...Object.keys(after)])) {
      if (IGNORED.has(k)) continue;
      const a = before[k];
      const b = after[k];
      if ((a === null || typeof a !== 'object') && (b === null || typeof b !== 'object') && a !== b) fields[k] = [a ?? null, b ?? null];
    }
  }
  const linesOf = (s: Record<string, unknown> | null) => (Array.isArray(s?.lines) ? (s.lines as Record<string, unknown>[]) : []);
  const bl = new Map(linesOf(before).map((l) => [lineKey(l), l]));
  const al = new Map(linesOf(after).map((l) => [lineKey(l), l]));
  const lines: LineDiff = { added: [], removed: [], changed: [] };
  if (before && after) {
    for (const [k, l] of al) if (!bl.has(k)) lines.added.push(l);
    for (const [k, l] of bl) if (!al.has(k)) lines.removed.push(l);
    for (const [k, b] of al) {
      const a = bl.get(k);
      if (!a) continue;
      const f: Record<string, [unknown, unknown]> = {};
      for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
        if (key === 'id' || key === 'line_no') continue;
        if (a[key] !== b[key] && (a[key] === null || typeof a[key] !== 'object')) f[key] = [a[key] ?? null, b[key] ?? null];
      }
      if (Object.keys(f).length) lines.changed.push({ key: k, label: lineLabel(b), fields: f });
    }
  }
  return { fields, lines };
}

/** Compact summary of a diff for summary_json. */
export function diffSummary(d: DocDiff): { changed_fields: string[]; lines_added: number; lines_removed: number; lines_changed: number } {
  return { changed_fields: Object.keys(d.fields), lines_added: d.lines.added.length, lines_removed: d.lines.removed.length, lines_changed: d.lines.changed.length };
}

// --- Dry runs (live checks while editing) -----------------------------------------------

class DryRunResult<T> extends Error {
  constructor(readonly value: T) {
    super('dry run');
  }
}

/** Runs `fn` in a transaction that is always rolled back, and returns its result. */
export function dryRun<T>(db: DB, fn: (tx: Tx) => T): T {
  try {
    db.transaction((tx) => {
      throw new DryRunResult(fn(tx));
    });
  } catch (e) {
    if (e instanceof DryRunResult) return e.value as T;
    throw e;
  }
  throw new Error('unreachable');
}
