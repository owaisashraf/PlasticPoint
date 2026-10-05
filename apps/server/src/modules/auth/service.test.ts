import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTestContext, TEST_PASSWORD, type TestContext } from '../../../test/helpers';

let t: TestContext;
afterEach(async () => {
  vi.useRealTimers();
  await t.close();
});

function lastAudit(): { action: string; entity: string; user_id: number | null; summary_json: string | null } {
  return t.dbh.sqlite.prepare('SELECT * FROM audit_log ORDER BY id DESC LIMIT 1').get() as never;
}

const account = { username: 'boss', display_name: 'Boss', password: 'long-password-1' };

describe('first-run setup', () => {
  it('creates the superuser first, then the owner, then refuses', async () => {
    t = await createTestContext({ noUsers: true });
    const { app } = t;

    expect((await app.inject({ method: 'GET', url: '/api/setup/status' })).json()).toEqual({ needs: 'superuser' });

    // The owner step needs the superuser's session.
    const early = await app.inject({ method: 'POST', url: '/api/setup/owner', payload: account });
    expect(early.statusCode).toBe(401);

    const su = await app.inject({ method: 'POST', url: '/api/setup/superuser', payload: { ...account, username: 'root' } });
    expect(su.statusCode).toBe(200);
    expect(su.json().user.role).toBe('superuser');
    const cookie = `sl_session=${su.cookies.find((c) => c.name === 'sl_session')?.value}`;

    expect((await app.inject({ method: 'GET', url: '/api/setup/status' })).json()).toEqual({ needs: 'owner' });

    // A second superuser can never be created.
    const again = await app.inject({ method: 'POST', url: '/api/setup/superuser', payload: { ...account, username: 'root2' } });
    expect(again.statusCode).toBe(409);

    const owner = await app.inject({ method: 'POST', url: '/api/setup/owner', headers: { cookie }, payload: account });
    expect(owner.statusCode).toBe(200);
    expect(owner.json().user.role).toBe('owner');
    expect((await app.inject({ method: 'GET', url: '/api/setup/status' })).json()).toEqual({ needs: null });

    const owner2 = await app.inject({
      method: 'POST',
      url: '/api/setup/owner',
      headers: { cookie },
      payload: { ...account, username: 'boss2' },
    });
    expect(owner2.statusCode).toBe(409);

    // Exactly one audit row per account created.
    const creates = t.dbh.sqlite.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'create' AND entity = 'user'").get() as {
      n: number;
    };
    expect(creates.n).toBe(2);
  });

  it('the database itself refuses a second superuser', async () => {
    t = await createTestContext();
    expect(() =>
      t.dbh.sqlite
        .prepare("INSERT INTO users (username, display_name, password_hash, role) VALUES ('x', 'x', 'x', 'superuser')")
        .run(),
    ).toThrow(/UNIQUE/);
  });
});

describe('login and logout', () => {
  it('logs in, records the login, and returns the user with permissions', async () => {
    t = await createTestContext();
    const before = t.auditCount();
    const login = await t.app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'operator', password: TEST_PASSWORD } });
    expect(login.statusCode).toBe(200);
    const cookie = `sl_session=${login.cookies.find((c) => c.name === 'sl_session')?.value}`;
    expect(t.auditCount()).toBe(before + 1);
    expect(lastAudit()).toMatchObject({ action: 'login', entity: 'session', user_id: t.users.operator.id });

    const me = await t.app.inject({ method: 'GET', url: '/api/me', headers: { cookie } });
    expect(me.statusCode).toBe(200);
    expect(me.json().user.username).toBe('operator');
    expect(me.json().permissions).toContain('sales.create');
    expect(me.json().permissions).not.toContain('finance.view');
    expect(me.json().user.password_hash).toBeUndefined();
  });

  it('records failed logins for wrong passwords and unknown users', async () => {
    t = await createTestContext();
    const wrong = await t.app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'owner', password: 'nope-nope' } });
    expect(wrong.statusCode).toBe(401);
    expect(wrong.json().error).toBe('Wrong username or password.');
    expect(lastAudit()).toMatchObject({ action: 'login_failed', user_id: t.users.owner.id });

    const unknown = await t.app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'ghost', password: 'nope-nope' } });
    expect(unknown.statusCode).toBe(401);
    expect(unknown.json().error).toBe('Wrong username or password.');
    expect(lastAudit()).toMatchObject({ action: 'login_failed', user_id: null });
    expect(JSON.parse(lastAudit().summary_json ?? '{}')).toMatchObject({ username: 'ghost', reason: 'unknown_user' });
  });

  it('logout ends the session and is audited', async () => {
    t = await createTestContext();
    const cookie = await t.cookie('owner');
    const out = await t.app.inject({ method: 'POST', url: '/api/auth/logout', headers: { cookie } });
    expect(out.statusCode).toBe(200);
    expect(lastAudit()).toMatchObject({ action: 'logout' });
    expect((await t.app.inject({ method: 'GET', url: '/api/me', headers: { cookie } })).statusCode).toBe(401);
  });

  it('rejects a tampered cookie', async () => {
    t = await createTestContext();
    const cookie = await t.cookie('owner');
    const res = await t.app.inject({ method: 'GET', url: '/api/me', headers: { cookie: cookie.slice(0, -2) + 'xx' } });
    expect(res.statusCode).toBe(401);
  });

  it('sessions expire after 12 hours idle, and activity keeps them alive', async () => {
    t = await createTestContext();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-05T04:00:00Z'));
    const cookie = await t.cookie('operator');
    const me = () => t.app.inject({ method: 'GET', url: '/api/me', headers: { cookie } });

    vi.setSystemTime(new Date('2026-10-05T15:00:00Z')); // 11h idle
    expect((await me()).statusCode).toBe(200);
    vi.setSystemTime(new Date('2026-10-06T02:59:00Z')); // 11h59m after last activity
    expect((await me()).statusCode).toBe(200);
    vi.setSystemTime(new Date('2026-10-06T15:00:00Z')); // >12h idle
    expect((await me()).statusCode).toBe(401);
  });

  it('a deactivated user cannot log in and their session stops working', async () => {
    t = await createTestContext();
    const opCookie = await t.cookie('operator');
    const ownerCookie = await t.cookie('owner');
    const res = await t.app.inject({
      method: 'PATCH',
      url: `/api/users/${t.users.operator.id}`,
      headers: { cookie: ownerCookie },
      payload: { active: false, reason: 'left the shop' },
    });
    expect(res.statusCode).toBe(200);
    expect((await t.app.inject({ method: 'GET', url: '/api/me', headers: { cookie: opCookie } })).statusCode).toBe(401);
    const login = await t.app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'operator', password: TEST_PASSWORD } });
    expect(login.statusCode).toBe(401);
    expect(login.json().error).toMatch(/deactivated/);
  });
});

describe('changing your own password', () => {
  it('needs the current password and logs out other sessions', async () => {
    t = await createTestContext();
    const first = await t.cookie('owner');
    const second = await t.app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'owner', password: TEST_PASSWORD } });
    const otherCookie = `sl_session=${second.cookies.find((c) => c.name === 'sl_session')?.value}`;

    const bad = await t.app.inject({
      method: 'POST',
      url: '/api/me/password',
      headers: { cookie: first },
      payload: { current_password: 'wrong-one', new_password: 'new-password-9' },
    });
    expect(bad.statusCode).toBe(400);

    const ok = await t.app.inject({
      method: 'POST',
      url: '/api/me/password',
      headers: { cookie: first },
      payload: { current_password: TEST_PASSWORD, new_password: 'new-password-9' },
    });
    expect(ok.statusCode).toBe(200);
    expect(lastAudit()).toMatchObject({ action: 'password_change' });
    expect((await t.app.inject({ method: 'GET', url: '/api/me', headers: { cookie: first } })).statusCode).toBe(200);
    expect((await t.app.inject({ method: 'GET', url: '/api/me', headers: { cookie: otherCookie } })).statusCode).toBe(401);
  });
});
