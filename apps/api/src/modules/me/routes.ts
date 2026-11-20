import {
  ChangePasswordRequest,
  RevokeSessionsRequest,
  UpdateMeRequest,
  type MeResponse,
  type OkResponse,
  type PlayerSessionsResponse,
  type RevokeSessionsResponse,
} from '@vamos/contracts';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { clientAddressKey } from '../../lib/client-address';
import { parseInput } from '../../lib/errors';
import {
  ACCOUNT_RATE_LIMIT_PER_MINUTE,
  enforceLimit,
  loginPhoneLimitKey,
  perPlayerRateLimit,
} from '../../lib/rate-limits';
import { requireUser } from '../../plugins/session';
import { changePassword, listSessions, revokeSessions, type RequestMeta } from '../auth/service';
import { exportMyData } from './export';
import { getMe, updateMe } from './service';

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;

/** Data exports per player and hour (each one reads the whole account). */
export const DATA_EXPORTS_PER_HOUR = 5;

/**
 * Password checks of the account security routes (change the password, end
 * other sessions) per player: one budget for both, like sign-in attempts.
 * Each check also counts against the player's number in the sign-in limits
 * (AuthLimits.loginPerPhone and loginPerPhoneDaily), which are the tighter
 * ones: a 4-digit PIN must not get more guesses through a stolen session than
 * through the login form.
 */
export const REAUTH_LIMIT = { max: 10, timeWindow: 15 * MINUTE_MS } as const;

function requestMeta(request: FastifyRequest, countPinCheck?: () => Promise<void>): RequestMeta {
  return {
    ip: request.ip,
    userAgent: request.headers['user-agent'] ?? null,
    log: request.log,
    ...(countPinCheck === undefined ? {} : { countPinCheck }),
  };
}

/**
 * Player profile (GET/PATCH /me), a copy of the player's data (GET /me/data-export), the
 * password change and the sessions (/me/password, /me/sessions).
 */
export default async function meRoutes(app: FastifyInstance): Promise<void> {
  const { deps, authLimits } = app;

  const reauth = app.createRateLimit({
    ...REAUTH_LIMIT,
    keyGenerator: (request) =>
      `me-reauth|${request.user === null ? clientAddressKey(request.ip) : request.user.id}`,
  });
  // The sign-in limits of the player's number, with the same keys and windows as POST
  // /auth/login, so both count in one budget: before 16 Nov the password had 12+ characters
  // and REAUTH_LIMIT alone sufficed; a 4-digit PIN would fall in days to 10 checks per 15 minutes.
  const phoneOf = (request: FastifyRequest) => request.user?.phone ?? 'invalid';
  const reauthPerPhone = app.createRateLimit({
    ...authLimits.loginPerPhone,
    keyGenerator: (request) => loginPhoneLimitKey(deps.redis, phoneOf(request)),
  });
  const reauthPerPhoneDaily = app.createRateLimit({
    ...authLimits.loginPerPhoneDaily,
    keyGenerator: (request) => loginPhoneLimitKey(deps.redis, phoneOf(request), 'day'),
  });
  const reauthLimit = async (request: FastifyRequest, reply: FastifyReply) => {
    requireUser(request);
    await enforceLimit(reauth, request, reply);
  };
  /** Counted by the service right before it compares the PIN (not for malformed requests). */
  const pinCheckCounter = (request: FastifyRequest, reply: FastifyReply) => async () => {
    await enforceLimit(reauthPerPhone, request, reply);
    await enforceLimit(reauthPerPhoneDaily, request, reply);
  };

  app.get('/me', { preHandler: app.requireAuth }, async (request): Promise<MeResponse> => {
    const user = requireUser(request);
    return getMe(deps.db, user.id, deps.clock());
  });

  app.patch(
    '/me',
    {
      preHandler: app.requireAuth,
      config: perPlayerRateLimit('me-update', ACCOUNT_RATE_LIMIT_PER_MINUTE),
    },
    async (request): Promise<MeResponse> => {
      const user = requireUser(request);
      const input = parseInput(UpdateMeRequest, request.body);
      return updateMe(deps, user.id, input, { ip: request.ip });
    },
  );

  app.get(
    '/me/data-export',
    {
      preHandler: app.requireAuth,
      config: perPlayerRateLimit('me-data-export', DATA_EXPORTS_PER_HOUR, HOUR_MS),
    },
    async (request, reply) => {
      const body = await exportMyData(deps, requireUser(request), { ip: request.ip });
      void reply.header('content-disposition', 'attachment; filename="nahubet-my-data.json"');
      return body;
    },
  );

  app.post(
    '/me/password',
    { preHandler: [app.requireAuth, reauthLimit] },
    async (request, reply): Promise<OkResponse> => {
      const user = requireUser(request);
      const input = parseInput(ChangePasswordRequest, request.body);
      const { deliver } = await changePassword(
        deps,
        user,
        input,
        requestMeta(request, pinCheckCounter(request, reply)),
      );
      app.background.run('password_changed_sms', deliver);
      return { ok: true };
    },
  );

  app.get(
    '/me/sessions',
    { preHandler: app.requireAuth },
    async (request): Promise<PlayerSessionsResponse> => listSessions(deps, requireUser(request)),
  );

  app.post(
    '/me/sessions/revoke',
    { preHandler: [app.requireAuth, reauthLimit] },
    async (request, reply): Promise<RevokeSessionsResponse> => {
      const user = requireUser(request);
      const input = parseInput(RevokeSessionsRequest, request.body);
      return revokeSessions(
        deps,
        user,
        input,
        requestMeta(request, pinCheckCounter(request, reply)),
      );
    },
  );
}
