import { settleJackpotDraw, settleJackpotEntry, type JackpotGameResult } from '@vamos/core';
import { and, asc, eq, exists, gt, lte, ne, or, sql } from 'drizzle-orm';
import { isUuid } from '../betting/selections';
import { lockAccounts, postTransaction } from '../ledger/post';
import type { AccountRef, DbExecutor, DbTransaction } from '../ledger/types';
import { writeAudit } from '../platform/audit';
import { enqueueOutbox } from '../platform/outbox';
import { events, markets } from '../schema/catalog';
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
  type JackpotRoundRow,
  type JackpotRoundSettlement,
  type JackpotRoundStatus,
} from './types';

/**
 * - settled: every game had a result; the last entries were paid (the round is final);
 * - voided: more than half of the games were cancelled; the last entries were
 *   refunded (the round is final);
 * - settling: the round's settlement is decided (results and prizes per
 *   combination fixed) and a batch of entries was paid; more remain, so
 *   call again (each call pays the next batch);
 * - open: the round is still taking entries (not due to close);
 * - pending: closed (possibly by this call), waiting for a game's result;
 *   the results known so far were recorded on the games;
 * - unchanged: already settled or voided, nothing to do;
 * - flagged: already settled or voided, and the games' results now differ
 *   from the settled ones in a way not flagged before: the round was
 *   flagged for the back office (never paid again).
 */
export type SettleJackpotOutcome =
  'settled' | 'voided' | 'settling' | 'open' | 'pending' | 'unchanged' | 'flagged';

/** Entries paid per settleJackpotRound call (one short transaction each). */
export const JACKPOT_SETTLE_BATCH_SIZE = 100;
/** How long after settling a round the sweep still looks for result corrections. */
export const JACKPOT_RECHECK_WINDOW_MS = 7 * 24 * 60 * 60_000;

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
 * A settled (or voided) round whose games' results now differ from the
 * settled ones: writes `jackpot.result_mismatch` and an audit record
 * whenever the discrepancy (by game, the catalogue result where it differs)
 * is not the one flagged last, so a further correction or a revert is
 * reported too. results_flagged_at keeps the first flag's time. Nothing is
 * paid or taken back: corrections after settlement are for the back office.
 */
async function flagChangedResults(
  tx: DbTransaction,
  round: {
    id: string;
    templateCode: string;
    resultsFlaggedAt: Date | null;
    resultsFlagged: (string | null)[] | null;
  },
  settlement: JackpotRoundSettlement,
  now: Date,
): Promise<boolean> {
  if (settlement.voidReason === 'not_opened') return false;
  const games = await loadRoundGames(tx, round.id);
  const discrepancy = games.map((game) =>
    game.current !== null && game.current !== settlement.results[game.position]
      ? game.current
      : null,
  );
  const previous = round.resultsFlagged ?? [];
  const length = Math.max(discrepancy.length, previous.length);
  const same = Array.from({ length }, (_, i) => i).every(
    (i) => (discrepancy[i] ?? null) === (previous[i] ?? null),
  );
  if (same) return false;
  const changed = games
    .filter((game) => discrepancy[game.position] !== null)
    .map((game) => ({
      position: game.position,
      eventId: game.eventId,
      settled: settlement.results[game.position] ?? null,
      current: game.current,
    }));
  await tx
    .update(jackpotRounds)
    .set({
      resultsFlaggedAt: round.resultsFlaggedAt ?? now,
      resultsFlagged: discrepancy,
      updatedAt: now,
    })
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
 * Settles a jackpot round once every game has a result, one step per call
 * in the caller's transaction (runJackpotSettlement repeats it). Safe to
 * call at any time and any number of times, also concurrently: the round
 * row is locked FOR UPDATE, so steps serialise and a later one sees what
 * an earlier one committed.
 *
 * 1. A settled or cancelled round is final: when the games' results now
 *    differ from the settled ones in a new way (a correction, or a revert),
 *    the round is flagged and nothing is paid again ('flagged'); otherwise
 *    'unchanged'.
 * 2. An open round is closed when due (its closing time came, or a game's
 *    event started or is no longer scheduled); otherwise 'open'. A
 *    scheduled round is left to closeDueJackpotRounds ('open').
 * 3. The decision, once: the games' events are locked FOR SHARE (id
 *    order), each game's result comes from its 1X2 market
 *    (catalogueGameResult) and the known ones are recorded. A game without
 *    a result yet → 'pending'. Otherwise core settleJackpotDraw over all of
 *    the round's open entries with its frozen terms decides the round: void
 *    (more than half of the games cancelled) or the prize per winning
 *    combination of every tier, and the totals. It is stored as the
 *    round's `settlement` (the round stays `closed`, settled_at null), so
 *    every later step pays on exactly these results and prizes, whatever
 *    is corrected meanwhile.
 * 4. A batch: the next `batchSize` open entries (id order) are settled with
 *    core settleJackpotEntry against the decision:
 *    - void: the exact reversal of the payment (`jackpot_entry`, key
 *      `jackpot_refund:<entryId>`: house_jackpot −cost, player_cash +cost),
 *      status void, prize 0;
 *    - a prize: one `jackpot_prize` (key `jackpot_prize:<entryId>`:
 *      house_jackpot −gross, player_cash +net, house_tax_payable +tax),
 *      status won; the rest lost. Shared-pool money nobody won stays in
 *      house_jackpot (nothing is posted for it).
 *    The batch's ledger accounts are locked first, in id order
 *    (lockAccounts), and held only until this step commits, so entries
 *    into other rounds (which post to house_jackpot) wait for one batch at
 *    most. One `jackpot.settled` outbox event per entry. More open entries
 *    left → 'settling'.
 * 5. With no open entry left the round becomes `settled` (or `cancelled`
 *    when void), with one `jackpot.round_settled` and an audit record, and
 *    a result corrected while it was being paid is flagged at once.
 */
export async function settleJackpotRound(
  tx: DbTransaction,
  roundId: string,
  now: Date,
  options: { batchSize?: number } = {},
): Promise<SettleJackpotRoundResult> {
  const batchSize = options.batchSize ?? JACKPOT_SETTLE_BATCH_SIZE;
  if (!Number.isSafeInteger(batchSize) || batchSize < 1) {
    throw new RangeError(
      `jackpot settlement batch size must be a positive integer (got ${batchSize})`,
    );
  }
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

  const { template, tax } = parseRoundTerms(round.terms);
  const settlement =
    round.settlement === null
      ? await decideRound(tx, round, now)
      : parseSettlement(round.settlement);
  if (settlement === null) return result('pending', 'closed', { closed });

  const entries = await tx
    .select()
    .from(jackpotEntries)
    .where(and(eq(jackpotEntries.roundId, roundId), eq(jackpotEntries.status, 'open')))
    .orderBy(asc(jackpotEntries.id))
    .limit(batchSize);
  const settled = entries.map((entry) =>
    settleJackpotEntry({
      entry: { picks: entry.picks, cost: entry.cost },
      results: settlement.results,
      cancelledRule: template.cancelledRule,
      payouts: settlement.payouts,
      tax,
    }),
  );
  if (settled.some((entry) => (entry.status === 'void') !== settlement.void)) {
    throw new Error(`jackpot round ${roundId}: an entry disagrees with the round's decision`);
  }

  const accounts: AccountRef[] = [{ kind: 'house_jackpot' }];
  if (settled.some((entry) => entry.tax > 0n)) accounts.push({ kind: 'house_tax_payable' });
  entries.forEach((entry, i) => {
    const one = settled[i];
    if (one !== undefined && (one.net > 0n || one.refund > 0n)) {
      accounts.push({ kind: 'player_cash', userId: entry.userId });
    }
  });
  if (accounts.length > 1) await lockAccounts(tx, accounts);

  for (const [i, entry] of entries.entries()) {
    const one = settled[i];
    if (one === undefined) throw new Error('unreachable: one settlement per entry');
    if (one.status === 'void') {
      const posting = await postTransaction(tx, {
        type: 'jackpot_entry',
        idempotencyKey: jackpotRefundLedgerKey(entry.id),
        refType: 'jackpot_entry',
        refId: entry.id,
        description: `Jackpot entry refunded (${template.code} round void)`,
        entries: jackpotRefundEntries(entry.userId, one.refund),
      });
      if (!posting.created) throw new Error(`refund of open jackpot entry ${entry.id} exists`);
    } else if (one.status === 'won') {
      const posting = await postTransaction(tx, {
        type: 'jackpot_prize',
        idempotencyKey: jackpotPrizeLedgerKey(entry.id),
        refType: 'jackpot_entry',
        refId: entry.id,
        description: `Jackpot prize (${template.code}, ${one.bestCorrect ?? 0} of ${template.gameCount} correct)`,
        entries: jackpotPrizeEntries(entry.userId, one),
      });
      if (!posting.created) throw new Error(`prize of open jackpot entry ${entry.id} exists`);
    }
    await tx
      .update(jackpotEntries)
      .set({
        status: one.status,
        correct: one.distribution === null ? null : one.distribution.map(String),
        bestCorrect: one.bestCorrect,
        prizeGross: one.gross,
        prizeTax: one.tax,
        prizeNet: one.net,
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
        status: one.status,
        cost: entry.cost,
        gross: one.gross,
        tax: one.tax,
        net: one.net,
        refund: one.refund,
        bestCorrect: one.bestCorrect,
      },
    });
  }
  const counts = {
    closed,
    entries: entries.length,
    winners: settled.filter((entry) => entry.status === 'won').length,
  };

  const [left] = await tx
    .select({ id: jackpotEntries.id })
    .from(jackpotEntries)
    .where(and(eq(jackpotEntries.roundId, roundId), eq(jackpotEntries.status, 'open')))
    .limit(1);
  if (left !== undefined) return result('settling', 'closed', counts);

  const status = settlement.void ? 'cancelled' : 'settled';
  await tx
    .update(jackpotRounds)
    .set({ status, settledAt: now, updatedAt: now })
    .where(eq(jackpotRounds.id, roundId));
  const summary = {
    roundId,
    templateCode: template.code,
    status,
    void: settlement.void,
    voidReason: settlement.voidReason,
    results: settlement.results,
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
    action: settlement.void ? 'jackpot.round_voided' : 'jackpot.round_settled',
    targetType: 'jackpot_round',
    targetId: roundId,
    metadata: { ...summary, payouts: settlement.payouts },
  });
  // A result corrected while the entries were being paid is flagged now.
  await flagChangedResults(tx, round, settlement, now);
  return result(settlement.void ? 'voided' : 'settled', status, counts);
}

/**
 * The round-level decision (step 3 of settleJackpotRound): null while a
 * game has no result; otherwise the settlement, stored on the round.
 */
async function decideRound(
  tx: DbTransaction,
  round: { id: string; gameCount: number; terms: JackpotRoundRow['terms'] },
  now: Date,
): Promise<JackpotRoundSettlement | null> {
  await lockRoundEvents(tx, round.id);
  const games = await loadRoundGames(tx, round.id);
  if (games.length !== round.gameCount) {
    throw new Error(`jackpot round ${round.id} has ${games.length} of ${round.gameCount} games`);
  }
  await recordResults(tx, round.id, games, now);
  const results: JackpotGameResult[] = [];
  for (const game of games) {
    if (game.current === null) return null;
    results.push(game.current);
  }
  const { template, tax } = parseRoundTerms(round.terms);
  // Every open entry, read once: the shared prizes depend on all of them.
  const entries = await tx
    .select({ picks: jackpotEntries.picks, cost: jackpotEntries.cost })
    .from(jackpotEntries)
    .where(and(eq(jackpotEntries.roundId, round.id), eq(jackpotEntries.status, 'open')));
  const draw = settleJackpotDraw({
    entries,
    results,
    cancelledRule: template.cancelledRule,
    prizeTiers: template.prizeTiers,
    tax,
  });
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
  await tx
    .update(jackpotRounds)
    .set({ settlement: serializeSettlement(settlement), updatedAt: now })
    .where(eq(jackpotRounds.id, round.id));
  return settlement;
}

/**
 * Settles a round to the end: settleJackpotRound, each step in its own
 * transaction from `runTx` (e.g. withTxRetry), until it is no longer
 * 'settling'. `entries` and `winners` add up over the steps; a run whose
 * last step found the round already final after paying batches itself
 * reports the round's final outcome.
 */
export async function runJackpotSettlement(
  runTx: <T>(fn: (tx: DbTransaction) => Promise<T>) => Promise<T>,
  roundId: string,
  clock: () => Date,
  options: { batchSize?: number } = {},
): Promise<SettleJackpotRoundResult> {
  let entries = 0;
  let winners = 0;
  let closed = false;
  let paid = false;
  for (;;) {
    const step = await runTx((tx) => settleJackpotRound(tx, roundId, clock(), options));
    entries += step.entries;
    winners += step.winners;
    closed ||= step.closed;
    if (step.outcome === 'settling') {
      paid = true;
      continue;
    }
    const outcome =
      paid && step.outcome === 'unchanged'
        ? step.status === 'cancelled'
          ? 'voided'
          : 'settled'
        : step.outcome;
    return { ...step, outcome, closed, entries, winners };
  }
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
 * closing first: closed rounds (waiting for results, being paid, or whose
 * settlement job failed or was lost), and open rounds due to close
 * (closing time passed, or a game's event started or is no longer
 * scheduled). Then, up to the same limit, rounds settled or voided within
 * JACKPOT_RECHECK_WINDOW_MS with a game resulted again since (a correction
 * whose `event.result_corrected` job may have been lost): settleJackpotRound
 * flags them when the results differ in a new way, else does nothing.
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
  const recheck = await exec
    .select({ id: jackpotRounds.id })
    .from(jackpotRounds)
    .where(
      and(
        or(eq(jackpotRounds.status, 'settled'), eq(jackpotRounds.status, 'cancelled')),
        gt(jackpotRounds.settledAt, new Date(now.getTime() - JACKPOT_RECHECK_WINDOW_MS)),
        sql`${jackpotRounds.settlement}->>'voidReason' IS DISTINCT FROM 'not_opened'`,
        exists(
          exec
            .select({ one: sql`1` })
            .from(jackpotGames)
            .innerJoin(events, eq(events.id, jackpotGames.eventId))
            .innerJoin(markets, eq(markets.id, jackpotGames.marketId))
            .where(
              and(
                eq(jackpotGames.roundId, jackpotRounds.id),
                or(
                  gt(events.resultedAt, jackpotRounds.settledAt),
                  gt(markets.settledAt, jackpotRounds.settledAt),
                ),
              ),
            ),
        ),
      ),
    )
    .orderBy(asc(jackpotRounds.settledAt), asc(jackpotRounds.id))
    .limit(options.limit);
  return [...rows, ...recheck].map((row) => row.id);
}
