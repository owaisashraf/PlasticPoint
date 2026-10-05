import { createHash, randomBytes } from 'node:crypto';
import { and, eq, lt, ne } from 'drizzle-orm';
import type { Role } from '@shopledger/shared';
import type { DB, DbOrTx } from '../../db/client';
import { sessions, users } from '../../db/schema';
import { HOUR_MS, msSince, nowIso } from '../../lib/dates';

export const SESSION_COOKIE = 'sl_session';
/** Sessions expire after this long without a request. */
export const SESSION_IDLE_MS = 12 * HOUR_MS;
/** last_seen_at is written at most this often, to spare a slow disk. */
const TOUCH_INTERVAL_MS = 60 * 1000;

/** The database stores only this hash; the raw token lives in the browser cookie. */
export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function createSession(tx: DbOrTx, userId: number, meta: { ip?: string; userAgent?: string } = {}): string {
  const token = randomBytes(32).toString('base64url');
  const now = nowIso();
  tx.insert(sessions)
    .values({
      id: hashToken(token),
      user_id: userId,
      created_at: now,
      last_seen_at: now,
      ip: meta.ip ?? null,
      user_agent: meta.userAgent?.slice(0, 300) ?? null,
    })
    .run();
  return token;
}

export interface SessionLookup {
  id: number;
  username: string;
  display_name: string;
  role: Role;
  active: boolean;
  created_at: string;
  updated_at: string;
}

/** The user behind a session token, or null if it is unknown, idle-expired or the user is inactive. */
export function resolveSession(db: DB, token: string): SessionLookup | null {
  const id = hashToken(token);
  const row = db
    .select({ session: sessions, user: users })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.user_id))
    .where(eq(sessions.id, id))
    .get();
  if (!row) return null;
  if (msSince(row.session.last_seen_at) > SESSION_IDLE_MS || !row.user.active) {
    db.delete(sessions).where(eq(sessions.id, id)).run();
    return null;
  }
  if (msSince(row.session.last_seen_at) > TOUCH_INTERVAL_MS) {
    db.update(sessions).set({ last_seen_at: nowIso() }).where(eq(sessions.id, id)).run();
  }
  const u = row.user;
  return {
    id: u.id,
    username: u.username,
    display_name: u.display_name,
    role: u.role,
    active: u.active,
    created_at: u.created_at,
    updated_at: u.updated_at,
  };
}

export function deleteSession(db: DbOrTx, token: string): void {
  db.delete(sessions).where(eq(sessions.id, hashToken(token))).run();
}

/** Logs a user out everywhere, optionally keeping the session behind `exceptToken`. */
export function deleteUserSessions(tx: DbOrTx, userId: number, exceptToken: string | null = null): void {
  const where = exceptToken
    ? and(eq(sessions.user_id, userId), ne(sessions.id, hashToken(exceptToken)))
    : eq(sessions.user_id, userId);
  tx.delete(sessions).where(where).run();
}

export function deleteAllSessions(db: DbOrTx): void {
  db.delete(sessions).run();
}

/** Removes sessions idle for longer than the limit. */
export function purgeExpiredSessions(db: DbOrTx): void {
  const cutoff = new Date(Date.now() - SESSION_IDLE_MS).toISOString();
  db.delete(sessions).where(lt(sessions.last_seen_at, cutoff)).run();
}
