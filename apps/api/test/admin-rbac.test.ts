import {
  ApiErrorSchema,
  hasPermission,
  PERMISSION_ROLES,
  STAFF_CSRF_HEADER,
  STAFF_PERMISSIONS,
  type StaffRole,
} from '@vamos/contracts';
import type { InjectOptions } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { listAdminRoutes, type AdminRouteInfo } from '../src/modules/admin/common';
import {
  BACK_OFFICE_ROLES,
  asStaff,
  seedStaff,
  staffLogin,
  type StaffSession,
} from './admin-helpers';
import {
  createTestContext,
  registerAndLogin,
  type LoggedInUser,
  type TestContext,
} from './helpers';

let ctx: TestContext;
let player: LoggedInUser;
const staff = new Map<StaffRole, StaffSession>();
const ABSENT_ID = '00000000-0000-4000-8000-000000000000';

beforeAll(async () => {
  ctx = await createTestContext();
  await seedStaff(ctx);
  for (const role of BACK_OFFICE_ROLES) staff.set(role, await staffLogin(ctx, role));
  player = await registerAndLogin(ctx);
});

afterAll(async () => {
  await ctx?.close();
});

/** A concrete URL for a route pattern: ids of nothing, a real setting key. */
function concreteUrl(route: AdminRouteInfo): string {
  return route.url.replace(':key', 'tax').replace(/:[A-Za-z]+/g, ABSENT_ID);
}

const routes = () => listAdminRoutes(ctx.deps);
const guarded = () => routes().filter((route) => route.access !== 'public');
const permissionRoutes = () =>
  guarded().filter(
    (route): route is AdminRouteInfo & { access: (typeof STAFF_PERMISSIONS)[number] } =>
      route.access !== 'session',
  );

function call(route: AdminRouteInfo, headers: Record<string, string>) {
  const unsafe = route.method !== 'GET';
  return ctx.app.inject({
    method: route.method as InjectOptions['method'],
    url: concreteUrl(route),
    headers,
    ...(unsafe ? { payload: {} } : {}),
  });
}

describe('admin RBAC', () => {
  it('registers every /admin route with an access rule covering the whole matrix', () => {
    const list = routes();
    expect(list.length).toBeGreaterThanOrEqual(40);
    expect(list.every((route) => route.url.startsWith('/admin/'))).toBe(true);
    expect(list.filter((route) => route.access === 'public')).toEqual([
      { method: 'POST', url: '/admin/auth/login', access: 'public' },
    ]);
    const used = new Set(list.map((route) => route.access));
    for (const permission of STAFF_PERMISSIONS) expect(used, permission).toContain(permission);
    // Spot checks of the decided matrix.
    const accessOf = (method: string, url: string) =>
      list.find((route) => route.method === method && route.url === url)?.access;
    expect(accessOf('POST', '/admin/trading/events/:id/suspend')).toBe('trading.status');
    expect(accessOf('POST', '/admin/trading/markets/:id/void')).toBe('trading.void');
    expect(accessOf('POST', '/admin/withdrawals/:id/approve')).toBe('withdrawals.approve');
    expect(accessOf('PUT', '/admin/settings/:key')).toBe('settings.edit');
    expect(accessOf('GET', '/admin/audit')).toBe('audit.view');
    expect(accessOf('POST', '/admin/staff')).toBe('staff.manage');
  });

  it('answers 401 on every guarded route without a staff session', async () => {
    for (const route of guarded()) {
      const response = await call(route, {});
      expect(response.statusCode, `${route.method} ${route.url}`).toBe(401);
      expect(ApiErrorSchema.parse(response.json()).error.code).toBe('unauthorized');
    }
  });

  it('guards the automatic HEAD routes too', async () => {
    for (const route of guarded().filter((r) => r.method === 'GET')) {
      const response = await ctx.app.inject({ method: 'HEAD', url: concreteUrl(route) });
      expect(response.statusCode, `HEAD ${route.url}`).toBe(401);
    }
  });

  it('answers 401 on every guarded route to a player session (cookie or bearer)', async () => {
    for (const route of guarded()) {
      const credentials: Record<string, string>[] = [
        { cookie: player.cookie, 'x-csrf-token': player.csrfToken },
        { authorization: `Bearer ${player.sessionToken}` },
      ];
      for (const headers of credentials) {
        const response = await call(route, headers);
        expect(response.statusCode, `${route.method} ${route.url}`).toBe(401);
      }
    }
  });

  it('answers 403 forbidden to each role lacking the permission, and lets the others through', async () => {
    let checked = 0;
    for (const route of permissionRoutes()) {
      for (const role of BACK_OFFICE_ROLES) {
        const session = staff.get(role)!;
        const response = await call(route, {
          cookie: session.cookie,
          [STAFF_CSRF_HEADER]: session.csrfToken,
        });
        const label = `${role} ${route.method} ${route.url}`;
        if (hasPermission(role, route.access)) {
          // Past the guard: validation, a missing record or the result itself.
          expect([401, 403], label).not.toContain(response.statusCode);
          expect(response.statusCode, `${label}: ${response.body}`).toBeLessThan(500);
        } else {
          expect(response.statusCode, label).toBe(403);
          expect(ApiErrorSchema.parse(response.json()).error).toMatchObject({
            code: 'forbidden',
            details: { permission: route.access },
          });
        }
        checked += 1;
      }
    }
    expect(checked).toBe(permissionRoutes().length * BACK_OFFICE_ROLES.length);
    // The matrix denies something to everyone but the admin.
    for (const role of BACK_OFFICE_ROLES.filter((r) => r !== 'admin')) {
      expect(
        STAFF_PERMISSIONS.some((p) => !PERMISSION_ROLES[p].includes(role)),
        role,
      ).toBe(true);
    }
  });

  it('refuses a support user a trading mutation (403) and every unsafe route without CSRF', async () => {
    const support = staff.get('support')!;
    const suspend = await asStaff(
      ctx,
      support,
      'POST',
      `/admin/trading/events/${ABSENT_ID}/suspend`,
      {},
    );
    expect(suspend.statusCode).toBe(403);
    const admin = staff.get('admin')!;
    for (const route of guarded().filter((r) => r.method !== 'GET')) {
      const response = await call(route, { cookie: admin.cookie });
      expect(response.statusCode, `${route.method} ${route.url}`).toBe(403);
      expect(ApiErrorSchema.parse(response.json()).error.code).toBe('csrf_invalid');
    }
  });
});
