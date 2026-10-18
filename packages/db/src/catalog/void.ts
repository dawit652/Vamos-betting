import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { DbTransaction } from '../ledger/types';
import { writeAudit } from '../platform/audit';
import { enqueueOutbox } from '../platform/outbox';
import { betLegs } from '../schema/betting';
import { events, markets, selections } from '../schema/catalog';
import { jackpotGames, jackpotRounds } from '../schema/jackpots';
import { CatalogNotFoundError, CatalogStateError } from './errors';
import { marketMessage, oddsMessage, type LiveMessage, type MarketStatus } from './live';
import { MARKET_RESULTED } from './results';
import type { TradingActor } from './status';

/**
 * Manual voids (back office, trading.void): a trader voids one market or one
 * selection, e.g. a palpable pricing error or a market that cannot be
 * settled. The voided selections get the result void (status settled) and
 * `voided_at`, which every later resulting respects (resultEvent and
 * resultMarket never give them another result, corrections included), and
 * the DB checks that a voided selection stays void.
 *
 * Settlement goes through the existing path: a `market.resulted` outbox
 * event (aggregate 'market', payload { eventId, marketId, status, score:
 * null, voided: { selectionIds, reason, by } }) makes the worker run
 * settlePlacedBet on every bet with a leg on the market (a leg on a voided
 * selection counts as void, odds 1.00; a bet settles once core canSettle
 * allows it, and a bet settled before is re-settled with an exact reversal).
 * The settlement sweep (listBetsToSettle) picks up legs on voided selections
 * whose job was lost. Voiding again is a no-op ('unchanged', nothing
 * written), so retries are safe.
 *
 * Locks like resultEvent: the event FOR UPDATE, then the market, then its
 * selections (FOR UPDATE, which also waits for bet placements holding them
 * FOR SHARE), so a void serialises with resulting, the live simulator,
 * cash-outs and placements.
 */

/** Audit actions of the manual voids. */
export const MARKET_VOIDED = 'catalog.market.voided';
export const SELECTION_VOIDED = 'catalog.selection.voided';

/** Longest void reason kept (audit metadata and outbox payload). */
export const MAX_VOID_REASON_LENGTH = 500;

export interface VoidActor extends TradingActor {
  /** Why (required): shown in the audit log. */
  reason: string;
}

export interface VoidOutcome {
  /** 'voided' when this call voided something; 'unchanged' when it was void already. */
  outcome: 'voided' | 'unchanged';
  eventId: string;
  marketId: string;
  /** Selections voided by this call (empty when unchanged). */
  selectionIds: string[];
  /** The market's status after the call. */
  marketStatus: MarketStatus;
  /** Bets (open or settled) with a leg on the voided selections, which settlement re-checks. */
  affectedBets: number;
  /** Deltas to publish after COMMIT (empty when unchanged). */
  messages: LiveMessage[];
}

function checkedReason(actor: VoidActor): string {
  if (typeof actor?.adminId !== 'string' || actor.adminId.length === 0) {
    throw new RangeError('a manual void needs the admin id');
  }
  const reason = typeof actor.reason === 'string' ? actor.reason.trim() : '';
  if (reason.length === 0) throw new RangeError('a manual void needs a reason');
  return reason.slice(0, MAX_VOID_REASON_LENGTH);
}

interface LockedMarket {
  event: { id: string; status: string };
  market: { id: string; key: string; type: string; status: MarketStatus; voidedAt: Date | null };
  selections: Array<{
    id: string;
    code: string;
    oddsMilli: number;
    result: 'won' | 'lost' | 'void' | null;
    voidedAt: Date | null;
  }>;
}

/** Locks the market's event, the market and its selections (in that order). */
async function lockMarket(tx: DbTransaction, marketId: string): Promise<LockedMarket> {
  const [ref] = await tx
    .select({ eventId: markets.eventId })
    .from(markets)
    .where(eq(markets.id, marketId));
  if (ref === undefined) throw new CatalogNotFoundError('market', marketId);
  const [event] = await tx
    .select({ id: events.id, status: events.status })
    .from(events)
    .where(eq(events.id, ref.eventId))
    .for('update');
  if (event === undefined) throw new CatalogNotFoundError('event', ref.eventId);
  const [market] = await tx
    .select({
      id: markets.id,
      eventId: markets.eventId,
      key: markets.key,
      type: markets.type,
      status: markets.status,
      voidedAt: markets.voidedAt,
    })
    .from(markets)
    .where(eq(markets.id, marketId))
    .for('update');
  if (market === undefined || market.eventId !== event.id) {
    throw new CatalogNotFoundError('market', marketId);
  }
  const rows = await tx
    .select({
      id: selections.id,
      code: selections.code,
      oddsMilli: selections.oddsMilli,
      result: selections.result,
      voidedAt: selections.voidedAt,
    })
    .from(selections)
    .where(eq(selections.marketId, marketId))
    .orderBy(asc(selections.id))
    .for('update');
  return { event, market, selections: rows };
}

async function countBetsOn(tx: DbTransaction, selectionIds: readonly string[]): Promise<number> {
  if (selectionIds.length === 0) return 0;
  const [row] = await tx
    .select({ n: sql<number>`count(DISTINCT ${betLegs.betId})::int` })
    .from(betLegs)
    .where(inArray(betLegs.selectionId, [...selectionIds]));
  return row?.n ?? 0;
}

async function announce(
  tx: DbTransaction,
  locked: LockedMarket,
  input: { status: MarketStatus; selectionIds: string[]; reason: string; adminId: string },
): Promise<void> {
  await enqueueOutbox(tx, {
    type: MARKET_RESULTED,
    aggregateType: 'market',
    aggregateId: locked.market.id,
    payload: {
      eventId: locked.event.id,
      marketId: locked.market.id,
      status: input.status,
      score: null,
      voided: { selectionIds: input.selectionIds, reason: input.reason, by: input.adminId },
    },
  });
}

/**
 * Voids a whole market (any status: open, suspended, closed, or already
 * settled, which is then a correction): every selection becomes void with
 * voided_at, the market `void` with voided_at, and `market.resulted` is
 * written so the bets on it are (re-)settled. A market voided before by a
 * trader is 'unchanged'. Audited as `catalog.market.voided` with the
 * previous status and results. A market resulted void by resultEvent (not
 * by a trader) is voided again here so the void becomes permanent.
 */
export async function voidMarket(
  tx: DbTransaction,
  marketId: string,
  actor: VoidActor,
): Promise<VoidOutcome> {
  const reason = checkedReason(actor);
  const locked = await lockMarket(tx, marketId);
  const { event, market } = locked;
  if (market.voidedAt !== null) {
    return {
      outcome: 'unchanged',
      eventId: event.id,
      marketId,
      selectionIds: [],
      marketStatus: market.status,
      affectedBets: 0,
      messages: [],
    };
  }
  const toVoid = locked.selections.filter((selection) => selection.voidedAt === null);
  const ids = toVoid.map((selection) => selection.id);
  if (ids.length > 0) {
    await tx
      .update(selections)
      .set({ result: 'void', status: 'settled', voidedAt: sql`now()`, updatedAt: sql`now()` })
      .where(inArray(selections.id, ids));
  }
  await tx
    .update(markets)
    .set({
      status: 'void',
      suspendedBy: null,
      resultedInPlay: false,
      voidedAt: sql`now()`,
      settledAt: sql`now()`,
      updatedAt: sql`now()`,
    })
    .where(eq(markets.id, marketId));
  await announce(tx, locked, { status: 'void', selectionIds: ids, reason, adminId: actor.adminId });
  const affectedBets = await countBetsOn(
    tx,
    locked.selections.map((selection) => selection.id),
  );
  await writeAudit(tx, {
    actorType: 'admin',
    actorId: actor.adminId,
    action: MARKET_VOIDED,
    targetType: 'market',
    targetId: marketId,
    metadata: {
      eventId: event.id,
      marketKey: market.key,
      previousStatus: market.status,
      previousResults: Object.fromEntries(
        locked.selections.map((selection) => [selection.code, selection.result]),
      ),
      affectedBets,
      reason,
    },
    ip: actor.ip ?? null,
  });
  return {
    outcome: 'voided',
    eventId: event.id,
    marketId,
    selectionIds: ids,
    marketStatus: 'void',
    affectedBets,
    messages: [marketMessage(event.id, marketId, 'void')],
  };
}

/**
 * Voids one selection: its result becomes void (status settled) with
 * voided_at, whatever the market's status (an already resulted selection
 * is a correction). The market keeps its status (the other selections may
 * still trade or keep their results), except that it becomes `void` when
 * every selection is now void. Writes `market.resulted` so the bets on the
 * market are (re-)settled. A selection voided before by a trader is
 * 'unchanged'.
 *
 * Refused (CatalogStateError) for a selection of the 1X2 market of a game
 * in a jackpot round that is not settled yet (scheduled, open or closed):
 * the jackpot game's result would not add up; void the whole market
 * instead (the game then counts as cancelled). Audited as
 * `catalog.selection.voided`.
 */
export async function voidSelection(
  tx: DbTransaction,
  selectionId: string,
  actor: VoidActor,
): Promise<VoidOutcome> {
  const reason = checkedReason(actor);
  const [ref] = await tx
    .select({ marketId: selections.marketId })
    .from(selections)
    .where(eq(selections.id, selectionId));
  if (ref === undefined) throw new CatalogNotFoundError('selection', selectionId);
  const locked = await lockMarket(tx, ref.marketId);
  const { event, market } = locked;
  const selection = locked.selections.find((row) => row.id === selectionId);
  if (selection === undefined) throw new CatalogNotFoundError('selection', selectionId);
  if (selection.voidedAt !== null) {
    return {
      outcome: 'unchanged',
      eventId: event.id,
      marketId: market.id,
      selectionIds: [],
      marketStatus: market.status,
      affectedBets: 0,
      messages: [],
    };
  }
  const [jackpotGame] = await tx
    .select({ roundId: jackpotGames.roundId })
    .from(jackpotGames)
    .innerJoin(jackpotRounds, eq(jackpotRounds.id, jackpotGames.roundId))
    .where(
      and(
        eq(jackpotGames.marketId, market.id),
        inArray(jackpotRounds.status, ['scheduled', 'open', 'closed']),
      ),
    )
    .limit(1);
  if (jackpotGame !== undefined) {
    throw new CatalogStateError(
      `selection ${selectionId} is an outcome of a game of jackpot round ${jackpotGame.roundId}; ` +
        'void the whole market instead',
    );
  }

  await tx
    .update(selections)
    .set({ result: 'void', status: 'settled', voidedAt: sql`now()`, updatedAt: sql`now()` })
    .where(and(eq(selections.id, selectionId), isNull(selections.voidedAt)));
  const allVoid = locked.selections.every((row) => row.id === selectionId || row.result === 'void');
  const marketStatus: MarketStatus = allVoid ? 'void' : market.status;
  if (allVoid && market.status !== 'void') {
    await tx
      .update(markets)
      .set({
        status: 'void',
        suspendedBy: null,
        settledAt: sql`now()`,
        updatedAt: sql`now()`,
      })
      .where(eq(markets.id, market.id));
  }
  await announce(tx, locked, {
    status: marketStatus,
    selectionIds: [selectionId],
    reason,
    adminId: actor.adminId,
  });
  const affectedBets = await countBetsOn(tx, [selectionId]);
  await writeAudit(tx, {
    actorType: 'admin',
    actorId: actor.adminId,
    action: SELECTION_VOIDED,
    targetType: 'selection',
    targetId: selectionId,
    metadata: {
      eventId: event.id,
      marketId: market.id,
      marketKey: market.key,
      code: selection.code,
      previousResult: selection.result,
      marketStatus,
      affectedBets,
      reason,
    },
    ip: actor.ip ?? null,
  });
  const messages: LiveMessage[] = [oddsMessage(event.id, selectionId, selection.oddsMilli, false)];
  if (marketStatus !== market.status)
    messages.push(marketMessage(event.id, market.id, marketStatus));
  return {
    outcome: 'voided',
    eventId: event.id,
    marketId: market.id,
    selectionIds: [selectionId],
    marketStatus,
    affectedBets,
    messages,
  };
}
