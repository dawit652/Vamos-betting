import { DEMO_STAFF_PASSWORD } from '@vamos/db/demo-staff';
import { staffAccountBackoffMs } from '@vamos/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { demoCode, seedStaff, staffEmail } from './admin-helpers';
import { createTestContext, type TestContext } from './helpers';

/**
 * Phase 12 security review A2: a stranger sending one wrong password after
 * each account-wide delay used to keep a staff member out indefinitely, even
 * with the right password and code.
 */
let ctx: TestContext;
beforeAll(async () => {
  ctx = await createTestContext();
  await seedStaff(ctx);
});
afterAll(async () => ctx?.close());

const MIN = 60_000;

describe('staff account backoff', () => {
  it('cannot be held by a stranger: the right password and code still sign in', async () => {
    const email = staffEmail('admin');
    const login = (password: string, code: string, ip: string) =>
      ctx.app.inject({
        method: 'POST',
        url: '/admin/auth/login',
        payload: { email, password, code },
        remoteAddress: ip,
      });
    // 20 wrong passwords from 4 addresses (5 each) start the account-wide delay.
    for (let a = 1; a <= 4; a += 1) {
      for (let i = 0; i < 5; i += 1) {
        expect((await login('wrong-password-x', '000000', `203.0.113.${a}`)).statusCode).toBe(401);
      }
    }
    let attackerRequests = 20;
    let staffAttempts = 0;
    let staffSuccesses = 0;
    // 6 simulated hours: the stranger keeps the delay running (one wrong password right after
    // each delay ends); the admin signs in every 7 minutes.
    let lockEndsAt = ctx.clock.now.getTime() + staffAccountBackoffMs(20);
    const end = ctx.clock.now.getTime() + 6 * 60 * MIN;
    let nextStaff = ctx.clock.now.getTime() + 7 * MIN;
    while (ctx.clock.now.getTime() < end) {
      if (nextStaff < lockEndsAt + 1000) {
        ctx.clock.advance(nextStaff - ctx.clock.now.getTime());
        staffAttempts += 1;
        // A new address each time only because the Redis limits count in real time.
        const ip = `198.51.100.${staffAttempts}`;
        const response = await login(DEMO_STAFF_PASSWORD, demoCode(ctx), ip);
        if (response.statusCode === 200) staffSuccesses += 1;
        nextStaff += 7 * MIN;
      } else {
        ctx.clock.advance(lockEndsAt + 1000 - ctx.clock.now.getTime());
        attackerRequests += 1;
        const ip = `192.0.2.${attackerRequests % 8}`;
        expect((await login('wrong-password-x', '000000', ip)).statusCode).toBe(401);
        lockEndsAt = ctx.clock.now.getTime() + staffAccountBackoffMs(attackerRequests);
      }
    }
    expect(staffAttempts).toBeGreaterThan(40);
    expect(staffSuccesses).toBe(staffAttempts);
  }, 120_000);
});
