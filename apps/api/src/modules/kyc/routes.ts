import { SubmitKycRequest, type KycResponse } from '@vamos/contracts';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { AppError, parseInput } from '../../lib/errors';
import { clearSessionCookies, requireUser } from '../../plugins/session';
import { getKyc, submitKyc } from './service';

const HOUR_MS = 60 * 60_000;
/** Submissions per player (or per IP before authentication) and hour; each one costs a registry lookup. */
export const KYC_SUBMISSIONS_PER_HOUR = 10;

/** Identity verification (Fayda national ID) via deps.kyc. */
export default async function kycRoutes(app: FastifyInstance): Promise<void> {
  const { deps } = app;

  app.get('/me/kyc', { preHandler: app.requireAuth }, async (request): Promise<KycResponse> => {
    const user = requireUser(request);
    return getKyc(deps.db, user.id);
  });

  app.post(
    '/me/kyc',
    {
      preHandler: app.requireAuth,
      config: {
        rateLimit: {
          max: KYC_SUBMISSIONS_PER_HOUR,
          timeWindow: HOUR_MS,
          hook: 'preHandler' as const,
          keyGenerator: (request: FastifyRequest) =>
            request.user === null ? `ip|${request.ip}` : `user|${request.user.id}`,
        },
      },
    },
    async (request, reply): Promise<KycResponse> => {
      const user = requireUser(request);
      const input = parseInput(SubmitKycRequest, request.body);
      try {
        return await submitKyc(deps, user.id, input, { ip: request.ip, log: request.log });
      } catch (error) {
        // An underage finding suspends the account and revokes this session too.
        if (error instanceof AppError && error.code === 'underage') {
          clearSessionCookies(reply, deps.config);
        }
        throw error;
      }
    },
  );
}
