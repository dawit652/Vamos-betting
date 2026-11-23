import { ServiceHealthResponse } from '@vamos/contracts';
import { schema, setBoardPricing } from '@vamos/db';
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
  it('shows each service up, down since when, unknown or switched off, down first', async () => {
    const now = ctx.clock.now;
    const minutes = (n: number) => new Date(now.getTime() - n * 60_000);
    // mr-z is watched while a Narobet switch is on (servicesSwitchedOff).
    await ctx.deps.db.transaction((tx) => setBoardPricing(tx, 'narobet', true, { system: 'test' }));
    await ctx.deps.db.insert(schema.serviceStatus).values([
      { service: 'api-football', lastOkAt: minutes(1), updatedAt: now },
      {
        service: 'some-provider',
        lastOkAt: minutes(60),
        failingSince: minutes(10),
        lastFailureAt: minutes(1),
        lastError: 'timeout',
        updatedAt: now,
      },
      { service: 'never-reported', updatedAt: now },
      // A scheduled read that stopped: down 30 minutes after its last success.
      { service: 'mrz', lastOkAt: minutes(45), updatedAt: now },
      // Switched off (owner, 23 Nov 2026): not watched, shown last, whatever their last state.
      { service: 'mrx', lastOkAt: minutes(600), updatedAt: now },
      {
        service: 'payments:chapa',
        failingSince: minutes(30),
        lastError: 'HTTP 503',
        updatedAt: now,
      },
      { service: 'source:theoddsapi', failingSince: minutes(30), updatedAt: now },
    ]);
    const response = await asStaff(ctx, admin, 'GET', '/admin/service-health');
    expect(response.statusCode, response.body).toBe(200);
    const body = ServiceHealthResponse.parse(response.json());
    const byId = Object.fromEntries(body.services.map((s) => [s.service, s]));
    expect(byId['some-provider']).toMatchObject({
      status: 'down',
      since: minutes(10).toISOString(),
      lastError: 'timeout',
    });
    expect(byId.mrz).toMatchObject({ status: 'down', since: minutes(15).toISOString() });
    expect(byId['api-football']).toMatchObject({
      name: 'API-Football results',
      status: 'up',
      since: null,
    });
    expect(byId['never-reported']?.status).toBe('unknown');
    // Hulusport's switch is off, Chapa is not in PAYMENT_PROVIDERS, the source is not switched on.
    for (const service of ['mrx', 'payments:chapa', 'source:theoddsapi']) {
      expect(byId[service], service).toMatchObject({ status: 'off', since: null });
    }
    expect(body.services.slice(0, 2).map((s) => s.status)).toEqual(['down', 'down']);
    expect(body.services.slice(-3).map((s) => s.status)).toEqual(['off', 'off', 'off']);
  });
});
