import {
  CreateExclusionRequest,
  RgLimitsRequest,
  type Exclusion,
  type RgLimitsResponse,
} from '@vamos/contracts';
import type { FastifyInstance } from 'fastify';
import { parseInput } from '../../lib/errors';
import { clearSessionCookies, requireUser } from '../../plugins/session';
import { createExclusion, getLimits, updateLimits } from './service';

/** POST /me/exclusions response (201). */
export interface CreateExclusionResponse {
  exclusion: Exclusion;
}

/**
 * Responsible gambling: deposit / loss / stake limits and cool-off or
 * self-exclusion (enforcement helpers in ./service.ts and ./guard.ts).
 */
export default async function rgRoutes(app: FastifyInstance): Promise<void> {
  const { deps } = app;

  app.get(
    '/me/limits',
    { preHandler: app.requireAuth },
    async (request): Promise<RgLimitsResponse> => {
      const user = requireUser(request);
      return getLimits(deps.db, user.id, deps.clock());
    },
  );

  app.put(
    '/me/limits',
    { preHandler: app.requireAuth },
    async (request): Promise<RgLimitsResponse> => {
      const user = requireUser(request);
      const input = parseInput(RgLimitsRequest, request.body);
      return updateLimits(deps, user.id, input, { ip: request.ip });
    },
  );

  app.post('/me/exclusions', { preHandler: app.requireAuth }, async (request, reply) => {
    const user = requireUser(request);
    const input = parseInput(CreateExclusionRequest, request.body);
    const { exclusion } = await createExclusion(deps, user.id, input, { ip: request.ip });
    if (input.kind === 'self_exclusion') {
      // Every session (this one included) was revoked.
      clearSessionCookies(reply, deps.config);
    }
    const body: CreateExclusionResponse = { exclusion };
    return reply.status(201).send(body);
  });
}
