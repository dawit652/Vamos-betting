import { redactUrl, type AppConfig } from '@vamos/config';
import {
  hasPermission,
  permissionsOf,
  STAFF_CSRF_HEADER,
  STAFF_SESSION_COOKIE,
  type StaffPermission,
  type StaffSessionResponse,
} from '@vamos/contracts';
import {
  authenticateStaffSession,
  type IssuedStaffSession,
  type PasswordHasher,
  type StaffActor,
  type StaffAuthDeps,
  type StaffPrincipal,
  type StaffSessionCheck,
} from '@vamos/db';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { AppDeps } from '../deps';
import { forbidden, unauthorized } from '../lib/errors';
import { hashPassword, verifyPassword } from '../lib/passwords';
import { secureCookies } from './session';

/**
 * Staff (back office) sessions, separate from the player sessions:
 * - the `vamos_staff` cookie (httpOnly, SameSite=Strict, path /admin, Secure
 *   like the player cookies; `__Host-vamos_staff` with path / when Secure,
 *   see staffCookieName) is the only credential; there are no bearer
 *   tokens, and the player plugin ignores every /admin request;
 * - sessions live in admin_sessions (idle and absolute expiry, see
 *   @vamos/db staff-auth), so a player token never authenticates staff and
 *   a staff token never authenticates a player;
 * - unsafe methods need the session's CSRF token in `x-staff-csrf-token`.
 *
 * Register it inside the /admin route scope (it is encapsulated): its hook
 * resolves the session of every request in that scope, and the route guards
 * (`requireStaffSession`, `requirePermission`) answer 401 `unauthorized`
 * without a live session, 403 `csrf_invalid` for an unsafe request without
 * the right token and 403 `forbidden` for a role lacking the permission.
 */

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

declare module 'fastify' {
  interface FastifyRequest {
    /** The staff session check of a request in the /admin scope (null outside it). */
    staffAuth: StaffSessionCheck | null;
  }
}

/** The password hasher the staff services use (argon2id, like the players'). */
export const apiPasswordHasher: PasswordHasher = {
  hash: hashPassword,
  verify: verifyPassword,
};

/** The dependencies of the @vamos/db staff-auth services. */
export function staffAuthDeps(deps: AppDeps): StaffAuthDeps {
  return {
    db: deps.db,
    clock: deps.clock,
    randomBytes: deps.randomBytes,
    totpKey: deps.config.admin.totpKey,
    passwords: apiPasswordHasher,
  };
}

/**
 * The staff cookie's name: `__Host-vamos_staff` when cookies are Secure, so a
 * sibling subdomain can neither set nor overwrite it (ASVS 3.4.4; the prefix
 * needs path /, and the API host serves nothing else); `vamos_staff`, limited
 * to /admin, over plain http (development).
 */
export function staffCookieName(config: Pick<AppConfig, 'nodeEnv' | 'mode' | 'api'>): string {
  return secureCookies(config) ? `__Host-${STAFF_SESSION_COOKIE}` : STAFF_SESSION_COOKIE;
}

function staffCookieOptions(config: AppConfig) {
  const secure = secureCookies(config);
  return {
    httpOnly: true,
    sameSite: 'strict' as const,
    secure,
    path: secure ? '/' : '/admin',
  };
}

export function setStaffCookie(
  reply: FastifyReply,
  config: AppConfig,
  session: IssuedStaffSession,
): void {
  reply.setCookie(staffCookieName(config), session.token, {
    ...staffCookieOptions(config),
    expires: session.expiresAt,
  });
}

export function clearStaffCookie(reply: FastifyReply, config: AppConfig): void {
  reply.clearCookie(staffCookieName(config), staffCookieOptions(config));
}

/** The StaffSessionResponse body for a signed-in staff member. */
export function staffSessionBody(staff: StaffPrincipal): StaffSessionResponse {
  return {
    staff: {
      id: staff.id,
      email: staff.email,
      displayName: staff.displayName,
      role: staff.role,
      permissions: permissionsOf(staff.role),
      passwordChangeRequired: staff.passwordChangeRequired,
    },
    csrfToken: staff.csrfToken,
    expiresAt: staff.expiresAt.toISOString(),
    idleExpiresAt: staff.idleExpiresAt.toISOString(),
  };
}

/** The signed-in staff member: 401 without a live session, 403 `csrf_invalid` on a forged unsafe request. */
export function requireStaff(request: FastifyRequest): StaffPrincipal {
  const check = request.staffAuth;
  if (check === null || check.status === 'none') {
    throw unauthorized('Sign in to the back office.');
  }
  if (check.status === 'csrf_invalid') {
    throw forbidden('csrf_invalid', 'Missing or invalid CSRF token. Reload the page and retry.');
  }
  return check.staff;
}

/** The audit actor of a staff request. */
export function staffActor(request: FastifyRequest): StaffActor {
  return { adminId: requireStaff(request).id, ip: request.ip };
}

/** preHandler: any live staff session (no particular permission). */
export async function requireStaffSession(request: FastifyRequest): Promise<void> {
  requireStaff(request);
}

/**
 * preHandler factory: a live staff session whose role holds `permission` (403 `forbidden`),
 * and whose password is the staff member's own (403 `password_change_required` until they
 * change one someone else chose; the session and /admin/me routes stay open).
 */
export function requirePermission(permission: StaffPermission) {
  return async (request: FastifyRequest): Promise<void> => {
    const staff = requireStaff(request);
    if (staff.passwordChangeRequired) {
      throw forbidden(
        'password_change_required',
        'Change the password you were given before using the back office.',
      );
    }
    if (!hasPermission(staff.role, permission)) {
      throw forbidden('forbidden', 'Your role does not allow this.', { permission });
    }
  };
}

/**
 * Resolves the staff cookie of every request in the scope it is registered in,
 * and leaves one access line per request of a signed-in staff member (who,
 * role, method, URL with search terms redacted, status): the trail of which
 * staff read which player data and when (ASVS 8.3.5). Changes are also in the
 * audit log.
 */
export async function staffSessionPlugin(app: FastifyInstance): Promise<void> {
  const { deps } = app;
  app.decorateRequest('staffAuth', null);
  app.addHook('onResponse', async (request, reply) => {
    const check = request.staffAuth;
    if (check === null || check.status !== 'ok') return;
    request.log.info(
      {
        staffAccess: {
          staffId: check.staff.id,
          role: check.staff.role,
          method: request.method,
          url: redactUrl(request.url),
          statusCode: reply.statusCode,
        },
      },
      'staff access',
    );
  });
  app.addHook('onRequest', async (request) => {
    if (request.method === 'OPTIONS') return;
    const token = request.cookies[staffCookieName(deps.config)];
    if (typeof token !== 'string' || token.length === 0) {
      request.staffAuth = { status: 'none' };
      return;
    }
    const header = request.headers[STAFF_CSRF_HEADER];
    request.staffAuth = await authenticateStaffSession(deps, {
      token,
      csrfToken: typeof header === 'string' ? header : null,
      checkCsrf: !SAFE_METHODS.has(request.method),
    });
  });
}
