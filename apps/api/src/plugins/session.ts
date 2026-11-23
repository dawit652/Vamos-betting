import { createHmac } from 'node:crypto';
import type { AppConfig } from '@vamos/config';
import type { SessionResponse, SessionStateResponse } from '@vamos/contracts';
import type { DbExecutor } from '@vamos/db';
import { sessions, users, type userStatus } from '@vamos/db/schema';
import { and, eq, isNull } from 'drizzle-orm';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { AppDeps } from '../deps';
import { randomToken, safeEqualHex, sha256Hex } from '../lib/crypto';
import { forbidden, unauthorized } from '../lib/errors';
import { toLocale, type Locale } from '../lib/locale';
import { isShopPath, isStaffPath } from '../lib/staff-path';

/** Cookie names over plain http (local development and tests). */
export const SESSION_COOKIE = 'vamos_session';
export const CSRF_COOKIE = 'vamos_csrf';
/**
 * Cookie names when cookies are Secure (production, licensed mode, https):
 * the `__Host-` prefix makes browsers refuse them unless Secure, Path=/ and
 * without Domain, so a sibling subdomain can neither set nor overwrite them
 * (ASVS 3.4.4). Only these names are read then.
 */
export const SECURE_SESSION_COOKIE = `__Host-${SESSION_COOKIE}`;
export const SECURE_CSRF_COOKIE = `__Host-${CSRF_COOKIE}`;
export const CSRF_HEADER = 'x-csrf-token';
/**
 * How long a player session lasts: config `api.playerSession` (PLAYER_SESSION_HOURS, default a
 * year, and PLAYER_SESSION_IDLE_MINUTES, default none). The owner's choice (16 Nov 2026): a player
 * stays signed in until they sign out. This is longer than ASVS 3.3.2 level 2 (12 hours, 30
 * minutes idle); signing out, a password change or reset, self-exclusion and a disabled account
 * still end sessions at once, a new device is told by SMS, and money only ever leaves to the
 * player's own registered wallet or KYC-named bank account. Staff sessions keep the strict limits.
 */
export interface PlayerSessionLifetime {
  absoluteMs: number;
  /** Null: no idle limit. */
  idleMs: number | null;
}

/** The player session lifetime of a configuration. */
export function playerSessionLifetime(config: Pick<AppConfig, 'api'>): PlayerSessionLifetime {
  return config.api.playerSession;
}
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
  /** The session's CSRF token (csrfTokenFor its token), for GET /auth/session. */
  csrfToken: string;
  /** Absolute end of the session. */
  expiresAt: Date;
  /** When the session ends without further requests. */
  idleExpiresAt: Date;
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
  /** Double-submit CSRF token (csrfTokenFor the token); only its SHA-256 is stored. */
  csrfToken: string;
  expiresAt: Date;
  idleExpiresAt: Date;
}

/**
 * The CSRF token of a session: an HMAC keyed by the (secret, httpOnly)
 * session token, so the API can hand it out again (GET /auth/session) to a
 * web app on another host, which cannot read the API's cookies.
 */
export function csrfTokenFor(sessionToken: string): string {
  return createHmac('sha256', sessionToken).update('vamos:player-csrf:v1').digest('base64url');
}

/** When a session last seen at `lastSeenAt` ends without further requests (its end if no idle limit). */
function idleExpiry(lastSeenAt: Date, expiresAt: Date, lifetime: PlayerSessionLifetime): Date {
  if (lifetime.idleMs === null) return expiresAt;
  return new Date(Math.min(lastSeenAt.getTime() + lifetime.idleMs, expiresAt.getTime()));
}

/**
 * Whether a session row still authenticates at `now`: not revoked, before its
 * absolute end and, with an idle limit, used within it.
 */
export function sessionLive(
  row: { revokedAt: Date | null; expiresAt: Date; lastSeenAt: Date },
  now: Date,
  lifetime: PlayerSessionLifetime,
): boolean {
  const t = now.getTime();
  return (
    row.revokedAt === null &&
    t < row.expiresAt.getTime() &&
    (lifetime.idleMs === null || t - row.lastSeenAt.getTime() < lifetime.idleMs)
  );
}

/**
 * Creates a session for `userId` (config `api.playerSession`).
 * Run it in the transaction that authenticates the user.
 */
export async function createSession(
  exec: DbExecutor,
  deps: Pick<AppDeps, 'clock' | 'randomBytes' | 'config'>,
  input: { userId: string; ip?: string | null; userAgent?: string | null },
): Promise<IssuedSession> {
  const now = deps.clock();
  const lifetime = playerSessionLifetime(deps.config);
  const token = randomToken(deps.randomBytes);
  const csrfToken = csrfTokenFor(token);
  const expiresAt = new Date(now.getTime() + lifetime.absoluteMs);
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
  return {
    id: row.id,
    token,
    csrfToken,
    expiresAt,
    idleExpiresAt: idleExpiry(now, expiresAt, lifetime),
  };
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

/**
 * Whether session cookies carry the Secure flag: in production, in licensed
 * (real-money) mode whatever NODE_ENV says, and whenever the API is public over HTTPS.
 */
export function secureCookies(config: Pick<AppConfig, 'nodeEnv' | 'mode' | 'api'>): boolean {
  return (
    config.nodeEnv === 'production' ||
    config.mode === 'licensed' ||
    new URL(config.api.publicUrl).protocol === 'https:'
  );
}

/** The session and CSRF cookie names for this configuration (`__Host-` when Secure). */
export function sessionCookieNames(config: Pick<AppConfig, 'nodeEnv' | 'mode' | 'api'>): {
  session: string;
  csrf: string;
} {
  return secureCookies(config)
    ? { session: SECURE_SESSION_COOKIE, csrf: SECURE_CSRF_COOKIE }
    : { session: SESSION_COOKIE, csrf: CSRF_COOKIE };
}

function cookieOptions(config: AppConfig, httpOnly: boolean) {
  return {
    httpOnly,
    sameSite: 'lax' as const,
    secure: secureCookies(config),
    path: '/',
  };
}

/** Sets the httpOnly session cookie and the script-readable CSRF cookie. */
export function setSessionCookies(
  reply: FastifyReply,
  config: AppConfig,
  session: IssuedSession,
): void {
  const names = sessionCookieNames(config);
  reply.setCookie(names.session, session.token, {
    ...cookieOptions(config, true),
    expires: session.expiresAt,
  });
  reply.setCookie(names.csrf, session.csrfToken, {
    ...cookieOptions(config, false),
    expires: session.expiresAt,
  });
}

export function clearSessionCookies(reply: FastifyReply, config: AppConfig): void {
  const names = sessionCookieNames(config);
  reply.clearCookie(names.session, cookieOptions(config, true));
  reply.clearCookie(names.csrf, cookieOptions(config, false));
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
    idleExpiresAt: session.idleExpiresAt.toISOString(),
  };
}

/** The GET /auth/session body of a request: its session, or null without one. */
export function sessionStateBody(user: SessionUser | null): SessionStateResponse {
  if (user === null) return { session: null };
  return {
    session: {
      user: { id: user.id, phone: user.phone, status: user.status, locale: user.locale },
      csrfToken: user.csrfToken,
      expiresAt: user.expiresAt.toISOString(),
      idleExpiresAt: user.idleExpiresAt.toISOString(),
    },
  };
}

/**
 * Whether a session still authenticates: not revoked, not expired (absolute
 * or idle) and its user still active (the checks of `authenticate`).
 * Long-lived streams call it to end when the player logs out.
 */
export async function isSessionActive(
  deps: Pick<AppDeps, 'db' | 'clock' | 'config'>,
  sessionId: string,
): Promise<boolean> {
  const [row] = await deps.db
    .select({
      expiresAt: sessions.expiresAt,
      revokedAt: sessions.revokedAt,
      lastSeenAt: sessions.lastSeenAt,
      status: users.status,
    })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .where(eq(sessions.id, sessionId))
    .limit(1);
  return (
    row !== undefined &&
    sessionLive(row, deps.clock(), playerSessionLifetime(deps.config)) &&
    row.status === 'active'
  );
}

/** The authenticated player, or a 401 `unauthorized`. */
export function requireUser(request: FastifyRequest): SessionUser {
  if (request.user === null) {
    throw unauthorized();
  }
  return request.user;
}

type Credential = { token: string; via: 'bearer' | 'cookie' };

function readCredential(request: FastifyRequest, cookieName: string): Credential | null {
  const authorization = request.headers.authorization;
  if (typeof authorization === 'string') {
    const match = /^Bearer\s+(\S+)\s*$/i.exec(authorization);
    if (match?.[1]) return { token: match[1], via: 'bearer' };
  }
  const cookie = request.cookies[cookieName];
  return cookie ? { token: cookie, via: 'cookie' } : null;
}

/**
 * Resolves the session behind the request. Revoked or expired sessions (after
 * config `api.playerSession`) and users who are no longer active count as
 * unauthenticated. Cookie-based requests with an
 * unsafe method must echo the CSRF token in `x-csrf-token` (403
 * `csrf_invalid`); bearer requests cannot be forged cross-site and are exempt.
 * /admin and /shop requests are never authenticated as a player: the player cookie is on the
 * API's host, so a browser signed in to the player site sends it to the shop app's calls too.
 */
async function authenticate(deps: AppDeps, request: FastifyRequest): Promise<SessionUser | null> {
  if (request.method === 'OPTIONS') return null;
  // The staff API has its own sessions (plugins/staff-session.ts): a player
  // credential never reaches it, not even to fail a CSRF check there.
  if (isStaffPath(request.url) || isShopPath(request.url)) return null;
  const credential = readCredential(request, sessionCookieNames(deps.config).session);
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
  const lifetime = playerSessionLifetime(deps.config);
  if (!row || !sessionLive(row, now, lifetime) || row.status !== 'active') {
    return null;
  }

  if (credential.via === 'cookie' && !SAFE_METHODS.has(request.method)) {
    const header = request.headers[CSRF_HEADER];
    const csrfToken = typeof header === 'string' ? header : '';
    if (csrfToken === '' || !safeEqualHex(sha256Hex(csrfToken), row.csrfHash)) {
      throw forbidden('csrf_invalid', 'Missing or invalid CSRF token. Reload the page and retry.');
    }
  }

  let lastSeenAt = row.lastSeenAt;
  if (now.getTime() - row.lastSeenAt.getTime() >= LAST_SEEN_RESOLUTION_MS) {
    await deps.db.update(sessions).set({ lastSeenAt: now }).where(eq(sessions.id, row.sessionId));
    lastSeenAt = now;
  }

  return {
    id: row.userId,
    phone: row.phone,
    status: row.status,
    locale: toLocale(row.locale),
    sessionId: row.sessionId,
    csrfToken: csrfTokenFor(credential.token),
    expiresAt: row.expiresAt,
    idleExpiresAt: idleExpiry(lastSeenAt, row.expiresAt, lifetime),
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
