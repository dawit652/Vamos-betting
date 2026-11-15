import { randomBytes, randomInt } from 'node:crypto';
import { loadConfig } from '@vamos/config';
import { RegisterResponse, SessionResponse } from '@vamos/contracts';
import { smsMessages } from '@vamos/db/schema';
import { createTestDatabase } from '@vamos/db/testing';
import { createPaymentProviders } from '@vamos/payments';
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

/**
 * The app's `sleep` in tests: it returns at once after moving the clock on by
 * the time asked, and runs `during` (when set) first, as if that happened
 * while the request waited.
 */
export interface TestSleep {
  /** Every wait asked for, in ms, oldest first. */
  calls: number[];
  during: ((ms: number) => Promise<void>) | null;
}

export interface TestContext {
  app: FastifyInstance;
  deps: AppDeps;
  db: TestDatabase;
  redis: Redis;
  clock: TestClock;
  sleep: TestSleep;
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
    OPERATING_MODE: 'demo',
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
  const now = () => new Date(clock.now.getTime());
  const sleep: TestSleep = { calls: [], during: null };
  const deps: AppDeps = {
    config,
    db: db.db,
    redis,
    clock: now,
    sms: new MockSmsProvider(db.db),
    kyc: new MockKycVerifier(),
    // The mock provider only (demo mode); its webhooks are checked against the test clock.
    payments: createPaymentProviders(config, {
      fetch: () => Promise.reject(new Error('no network in tests')),
      clock: now,
      randomBytes: (size) => randomBytes(size),
    }),
    randomBytes: (size) => randomBytes(size),
    sleep: async (ms) => {
      sleep.calls.push(ms);
      clock.advance(ms);
      await sleep.during?.(ms);
    },
    // Never the shared production channel: a dev stack on the same Redis would see test deltas.
    liveChannel: `vamos-test:${id}:live`,
    // Likewise for the per-player channels of GET /me/stream.
    userChannelPrefix: `vamos-test:${id}:user:`,
  };
  const app = buildApp(deps, { logger: false, rateLimitNameSpace: `vamos-rl-${id}:` });
  await app.ready();

  return {
    app,
    deps,
    db,
    redis,
    clock,
    sleep,
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

/**
 * `YYYY-MM-DD` of a birth date `years` years before `now`, moved `offsetDays`
 * days later. With offset 0 the person is exactly `years` old today (or since
 * yesterday when today is 29 February and that year had none); with offset 1
 * they are not `years` old yet. The day is clamped to the end of the month
 * before the offset is added, so 29 February never rolls over to 1 March.
 */
export function dobForAge(now: Date, years: number, offsetDays = 0): string {
  const year = now.getUTCFullYear() - years;
  const month = now.getUTCMonth();
  const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  const date = new Date(Date.UTC(year, month, Math.min(now.getUTCDate(), lastDay) + offsetDays));
  return date.toISOString().slice(0, 10);
}

/**
 * The code in the newest SMS sent to `phone` (read from the mock gateway's
 * table), once SMS sent after a response (password resets) have gone out.
 */
export async function latestOtp(ctx: TestContext, phone: string): Promise<string> {
  await ctx.app.background.idle();
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

/**
 * Signs `player` in again and puts the new session on it. Sessions end 30
 * minutes after their last request and 12 hours after sign-in, so a test whose
 * clock jumps further (a 24-hour limit delay, a cool-off) signs in again, like
 * the player would.
 */
export async function relogin(ctx: TestContext, player: LoggedInUser): Promise<LoggedInUser> {
  const response = await post(ctx, '/auth/login', {
    phone: player.phone,
    password: player.password,
  });
  if (response.statusCode !== 200) {
    throw new Error(`login failed: ${response.statusCode} ${response.body}`);
  }
  const session = SessionResponse.parse(response.json());
  player.cookie = cookieHeader(response);
  player.csrfToken = session.csrfToken;
  player.sessionToken = session.sessionToken;
  return player;
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
  const { registrationToken } = RegisterResponse.parse(registered.json());
  const code = await latestOtp(ctx, phone);
  const verified = await post(ctx, '/auth/verify-otp', {
    phone,
    code,
    purpose: 'register',
    registrationToken,
  });
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
