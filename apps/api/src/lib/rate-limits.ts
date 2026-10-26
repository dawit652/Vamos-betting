import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Redis } from 'ioredis';
import { clientAddressKey } from './client-address';
import { tooManyRequests } from './errors';

const MINUTE_MS = 60_000;

/** At most `max` requests per `timeWindow` milliseconds. */
export interface WindowLimit {
  max: number;
  timeWindow: number;
}

/**
 * Brute-force limits of the unauthenticated auth endpoints, on top of each
 * route's limit per (client address, phone).
 */
export interface AuthLimits {
  /**
   * Requests to any unauthenticated /auth endpoint from one client address
   * (an IPv4 address or an IPv6 /64), whatever the phone number. It caps the
   * Argon2 work and the SMS one address can trigger. Ethiopian mobile users
   * share carrier-grade NAT addresses, so this cap is generous.
   */
  perClient: WindowLimit;
  /**
   * Login attempts for one phone number from any address, so password
   * guessing spread over many addresses is stopped as well. While the
   * number is locked even the right password gets 429, until the window ends
   * or the owner resets the password with an SMS code (which clears it).
   */
  loginPerPhone: WindowLimit;
  /** Staff sign-ins (POST /admin/auth/login) from one client address. */
  staffLoginPerClient: WindowLimit;
  /**
   * Staff sign-ins for one email from one client address (on top of the
   * per-address lockout after 5 failures). Not per email alone: a stranger
   * could then keep the staff member at 429 indefinitely; guessing spread
   * over addresses meets the account-wide backoff (@vamos/db staff-auth).
   */
  staffLoginPerEmail: WindowLimit;
}

export const DEFAULT_AUTH_LIMITS: AuthLimits = {
  perClient: { max: 300, timeWindow: 15 * MINUTE_MS },
  loginPerPhone: { max: 20, timeWindow: 15 * MINUTE_MS },
  staffLoginPerClient: { max: 60, timeWindow: 15 * MINUTE_MS },
  staffLoginPerEmail: { max: 20, timeWindow: 15 * MINUTE_MS },
};

/**
 * Requests per minute of the signed-in player's account routes (profile,
 * responsible-gambling settings, password and sessions). Generous for a
 * person, tight for a script.
 */
export const ACCOUNT_RATE_LIMIT_PER_MINUTE = 30;

/**
 * Route `config` with a per-player limit of `max` requests per `timeWindow`
 * (default a minute). It runs as a preHandler, after the session hook, so a
 * signed-in player has their own budget; without a session it counts per
 * client address.
 */
export function perPlayerRateLimit(name: string, max: number, timeWindow = MINUTE_MS) {
  return {
    rateLimit: {
      max,
      timeWindow,
      hook: 'preHandler' as const,
      keyGenerator: (request: FastifyRequest) =>
        request.user === null
          ? `${name}|ip|${clientAddressKey(request.ip)}`
          : `${name}|user|${request.user.id}`,
    },
  };
}

export type Limiter = ReturnType<FastifyInstance['createRateLimit']>;

type EpochRedis = Pick<Redis, 'get' | 'set'>;

const loginEpochKey = (phone: string) => `vamos:login-phone-epoch:${phone}`;

/**
 * Key of the per-phone login limiter (AuthLimits.loginPerPhone) for a
 * normalised phone (or 'invalid'). It carries the number's current epoch, so
 * restartLoginPhoneLimit starts a fresh window without touching the
 * limiter's own Redis keys.
 */
export async function loginPhoneLimitKey(redis: EpochRedis, phone: string): Promise<string> {
  const epoch = phone === 'invalid' ? null : await redis.get(loginEpochKey(phone));
  return `login-phone|${phone}|${epoch ?? '0'}`;
}

/**
 * Lifts the per-phone login lock of `phone` (a fresh window from now): the
 * owner proved control of the number with an SMS code (password reset). The
 * epoch outlives any window counted under the previous one.
 */
export async function restartLoginPhoneLimit(
  redis: EpochRedis,
  phone: string,
  window: WindowLimit,
  epoch: string,
): Promise<void> {
  await redis.set(loginEpochKey(phone), epoch, 'PX', window.timeWindow * 2);
}

function waitText(seconds: number): string {
  if (seconds < 120) return `${seconds} seconds`;
  return `${Math.ceil(seconds / 60)} minutes`;
}

/**
 * Counts the request against `limiter` (built with `app.createRateLimit`) and
 * throws 429 `rate_limited` with `details.retryAfterSeconds` and a
 * Retry-After header once the limit is exceeded.
 */
export async function enforceLimit(
  limiter: Limiter,
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const result = await limiter(request);
  if (result.isAllowed || !result.isExceeded) return;
  const retryAfterSeconds = Math.max(1, result.ttlInSeconds);
  void reply.header('retry-after', retryAfterSeconds);
  throw tooManyRequests(
    'rate_limited',
    `Too many requests. Try again in ${waitText(retryAfterSeconds)}.`,
    { retryAfterSeconds },
  );
}
