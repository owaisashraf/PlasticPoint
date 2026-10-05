import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestContext, type TestContext } from '../../test/helpers';
import { writeTx } from '../db/client';
import { getOpeningBalance, partyBalance, postEntry, removeEntriesForSource, setOpeningBalance, statement } from './ledger';

let t: TestContext;
beforeEach(async () => {
  t = await createTestContext({ noUsers: true });
});
afterEach(async () => {
  await t.close();
});

const post = (e: Parameters<typeof postEntry>[1]) => writeTx(t.dbh.db, (tx) => postEntry(tx, e));
const C = { party_type: 'customer' as const, party_id: 1 };
const S = { party_type: 'supplier' as const, party_id: 1 };

describe('ledger posting', () => {
  it('customer balance = debits − credits (positive means they owe us)', () => {
    post({ ...C, date: '2026-07-01', debit_paisa: 100_000, entry_type: 'sale', source_type: 'sale', source_id: 1 });
    post({ ...C, date: '2026-07-05', credit_paisa: 30_000, entry_type: 'receipt', source_type: 'payment', source_id: 1 });
    post({ ...C, date: '2026-07-06', credit_paisa: 10_000, entry_type: 'sales_return', source_type: 'sales_return', source_id: 1 });
    expect(partyBalance(t.dbh.db, 'customer', 1)).toBe(60_000);
    expect(partyBalance(t.dbh.db, 'customer', 1, '2026-07-05')).toBe(70_000);
    expect(partyBalance(t.dbh.db, 'customer', 2)).toBe(0);
  });

  it('supplier balance = credits − debits (positive means we owe them)', () => {
    post({ ...S, date: '2026-07-01', credit_paisa: 880_000, entry_type: 'purchase', source_type: 'purchase', source_id: 1 });
    post({ ...S, date: '2026-07-10', debit_paisa: 500_000, entry_type: 'supplier_payment', source_type: 'payment', source_id: 2 });
    expect(partyBalance(t.dbh.db, 'supplier', 1)).toBe(380_000);
  });

  it('customers and suppliers with the same id are separate', () => {
    post({ ...C, date: '2026-07-01', debit_paisa: 5, entry_type: 'sale', source_type: 'sale', source_id: 1 });
    expect(partyBalance(t.dbh.db, 'supplier', 1)).toBe(0);
  });

  it('refuses entries with both sides, neither side, negatives or fractions', () => {
    const base = { ...C, date: '2026-07-01', entry_type: 'sale' as const, source_type: 'sale', source_id: 1 };
    expect(() => post({ ...base, debit_paisa: 1, credit_paisa: 1 })).toThrow(/exactly one/);
    expect(() => post({ ...base })).toThrow(/exactly one/);
    expect(() => post({ ...base, debit_paisa: -5 })).toThrow(/non-negative/);
    expect(() => post({ ...base, debit_paisa: 1.5 })).toThrow(/whole paisa/);
    // The database refuses them too.
    expect(() =>
      t.dbh.sqlite
        .prepare("INSERT INTO ledger_entries (party_type, party_id, date, debit_paisa, credit_paisa, entry_type, source_type, source_id) VALUES ('customer', 1, '2026-07-01', 5, 5, 'sale', 'sale', 1)")
        .run(),
    ).toThrow(/CHECK/);
  });

  it('removes a document\'s entries', () => {
    post({ ...C, date: '2026-07-01', debit_paisa: 100, entry_type: 'sale', source_type: 'sale', source_id: 7 });
    post({ ...C, date: '2026-07-01', debit_paisa: 200, entry_type: 'sale', source_type: 'sale', source_id: 8 });
    writeTx(t.dbh.db, (tx) => removeEntriesForSource(tx, 'sale', 7));
    expect(partyBalance(t.dbh.db, 'customer', 1)).toBe(200);
  });
});

describe('opening balances', () => {
  it('customer: positive is a debit (they owe), negative is an advance (credit); replacing keeps one entry', () => {
    writeTx(t.dbh.db, (tx) => setOpeningBalance(tx, 'customer', 1, 45_000, '2026-07-01'));
    expect(partyBalance(t.dbh.db, 'customer', 1)).toBe(45_000);
    expect(getOpeningBalance(t.dbh.db, 'customer', 1)).toEqual({ amount_paisa: 45_000, date: '2026-07-01' });

    writeTx(t.dbh.db, (tx) => setOpeningBalance(tx, 'customer', 1, -10_000, '2026-07-02'));
    expect(partyBalance(t.dbh.db, 'customer', 1)).toBe(-10_000);
    expect(getOpeningBalance(t.dbh.db, 'customer', 1)).toEqual({ amount_paisa: -10_000, date: '2026-07-02' });

    writeTx(t.dbh.db, (tx) => setOpeningBalance(tx, 'customer', 1, 0, '2026-07-02'));
    expect(partyBalance(t.dbh.db, 'customer', 1)).toBe(0);
    expect(getOpeningBalance(t.dbh.db, 'customer', 1)).toEqual({ amount_paisa: 0, date: null });
  });

  it('supplier: positive is a credit (we owe)', () => {
    writeTx(t.dbh.db, (tx) => setOpeningBalance(tx, 'supplier', 1, 250_000, '2026-07-01'));
    expect(partyBalance(t.dbh.db, 'supplier', 1)).toBe(250_000);
    const row = t.dbh.sqlite.prepare("SELECT debit_paisa, credit_paisa FROM ledger_entries WHERE party_type = 'supplier'").get();
    expect(row).toEqual({ debit_paisa: 0, credit_paisa: 250_000 });
  });
});

describe('statement', () => {
  it('brings forward the balance before the range and keeps a running balance', () => {
    writeTx(t.dbh.db, (tx) => setOpeningBalance(tx, 'customer', 1, 10_000, '2026-06-30'));
    post({ ...C, date: '2026-07-03', debit_paisa: 50_000, entry_type: 'sale', source_type: 'sale', source_id: 1 });
    post({ ...C, date: '2026-07-01', debit_paisa: 20_000, entry_type: 'sale', source_type: 'sale', source_id: 2 });
    post({ ...C, date: '2026-07-10', credit_paisa: 25_000, entry_type: 'receipt', source_type: 'payment', source_id: 1 });
    post({ ...C, date: '2026-08-01', debit_paisa: 1, entry_type: 'sale', source_type: 'sale', source_id: 3 });

    const s = statement(t.dbh.db, 'customer', 1, { from: '2026-07-01', to: '2026-07-31' });
    expect(s.opening_balance_paisa).toBe(10_000);
    expect(s.lines.map((l) => [l.date, l.balance_paisa])).toEqual([
      ['2026-07-01', 30_000],
      ['2026-07-03', 80_000],
      ['2026-07-10', 55_000],
    ]);
    expect(s.closing_balance_paisa).toBe(55_000);

    const all = statement(t.dbh.db, 'customer', 1);
    expect(all.opening_balance_paisa).toBe(0);
    expect(all.closing_balance_paisa).toBe(partyBalance(t.dbh.db, 'customer', 1));
  });
});
