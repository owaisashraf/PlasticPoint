import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestContext, type TestContext } from '../../test/helpers';
import { writeTx } from '../db/client';
import { updateSettings } from '../modules/settings/service';
import { nextCustomerCode, nextDocNo, nextSequence } from './numbering';

let t: TestContext;
beforeEach(async () => {
  t = await createTestContext({ noUsers: true });
});
afterEach(async () => {
  await t.close();
});

describe('numbering', () => {
  it('formats document numbers with the prefix from settings', () => {
    expect(writeTx(t.dbh.db, (tx) => nextDocNo(tx, 'sale'))).toBe('INV-000001');
    expect(writeTx(t.dbh.db, (tx) => nextDocNo(tx, 'sale'))).toBe('INV-000002');
    expect(writeTx(t.dbh.db, (tx) => nextDocNo(tx, 'purchase'))).toBe('PUR-000001');
    expect(writeTx(t.dbh.db, (tx) => nextCustomerCode(tx))).toBe('C-0001');
  });

  it('has no gaps after a failed transaction', () => {
    writeTx(t.dbh.db, (tx) => nextDocNo(tx, 'sale'));
    expect(() =>
      writeTx(t.dbh.db, (tx) => {
        nextDocNo(tx, 'sale');
        throw new Error('posting failed');
      }),
    ).toThrow('posting failed');
    expect(writeTx(t.dbh.db, (tx) => nextDocNo(tx, 'sale'))).toBe('INV-000002');
  });

  it('never reuses a number, and continues when the prefix changes', () => {
    const seen = new Set<number>();
    for (let i = 0; i < 50; i++) seen.add(writeTx(t.dbh.db, (tx) => nextSequence(tx, 'doc:sale')));
    expect(seen.size).toBe(50);
    updateSettings(t.dbh.db, { id: null, role: 'system' }, { prefix_sale: 'SI' });
    expect(writeTx(t.dbh.db, (tx) => nextDocNo(tx, 'sale'))).toBe('SI-000051');
  });
});
