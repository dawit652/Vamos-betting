import type { AppConfig } from '@vamos/config';
import { SHOP_CSRF_HEADER, SHOP_DEVICE_COOKIE, SHOP_SESSION_COOKIE } from '@vamos/contracts';
import {
  authenticateStaffSession,
  type IssuedStaffSession,
  type StaffPrincipal,
  type StaffSessionCheck,
} from '@vamos/db';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { forbidden, unauthorized } from '../lib/errors';
import { secureCookies } from './session';

/**
 * The shop app's sessions (docs/plans/agent-shops.md phase 1b): staff sessions of channel `shop`,
 * opened by a cashier on an approved device of their own shop. Their own cookie and CSRF header;
 * `authenticateStaffSession({ channel: 'shop' })` re-checks the device, the shop and its agent on
 * every request. The device cookie holds the device's random secret (only its hash is stored).
 */

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
/** A registered device keeps its cookie two years, until an admin revokes the device. */
const DEVICE_COOKIE_MS = 2 * 365 * 24 * 3_600_000;

declare module 'fastify' {
  interface FastifyRequest {
    /** The shop session check of a request in the /shop scope (null outside it). */
    shopAuth: StaffSessionCheck | null;
  }
}

type CookieConfig = Pick<AppConfig, 'nodeEnv' | 'mode' | 'api'>;

export function shopCookieName(config: CookieConfig): string {
  return secureCookies(config) ? `__Host-${SHOP_SESSION_COOKIE}` : SHOP_SESSION_COOKIE;
}

export function shopDeviceCookieName(config: CookieConfig): string {
  return secureCookies(config) ? `__Host-${SHOP_DEVICE_COOKIE}` : SHOP_DEVICE_COOKIE;
}

function cookieOptions(config: CookieConfig) {
  const secure = secureCookies(config);
  return { httpOnly: true, sameSite: 'strict' as const, secure, path: secure ? '/' : '/shop' };
}

export function setShopCookie(
  reply: FastifyReply,
  config: CookieConfig,
  session: IssuedStaffSession,
): void {
  reply.setCookie(shopCookieName(config), session.token, {
    ...cookieOptions(config),
    expires: session.expiresAt,
  });
}

export function clearShopCookie(reply: FastifyReply, config: CookieConfig): void {
  reply.clearCookie(shopCookieName(config), cookieOptions(config));
}

export function setDeviceCookie(
  reply: FastifyReply,
  config: CookieConfig,
  secret: string,
  now: Date,
): void {
  reply.setCookie(shopDeviceCookieName(config), secret, {
    ...cookieOptions(config),
    expires: new Date(now.getTime() + DEVICE_COOKIE_MS),
  });
}

/** The signed-in cashier of a /shop request: 401 without a live shop session, 403 bad CSRF. */
export function requireShopStaff(request: FastifyRequest): StaffPrincipal {
  const check = request.shopAuth;
  if (check === null || check.status === 'none') {
    throw unauthorized('Sign in to the shop app on a registered device.');
  }
  if (check.status === 'csrf_invalid') {
    throw forbidden('csrf_invalid', 'Missing or invalid CSRF token. Reload the page and retry.');
  }
  return check.staff;
}

/** Resolves the shop cookie of every request in the scope it is called in. */
export async function shopSessionPlugin(app: FastifyInstance): Promise<void> {
  const { deps } = app;
  app.decorateRequest('shopAuth', null);
  app.addHook('onRequest', async (request) => {
    if (request.method === 'OPTIONS') return;
    const token = request.cookies[shopCookieName(deps.config)];
    if (typeof token !== 'string' || token.length === 0) {
      request.shopAuth = { status: 'none' };
      return;
    }
    const header = request.headers[SHOP_CSRF_HEADER];
    request.shopAuth = await authenticateStaffSession(deps, {
      token,
      csrfToken: typeof header === 'string' ? header : null,
      checkCsrf: !SAFE_METHODS.has(request.method),
      channel: 'shop',
    });
  });
}
