import {
  BigBetsQuery,
  LiabilityListResponse,
  LiabilityQuery,
  type StaffBetDetailView,
  StaffBetListResponse,
  StaffBetQuery,
} from '@vamos/contracts';
import { getStaffBet, listBigBets, listSelectionLiabilities, searchBets } from '@vamos/db';
import type { FastifyInstance } from 'fastify';
import { notFound, parseInput } from '../../lib/errors';
import { cachedGameSettings } from '../betting/service';
import { betView } from '../betting/views';
import { optionalDate, parseUuid, wire } from './common';

/** Bets (bets.view) and risk (risk.view). */
export default async function adminBetRoutes(app: FastifyInstance): Promise<void> {
  const { deps } = app;

  app.get('/admin/bets', { config: { staff: 'bets.view' } }, async (request) => {
    const query = parseInput(StaffBetQuery, request.query);
    const page = await searchBets(deps.db, {
      ...(query.shortId === undefined || query.shortId === '' ? {} : { shortId: query.shortId }),
      ...(query.userId === undefined ? {} : { userId: query.userId }),
      ...(query.phone === undefined || query.phone === '' ? {} : { phone: query.phone }),
      ...(query.status === undefined || query.status.length === 0
        ? {}
        : { statuses: query.status }),
      ...(query.from === undefined ? {} : { from: optionalDate(query.from) }),
      ...(query.to === undefined ? {} : { to: optionalDate(query.to) }),
      ...(query.eventId === undefined ? {} : { eventId: query.eventId }),
      ...(query.minStake === undefined ? {} : { minStake: BigInt(query.minStake) }),
      ...(query.minPotentialPayout === undefined
        ? {}
        : { minPotentialPayout: BigInt(query.minPotentialPayout) }),
      limit: query.limit,
      ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
    });
    return wire(StaffBetListResponse, page);
  });

  app.get<{ Params: { id: string } }>(
    '/admin/bets/:id',
    { config: { staff: 'bets.view' } },
    async (request) => {
      const bet = await getStaffBet(deps.db, parseUuid(request.params.id, 'Bet'));
      if (bet === null) throw notFound('Bet');
      const settings = await cachedGameSettings(deps);
      const view: StaffBetDetailView = {
        ...betView(bet, { config: settings.cashOut, now: deps.clock() }),
        userId: bet.userId,
        phone: bet.phone,
        settlementVersion: bet.settlementVersion,
      };
      return view;
    },
  );

  app.get('/admin/risk/liabilities', { config: { staff: 'risk.view' } }, async (request) => {
    const query = parseInput(LiabilityQuery, request.query);
    const items = await listSelectionLiabilities(deps.db, {
      ...(query.eventId === undefined ? {} : { eventId: query.eventId }),
      ...(query.minLiability === undefined ? {} : { minLiability: BigInt(query.minLiability) }),
      limit: query.limit,
    });
    return wire(LiabilityListResponse, { items });
  });

  app.get('/admin/risk/big-bets', { config: { staff: 'risk.view' } }, async (request) => {
    const query = parseInput(BigBetsQuery, request.query);
    const page = await listBigBets(deps.db, {
      ...(query.minStake === undefined ? {} : { minStake: BigInt(query.minStake) }),
      ...(query.minPotentialPayout === undefined
        ? {}
        : { minPotentialPayout: BigInt(query.minPotentialPayout) }),
      limit: query.limit,
      ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
    });
    return wire(StaffBetListResponse, page);
  });
}
