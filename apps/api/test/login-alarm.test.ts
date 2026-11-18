import { randomBytes } from 'node:crypto';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { recordLoginFailure, type LoginAlarmThresholds } from '../src/lib/login-alarm';
import { createTestContext, post, type TestContext } from './helpers';

/** X6b: many failed logins, many numbers, or many numbers from one address raise one alarm each. */

const REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6379';
const SMALL: LoginAlarmThresholds = {
  windowMs: 15 * 60_000,
  total: 5,
  numbers: 4,
  numbersPerAddress: 3,
};

function captureLog() {
  const errors: Array<Record<string, unknown>> = [];
  const warns: Array<Record<string, unknown>> = [];
  return {
    errors,
    warns,
    log: {
      error: (obj: Record<string, unknown>) => void errors.push(obj),
      warn: (obj: Record<string, unknown>) => void warns.push(obj),
    },
  };
}

describe('recordLoginFailure', () => {
  let redis: Redis;
  beforeAll(() => {
    redis = new Redis(REDIS_URL, {
      keyPrefix: `vamos-test:${randomBytes(6).toString('hex')}:`,
      maxRetriesPerRequest: 2,
    });
  });
  afterAll(async () => {
    await redis.quit();
  });

  const now = new Date('2026-11-18T10:00:00.000Z');

  it('raises the per-address alarm once when one address tries many numbers', async () => {
    const { log, errors } = captureLog();
    const raised: string[][] = [];
    for (const phone of ['+251911000001', '+251911000002', '+251911000003', '+251911000004']) {
      raised.push(
        await recordLoginFailure(redis, log, { phone, address: 'ip:1.2.3.4', now }, SMALL),
      );
    }
    expect(raised).toEqual([[], [], ['login_failures_address'], ['login_failures_numbers']]);
    expect(errors.map((e) => e.alarm)).toEqual([
      'login_failures_address',
      'login_failures_numbers',
    ]);
    expect(errors[0]).toMatchObject({ count: 3, threshold: 3, windowMinutes: 15 });
    // No raw phone number in the alarm line.
    expect(JSON.stringify(errors)).not.toMatch(/2519110000/);
  });

  it('raises the total alarm on many failures of the same number, once per window', async () => {
    const { log, errors } = captureLog();
    const later = new Date(now.getTime() + 60 * 60_000); // another window
    for (let i = 0; i < 7; i += 1) {
      await recordLoginFailure(
        redis,
        log,
        { phone: '+251911000009', address: 'ip:5.6.7.8', now: later },
        SMALL,
      );
    }
    expect(errors.map((e) => e.alarm)).toEqual(['login_failures_total']);
    expect(errors[0]).toMatchObject({ count: 5 });
  });

  it('counts a number that did not parse in the total only, and never throws', async () => {
    const { log, errors, warns } = captureLog();
    const other = new Date(now.getTime() + 2 * 60 * 60_000);
    const raised = await recordLoginFailure(
      redis,
      log,
      { phone: null, address: 'ip:9.9.9.9', now: other },
      SMALL,
    );
    expect(raised).toEqual([]);
    expect(errors).toEqual([]);
    const broken = new Redis(REDIS_URL, { lazyConnect: true, maxRetriesPerRequest: 0 });
    broken.disconnect();
    await expect(
      recordLoginFailure(
        broken,
        log,
        { phone: '+251911000010', address: 'ip:9.9.9.9', now: other },
        SMALL,
      ),
    ).resolves.toEqual([]);
    expect(warns).toHaveLength(1);
  });
});

describe('a failed login through the API is counted', () => {
  let ctx: TestContext;
  beforeAll(async () => {
    ctx = await createTestContext();
  });
  afterAll(async () => {
    await ctx?.close();
  });

  it('adds to the window counter', async () => {
    const response = await post(ctx, '/auth/login', { phone: '0911999888', password: '4826' });
    expect(response.statusCode).toBe(401);
    const keys = await ctx.deps.redis.keys('*auth:login-failures:*:n');
    expect(keys.length).toBeGreaterThan(0);
  });
});
