import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Role } from '@shopledger/shared';
import { createTestContext, type TestContext } from '../../../test/helpers';

let t: TestContext;
beforeEach(async () => {
  t = await createTestContext();
});
afterEach(async () => {
  await t.close();
});

async function call(role: Role, method: 'GET' | 'POST' | 'PATCH', url: string, payload?: object) {
  return t.app.inject({ method, url, headers: { cookie: await t.cookie(role) }, ...(payload ? { payload } : {}) });
}

const newUser = (role: 'owner' | 'operator', username = `new-${role}`) => ({
  username,
  display_name: username,
  role,
  password: 'long-password-1',
});

describe('who manages whom', () => {
  it('owner creates operators but not owners', async () => {
    const before = t.auditCount();
    expect((await call('owner', 'POST', '/api/users', newUser('operator'))).statusCode).toBe(200);
    expect(t.auditCount()).toBe(before + 1);
    expect((await call('owner', 'POST', '/api/users', newUser('owner'))).statusCode).toBe(403);
    expect(t.auditCount()).toBe(before + 1);
  });

  it('superuser creates owners and operators', async () => {
    expect((await call('superuser', 'POST', '/api/users', newUser('owner'))).statusCode).toBe(200);
    expect((await call('superuser', 'POST', '/api/users', newUser('operator'))).statusCode).toBe(200);
  });

  it('nobody can create a superuser through user management', async () => {
    const res = await call('superuser', 'POST', '/api/users', { ...newUser('operator'), role: 'superuser' });
    expect(res.statusCode).toBe(400);
  });

  it('operators cannot use user management at all', async () => {
    expect((await call('operator', 'GET', '/api/users')).statusCode).toBe(403);
    expect((await call('operator', 'POST', '/api/users', newUser('operator'))).statusCode).toBe(403);
  });

  it('owner cannot change another owner or promote an operator to owner', async () => {
    const other = (await call('superuser', 'POST', '/api/users', newUser('owner', 'owner2'))).json().user;
    expect((await call('owner', 'PATCH', `/api/users/${other.id}`, { display_name: 'X' })).statusCode).toBe(403);
    expect((await call('owner', 'POST', `/api/users/${other.id}/password`, { password: 'long-password-2' })).statusCode).toBe(403);
    expect((await call('owner', 'PATCH', `/api/users/${t.users.operator.id}`, { role: 'owner' })).statusCode).toBe(403);
  });

  it('owner edits, deactivates and resets operators, each with one audit row', async () => {
    const id = t.users.operator.id;
    let n = t.auditCount();
    expect((await call('owner', 'PATCH', `/api/users/${id}`, { display_name: 'Ali' })).statusCode).toBe(200);
    expect(t.auditCount()).toBe(++n);
    expect((await call('owner', 'POST', `/api/users/${id}/password`, { password: 'long-password-2' })).statusCode).toBe(200);
    expect(t.auditCount()).toBe(++n);
    expect((await call('owner', 'PATCH', `/api/users/${id}`, { active: false })).statusCode).toBe(200);
    expect(t.auditCount()).toBe(n + 1);
    const row = t.dbh.sqlite.prepare('SELECT action, before_json, after_json FROM audit_log ORDER BY id DESC LIMIT 1').get() as {
      action: string;
      before_json: string;
      after_json: string;
    };
    expect(row.action).toBe('deactivate');
    expect(row.after_json).not.toMatch(/password/);
  });

  it('superuser changes an operator into an owner', async () => {
    const res = await call('superuser', 'PATCH', `/api/users/${t.users.operator.id}`, { role: 'owner' });
    expect(res.statusCode).toBe(200);
    expect(res.json().user.role).toBe('owner');
  });

  it('nobody can deactivate themselves', async () => {
    expect((await call('owner', 'PATCH', `/api/users/${t.users.owner.id}`, { active: false })).statusCode).toBe(400);
  });

  it('there is no way to delete a user', async () => {
    const res = await t.app.inject({
      method: 'DELETE',
      url: `/api/users/${t.users.operator.id}`,
      headers: { cookie: await t.cookie('superuser') },
    });
    expect(res.statusCode).toBe(404);
  });
});

describe('superuser protections', () => {
  it('owners do not see the superuser in the user list', async () => {
    const list = (await call('owner', 'GET', '/api/users')).json().users as { role: string }[];
    expect(list.some((u) => u.role === 'superuser')).toBe(false);
    const suList = (await call('superuser', 'GET', '/api/users')).json().users as { role: string }[];
    expect(suList.some((u) => u.role === 'superuser')).toBe(true);
  });

  it('owners get "not found" when they try to edit, deactivate or reset the superuser', async () => {
    const id = t.users.superuser.id;
    const before = t.auditCount();
    expect((await call('owner', 'PATCH', `/api/users/${id}`, { display_name: 'Hacked' })).statusCode).toBe(404);
    expect((await call('owner', 'PATCH', `/api/users/${id}`, { active: false })).statusCode).toBe(404);
    expect((await call('owner', 'PATCH', `/api/users/${id}`, { role: 'operator' })).statusCode).toBe(404);
    expect((await call('owner', 'POST', `/api/users/${id}/password`, { password: 'long-password-2' })).statusCode).toBe(404);
    expect(t.auditCount()).toBe(before);
  });

  it('the superuser cannot be deactivated or demoted, even by itself', async () => {
    const id = t.users.superuser.id;
    expect((await call('superuser', 'PATCH', `/api/users/${id}`, { active: false })).statusCode).toBe(403);
    expect((await call('superuser', 'PATCH', `/api/users/${id}`, { role: 'owner' })).statusCode).toBe(403);
    // Renaming itself is fine.
    expect((await call('superuser', 'PATCH', `/api/users/${id}`, { display_name: 'Main admin' })).statusCode).toBe(200);
  });

  it('the superuser password cannot be reset through user management', async () => {
    const res = await call('superuser', 'POST', `/api/users/${t.users.superuser.id}/password`, { password: 'long-password-2' });
    expect(res.statusCode).toBe(403);
  });

  it('there is exactly one superuser', async () => {
    const n = t.dbh.sqlite.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'superuser'").get() as { n: number };
    expect(n.n).toBe(1);
  });
});
