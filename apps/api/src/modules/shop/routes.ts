import {
  ShopDeviceAskRequest,
  ShopDeviceAskResponse,
  ShopLoginRequest,
  ShopPasswordChangeRequest,
  ShopSessionResponse,
} from '@vamos/contracts';
import {
  changeOwnStaffPassword,
  getShop,
  getStaffShop,
  hashDeviceSecret,
  loginStaff,
  logoutStaff,
  normalizeStaffEmail,
  requestShopDeviceWithPassword,
  warmUpStaffPasswordHashing,
  type DbExecutor,
  type StaffPrincipal,
} from '@vamos/db';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { clientAddressKey } from '../../lib/client-address';
import { parseInput, unauthorized } from '../../lib/errors';
import { enforceLimit } from '../../lib/rate-limits';
import {
  clearShopCookie,
  requireShopStaff,
  setDeviceCookie,
  setShopCookie,
  shopDeviceCookieName,
  shopSessionPlugin,
} from '../../plugins/shop-session';
import { apiPasswordHasher, staffAuthDeps } from '../../plugins/staff-session';
import { shopView } from '../admin/cashier';
import { wire } from '../admin/common';

/**
 * The shop app's API (docs/plans/agent-shops.md phase 1b): a device asks to be registered (the
 * cashier's password, then an admin approves it in the back office), a cashier signs in on an
 * approved device of their own shop, sees who and where they are, and signs out. The checks live
 * in @vamos/db (loginStaff with channel `shop`, requestShopDeviceWithPassword); sign-in and asking
 * are rate limited like the back office's sign-in.
 */

function bodyEmail(request: FastifyRequest): string {
  const body = request.body as { email?: unknown } | null | undefined;
  return typeof body?.email === 'string' ? normalizeStaffEmail(body.email).slice(0, 254) : '';
}

/** The session answer: the cashier, their shop (label, paper width) and the session times. */
async function shopSessionBody(exec: DbExecutor, staff: StaffPrincipal) {
  const shopId = await getStaffShop(exec, staff.id);
  const shop = shopId === null ? null : await getShop(exec, shopId);
  if (shop === null || staff.role !== 'cashier' || typeof staff.deviceId !== 'string') {
    // The session check already refuses this; a race (unassigned meanwhile) ends here.
    throw unauthorized('Sign in to the shop app on a registered device.');
  }
  return {
    staff: {
      id: staff.id,
      email: staff.email,
      displayName: staff.displayName,
      role: 'cashier' as const,
      passwordChangeRequired: staff.passwordChangeRequired,
    },
    shop: shopView(shop),
    deviceId: staff.deviceId,
    csrfToken: staff.csrfToken,
    expiresAt: staff.expiresAt,
    idleExpiresAt: staff.idleExpiresAt,
  };
}

export default async function shopRoutes(app: FastifyInstance): Promise<void> {
  // Called directly, not registered: its hook must cover this scope's routes.
  await shopSessionPlugin(app);
  const { deps, authLimits } = app;
  const authDeps = staffAuthDeps(deps);
  await warmUpStaffPasswordHashing(apiPasswordHasher(deps.config));

  const perClient = app.createRateLimit({
    ...authLimits.staffLoginPerClient,
    keyGenerator: (request) => `shop-login-client|${clientAddressKey(request.ip)}`,
  });
  const perEmail = app.createRateLimit({
    ...authLimits.staffLoginPerEmail,
    keyGenerator: (request) =>
      `shop-login-email|${bodyEmail(request)}|${clientAddressKey(request.ip)}`,
  });
  const loginLimits = async (request: FastifyRequest, reply: FastifyReply) => {
    await enforceLimit(perClient, request, reply);
    if (bodyEmail(request) !== '') await enforceLimit(perEmail, request, reply);
  };

  app.post('/shop/devices/request', { preHandler: loginLimits }, async (request, reply) => {
    const input = parseInput(ShopDeviceAskRequest, request.body);
    const secret = deps.randomBytes(32).toString('base64url');
    const device = await requestShopDeviceWithPassword(authDeps, {
      email: input.email,
      password: input.password,
      label: input.label,
      secretHash: hashDeviceSecret(secret),
      userAgent: request.headers['user-agent'] ?? '',
      ip: request.ip,
      clientKey: clientAddressKey(request.ip),
    });
    setDeviceCookie(reply, deps.config, secret, deps.clock());
    reply.code(201);
    return wire(ShopDeviceAskResponse, {
      device: { id: device.id, label: device.label, status: 'pending' },
    });
  });

  app.post('/shop/auth/login', { preHandler: loginLimits }, async (request, reply) => {
    const input = parseInput(ShopLoginRequest, request.body);
    const secret = request.cookies[shopDeviceCookieName(deps.config)];
    const deviceSecretHash =
      typeof secret === 'string' && secret.length > 0 && secret.length <= 128
        ? hashDeviceSecret(secret)
        : '';
    const { staff, session } = await loginStaff(authDeps, {
      email: input.email,
      password: input.password,
      code: '',
      channel: 'shop',
      deviceSecretHash,
      ip: request.ip,
      clientKey: clientAddressKey(request.ip),
      userAgent: request.headers['user-agent'] ?? null,
    });
    setShopCookie(reply, deps.config, session);
    return wire(ShopSessionResponse, await shopSessionBody(deps.db, staff));
  });

  app.get('/shop/me', async (request) =>
    wire(ShopSessionResponse, await shopSessionBody(deps.db, requireShopStaff(request))),
  );

  // The password re-check costs an argon2 hash: limited like sign-in, per address and cashier.
  const perStaff = app.createRateLimit({
    ...authLimits.staffLoginPerEmail,
    keyGenerator: (request) => `shop-self|${requireShopStaff(request).id}`,
  });
  app.post(
    '/shop/auth/password',
    {
      preHandler: async (request: FastifyRequest, reply: FastifyReply) => {
        await enforceLimit(perClient, request, reply);
        await enforceLimit(perStaff, request, reply);
      },
    },
    async (request) => {
      const staff = requireShopStaff(request);
      const input = parseInput(ShopPasswordChangeRequest, request.body);
      await changeOwnStaffPassword(authDeps, {
        adminUserId: staff.id,
        sessionId: staff.sessionId,
        currentPassword: input.currentPassword,
        code: '',
        newPassword: input.newPassword,
        channel: 'shop',
        ip: request.ip,
        clientKey: clientAddressKey(request.ip),
      });
      return { ok: true };
    },
  );

  app.post('/shop/auth/logout', async (request, reply) => {
    const staff = requireShopStaff(request);
    await logoutStaff(deps, { sessionId: staff.sessionId, adminUserId: staff.id, ip: request.ip });
    clearShopCookie(reply, deps.config);
    return { ok: true };
  });
}
