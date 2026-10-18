import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
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
   * number is locked even the right password gets 429, until the window ends.
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

export type Limiter = ReturnType<FastifyInstance['createRateLimit']>;

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
