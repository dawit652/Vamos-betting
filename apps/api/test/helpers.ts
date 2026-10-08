import { randomBytes, randomInt } from 'node:crypto';
import { loadConfig } from '@vamos/config';
import { SessionResponse } from '@vamos/contracts';
import { smsMessages } from '@vamos/db/schema';
import { createTestDatabase } from '@vamos/db/testing';
import { desc, eq } from 'drizzle-orm';
import type { FastifyInstance, InjectOptions, LightMyRequestResponse } from 'fastify';
import { Redis } from 'ioredis';
import { buildApp } from '../src/app';
import type { AppDeps } from '../src/deps';
import { MockKycVerifier } from '../src/providers/kyc';
import { MockSmsProvider } from '../src/providers/sms';

export type TestDatabase = Awaited<ReturnType<typeof createTestDatabase>>;

/** A clock that only moves when told to. */
export interface TestClock {
  now: Date;
  advance(ms: number): void;
}

export interface TestContext {
  app: FastifyInstance;
  deps: AppDeps;
  db: TestDatabase;
  redis: Redis;
  clock: TestClock;
  close(): Promise<void>;
}

export const TEST_PASSWORD = 'Abebe-bikila-1960';
export const ADULT_DOB = '1990-05-17';

/**
 * A fully wired app on a throwaway, migrated database, a Redis client with a
 * unique key prefix, a manual clock and the mock providers. One per test file.
 */
export async function createTestContext(env: Record<string, string> = {}): Promise<TestContext> {
  const db = await createTestDatabase();
  const id = randomBytes(6).toString('hex');
  const redisUrl = process.env.REDIS_URL ?? 'redis://localhost:6379';
  const redis = new Redis(redisUrl, { keyPrefix: `vamos-test:${id}:`, maxRetriesPerRequest: 2 });
  const config = loadConfig({
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
    DATABASE_URL: db.url,
    REDIS_URL: redisUrl,
    ...env,
  });

  const clock: TestClock = {
    now: new Date(),
    advance(ms) {
      this.now = new Date(this.now.getTime() + ms);
    },
  };
  const deps: AppDeps = {
    config,
    db: db.db,
    redis,
    clock: () => new Date(clock.now.getTime()),
    sms: new MockSmsProvider(db.db),
    kyc: new MockKycVerifier(),
    randomBytes: (size) => randomBytes(size),
  };
  const app = buildApp(deps, { logger: false, rateLimitNameSpace: `vamos-rl-${id}:` });
  await app.ready();

  return {
    app,
    deps,
    db,
    redis,
    clock,
    close: async () => {
      await app.close();
      await redis.quit();
      await db.drop();
    },
  };
}

/** A random Ethio Telecom number in E.164. */
export function randomPhone(): string {
  return `+2519${randomInt(0, 100_000_000).toString().padStart(8, '0')}`;
}

/** `YYYY-MM-DD` for the person who turns `years` old `offsetDays` days from `now`. */
export function dobForAge(now: Date, years: number, offsetDays = 0): string {
  const date = new Date(
    Date.UTC(now.getUTCFullYear() - years, now.getUTCMonth(), now.getUTCDate() + offsetDays),
  );
  return date.toISOString().slice(0, 10);
}

/** The code in the newest SMS sent to `phone` (read from the mock gateway's table). */
export async function latestOtp(ctx: TestContext, phone: string): Promise<string> {
  const [message] = await ctx.db.db
    .select({ body: smsMessages.body })
    .from(smsMessages)
    .where(eq(smsMessages.to, phone))
    .orderBy(desc(smsMessages.createdAt))
    .limit(1);
  const code = message ? /\b(\d{6})\b/.exec(message.body)?.[1] : undefined;
  if (code === undefined) throw new Error(`no OTP SMS found for ${phone}`);
  return code;
}

/** `name=value; …` Cookie header from a response's Set-Cookie headers. */
export function cookieHeader(response: LightMyRequestResponse): string {
  return response.cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join('; ');
}

export function post(
  ctx: TestContext,
  url: string,
  payload: Record<string, unknown>,
  extra: Omit<InjectOptions, 'method' | 'url' | 'payload'> = {},
): Promise<LightMyRequestResponse> {
  return ctx.app.inject({ method: 'POST', url, payload, ...extra });
}

export interface LoggedInUser {
  userId: string;
  phone: string;
  password: string;
  /** Cookie header carrying `vamos_session` and `vamos_csrf`. */
  cookie: string;
  csrfToken: string;
  sessionToken: string;
}

/** Registers `phone` (random by default), verifies it with the SMS code and returns the session. */
export async function registerAndLogin(
  ctx: TestContext,
  phone: string = randomPhone(),
): Promise<LoggedInUser> {
  const registered = await post(ctx, '/auth/register', {
    phone,
    password: TEST_PASSWORD,
    dateOfBirth: ADULT_DOB,
    fullName: 'Test Player',
    locale: 'en',
    acceptTerms: true,
  });
  if (registered.statusCode !== 201) {
    throw new Error(`register failed: ${registered.statusCode} ${registered.body}`);
  }
  const code = await latestOtp(ctx, phone);
  const verified = await post(ctx, '/auth/verify-otp', { phone, code, purpose: 'register' });
  if (verified.statusCode !== 200) {
    throw new Error(`verify-otp failed: ${verified.statusCode} ${verified.body}`);
  }
  const session = SessionResponse.parse(verified.json());
  return {
    userId: session.user.id,
    phone,
    password: TEST_PASSWORD,
    cookie: cookieHeader(verified),
    csrfToken: session.csrfToken,
    sessionToken: session.sessionToken,
  };
}
