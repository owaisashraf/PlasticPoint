import type { DB } from '../db/client';
import { AppError } from './errors';

/**
 * Slows down password guessing (login and the inline owner-approval prompt).
 * After MAX_FAILURES wrong passwords for the same key within WINDOW_MS, the
 * key is locked for LOCK_MS. Kept in memory per database connection: a
 * restart clears it, which is fine for a single shop laptop. Failures are
 * still written to the audit log by the callers.
 */

export const MAX_FAILURES = 5;
export const WINDOW_MS = 15 * 60_000;
export const LOCK_MS = 5 * 60_000;

interface Entry {
  count: number;
  first: number;
  lockedUntil: number;
}

export class PasswordThrottle {
  readonly #entries = new Map<string, Entry>();

  /** Throws 429 while the key is locked. */
  assertAllowed(key: string, what: string): void {
    const e = this.#entries.get(key);
    const now = Date.now();
    if (e && e.lockedUntil > now) {
      const minutes = Math.ceil((e.lockedUntil - now) / 60_000);
      throw new AppError(429, `Too many wrong passwords for ${what}. Wait ${minutes} minute${minutes === 1 ? '' : 's'} and try again.`, 'TOO_MANY_ATTEMPTS');
    }
  }

  fail(key: string): void {
    const now = Date.now();
    const e = this.#entries.get(key);
    if (!e || now - e.first > WINDOW_MS || e.lockedUntil > 0) {
      this.#entries.set(key, { count: 1, first: now, lockedUntil: 0 });
      return;
    }
    e.count++;
    if (e.count >= MAX_FAILURES) e.lockedUntil = now + LOCK_MS;
  }

  reset(key: string): void {
    this.#entries.delete(key);
  }
}

const byDb = new WeakMap<DB, PasswordThrottle>();

export function throttleFor(db: DB): PasswordThrottle {
  let t = byDb.get(db);
  if (!t) {
    t = new PasswordThrottle();
    byDb.set(db, t);
  }
  return t;
}
