import { and, eq, lte, ne, or, sql } from 'drizzle-orm';
import { domainConflict, domainNotFound } from '../errors';
import type { DbTransaction } from '../ledger/types';
import { writeAudit } from '../platform/audit';
import { enqueueOutbox } from '../platform/outbox';
import { events } from '../schema/catalog';
import { jackpotEntries, jackpotGames, jackpotRounds } from '../schema/jackpots';
import { JACKPOT_ROUND_SETTLED } from './events';
import { closeLockedRound } from './rounds';
import { parseSettlement, serializeSettlement, type JackpotRoundSettlement } from './types';

/** Audit action of a round cancelled by staff. */
export const JACKPOT_ROUND_CANCELLED = 'jackpot.round_cancelled';

export interface CancelJackpotRoundInput {
  roundId: string;
  /** The staff member (jackpots.manage). */
  adminId: string;
  /** Why (required): shown in the audit log. */
  reason: string;
  now: Date;
  ip?: string | null;
}

export interface CancelJackpotRoundResult {
  /**
   * cancelled: the round was cancelled by this call (status `cancelled`
   * when it had no entries, else `closed` until settlement has refunded
   * them); unchanged: staff had cancelled it already.
   */
  outcome: 'cancelled' | 'unchanged';
  status: 'closed' | 'cancelled';
  /** Entries to refund (0 when there were none or for 'unchanged'). */
  entries: number;
  /** Σ their cost, refunded in full. */
  refunds: bigint;
}

function staffCancelledSettlement(entries: number, stakes: bigint): JackpotRoundSettlement {
  return {
    void: true,
    voidReason: 'cancelled_by_staff',
    results: [],
    cancelledGames: 0,
    entries,
    winners: 0,
    stakes,
    gross: 0n,
    tax: 0n,
    net: 0n,
    refunds: stakes,
    undistributed: 0n,
    payouts: [],
  };
}

/**
 * Staff cancel a jackpot round before its first kick-off (back office,
 * jackpots.manage), in the caller's transaction. The round must be
 * scheduled or open, its closing time still ahead and every game's event
 * still scheduled and not started; else 409 `jackpot_round_not_cancellable`
 * (details { status, reason: 'final' | 'closed' | 'started' }). 404 for an
 * unknown round. Repeating it is a no-op ('unchanged').
 *
 * The decision is stored like settlement's own (a void settlement with
 * voidReason `cancelled_by_staff`, no results):
 * - without entries the round is `cancelled` at once (`jackpot.round_settled`;
 *   an open round is closed first, `jackpot.round_closed`, as the round
 *   guard trigger only lets a closed or scheduled round be cancelled);
 * - with entries the round is closed (`jackpot.round_closed`) with that
 *   decision, and the existing settlement path refunds every entry in full
 *   (settleJackpotRound / runJackpotSettlement: `jackpot_refund:<entryId>`
 *   postings, one `jackpot.settled` per entry, then the round `cancelled`).
 *   Run runJackpotSettlement after COMMIT to refund at once; the worker's
 *   jackpot settlement sweep does it otherwise.
 *
 * Audited as `jackpot.round_cancelled` with the reason.
 */
export async function cancelJackpotRound(
  tx: DbTransaction,
  input: CancelJackpotRoundInput,
): Promise<CancelJackpotRoundResult> {
  const reason = input.reason.trim();
  if (reason.length === 0) throw new RangeError('cancelJackpotRound: a reason is required');
  if (input.adminId.length === 0)
    throw new RangeError('cancelJackpotRound: the admin id is required');
  const [round] = await tx
    .select()
    .from(jackpotRounds)
    .where(eq(jackpotRounds.id, input.roundId))
    .for('update');
  if (round === undefined) throw domainNotFound('Jackpot round');

  const decided = round.settlement === null ? null : parseSettlement(round.settlement);
  if (decided?.voidReason === 'cancelled_by_staff') {
    return {
      outcome: 'unchanged',
      status: round.status === 'cancelled' ? 'cancelled' : 'closed',
      entries: 0,
      refunds: 0n,
    };
  }
  const refuse = (why: 'final' | 'closed' | 'started') =>
    domainConflict(
      'jackpot_round_not_cancellable',
      why === 'final'
        ? 'This round is already settled or cancelled.'
        : why === 'closed'
          ? 'This round is closed: its games have started.'
          : 'A game of this round has started, so it can no longer be cancelled.',
      { status: round.status, reason: why },
    );
  if (round.status === 'settled' || round.status === 'cancelled') throw refuse('final');
  if (round.status === 'closed') throw refuse('closed');
  if (round.closesAt.getTime() <= input.now.getTime()) throw refuse('started');
  const [started] = await tx
    .select({ one: sql`1` })
    .from(jackpotGames)
    .innerJoin(events, eq(events.id, jackpotGames.eventId))
    .where(
      and(
        eq(jackpotGames.roundId, round.id),
        or(ne(events.status, 'scheduled'), lte(events.startTime, input.now)),
      ),
    )
    .limit(1);
  if (started !== undefined) throw refuse('started');

  const [totals] = await tx
    .select({
      entries: sql<number>`count(*)::int`,
      stakes: sql<string>`COALESCE(sum(${jackpotEntries.cost}), 0)::text`,
    })
    .from(jackpotEntries)
    .where(and(eq(jackpotEntries.roundId, round.id), eq(jackpotEntries.status, 'open')));
  const entries = totals?.entries ?? 0;
  const stakes = BigInt(totals?.stakes ?? '0');
  const settlement = staffCancelledSettlement(entries, stakes);
  const { now } = input;

  let status: 'closed' | 'cancelled';
  if (entries === 0) {
    status = 'cancelled';
    // The round guard allows scheduled → cancelled, but an open round closes first.
    if (round.status === 'open') await closeLockedRound(tx, round, now);
    await tx
      .update(jackpotRounds)
      .set({
        status,
        closedAt: round.closedAt ?? now,
        settledAt: now,
        settlement: serializeSettlement(settlement),
        updatedAt: now,
      })
      .where(eq(jackpotRounds.id, round.id));
    await enqueueOutbox(tx, {
      type: JACKPOT_ROUND_SETTLED,
      aggregateType: 'jackpot_round',
      aggregateId: round.id,
      payload: {
        roundId: round.id,
        templateCode: round.templateCode,
        status,
        ...settlement,
      },
    });
  } else {
    status = 'closed';
    // Entries are open only in an open round (a scheduled round takes none).
    await closeLockedRound(tx, round, now);
    await tx
      .update(jackpotRounds)
      .set({ settlement: serializeSettlement(settlement), updatedAt: now })
      .where(eq(jackpotRounds.id, round.id));
  }
  await writeAudit(tx, {
    actorType: 'admin',
    actorId: input.adminId,
    action: JACKPOT_ROUND_CANCELLED,
    targetType: 'jackpot_round',
    targetId: round.id,
    metadata: {
      templateCode: round.templateCode,
      previousStatus: round.status,
      entries,
      refunds: stakes,
      reason: reason.slice(0, 500),
    },
    ip: input.ip ?? null,
  });
  return { outcome: 'cancelled', status, entries, refunds: stakes };
}
