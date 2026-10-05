import { can, type PermissionKey, type Role } from '@shopledger/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestContext, type TestContext } from '../test/helpers';
import { effectivePermissions } from './lib/permissions';

// Walks every registered /api route, so routes added in later phases are
// covered automatically as soon as they declare their permission key.

let t: TestContext;
beforeAll(async () => {
  t = await createTestContext();
});
afterAll(async () => {
  await t.close();
});

const sample = (url: string) => url.replace(/:(\w+)/g, '1');

describe('route permissions', () => {
  it('every /api route declares its access', () => {
    expect(t.app.routeAccess.length).toBeGreaterThan(10);
    for (const r of t.app.routeAccess) expect(r.access, `${r.method} ${r.url}`).toBeTruthy();
  });

  it('anonymous requests get 401 on every non-public route', async () => {
    for (const r of t.app.routeAccess.filter((x) => x.access !== 'public')) {
      const res = await t.app.inject({ method: r.method as 'GET', url: sample(r.url), payload: {} });
      expect(res.statusCode, `${r.method} ${r.url}`).toBe(401);
    }
  });

  for (const role of ['operator', 'owner'] as Role[]) {
    it(`${role} gets 403 on every route needing a key the role lacks`, async () => {
      const user = { role, permissions: effectivePermissions(role, true) };
      const denied = t.app.routeAccess.filter(
        (r) => r.access !== 'public' && r.access !== 'authenticated' && !can(user, r.access as PermissionKey),
      );
      expect(denied.length).toBeGreaterThan(0);
      const cookie = await t.cookie(role);
      for (const r of denied) {
        const res = await t.app.inject({ method: r.method as 'GET', url: sample(r.url), headers: { cookie }, payload: {} });
        expect(res.statusCode, `${role} ${r.method} ${r.url}`).toBe(403);
      }
    });
  }

  it('only the superuser can verify the audit log', async () => {
    for (const role of ['operator', 'owner'] as Role[]) {
      const res = await t.app.inject({ method: 'GET', url: '/api/audit/verify', headers: { cookie: await t.cookie(role) } });
      expect(res.statusCode).toBe(403);
    }
    const res = await t.app.inject({ method: 'GET', url: '/api/audit/verify', headers: { cookie: await t.cookie('superuser') } });
    expect(res.statusCode).toBe(200);
    expect(res.json().ok).toBe(true);
  });

  it('errors are plain language with no stack traces', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/api/nope' });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: 'Not found.', code: 'NOT_FOUND' });
    const bad = await t.app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: '' } });
    expect(bad.statusCode).toBe(400);
    expect(bad.body).not.toMatch(/at .*\.ts/);
  });

  it('a route without an access declaration is refused at startup', async () => {
    const { buildApp } = await import('./app');
    const app = await buildApp(t.app.ctx);
    expect(() => app.get('/api/unguarded', async () => ({}))).toThrow(/must declare its access/);
    await app.close();
  });
});
