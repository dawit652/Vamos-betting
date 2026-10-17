import { settleJackpotDraw, type JackpotGameResult } from '@vamos/core';
import { and, asc, eq, exists, lte, ne, or, sql } from 'drizzle-orm';
import { isUuid } from '../betting/selections';
import { lockAccounts, postTransaction } from '../ledger/post';
import type { AccountRef, DbExecutor, DbTransaction } from '../ledger/types';
import { writeAudit } from '../platform/audit';
import { enqueueOutbox } from '../platform/outbox';
import { events } from '../schema/catalog';
import { jackpotEntries, jackpotGames, jackpotRounds } from '../schema/jackpots';
import {
  jackpotPrizeEntries,
  jackpotPrizeLedgerKey,
  jackpotRefundEntries,
  jackpotRefundLedgerKey,
} from './entries';
import { JACKPOT_RESULT_MISMATCH, JACKPOT_ROUND_SETTLED, JACKPOT_SETTLED } from './events';
import { loadRoundGames, lockRoundEvents, type LoadedJackpotGame } from './games';
import { closeLockedRound, isRoundDue } from './rounds';
import {
  FINAL_ROUND_STATUSES,
  parseRoundTerms,
  parseSettlement,
  serializeSettlement,
  type JackpotRoundSettlement,
  type JackpotRoundStatus,
} from './types';

/**
 * - settled: every game had a result; prizes were paid;
 * - voided: more than half of the games were cancelled; every entry was refunded;
 * - open: the round is still taking entries (not due to close);
 * - pending: closed (possibly by this call), waiting for a game's result;
 *   the results known so far were recorded on the games;
 * - unchanged: already settled or voided, nothing to do;
 * - flagged: already settled or voided, and a game's result has changed
 *   since: the round was flagged for the back office (never paid again).
 */
export type SettleJackpotOutcome =
  'settled' | 'voided' | 'open' | 'pending' | 'unchanged' | 'flagged';

export interface SettleJackpotRoundResult {
  roundId: string;
  outcome: SettleJackpotOutcome;
  status: JackpotRoundStatus;
  /** true when this call closed the round. */
  closed: boolean;
  /** Entries settled or refunded by this call. */
  entries: number;
  /** Entries paid a prize by this call. */
  winners: number;
}

const FINAL: ReadonlySet<JackpotRoundStatus> = new Set(FINAL_ROUND_STATUSES);

/** Records the results known now on the games whose recorded result differs (unsettled rounds only). */
async function recordResults(
  tx: DbTransaction,
  roundId: string,
  games: readonly LoadedJackpotGame[],
  now: Date,
): Promise<void> {
  for (const game of games) {
    if (game.current === game.result) continue;
    await tx
      .update(jackpotGames)
      .set({ result: game.current, resultedAt: game.current === null ? null : now })
      .where(and(eq(jackpotGames.roundId, roundId), eq(jackpotGames.position, game.position)));
  }
}

/**
 * A settled (or voided) round whose games' results changed since: flags it
 * once (results_flagged_at, `jackpot.result_mismatch`, an audit record).
 * Nothing is paid or taken back: corrections after settlement are for the
 * back office.
 */
async function flagChangedResults(
  tx: DbTransaction,
  round: { id: string; templateCode: string; resultsFlaggedAt: Date | null },
  settlement: JackpotRoundSettlement,
  now: Date,
): Promise<boolean> {
  if (settlement.voidReason === 'not_opened') return false;
  const games = await loadRoundGames(tx, round.id);
  const changed = games
    .filter((game) => game.current !== null && game.current !== settlement.results[game.position])
    .map((game) => ({
      position: game.position,
      eventId: game.eventId,
      settled: settlement.results[game.position] ?? null,
      current: game.current,
    }));
  if (changed.length === 0 || round.resultsFlaggedAt !== null) return false;
  await tx
    .update(jackpotRounds)
    .set({ resultsFlaggedAt: now, updatedAt: now })
    .where(eq(jackpotRounds.id, round.id));
  const details = { roundId: round.id, templateCode: round.templateCode, games: changed };
  await enqueueOutbox(tx, {
    type: JACKPOT_RESULT_MISMATCH,
    aggregateType: 'jackpot_round',
    aggregateId: round.id,
    payload: details,
  });
  await writeAudit(tx, {
    actorType: 'system',
    action: JACKPOT_RESULT_MISMATCH,
    targetType: 'jackpot_round',
    targetId: round.id,
    metadata: details,
  });
  return true;
}

/**
 * Settles a jackpot round once every game has a result, in the caller's
 * transaction. Safe to call at any time and any number of times, also
 * concurrently: the round row is locked FOR UPDATE, so runs serialise and
 * a later one finds the round final.
 *
 * 1. A settled or cancelled round is final: when a game's result has
 *    changed since (a correction), the round is flagged once and nothing
 *    is paid again ('flagged'); otherwise 'unchanged'.
 * 2. An open round is closed when due (its closing time came, or a game's
 *    event started or is no longer scheduled); otherwise 'open'. A
 *    scheduled round is left to closeDueJackpotRounds ('open').
 * 3. The games' events are locked FOR SHARE (id order), so results cannot
 *    change under the settlement; each game's result comes from its 1X2
 *    market (catalogueGameResult) and the known ones are recorded. A game
 *    without a result yet → 'pending'.
 * 4. core settleJackpotDraw over the round's open entries with the round's
 *    frozen terms (cancelled rule, prize tiers, tax):
 *    - void (more than half of the games cancelled): every entry is
 *      refunded with the exact reversal of its payment (`jackpot_entry`,
 *      key `jackpot_refund:<entryId>`: house_jackpot −cost, player_cash
 *      +cost), status void, prize 0; the round becomes `cancelled`;
 *    - otherwise each entry with a prize is paid by one `jackpot_prize`
 *      (key `jackpot_prize:<entryId>`: house_jackpot −gross, player_cash
 *      +net, house_tax_payable +tax), status won; the rest lost; the round
 *      becomes `settled`. Shared-pool money nobody won stays in
 *      house_jackpot (nothing is posted for it).
 *    The ledger accounts of every posting are locked first, in id order
 *    (lockAccounts), so the many postings of one settlement cannot
 *    deadlock with single postings (entries, bets) on the same accounts.
 * 5. One `jackpot.settled` outbox event per entry, one
 *    `jackpot.round_settled` for the round, and an audit record.
 */
export async function settleJackpotRound(
  tx: DbTransaction,
  roundId: string,
  now: Date,
): Promise<SettleJackpotRoundResult> {
  const [round] = await tx
    .select()
    .from(jackpotRounds)
    .where(eq(jackpotRounds.id, roundId))
    .for('update');
  if (round === undefined) throw new Error(`jackpot round ${roundId} not found`);
  const result = (
    outcome: SettleJackpotOutcome,
    status: JackpotRoundStatus,
    extra: Partial<Pick<SettleJackpotRoundResult, 'closed' | 'entries' | 'winners'>> = {},
  ): SettleJackpotRoundResult => ({
    roundId,
    outcome,
    status,
    closed: extra.closed ?? false,
    entries: extra.entries ?? 0,
    winners: extra.winners ?? 0,
  });

  if (FINAL.has(round.status)) {
    if (round.settlement === null)
      throw new Error(`final jackpot round ${roundId} has no settlement`);
    const flagged = await flagChangedResults(tx, round, parseSettlement(round.settlement), now);
    return result(flagged ? 'flagged' : 'unchanged', round.status);
  }
  if (round.status === 'scheduled') return result('open', round.status);

  let closed = false;
  if (round.status === 'open') {
    if (!(await isRoundDue(tx, round, now))) return result('open', round.status);
    await closeLockedRound(tx, round, now);
    closed = true;
  }

  await lockRoundEvents(tx, roundId);
  const games = await loadRoundGames(tx, roundId);
  if (games.length !== round.gameCount) {
    throw new Error(`jackpot round ${roundId} has ${games.length} of ${round.gameCount} games`);
  }
  await recordResults(tx, roundId, games, now);
  const results: JackpotGameResult[] = [];
  for (const game of games) {
    if (game.current === null) return result('pending', 'closed', { closed });
    results.push(game.current);
  }

  const { template, tax } = parseRoundTerms(round.terms);
  const entries = await tx
    .select()
    .from(jackpotEntries)
    .where(and(eq(jackpotEntries.roundId, roundId), eq(jackpotEntries.status, 'open')))
    .orderBy(asc(jackpotEntries.id));
  const draw = settleJackpotDraw({
    entries: entries.map((entry) => ({ picks: entry.picks, cost: entry.cost })),
    results,
    cancelledRule: template.cancelledRule,
    prizeTiers: template.prizeTiers,
    tax,
  });

  const accounts: AccountRef[] = [{ kind: 'house_jackpot' }];
  if (draw.totals.tax > 0n) accounts.push({ kind: 'house_tax_payable' });
  entries.forEach((entry, i) => {
    const settled = draw.entries[i];
    if (settled !== undefined && (settled.net > 0n || settled.refund > 0n)) {
      accounts.push({ kind: 'player_cash', userId: entry.userId });
    }
  });
  if (accounts.length > 1) await lockAccounts(tx, accounts);

  for (const [i, entry] of entries.entries()) {
    const settled = draw.entries[i];
    if (settled === undefined) throw new Error('unreachable: one settlement per entry');
    if (settled.status === 'void') {
      const posting = await postTransaction(tx, {
        type: 'jackpot_entry',
        idempotencyKey: jackpotRefundLedgerKey(entry.id),
        refType: 'jackpot_entry',
        refId: entry.id,
        description: `Jackpot entry refunded (${template.code} round void)`,
        entries: jackpotRefundEntries(entry.userId, settled.refund),
      });
      if (!posting.created) throw new Error(`refund of open jackpot entry ${entry.id} exists`);
    } else if (settled.status === 'won') {
      const posting = await postTransaction(tx, {
        type: 'jackpot_prize',
        idempotencyKey: jackpotPrizeLedgerKey(entry.id),
        refType: 'jackpot_entry',
        refId: entry.id,
        description: `Jackpot prize (${template.code}, ${settled.bestCorrect ?? 0} of ${template.gameCount} correct)`,
        entries: jackpotPrizeEntries(entry.userId, settled),
      });
      if (!posting.created) throw new Error(`prize of open jackpot entry ${entry.id} exists`);
    }
    await tx
      .update(jackpotEntries)
      .set({
        status: settled.status,
        correct: settled.distribution === null ? null : settled.distribution.map(String),
        bestCorrect: settled.bestCorrect,
        prizeGross: settled.gross,
        prizeTax: settled.tax,
        prizeNet: settled.net,
        settledAt: now,
        updatedAt: now,
      })
      .where(eq(jackpotEntries.id, entry.id));
    await enqueueOutbox(tx, {
      type: JACKPOT_SETTLED,
      aggregateType: 'jackpot_entry',
      aggregateId: entry.id,
      payload: {
        entryId: entry.id,
        roundId,
        userId: entry.userId,
        templateCode: template.code,
        status: settled.status,
        cost: entry.cost,
        gross: settled.gross,
        tax: settled.tax,
        net: settled.net,
        refund: settled.refund,
        bestCorrect: settled.bestCorrect,
      },
    });
  }

  const settlement: JackpotRoundSettlement = {
    void: draw.void,
    voidReason: draw.void ? 'cancelled_games' : null,
    results,
    cancelledGames: draw.cancelledGames,
    entries: entries.length,
    winners: draw.totals.winners,
    stakes: draw.totals.stakes,
    gross: draw.totals.gross,
    tax: draw.totals.tax,
    net: draw.totals.net,
    refunds: draw.totals.refunds,
    undistributed: draw.totals.undistributed,
    payouts: draw.payouts,
  };
  const status = draw.void ? 'cancelled' : 'settled';
  await tx
    .update(jackpotRounds)
    .set({ status, settledAt: now, settlement: serializeSettlement(settlement), updatedAt: now })
    .where(eq(jackpotRounds.id, roundId));
  const summary = {
    roundId,
    templateCode: template.code,
    status,
    void: settlement.void,
    voidReason: settlement.voidReason,
    results,
    cancelledGames: settlement.cancelledGames,
    entries: settlement.entries,
    winners: settlement.winners,
    stakes: settlement.stakes,
    gross: settlement.gross,
    tax: settlement.tax,
    net: settlement.net,
    refunds: settlement.refunds,
    undistributed: settlement.undistributed,
  };
  await enqueueOutbox(tx, {
    type: JACKPOT_ROUND_SETTLED,
    aggregateType: 'jackpot_round',
    aggregateId: roundId,
    payload: summary,
  });
  await writeAudit(tx, {
    actorType: 'system',
    action: draw.void ? 'jackpot.round_voided' : 'jackpot.round_settled',
    targetType: 'jackpot_round',
    targetId: roundId,
    metadata: { ...summary, payouts: settlement.payouts },
  });
  return result(draw.void ? 'voided' : 'settled', status, {
    closed,
    entries: entries.length,
    winners: settlement.winners,
  });
}

/**
 * Ids of the rounds with a game on the event (after `event.resulted` /
 * `event.result_corrected`), in id order: settleJackpotRound settles the
 * ones now complete and flags settled ones whose result changed.
 */
export async function listJackpotRoundIdsForEvent(
  exec: DbExecutor,
  eventId: string,
): Promise<string[]> {
  if (!isUuid(eventId)) return [];
  const rows = await exec
    .selectDistinct({ id: jackpotGames.roundId })
    .from(jackpotGames)
    .where(eq(jackpotGames.eventId, eventId))
    .orderBy(asc(jackpotGames.roundId));
  return rows.map((row) => row.id);
}

/** Ids of the rounds with a game on the 1X2 market (after `market.resulted`), in id order. */
export async function listJackpotRoundIdsForMarket(
  exec: DbExecutor,
  marketId: string,
): Promise<string[]> {
  if (!isUuid(marketId)) return [];
  const rows = await exec
    .selectDistinct({ id: jackpotGames.roundId })
    .from(jackpotGames)
    .where(eq(jackpotGames.marketId, marketId))
    .orderBy(asc(jackpotGames.roundId));
  return rows.map((row) => row.id);
}

/**
 * Rounds the settlement sweep should run settleJackpotRound on, soonest
 * closing first: closed rounds (waiting for results, or whose settlement
 * job failed or was lost), and open rounds due to close (closing time
 * passed, or a game's event started or is no longer scheduled).
 */
export async function listJackpotRoundsToSettle(
  exec: DbExecutor,
  now: Date,
  options: { limit: number },
): Promise<string[]> {
  const rows = await exec
    .select({ id: jackpotRounds.id })
    .from(jackpotRounds)
    .where(
      or(
        eq(jackpotRounds.status, 'closed'),
        and(
          eq(jackpotRounds.status, 'open'),
          or(
            lte(jackpotRounds.closesAt, now),
            exists(
              exec
                .select({ one: sql`1` })
                .from(jackpotGames)
                .innerJoin(events, eq(events.id, jackpotGames.eventId))
                .where(
                  and(
                    eq(jackpotGames.roundId, jackpotRounds.id),
                    or(ne(events.status, 'scheduled'), lte(events.startTime, now)),
                  ),
                ),
            ),
          ),
        ),
      ),
    )
    .orderBy(asc(jackpotRounds.closesAt), asc(jackpotRounds.id))
    .limit(options.limit);
  return rows.map((row) => row.id);
}
