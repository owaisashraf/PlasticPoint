import Database from 'better-sqlite3';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import * as schema from './schema';

export type DB = BetterSQLite3Database<typeof schema>;
/** A drizzle transaction handle (synchronous for better-sqlite3). */
export type Tx = Parameters<Parameters<DB['transaction']>[0]>[0];
/** Anything that can run queries: the database or an open transaction. */
export type DbOrTx = DB | Tx;

/**
 * Runs `fn` in one write transaction (BEGIN IMMEDIATE). better-sqlite3
 * transactions are synchronous: never `await` inside `fn`.
 */
export function writeTx<T>(db: DB, fn: (tx: Tx) => T): T {
  return db.transaction(fn, { behavior: 'immediate' });
}

export interface OpenDb {
  sqlite: Database.Database;
  db: DB;
}

function applyPragmas(sqlite: Database.Database, inMemory: boolean): void {
  if (!inMemory) {
    sqlite.pragma('journal_mode = WAL');
    sqlite.pragma('synchronous = NORMAL');
  }
  sqlite.pragma('foreign_keys = ON');
  sqlite.pragma('busy_timeout = 5000');
}

/** Opens (or creates) the database file and applies all migrations. */
export function openDatabase(file: string, migrationsFolder: string): OpenDb {
  const inMemory = file === ':memory:';
  const sqlite = new Database(file);
  applyPragmas(sqlite, inMemory);
  const db = drizzle({ client: sqlite, schema });
  migrate(db, { migrationsFolder });
  return { sqlite, db };
}

/**
 * Holds the current connection. Restoring a backup swaps the database file
 * and reopens it in the same process, so everything reads the connection
 * through this holder instead of keeping its own reference.
 */
export class DbHolder {
  #current: OpenDb;

  constructor(
    readonly file: string,
    readonly migrationsFolder: string,
  ) {
    this.#current = openDatabase(file, migrationsFolder);
  }

  get db(): DB {
    return this.#current.db;
  }

  get sqlite(): Database.Database {
    return this.#current.sqlite;
  }

  close(): void {
    if (this.#current.sqlite.open) this.#current.sqlite.close();
  }

  /** Closes the connection, runs `swap` (which may replace files), then reopens. */
  reopen(swap: () => void): void {
    this.close();
    try {
      swap();
    } finally {
      this.#current = openDatabase(this.file, this.migrationsFolder);
    }
  }
}
