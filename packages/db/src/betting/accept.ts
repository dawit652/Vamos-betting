import {
  applyOddsChangePolicy,
  hasRiskLimits,
  liabilityBreach,
  quoteBet,
  type SlipLeg,
} from '@vamos/core';
import { and, asc, eq, lte } from 'drizzle-orm';
import { postTransaction } from '../ledger/post';
import type { DbExecutor, DbTransaction } from '../ledger/types';
import { enqueueOutbox } from '../platform/outbox';
import { betLegs, bets } from '../schema/betting';
import { loadGameSettings } from '../settings/index';
import { BET_ACCEPTED, BET_REJECTED } from './events';
import { potentialOf } from './place';
import { refundEntries, rejectionLedgerKey } from './postings';
import { getBetById } from './queries';
import { lockEventsForRisk, openLiabilities } from './risk';
import { loadSelectionSnapshots, unavailableReason } from './selections';
import { settlePlacedBet } from './settle';
import { parseTerms, type UserBet } from './types';

/** Why a pending bet was rejected (bets.reject_reason). */
export type RejectReason = 'selection_unavailable' | 'odds_changed' | 'slip_invalid';

export interface AcceptPendingResult {
  /**
   * accepted / rejected by this call; not_due before accept_after (nothing
   * written); unchanged when the bet was not pending any more.
   */
  outcome: 'accepted' | 'rejected' | 'not_due' | 'unchanged';
  reason: RejectReason | null;
  bet: UserBet;
}

async function betView(tx: DbExecutor, betId: string): Promise<UserBet> {
  const bet = await getBetById(tx, betId);
  if (bet === null) throw new Error(`bet ${betId} not found`);
  return bet;
}

/**
 * Rejects a bet that is pending acceptance and refunds its stake
 * (`bet_refund`, key `reject:<betId>`), writing `bet.rejected`. Locks the bet
 * FOR UPDATE; a bet that is no longer pending is left alone (`unchanged`).
 */
export async function rejectPendingBet(
  tx: DbTransaction,
  betId: string,
  now: Date,
  reason: RejectReason,
): Promise<AcceptPendingResult> {
  const [bet] = await tx.select().from(bets).where(eq(bets.id, betId)).for('update');
  if (bet === undefined) throw new Error(`bet ${betId} not found`);
  if (bet.status !== 'pending_acceptance') {
    return { outcome: 'unchanged', reason: null, bet: await betView(tx, betId) };
  }
  await postTransaction(tx, {
    type: 'bet_refund',
    idempotencyKey: rejectionLedgerKey(betId),
    refType: 'bet',
    refId: betId,
    description: 'Live bet not accepted: stake refunded',
    entries: refundEntries(bet.userId, bet.stake),
  });
  await tx
    .update(bets)
    .set({ status: 'rejected', rejectReason: reason, updatedAt: now })
    .where(eq(bets.id, betId));
  await enqueueOutbox(tx, {
    type: BET_REJECTED,
    aggregateType: 'bet',
    aggregateId: betId,
    payload: { betId, userId: bet.userId, shortId: bet.shortId, reason, refund: bet.stake },
  });
  return { outcome: 'rejected', reason, bet: await betView(tx, betId) };
}

/**
 * Decides a bet that is pending acceptance once its live delay is over
 * (accept_after <= now). Its live legs are checked again under FOR SHARE
 * locks: each must still be bettable, and its current odds must pass the
 * bet's odds-change policy against the odds it was placed at (none: equal;
 * higher: not lower, a higher price is taken; any: the current price). When
 * odds moved and were taken, the bet is re-quoted with its stored terms.
 * Prematch legs were accepted at placement and are not re-checked (their
 * selections are locked FOR SHARE too, so they cannot be resulted meanwhile).
 *
 * Accepted: status `open`, `bet.accepted`, then settlePlacedBet runs at once
 * in case a leg was resulted while the bet was pending (settlement skips
 * pending bets). Otherwise the bet is rejected and refunded (rejectPendingBet).
 * Idempotent: a bet that is no longer pending is returned `unchanged`.
 */
export async function acceptPendingBet(
  tx: DbTransaction,
  betId: string,
  now: Date,
): Promise<AcceptPendingResult> {
  const [bet] = await tx.select().from(bets).where(eq(bets.id, betId)).for('update');
  if (bet === undefined) throw new Error(`bet ${betId} not found`);
  if (bet.status !== 'pending_acceptance') {
    return { outcome: 'unchanged', reason: null, bet: await betView(tx, betId) };
  }
  if (bet.acceptAfter !== null && bet.acceptAfter.getTime() > now.getTime()) {
    return { outcome: 'not_due', reason: null, bet: await betView(tx, betId) };
  }

  const legs = await tx
    .select()
    .from(betLegs)
    .where(eq(betLegs.betId, betId))
    .orderBy(asc(betLegs.position));
  const liveLegs = legs.filter((leg) => leg.isLive);
  // Every leg's selection is locked FOR SHARE, the prematch ones too: resulting
  // a prematch leg then waits for this transaction, so its settlement job
  // finds the bet open (and settles that leg) instead of skipping it as
  // pending while the settlePlacedBet below still sees the leg open.
  const snapshots = await loadSelectionSnapshots(
    tx,
    legs.map((leg) => leg.selectionId),
    { lock: 'share' },
  );
  if (liveLegs.some((leg) => unavailableReason(snapshots.get(leg.selectionId), now) !== null)) {
    return rejectPendingBet(tx, betId, now, 'selection_unavailable');
  }
  const odds = applyOddsChangePolicy(
    bet.oddsChangePolicy,
    liveLegs.map((leg) => ({
      selectionId: leg.selectionId,
      requestedOddsMilli: leg.oddsMilli,
      currentOddsMilli: snapshots.get(leg.selectionId)?.oddsMilli ?? leg.oddsMilli,
    })),
  );
  if (!odds.accepted) return rejectPendingBet(tx, betId, now, 'odds_changed');

  if (odds.changes.length > 0) {
    const newOdds = new Map(odds.changes.map((c) => [c.selectionId, c.currentOddsMilli]));
    const slipLegs: SlipLeg[] = legs.map((leg) => ({
      selectionId: leg.selectionId,
      eventId: leg.eventId,
      oddsMilli: newOdds.get(leg.selectionId) ?? leg.oddsMilli,
    }));
    const terms = parseTerms(bet.terms);
    const quote = quoteBet({
      stake: bet.stake,
      legs: slipLegs,
      rules: terms.betRules,
      multiBonus: terms.multiBonus,
      tax: terms.tax,
    });
    if (quote.errors.length > 0) return rejectPendingBet(tx, betId, now, 'slip_invalid');
    // A price taken at acceptance can raise the payout, which adds liability that placement did
    // not check (rule L1). Only the increase is new: the bet's old payout is already in the sums.
    // Refused as `odds_changed`: at the new price the bet no longer fits.
    const increase = quote.grossPayout - bet.potentialGrossPayout;
    if (increase > 0n) {
      const limits = (await loadGameSettings(tx)).riskLimits;
      if (hasRiskLimits(limits)) {
        await lockEventsForRisk(
          tx,
          legs.map((leg) => leg.eventId),
        );
        const open = await openLiabilities(tx, {
          selectionIds: legs.map((leg) => leg.selectionId),
          eventIds: legs.map((leg) => leg.eventId),
        });
        if (liabilityBreach({ payout: increase, ...open, limits }) !== null) {
          return rejectPendingBet(tx, betId, now, 'odds_changed');
        }
      }
    }
    for (const [selectionId, oddsMilli] of newOdds) {
      await tx
        .update(betLegs)
        .set({ oddsMilli, updatedAt: now })
        .where(and(eq(betLegs.betId, betId), eq(betLegs.selectionId, selectionId)));
    }
    await tx
      .update(bets)
      .set({ totalOddsMilli: quote.totalOddsMilli, ...potentialOf(quote) })
      .where(eq(bets.id, betId));
  }

  await tx
    .update(bets)
    .set({ status: 'open', acceptedAt: now, updatedAt: now })
    .where(eq(bets.id, betId));
  await enqueueOutbox(tx, {
    type: BET_ACCEPTED,
    aggregateType: 'bet',
    aggregateId: betId,
    payload: {
      betId,
      userId: bet.userId,
      shortId: bet.shortId,
      oddsChanged: odds.changes.map((c) => ({
        selectionId: c.selectionId,
        from: c.requestedOddsMilli,
        to: c.currentOddsMilli,
      })),
    },
  });
  await settlePlacedBet(tx, betId, now);
  return { outcome: 'accepted', reason: null, bet: await betView(tx, betId) };
}

/** Ids of bets pending acceptance whose delay is over at `now`, oldest first. */
export async function listDuePendingBets(
  exec: DbExecutor,
  now: Date,
  limit = 100,
): Promise<string[]> {
  const rows = await exec
    .select({ id: bets.id })
    .from(bets)
    .where(and(eq(bets.status, 'pending_acceptance'), lte(bets.acceptAfter, now)))
    .orderBy(asc(bets.acceptAfter), asc(bets.id))
    .limit(limit);
  return rows.map((row) => row.id);
}
