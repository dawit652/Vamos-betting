import { canSettle, settleBet, toWire, type LegState } from '@vamos/core';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { InsufficientFundsError } from '../ledger/errors';
import { postTransaction } from '../ledger/post';
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
 * - correction_blocked: the reversal of a winning settlement would take the
 *   player's cash balance below zero, so the old settlement stays in place
 *   and a `bet.correction_blocked` event asks the back office to step in.
 *   Running settlement again retries the correction.
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

/**
 * Brings one bet in line with the current results of its selections, in the
 * caller's transaction. The bet row is locked FOR UPDATE, so concurrent runs
 * for the same bet serialise and the later one finds nothing to do.
 *
 * Each leg's state comes from its selection: a void market makes it void,
 * otherwise `selections.result` (null = still open). When core `canSettle`
 * allows it, core `settleBet` (with the terms stored on the bet) gives the
 * settlement, posted as `settlementPosting` under `settle:<betId>:<version>`.
 * When an already settled bet's result changes, its settlement posting is
 * reversed exactly (`settlement_reversal`, `reverse:<betId>:<version>`), the
 * version is bumped and the bet is settled again, or reopened when a leg is
 * open again. Every change writes a `bet.settled` / `bet.reopened` outbox event.
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
  const result = (outcome: SettleOutcome, legsChanged: number, row: BetRow = bet) => ({
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
  if (sameSettlement(current, desired)) return result('unchanged', legsChanged);

  let version = bet.settlementVersion;
  if (current !== null) {
    const previous = await loadPostingEntries(tx, settlementLedgerKey(betId, version));
    if (previous === null) {
      throw new Error(`settled bet ${betId} has no posting ${settlementLedgerKey(betId, version)}`);
    }
    try {
      await postTransaction(tx, {
        type: 'settlement_reversal',
        idempotencyKey: reversalLedgerKey(betId, version),
        refType: 'bet',
        refId: betId,
        description: `Reversal of settlement ${version} (result corrected)`,
        entries: negateEntries(previous.entries),
      });
    } catch (error) {
      if (!(error instanceof InsufficientFundsError)) throw error;
      // postTransaction ran in a savepoint, so nothing of the reversal remains.
      const details = {
        betId,
        userId: bet.userId,
        version,
        current: current.status,
        corrected: desired?.status ?? 'open',
        shortfall: toWire(error.amount - error.available),
      };
      await enqueueOutbox(tx, {
        type: BET_CORRECTION_BLOCKED,
        aggregateType: 'bet',
        aggregateId: betId,
        payload: details,
      });
      await writeAudit(tx, {
        actorType: 'system',
        action: BET_CORRECTION_BLOCKED,
        targetType: 'bet',
        targetId: betId,
        metadata: details,
      });
      return result('correction_blocked', legsChanged);
    }
    version += 1;
  }

  if (desired === null) {
    const [row] = await tx
      .update(bets)
      .set({
        status: 'open',
        settlementVersion: version,
        settledGrossPayout: null,
        settledTax: null,
        settledNetPayout: null,
        settledAt: null,
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

  const posting = settlementPosting(bet.userId, bet.stake, desired);
  await postTransaction(tx, {
    type: posting.type,
    idempotencyKey: settlementLedgerKey(betId, version),
    refType: 'bet',
    refId: betId,
    description: `Bet ${desired.status}${version > 0 ? ` (settlement ${version})` : ''}`,
    entries: posting.entries,
  });
  const [row] = await tx
    .update(bets)
    .set({
      status: desired.status,
      settlementVersion: version,
      settledGrossPayout: desired.grossPayout,
      settledTax: desired.taxAmount,
      settledNetPayout: desired.netPayout,
      settledAt: now,
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
