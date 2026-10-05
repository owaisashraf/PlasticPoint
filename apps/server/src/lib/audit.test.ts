import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestContext, type TestContext } from '../../test/helpers';
import { writeTx } from '../db/client';
import { backup_log } from '../db/schema';
import { canonicalJson, GENESIS_HASH, verifyAudit, writeAudit } from './audit';

let t: TestContext;

beforeEach(async () => {
  t = await createTestContext({ noUsers: true });
});
afterEach(async () => {
  await t.close();
});

function write(n: number) {
  for (let i = 0; i < n; i++) {
    writeTx(t.dbh.db, (tx) =>
      writeAudit(tx, { id: 1, role: 'owner' }, {
        action: 'update',
        entity: 'settings',
        before: { grace_days: i },
        after: { grace_days: i + 1 },
        reason: `change ${i}`,
      }),
    );
  }
}

/** Simulates someone editing the database file directly with an SQLite tool. */
function dropTriggers() {
  t.dbh.sqlite.exec('DROP TRIGGER audit_log_no_update; DROP TRIGGER audit_log_no_delete;');
}

describe('canonicalJson', () => {
  it('sorts keys at every level and drops undefined', () => {
    expect(canonicalJson({ b: 1, a: { d: [{ z: 1, y: 2 }], c: undefined } })).toBe('{"a":{"d":[{"y":2,"z":1}]},"b":1}');
  });
});

describe('writeAudit', () => {
  it('chains rows from the genesis hash with consecutive ids', () => {
    write(3);
    const rows = t.dbh.sqlite.prepare('SELECT id, prev_hash, row_hash FROM audit_log ORDER BY id').all() as {
      id: number;
      prev_hash: string;
      row_hash: string;
    }[];
    expect(rows.map((r) => r.id)).toEqual([1, 2, 3]);
    expect(rows[0]?.prev_hash).toBe(GENESIS_HASH);
    expect(rows[1]?.prev_hash).toBe(rows[0]?.row_hash);
    expect(rows[2]?.prev_hash).toBe(rows[1]?.row_hash);
    expect(new Set(rows.map((r) => r.row_hash)).size).toBe(3);
  });

  it('is rolled back together with a failed transaction', () => {
    write(1);
    expect(() =>
      writeTx(t.dbh.db, (tx) => {
        writeAudit(tx, { id: 1, role: 'owner' }, { action: 'create', entity: 'test' });
        throw new Error('posting failed');
      }),
    ).toThrow('posting failed');
    expect(t.auditCount()).toBe(1);
    write(1);
    expect(verifyAudit(t.dbh.sqlite).ok).toBe(true);
  });
});

describe('append-only triggers', () => {
  it('reject UPDATE of an audit row', () => {
    write(1);
    expect(() => t.dbh.sqlite.prepare("UPDATE audit_log SET reason = 'x' WHERE id = 1").run()).toThrow(/append-only/);
  });

  it('reject DELETE of an audit row', () => {
    write(1);
    expect(() => t.dbh.sqlite.prepare('DELETE FROM audit_log WHERE id = 1').run()).toThrow(/append-only/);
    expect(() => t.dbh.sqlite.prepare('DELETE FROM audit_log').run()).toThrow(/append-only/);
    expect(t.auditCount()).toBe(1);
  });
});

describe('verifyAudit', () => {
  it('passes on an untouched chain', () => {
    write(5);
    const r = verifyAudit(t.dbh.sqlite);
    expect(r).toMatchObject({ ok: true, rows_checked: 5, last_id: 5, problems: [] });
  });

  it('passes on an empty log', () => {
    expect(verifyAudit(t.dbh.sqlite)).toMatchObject({ ok: true, rows_checked: 0, last_id: null });
  });

  it('detects a changed row', () => {
    write(4);
    dropTriggers();
    t.dbh.sqlite.prepare("UPDATE audit_log SET reason = 'nothing to see' WHERE id = 2").run();
    const r = verifyAudit(t.dbh.sqlite);
    expect(r.ok).toBe(false);
    expect(r.problems.join(' ')).toMatch(/Row 2 has been changed/);
  });

  it('detects a changed row even if its hash was recomputed (the next row no longer links)', () => {
    write(3);
    dropTriggers();
    t.dbh.sqlite.prepare(`UPDATE audit_log SET row_hash = '${'e'.repeat(64)}' WHERE id = 2`).run();
    const r = verifyAudit(t.dbh.sqlite);
    expect(r.ok).toBe(false);
    expect(r.problems.join(' ')).toMatch(/Row 3 does not link/);
  });

  it('detects a deleted row in the middle', () => {
    write(5);
    dropTriggers();
    t.dbh.sqlite.prepare('DELETE FROM audit_log WHERE id = 3').run();
    const r = verifyAudit(t.dbh.sqlite);
    expect(r.ok).toBe(false);
    expect(r.problems.join(' ')).toMatch(/missing/);
  });

  it('detects rows deleted from the end using the position recorded by a backup', () => {
    write(5);
    const tail = t.dbh.sqlite.prepare('SELECT id, row_hash FROM audit_log ORDER BY id DESC LIMIT 1').get() as {
      id: number;
      row_hash: string;
    };
    t.dbh.db
      .insert(backup_log)
      .values({
        started_at: new Date().toISOString(),
        file_name: 'shopledger-2026-10-05_2100.db',
        trigger: 'scheduled',
        status: 'ok',
        audit_last_id: tail.id,
        audit_last_hash: tail.row_hash,
      })
      .run();
    expect(verifyAudit(t.dbh.sqlite).ok).toBe(true);

    dropTriggers();
    t.dbh.sqlite.prepare('DELETE FROM audit_log WHERE id >= 4').run();
    const r = verifyAudit(t.dbh.sqlite);
    expect(r.ok).toBe(false);
    expect(r.problems.join(' ')).toMatch(/missing from the end/);
  });

  it('detects a rewritten chain that no longer matches a backup position', () => {
    write(3);
    t.dbh.db
      .insert(backup_log)
      .values({
        started_at: new Date().toISOString(),
        file_name: 'shopledger-2026-10-05_2100.db',
        trigger: 'scheduled',
        status: 'ok',
        audit_last_id: 3,
        audit_last_hash: 'a'.repeat(64),
      })
      .run();
    const r = verifyAudit(t.dbh.sqlite);
    expect(r.ok).toBe(false);
    expect(r.problems.join(' ')).toMatch(/Row 3 differs/);
  });
});
