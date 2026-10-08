import type { AppConfig } from '@vamos/config';
import type { SessionResponse } from '@vamos/contracts';
import type { DbExecutor } from '@vamos/db';
import { sessions, users, type userStatus } from '@vamos/db/schema';
import { and, eq, isNull } from 'drizzle-orm';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { AppDeps } from '../deps';
import { randomToken, safeEqualHex, sha256Hex } from '../lib/crypto';
import { forbidden, unauthorized } from '../lib/errors';
import { toLocale, type Locale } from '../lib/locale';

export const SESSION_COOKIE = 'vamos_session';
export const CSRF_COOKIE = 'vamos_csrf';
export const CSRF_HEADER = 'x-csrf-token';
export const SESSION_TTL_MS = 30 * 24 * 60 * 60_000;
/** `last_seen_at` is written at most this often per session. */
const LAST_SEEN_RESOLUTION_MS = 60_000;
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export type UserStatus = (typeof userStatus.enumValues)[number];

/** The authenticated player, attached to `request.user`. */
export interface SessionUser {
  id: string;
  phone: string;
  status: UserStatus;
  locale: Locale;
  sessionId: string;
}

declare module 'fastify' {
  interface FastifyInstance {
    /** preHandler that rejects unauthenticated requests with 401. */
    requireAuth: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }
  interface FastifyRequest {
    /** The player behind a valid session (cookie or bearer token), else null. */
    user: SessionUser | null;
  }
}

export interface IssuedSession {
  id: string;
  /** Bearer token; only its SHA-256 is stored. */
  token: string;
  /** Double-submit CSRF token; only its SHA-256 is stored. */
  csrfToken: string;
  expiresAt: Date;
}

/** Creates a 30-day session for `userId`. Run it in the transaction that authenticates the user. */
export async function createSession(
  exec: DbExecutor,
  deps: Pick<AppDeps, 'clock' | 'randomBytes'>,
  input: { userId: string; ip?: string | null; userAgent?: string | null },
): Promise<IssuedSession> {
  const now = deps.clock();
  const token = randomToken(deps.randomBytes);
  const csrfToken = randomToken(deps.randomBytes);
  const expiresAt = new Date(now.getTime() + SESSION_TTL_MS);
  const [row] = await exec
    .insert(sessions)
    .values({
      userId: input.userId,
      tokenHash: sha256Hex(token),
      csrfHash: sha256Hex(csrfToken),
      ip: input.ip ?? null,
      userAgent: input.userAgent?.slice(0, 512) ?? null,
      createdAt: now,
      lastSeenAt: now,
      expiresAt,
    })
    .returning({ id: sessions.id });
  if (!row) throw new Error('sessions insert returned no row');
  return { id: row.id, token, csrfToken, expiresAt };
}

export async function revokeSession(exec: DbExecutor, sessionId: string, now: Date): Promise<void> {
  await exec
    .update(sessions)
    .set({ revokedAt: now })
    .where(and(eq(sessions.id, sessionId), isNull(sessions.revokedAt)));
}

/** Revokes every live session of the user; returns how many were revoked. */
export async function revokeAllUserSessions(
  exec: DbExecutor,
  userId: string,
  now: Date,
): Promise<number> {
  const revoked = await exec
    .update(sessions)
    .set({ revokedAt: now })
    .where(and(eq(sessions.userId, userId), isNull(sessions.revokedAt)))
    .returning({ id: sessions.id });
  return revoked.length;
}

function cookieOptions(config: AppConfig, httpOnly: boolean) {
  return {
    httpOnly,
    sameSite: 'lax' as const,
    secure: config.nodeEnv === 'production',
    path: '/',
  };
}

/** Sets the httpOnly session cookie and the script-readable CSRF cookie. */
export function setSessionCookies(
  reply: FastifyReply,
  config: AppConfig,
  session: IssuedSession,
): void {
  reply.setCookie(SESSION_COOKIE, session.token, {
    ...cookieOptions(config, true),
    expires: session.expiresAt,
  });
  reply.setCookie(CSRF_COOKIE, session.csrfToken, {
    ...cookieOptions(config, false),
    expires: session.expiresAt,
  });
}

export function clearSessionCookies(reply: FastifyReply, config: AppConfig): void {
  reply.clearCookie(SESSION_COOKIE, cookieOptions(config, true));
  reply.clearCookie(CSRF_COOKIE, cookieOptions(config, false));
}

/** The `SessionResponse` body for a freshly created session. */
export function sessionResponseBody(
  user: { id: string; phone: string; status: UserStatus; locale: string },
  session: IssuedSession,
): SessionResponse {
  return {
    user: { id: user.id, phone: user.phone, status: user.status, locale: toLocale(user.locale) },
    csrfToken: session.csrfToken,
    sessionToken: session.token,
    expiresAt: session.expiresAt.toISOString(),
  };
}

/** The authenticated player, or a 401 `unauthorized`. */
export function requireUser(request: FastifyRequest): SessionUser {
  if (request.user === null) {
    throw unauthorized();
  }
  return request.user;
}

type Credential = { token: string; via: 'bearer' | 'cookie' };

function readCredential(request: FastifyRequest): Credential | null {
  const authorization = request.headers.authorization;
  if (typeof authorization === 'string') {
    const match = /^Bearer\s+(\S+)\s*$/i.exec(authorization);
    if (match?.[1]) return { token: match[1], via: 'bearer' };
  }
  const cookie = request.cookies[SESSION_COOKIE];
  return cookie ? { token: cookie, via: 'cookie' } : null;
}

/**
 * Resolves the session behind the request. Revoked or expired sessions and
 * users who are no longer active count as unauthenticated. Cookie-based
 * requests with an unsafe method must echo the CSRF token in `x-csrf-token`
 * (403 `csrf_invalid`); bearer requests cannot be forged cross-site and are exempt.
 */
async function authenticate(deps: AppDeps, request: FastifyRequest): Promise<SessionUser | null> {
  if (request.method === 'OPTIONS') return null;
  const credential = readCredential(request);
  if (credential === null) return null;

  const now = deps.clock();
  const [row] = await deps.db
    .select({
      sessionId: sessions.id,
      csrfHash: sessions.csrfHash,
      expiresAt: sessions.expiresAt,
      revokedAt: sessions.revokedAt,
      lastSeenAt: sessions.lastSeenAt,
      userId: users.id,
      phone: users.phone,
      status: users.status,
      locale: users.locale,
    })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .where(eq(sessions.tokenHash, sha256Hex(credential.token)))
    .limit(1);
  if (
    !row ||
    row.revokedAt !== null ||
    row.expiresAt.getTime() <= now.getTime() ||
    row.status !== 'active'
  ) {
    return null;
  }

  if (credential.via === 'cookie' && !SAFE_METHODS.has(request.method)) {
    const header = request.headers[CSRF_HEADER];
    const csrfToken = typeof header === 'string' ? header : '';
    if (csrfToken === '' || !safeEqualHex(sha256Hex(csrfToken), row.csrfHash)) {
      throw forbidden('csrf_invalid', 'Missing or invalid CSRF token. Reload the page and retry.');
    }
  }

  if (now.getTime() - row.lastSeenAt.getTime() >= LAST_SEEN_RESOLUTION_MS) {
    await deps.db.update(sessions).set({ lastSeenAt: now }).where(eq(sessions.id, row.sessionId));
  }

  return {
    id: row.userId,
    phone: row.phone,
    status: row.status,
    locale: toLocale(row.locale),
    sessionId: row.sessionId,
  };
}

async function sessionPluginImpl(app: FastifyInstance): Promise<void> {
  const { deps } = app;
  app.decorateRequest('user', null);
  app.decorate('requireAuth', async (request: FastifyRequest) => {
    requireUser(request);
  });
  app.addHook('onRequest', async (request) => {
    request.user = await authenticate(deps, request);
  });
}

/**
 * Session authentication for the whole app. Register it after
 * `@fastify/cookie`; it is not encapsulated (like a `fastify-plugin`), so the
 * hook and decorators apply to every route.
 */
export const sessionPlugin = Object.assign(sessionPluginImpl, {
  [Symbol.for('skip-override')]: true,
  [Symbol.for('fastify.display-name')]: 'vamos-session',
});
