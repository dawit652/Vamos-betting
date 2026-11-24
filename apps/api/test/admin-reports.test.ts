import { randomUUID } from 'node:crypto';
import { OwnerReportResponse, type StaffRole } from '@vamos/contracts';
import { birr } from '@vamos/core';
import { postTransaction } from '@vamos/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  BACK_OFFICE_ROLES,
  asStaff,
  seedStaff,
  staffLogin,
  type StaffSession,
} from './admin-helpers';
import { createTestContext, registerAndLogin, type TestContext } from './helpers';

/**
 * GET /admin/reports (docs/plans/owner-reports.md): the owner reports of a day, a week, a month and
 * a year, for the roles with reports.view, with the checks each report ran on itself.
 */

let ctx: TestContext;
const staff = new Map<StaffRole, StaffSession>();
const as = (role: StaffRole) => staff.get(role)!;

beforeAll(async () => {
  ctx = await createTestContext();
  await seedStaff(ctx);
  for (const role of BACK_OFFICE_ROLES) staff.set(role, await staffLogin(ctx, role));
}, 60_000);

afterAll(async () => {
  await ctx?.close();
});

describe('GET /admin/reports', () => {
  it('answers a day, a week, a month and a year that add up, and checks itself', async () => {
    const player = await registerAndLogin(ctx);
    await ctx.deps.db.transaction((tx) =>
      postTransaction(tx, {
        type: 'deposit',
        idempotencyKey: `deposit:test-${randomUUID()}`,
        createdAt: new Date('2026-03-10T09:00:00Z'),
        entries: [
          { account: { kind: 'house_psp_clearing', provider: 'chapa' }, amount: -birr(250) },
          { account: { kind: 'player_cash', userId: player.userId }, amount: birr(250) },
        ],
      }),
    );
    const get = async (query: string) => {
      const response = await asStaff(ctx, as('finance'), 'GET', `/admin/reports${query}`);
      expect(response.statusCode, response.body).toBe(200);
      return OwnerReportResponse.parse(response.json());
    };
    const day = await get('?period=day&date=2026-03-10');
    expect(day).toMatchObject({ period: 'day', firstDay: '2026-03-10', open: false });
    expect(day.figures.deposits).toEqual({
      total: '25000',
      count: 1,
      byProvider: [{ provider: 'chapa', amount: '25000', count: 1 }],
    });
    expect(day.checks.map((c) => c.id)).toEqual([
      'balanced',
      'every_posting_balanced',
      'unchanged_since_close',
      'closed_days_passed',
      'balances_roll_forward',
    ]);
    expect(day.checks.every((c) => c.ok)).toBe(true);
    for (const period of ['week', 'month', 'year']) {
      const report = await get(`?period=${period}&date=2026-03-10`);
      expect(report.figures.deposits.byProvider.find((p) => p.provider === 'chapa')?.amount).toBe(
        '25000',
      );
    }
    // No query: today's report, still open.
    const today = await get('');
    expect(today).toMatchObject({ period: 'day', open: true });
  });

  it('is for admin, compliance and finance only, and refuses a bad period or date', async () => {
    for (const role of BACK_OFFICE_ROLES) {
      const response = await asStaff(ctx, as(role), 'GET', '/admin/reports?period=month');
      const allowed = role === 'admin' || role === 'compliance' || role === 'finance';
      expect(response.statusCode, role).toBe(allowed ? 200 : 403);
    }
    expect(
      (await asStaff(ctx, as('admin'), 'GET', '/admin/reports?period=quarter')).statusCode,
    ).toBe(400);
    expect(
      (await asStaff(ctx, as('admin'), 'GET', '/admin/reports?period=day&date=2026-02-30'))
        .statusCode,
    ).toBe(400);
  });
});
