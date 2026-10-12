import { afterEach, describe, expect, it } from 'vitest';
import { createTestContext, type TestContext } from '../../test/helpers';
import { verifyAudit } from '../lib/audit';
import { installSimClock, type SimClock } from './clock';
import { seedDemo } from './simulate';

let t: TestContext;
let clock: SimClock | null = null;
afterEach(async () => {
  clock?.restore();
  clock = null;
  await t.close();
});

describe('demo seed', () => {
  it('plays a month of shop life through the API with every rule satisfied and the audit chain intact', async () => {
    t = await createTestContext({ noUsers: true });
    clock = installSimClock();
    const summary = await seedDemo(t.app, t.dbh, clock, { months: 1, businessName: 'Demo Test', password: 'demo1234', log: () => {} });
    clock.restore();
    clock = null;

    expect(summary.skipped).toEqual([]);
    expect(summary.counts.customers).toBe(30);
    expect(summary.counts.products).toBe(60);
    expect(summary.counts.sales).toBeGreaterThan(50);
    expect(summary.counts.receipts).toBeGreaterThan(5);
    expect(verifyAudit(t.dbh.sqlite).ok).toBe(true);

    const q = <T>(s: string) => t.dbh.sqlite.prepare(s).get() as T;
    // Documents are dated across the month, not all today.
    expect(q<{ n: number }>('SELECT count(DISTINCT date) AS n FROM sales').n).toBeGreaterThan(15);
    // Old opening balances make some customers overdue straight away.
    expect(q<{ n: number }>("SELECT count(*) AS n FROM ledger_entries WHERE entry_type = 'opening_balance'").n).toBeGreaterThan(3);
    expect(q<{ v: string }>("SELECT value_json AS v FROM settings WHERE key = 'business_name'").v).toBe('"Demo Test"');
    // Every login works with the demo password; no session is left behind.
    expect(q<{ n: number }>('SELECT count(*) AS n FROM sessions').n).toBe(0);
    const login = await t.app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'owner', password: 'demo1234' } });
    expect(login.statusCode).toBe(200);
  }, 120_000);
});
