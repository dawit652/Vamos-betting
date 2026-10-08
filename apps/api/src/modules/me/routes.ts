import { UpdateMeRequest, type MeResponse } from '@vamos/contracts';
import type { FastifyInstance } from 'fastify';
import { parseInput } from '../../lib/errors';
import { requireUser } from '../../plugins/session';
import { getMe, updateMe } from './service';

/** Player profile: GET/PATCH /me. */
export default async function meRoutes(app: FastifyInstance): Promise<void> {
  const { deps } = app;

  app.get('/me', { preHandler: app.requireAuth }, async (request): Promise<MeResponse> => {
    const user = requireUser(request);
    return getMe(deps.db, user.id, deps.clock());
  });

  app.patch('/me', { preHandler: app.requireAuth }, async (request): Promise<MeResponse> => {
    const user = requireUser(request);
    const input = parseInput(UpdateMeRequest, request.body);
    return updateMe(deps, user.id, input, { ip: request.ip });
  });
}
