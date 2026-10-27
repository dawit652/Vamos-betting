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
 */
export const REAUTH_LIMIT = { max: 10, timeWindow: 15 * MINUTE_MS } as const;

function requestMeta(request: FastifyRequest): RequestMeta {
  return { ip: request.ip, userAgent: request.headers['user-agent'] ?? null, log: request.log };
}

/**
 * Player profile (GET/PATCH /me), a copy of the player's data (GET /me/data-export), the
 * password change and the sessions (/me/password, /me/sessions).
 */
export default async function meRoutes(app: FastifyInstance): Promise<void> {
  const { deps } = app;

  const reauth = app.createRateLimit({
    ...REAUTH_LIMIT,
    keyGenerator: (request) =>
      `me-reauth|${request.user === null ? clientAddressKey(request.ip) : request.user.id}`,
  });
  const reauthLimit = async (request: FastifyRequest, reply: FastifyReply) => {
    requireUser(request);
    await enforceLimit(reauth, request, reply);
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
      void reply.header('content-disposition', 'attachment; filename="vamos-my-data.json"');
      return body;
    },
  );

  app.post(
    '/me/password',
    { preHandler: [app.requireAuth, reauthLimit] },
    async (request): Promise<OkResponse> => {
      const user = requireUser(request);
      const input = parseInput(ChangePasswordRequest, request.body);
      const { deliver } = await changePassword(deps, user, input, requestMeta(request));
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
    async (request): Promise<RevokeSessionsResponse> => {
      const user = requireUser(request);
      const input = parseInput(RevokeSessionsRequest, request.body);
      return revokeSessions(deps, user, input, requestMeta(request));
    },
  );
}
