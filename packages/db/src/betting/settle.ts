import { canSettle, settleBet, toWire, type LegState } from '@vamos/core';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { InsufficientFundsError } from '../ledger/errors';
import { lockAccounts, postTransaction } from '../ledger/post';
import type { DbExecutor, DbTransaction } from '../ledger/types';
import { writeAudit } from '../platform/audit';
import { enqueueOutbox } from '../platform/outbox';
import { betLegs, bets } from '../schema/betting';
import { markets, selections } from '../schema/catalog';
import { BET_CORRECTION_BLOCKED, BET_REOPENED, BET_SETTLED } from './events';
import {
  loadPostingEntries,
  negateEntries,
  reversalLedgerKey,
  settlementLedgerKey,
  settlementPosting,
  type SettlementAmounts,
} from './postings';
import type { BetRow } from './queries';
import { parseTerms, type BetStatus } from './types';

/**
 * - settled: an open bet was settled (won / lost / void);
 * - resettled: a settled bet's result changed: the old settlement was
 *   reversed and the new one posted;
 * - reopened: a settled bet has an open leg again after a correction: the
 *   settlement was reversed and the bet is open;
 * - unchanged: nothing to post (leg states may still have been updated);
 * - skipped: the bet is pending acceptance, rejected or cashed out;
 * - correction_blocked: the correction would take the player's cash balance
 *   below zero (the player owes more than they hold: the new net payout is
 *   lower than the old one by more than their balance), so the old
 *   settlement stays in place. The bet gets settlement_retry_at (now +
 *   CORRECTION_RETRY_DELAY_MS), which the settlement sweep (listBetsToSettle)
 *   picks up to try again, and the first block writes a
 *   `bet.correction_blocked` event for the back office.
 */
export type SettleOutcome =
  'settled' | 'resettled' | 'reopened' | 'unchanged' | 'skipped' | 'correction_blocked';

export interface SettleBetResult {
  betId: string;
  outcome: SettleOutcome;
  status: BetStatus;
  /** settlement_version after this call. */
  version: number;
  /** Legs whose state changed in this call. */
  legsChanged: number;
}

/** How long a blocked correction waits before the settlement sweep tries it again. */
export const CORRECTION_RETRY_DELAY_MS = 5 * 60_000;

const MONEY_STATUSES: ReadonlySet<BetStatus> = new Set(['open', 'won', 'lost', 'void']);
const SETTLED: ReadonlySet<BetStatus> = new Set(['won', 'lost', 'void']);

function legStateOf(marketStatus: string, result: LegState | null): LegState {
  if (marketStatus === 'void') return 'void';
  return result ?? 'open';
}

function currentSettlement(bet: BetRow): SettlementAmounts | null {
  if (!SETTLED.has(bet.status)) return null;
  if (bet.settledGrossPayout === null || bet.settledTax === null || bet.settledNetPayout === null) {
    throw new Error(`settled bet ${bet.id} has no settled amounts`);
  }
  return {
    status: bet.status as SettlementAmounts['status'],
    grossPayout: bet.settledGrossPayout,
    taxAmount: bet.settledTax,
    netPayout: bet.settledNetPayout,
  };
}

function sameSettlement(a: SettlementAmounts | null, b: SettlementAmounts | null): boolean {
  if (a === null || b === null) return a === b;
  return (
    a.status === b.status &&
    a.grossPayout === b.grossPayout &&
    a.taxAmount === b.taxAmount &&
    a.netPayout === b.netPayout
  );
}

type ResultOf = (outcome: SettleOutcome, legsChanged: number, row?: BetRow) => SettleBetResult;

/**
 * Leaves a settled bet as it is because its correction would overdraw the
 * player: marks it for the settlement sweep (settlement_retry_at) and, the
 * first time only, writes `bet.correction_blocked` and an audit record.
 */
async function blockCorrection(
  tx: DbTransaction,
  bet: BetRow,
  info: {
    now: Date;
    legsChanged: number;
    current: SettlementAmounts;
    corrected: SettlementAmounts['status'] | 'open';
    shortfall: bigint;
    result: ResultOf;
  },
): Promise<SettleBetResult> {
  const { now } = info;
  await tx
    .update(bets)
    .set({ settlementRetryAt: new Date(now.getTime() + CORRECTION_RETRY_DELAY_MS), updatedAt: now })
    .where(eq(bets.id, bet.id));
  if (bet.settlementRetryAt === null) {
    const details = {
      betId: bet.id,
      userId: bet.userId,
      version: bet.settlementVersion,
      current: info.current.status,
      corrected: info.corrected,
      shortfall: toWire(info.shortfall),
    };
    await enqueueOutbox(tx, {
      type: BET_CORRECTION_BLOCKED,
      aggregateType: 'bet',
      aggregateId: bet.id,
      payload: details,
    });
    await writeAudit(tx, {
      actorType: 'system',
      action: BET_CORRECTION_BLOCKED,
      targetType: 'bet',
      targetId: bet.id,
      metadata: details,
    });
  }
  return info.result('correction_blocked', info.legsChanged);
}

/**
 * Brings one bet in line with the current results of its selections, in the
 * caller's transaction. The bet row is locked FOR UPDATE, so concurrent runs
 * for the same bet serialise and the later one finds nothing to do.
 *
 * Each leg's state comes from its selection: a void market makes it void,
 * otherwise `selections.result` (null = still open). When core `canSettle`
 * allows it, core `settleBet` (with the terms stored on the bet) gives the
 * settlement, posted as `settlementPosting` under `settle:<betId>:<version>`.
 * When an already settled bet's result changes, the new settlement is posted
 * under `settle:<betId>:<version + 1>` and the old posting is reversed exactly
 * (`settlement_reversal`, `reverse:<betId>:<version>`), in that order and in
 * one savepoint, so the player's balance only has to cover the net change;
 * the version is bumped. A bet with an open leg again is only reversed and
 * reopened. The accounts of both postings are locked up front in id order
 * (lockAccounts). Every change writes a `bet.settled` / `bet.reopened`
 * outbox event.
 *
 * Idempotent: running it again with the same results changes nothing.
 * Pending-acceptance, rejected and cashed-out bets are skipped (a pending bet
 * is settled after acceptance; see acceptPendingBet).
 */
export async function settlePlacedBet(
  tx: DbTransaction,
  betId: string,
  now: Date,
): Promise<SettleBetResult> {
  const [bet] = await tx.select().from(bets).where(eq(bets.id, betId)).for('update');
  if (bet === undefined) throw new Error(`bet ${betId} not found`);
  const result: ResultOf = (outcome, legsChanged, row = bet) => ({
    betId,
    outcome,
    status: row.status,
    version: row.settlementVersion,
    legsChanged,
  });
  if (!MONEY_STATUSES.has(bet.status)) return result('skipped', 0);

  const legs = await tx
    .select({
      id: betLegs.id,
      oddsMilli: betLegs.oddsMilli,
      state: betLegs.state,
      result: selections.result,
      marketStatus: markets.status,
    })
    .from(betLegs)
    .innerJoin(selections, eq(selections.id, betLegs.selectionId))
    .innerJoin(markets, eq(markets.id, betLegs.marketId))
    .where(eq(betLegs.betId, betId))
    .orderBy(asc(betLegs.position));

  const nextStates = legs.map((leg) => legStateOf(leg.marketStatus, leg.result));
  const changedByState = new Map<LegState, string[]>();
  legs.forEach((leg, i) => {
    const next = nextStates[i] ?? leg.state;
    if (next === leg.state) return;
    const list = changedByState.get(next) ?? [];
    list.push(leg.id);
    changedByState.set(next, list);
  });
  let legsChanged = 0;
  for (const [state, ids] of changedByState) {
    legsChanged += ids.length;
    await tx.update(betLegs).set({ state, updatedAt: now }).where(inArray(betLegs.id, ids));
  }

  const settlementLegs = legs.map((leg, i) => ({
    oddsMilli: leg.oddsMilli,
    state: nextStates[i] ?? leg.state,
  }));
  let desired: SettlementAmounts | null = null;
  if (canSettle(settlementLegs)) {
    const terms = parseTerms(bet.terms);
    const settled = settleBet({
      stake: bet.stake,
      legs: settlementLegs,
      maxPayout: terms.betRules.maxPayout,
      multiBonus: terms.multiBonus,
      tax: terms.tax,
    });
    desired = {
      status: settled.status,
      grossPayout: settled.grossPayout,
      taxAmount: settled.taxAmount,
      netPayout: settled.netPayout,
    };
  }
  const current = currentSettlement(bet);
  if (sameSettlement(current, desired)) {
    if (bet.settlementRetryAt !== null) {
      // A blocked correction was undone by another correction: nothing is pending any more.
      await tx
        .update(bets)
        .set({ settlementRetryAt: null, updatedAt: now })
        .where(eq(bets.id, betId));
    }
    return result('unchanged', legsChanged);
  }

  const next = desired === null ? null : settlementPosting(bet.userId, bet.stake, desired);
  let version = bet.settlementVersion;
  if (current !== null) {
    const previous = await loadPostingEntries(tx, settlementLedgerKey(betId, version));
    if (previous === null) {
      throw new Error(`settled bet ${betId} has no posting ${settlementLedgerKey(betId, version)}`);
    }
    const reversal = negateEntries(previous.entries);
    // Two postings over different accounts: lock all of them first, in the
    // ledger's id order, so this cannot deadlock with a single posting
    // (e.g. the player placing a bet) that locks the same accounts.
    await lockAccounts(
      tx,
      [...reversal, ...(next?.entries ?? [])].map((entry) => entry.account),
    );
    try {
      // One savepoint for both postings. The new settlement goes first, so the
      // player's balance is checked against the net change (new net payout −
      // old net payout), not against the whole old payout on its own.
      await tx.transaction(async (sp) => {
        if (next !== null && desired !== null) {
          await postTransaction(sp, {
            type: next.type,
            idempotencyKey: settlementLedgerKey(betId, version + 1),
            refType: 'bet',
            refId: betId,
            description: `Bet ${desired.status} (settlement ${version + 1})`,
            entries: next.entries,
          });
        }
        await postTransaction(sp, {
          type: 'settlement_reversal',
          idempotencyKey: reversalLedgerKey(betId, version),
          refType: 'bet',
          refId: betId,
          description: `Reversal of settlement ${version} (result corrected)`,
          entries: reversal,
        });
      });
    } catch (error) {
      if (!(error instanceof InsufficientFundsError)) throw error;
      // The savepoint rolled back, so neither posting remains.
      return blockCorrection(tx, bet, {
        now,
        legsChanged,
        current,
        corrected: desired?.status ?? 'open',
        shortfall: error.amount - error.available,
        result,
      });
    }
    version += 1;
  }

  if (desired === null || next === null) {
    const [row] = await tx
      .update(bets)
      .set({
        status: 'open',
        settlementVersion: version,
        settledGrossPayout: null,
        settledTax: null,
        settledNetPayout: null,
        settledAt: null,
        settlementRetryAt: null,
        updatedAt: now,
      })
      .where(eq(bets.id, betId))
      .returning();
    if (row === undefined) throw new Error(`bet ${betId} vanished`);
    await enqueueOutbox(tx, {
      type: BET_REOPENED,
      aggregateType: 'bet',
      aggregateId: betId,
      payload: { betId, userId: bet.userId, version, previous: current },
    });
    return result('reopened', legsChanged, row);
  }

  if (current === null) {
    await postTransaction(tx, {
      type: next.type,
      idempotencyKey: settlementLedgerKey(betId, version),
      refType: 'bet',
      refId: betId,
      description: `Bet ${desired.status}${version > 0 ? ` (settlement ${version})` : ''}`,
      entries: next.entries,
    });
  }
  const [row] = await tx
    .update(bets)
    .set({
      status: desired.status,
      settlementVersion: version,
      settledGrossPayout: desired.grossPayout,
      settledTax: desired.taxAmount,
      settledNetPayout: desired.netPayout,
      settledAt: now,
      settlementRetryAt: null,
      updatedAt: now,
    })
    .where(eq(bets.id, betId))
    .returning();
  if (row === undefined) throw new Error(`bet ${betId} vanished`);
  await enqueueOutbox(tx, {
    type: BET_SETTLED,
    aggregateType: 'bet',
    aggregateId: betId,
    payload: {
      betId,
      userId: bet.userId,
      shortId: bet.shortId,
      status: desired.status,
      version,
      stake: bet.stake,
      grossPayout: desired.grossPayout,
      taxAmount: desired.taxAmount,
      netPayout: desired.netPayout,
      corrected: current !== null || bet.settlementVersion > 0,
      previous: current,
    },
  });
  return result(current === null ? 'settled' : 'resettled', legsChanged, row);
}

/** Ids of the bets with a leg on the event that settlement may need to look at, in id order. */
export async function listBetIdsForEvent(exec: DbExecutor, eventId: string): Promise<string[]> {
  const rows = await exec
    .selectDistinct({ id: bets.id })
    .from(betLegs)
    .innerJoin(bets, eq(bets.id, betLegs.betId))
    .where(and(eq(betLegs.eventId, eventId), inArray(bets.status, [...MONEY_STATUSES])))
    .orderBy(asc(bets.id));
  return rows.map((row) => row.id);
}

export interface ListBetsToSettleOptions {
  /** Only events resulted at least this long before `now`, so the settlement job goes first. */
  graceMs: number;
  /** Only events resulted within this long before `now`. */
  lookbackMs: number;
  limit: number;
}

/**
 * Bets the settlement sweep should run settlePlacedBet on, in id order:
 * - blocked corrections whose settlement_retry_at is due;
 * - bets in a money status (open, won, lost, void) with a leg on an event
 *   resulted between `now − lookbackMs` and `now − graceMs` whose state
 *   differs from its selection's result (void market → void, else the
 *   result, null → open). settlePlacedBet writes leg states and the
 *   settlement in one transaction, so such a leg means the bet was never
 *   settled for that result: its settlement job failed for good or was
 *   lost, or the bet was accepted while a prematch leg was being resulted.
 */
export async function listBetsToSettle(
  exec: DbExecutor,
  now: Date,
  options: ListBetsToSettleOptions,
): Promise<string[]> {
  const from = new Date(now.getTime() - options.lookbackMs);
  const to = new Date(now.getTime() - options.graceMs);
  const statuses = sql.join(
    [...MONEY_STATUSES].map((status) => sql`${status}`),
    sql`, `,
  );
  const result = await exec.execute<{ id: string }>(sql`
    SELECT id FROM (
      SELECT b.id FROM bets b
      WHERE b.settlement_retry_at IS NOT NULL
        AND b.settlement_retry_at <= ${now.toISOString()}::timestamptz
        AND b.status IN (${statuses})
      UNION
      SELECT l.bet_id FROM events e
      JOIN bet_legs l ON l.event_id = e.id
      JOIN bets b ON b.id = l.bet_id
      JOIN markets m ON m.id = l.market_id
      JOIN selections s ON s.id = l.selection_id
      WHERE e.resulted_at >= ${from.toISOString()}::timestamptz
        AND e.resulted_at <= ${to.toISOString()}::timestamptz
        AND b.status IN (${statuses})
        AND l.state::text <> CASE WHEN m.status = 'void' THEN 'void'
                                  ELSE COALESCE(s.result::text, 'open') END
    ) due
    ORDER BY id
    LIMIT ${options.limit}
  `);
  return result.rows.map((row) => row.id);
}

export interface SettleEventSummary {
  eventId: string;
  bets: number;
  outcomes: Record<SettleOutcome, number>;
  /** Bets on the event still pending acceptance (left to acceptPendingBet). */
  pendingAcceptance: number;
}

/**
 * Runs settlePlacedBet for every bet with a leg on the event (after
 * `event.resulted` / `event.result_corrected`), in bet id order, in the
 * caller's transaction. Each posting locks the shared house accounts until
 * COMMIT, so two such transactions for events that share an accumulator can
 * deadlock (Postgres aborts one; retrying is safe). A worker that settles
 * events concurrently should instead run listBetIdsForEvent and settle each
 * bet in its own short transaction.
 */
export async function settleEventBets(
  tx: DbTransaction,
  eventId: string,
  now: Date,
): Promise<SettleEventSummary> {
  const ids = await listBetIdsForEvent(tx, eventId);
  const outcomes: Record<SettleOutcome, number> = {
    settled: 0,
    resettled: 0,
    reopened: 0,
    unchanged: 0,
    skipped: 0,
    correction_blocked: 0,
  };
  for (const id of ids) {
    const { outcome } = await settlePlacedBet(tx, id, now);
    outcomes[outcome] += 1;
  }
  const [pending] = await tx
    .select({ n: sql<number>`count(DISTINCT ${bets.id})::int` })
    .from(betLegs)
    .innerJoin(bets, eq(bets.id, betLegs.betId))
    .where(and(eq(betLegs.eventId, eventId), eq(bets.status, 'pending_acceptance')));
  return { eventId, bets: ids.length, outcomes, pendingAcceptance: pending?.n ?? 0 };
}
