import {
  CancelJackpotRoundRequest,
  CancelJackpotRoundResponse,
  StaffJackpotEntryListResponse,
  StaffJackpotEntryQuery,
  StaffJackpotRoundListResponse,
  StaffJackpotRoundQuery,
} from '@vamos/contracts';
import {
  listStaffJackpotEntries,
  listStaffJackpotRounds,
  runJackpotSettlement,
  staffCancelJackpotRound,
  withTxRetry,
} from '@vamos/db';
import type { FastifyInstance } from 'fastify';
import { parseInput } from '../../lib/errors';
import { staffActor } from '../../plugins/staff-session';
import { inTx, parseUuid, wire } from './common';

type IdParams = { Params: { id: string } };

/** Jackpot rounds and entries (jackpots.view), cancelling a round (jackpots.manage). */
export default async function adminJackpotRoutes(app: FastifyInstance): Promise<void> {
  const { deps } = app;

  app.get('/admin/jackpots/rounds', { config: { staff: 'jackpots.view' } }, async (request) => {
    const query = parseInput(StaffJackpotRoundQuery, request.query);
    const page = await listStaffJackpotRounds(deps.db, {
      ...(query.status === undefined || query.status.length === 0
        ? {}
        : { statuses: query.status }),
      ...(query.template === undefined ? {} : { templateCode: query.template }),
      limit: query.limit,
      ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
    });
    return wire(StaffJackpotRoundListResponse, page);
  });

  app.get<IdParams>(
    '/admin/jackpots/rounds/:id/entries',
    { config: { staff: 'jackpots.view' } },
    async (request) => {
      const roundId = parseUuid(request.params.id, 'Jackpot round');
      const query = parseInput(StaffJackpotEntryQuery, request.query);
      const page = await listStaffJackpotEntries(deps.db, roundId, {
        limit: query.limit,
        ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
      });
      return wire(StaffJackpotEntryListResponse, page);
    },
  );

  app.post<IdParams>(
    '/admin/jackpots/rounds/:id/cancel',
    { config: { staff: 'jackpots.manage' } },
    async (request) => {
      const roundId = parseUuid(request.params.id, 'Jackpot round');
      const input = parseInput(CancelJackpotRoundRequest, request.body);
      const actor = staffActor(request);
      const now = deps.clock();
      const result = await inTx(deps, (tx) =>
        staffCancelJackpotRound(tx, { roundId, reason: input.reason, actor, now }),
      );
      if (result.outcome === 'cancelled' && result.status === 'closed') {
        // Refund the entries now; the worker's jackpot sweep is the fallback.
        app.background.run('jackpot_cancel_refunds', async () => {
          await runJackpotSettlement((fn) => withTxRetry(deps.db, fn), roundId, deps.clock);
        });
      }
      return wire(CancelJackpotRoundResponse, result);
    },
  );
}
