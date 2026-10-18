import {
  DashboardQuery,
  DashboardResponse,
  KycQueueQuery,
  KycQueueResponse,
  KycReviewRequest,
  KycReviewResponse,
  PlayerDetailView,
  PlayerListResponse,
  PlayerSearchQuery,
} from '@vamos/contracts';
import { getDashboard, getPlayerDetail, listKycQueue, reviewKyc, searchPlayers } from '@vamos/db';
import type { FastifyInstance } from 'fastify';
import { notFound, parseInput } from '../../lib/errors';
import { staffActor } from '../../plugins/staff-session';
import { inTx, parseUuid, wire } from './common';

/** The dashboard (dashboard.view), players (users.view) and the KYC queue (kyc.review). */
export default async function adminPlayerRoutes(app: FastifyInstance): Promise<void> {
  const { deps } = app;

  app.get('/admin/dashboard', { config: { staff: 'dashboard.view' } }, async (request) => {
    const query = parseInput(DashboardQuery, request.query);
    const dashboard = await getDashboard(deps.db, {
      from: new Date(query.from),
      to: new Date(query.to),
    });
    return wire(DashboardResponse, dashboard);
  });

  app.get('/admin/users', { config: { staff: 'users.view' } }, async (request) => {
    const query = parseInput(PlayerSearchQuery, request.query);
    const page = await searchPlayers(deps.db, {
      ...(query.q === undefined || query.q === '' ? {} : { q: query.q }),
      ...(query.status === undefined ? {} : { status: query.status }),
      ...(query.kycStatus === undefined ? {} : { kycStatus: query.kycStatus }),
      limit: query.limit,
      ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
    });
    return wire(PlayerListResponse, page);
  });

  app.get<{ Params: { id: string } }>(
    '/admin/users/:id',
    { config: { staff: 'users.view' } },
    async (request) => {
      const userId = parseUuid(request.params.id, 'Player');
      const detail = await getPlayerDetail(deps.db, userId, deps.clock());
      if (detail === null) throw notFound('Player');
      return wire(PlayerDetailView, detail);
    },
  );

  app.get('/admin/kyc', { config: { staff: 'kyc.review' } }, async (request) => {
    const query = parseInput(KycQueueQuery, request.query);
    const page = await listKycQueue(deps.db, {
      status: query.status,
      limit: query.limit,
      ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
    });
    return wire(KycQueueResponse, page);
  });

  app.post<{ Params: { userId: string } }>(
    '/admin/kyc/:userId/review',
    { config: { staff: 'kyc.review' } },
    async (request) => {
      const userId = parseUuid(request.params.userId, 'KYC profile');
      const input = parseInput(KycReviewRequest, request.body);
      const actor = staffActor(request);
      const now = deps.clock();
      const result = await inTx(deps, (tx) =>
        reviewKyc(tx, {
          userId,
          decision: input.decision,
          ...(input.reason === undefined ? {} : { reason: input.reason }),
          actor,
          now,
        }),
      );
      return wire(KycReviewResponse, result);
    },
  );
}
