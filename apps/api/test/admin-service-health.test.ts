import { ServiceHealthResponse } from '@vamos/contracts';
import { schema } from '@vamos/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { asStaff, seedStaff, staffLogin, type StaffSession } from './admin-helpers';
import { createTestContext, type TestContext } from './helpers';

/** The back office's Service health page (counter codes plan, G7). */

let ctx: TestContext;
let admin: StaffSession;

beforeAll(async () => {
  ctx = await createTestContext();
  await seedStaff(ctx);
  admin = await staffLogin(ctx, 'admin');
}, 60_000);

afterAll(async () => {
  await ctx?.close();
});

describe('GET /admin/service-health', () => {
  it('shows each service up, down since when, or unknown, down first', async () => {
    const now = ctx.clock.now;
    const minutes = (n: number) => new Date(now.getTime() - n * 60_000);
    await ctx.deps.db.insert(schema.serviceStatus).values([
      { service: 'payments:chapa', lastOkAt: minutes(1), updatedAt: now },
      {
        service: 'payments:telebirr',
        lastOkAt: minutes(60),
        failingSince: minutes(10),
        lastFailureAt: minutes(1),
        lastError: 'timeout',
        updatedAt: now,
      },
      // A scheduled read that stopped: down 30 minutes after its last success.
      { service: 'mrz', lastOkAt: minutes(45), updatedAt: now },
      { service: 'source:theoddsapi', updatedAt: now },
    ]);
    const response = await asStaff(ctx, admin, 'GET', '/admin/service-health');
    expect(response.statusCode, response.body).toBe(200);
    const body = ServiceHealthResponse.parse(response.json());
    const byId = Object.fromEntries(body.services.map((s) => [s.service, s]));
    expect(byId['payments:telebirr']).toMatchObject({
      name: 'telebirr payments',
      status: 'down',
      since: minutes(10).toISOString(),
      lastError: 'timeout',
    });
    expect(byId.mrz).toMatchObject({ status: 'down', since: minutes(15).toISOString() });
    expect(byId['payments:chapa']).toMatchObject({ status: 'up', since: null });
    expect(byId['source:theoddsapi']?.status).toBe('unknown');
    expect(body.services.slice(0, 2).map((s) => s.status)).toEqual(['down', 'down']);
  });
});
