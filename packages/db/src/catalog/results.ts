import {
  certainMarketResult,
  MARKET_TYPES,
  resolveSelection,
  type InPlayScore,
  type MarketResult,
  type MarketTypeCode,
  type ResolutionInput,
  type SelectionResult,
} from '@vamos/core';
import { asc, eq, inArray, sql } from 'drizzle-orm';
import type { DbTransaction } from '../ledger/types';
import { enqueueOutbox } from '../platform/outbox';
import { events, markets, selections } from '../schema/catalog';
import { CatalogNotFoundError, CatalogStateError } from './errors';
import { marketMessage, matchMessage, type LiveMessage, type MarketStatus } from './live';

/** Outbox event types written by resultEvent (aggregate type 'event'). */
export const EVENT_RESULTED = 'event.resulted';
export const EVENT_RESULT_CORRECTED = 'event.result_corrected';
/**
 * Outbox event type written by resultMarket (aggregate type 'market'):
 * payload { eventId, marketId, status, score }.
 */
export const MARKET_RESULTED = 'market.resulted';

export type ResultStatus = ResolutionInput['status'];

/** The resulted score as stored and as put in outbox payloads. */
export interface ResultScore {
  home: number;
  away: number;
  htHome: number | null;
  htAway: number | null;
}

export interface ResultEventOutcome {
  /**
   * 'resulted' on the first call, 'corrected' when an already-resulted event
   * got a different result, 'unchanged' when the same result was given again.
   */
  outcome: 'resulted' | 'corrected' | 'unchanged';
  eventId: string;
  status: ResultStatus;
  /** Markets settled (at least one winning or losing selection) by this call. */
  marketsSettled: number;
  /** Markets voided (every selection void) by this call. */
  marketsVoided: number;
  /** Deltas (the match, each market); publish after COMMIT. */
  messages: LiveMessage[];
}

const RESULT_STATUSES: ReadonlySet<string> = new Set([
  'finished',
  'cancelled',
  'abandoned',
  'postponed',
]);

/**
 * Results an event: resolves every selection of every market with
 * resolveSelection (@vamos/core), marks selections 'settled' with their
 * result, markets 'settled' (or 'void' when every selection is void), and
 * the event finished / cancelled / abandoned / postponed with its score and
 * resulted_at. Writes an 'event.resulted' outbox event in the same
 * transaction.
 *
 * - Markets already settled or void before the first resulting are left as
 *   they are. That includes markets resulted early in play by resultMarket:
 *   their outcome was already certain, so the final score cannot change it,
 *   and a match cancelled or abandoned after that keeps them too (bets on a
 *   market already decided stand, the usual sportsbook rule; the rest are
 *   void).
 * - Calling it again with the same result is a no-op ('unchanged').
 * - Calling it with a different result (a correction) re-resolves the
 *   markets of the event and writes 'event.result_corrected' with the
 *   previous result, so settlement can re-settle affected bets. A correction
 *   to a final score re-resolves every market, those resulted in play too
 *   (one whose result the final score overturns is then no longer counted as
 *   decided in play); a correction to cancelled, abandoned or postponed
 *   leaves the markets resulted in play as they are, exactly as resulting
 *   the event that way first does, so the order of the results never
 *   changes what a decided market pays.
 *
 * - Markets and selections a trader voided (voidMarket / voidSelection:
 *   voided_at set) stay void: resulting and every correction leave a voided
 *   market out and give a voided selection the result void, so the trader's
 *   decision always stands.
 *
 * Invalid input throws RangeError before anything is written: a negative
 * score, a half-time score above the full-time score, a tie for a market
 * that cannot tie ('ml', 'winner'), or a missing half-time score when the
 * event has a half-time market.
 */
export async function resultEvent(
  tx: DbTransaction,
  eventId: string,
  input: ResolutionInput,
): Promise<ResultEventOutcome> {
  const resolution = checkedResolution(input);
  const score = resolution.status === 'finished' ? scoreOf(resolution.score) : null;

  const [event] = await tx.select().from(events).where(eq(events.id, eventId)).for('update');
  if (event === undefined) throw new CatalogNotFoundError('event', eventId);

  const resulted = event.resultedAt !== null;
  const previousScore: ResultScore | null =
    event.status === 'finished' && event.scoreHome !== null && event.scoreAway !== null
      ? {
          home: event.scoreHome,
          away: event.scoreAway,
          htHome: event.htScoreHome,
          htAway: event.htScoreAway,
        }
      : null;
  if (resulted && event.status === resolution.status && sameScore(previousScore, score)) {
    return {
      outcome: 'unchanged',
      eventId,
      status: resolution.status,
      marketsSettled: 0,
      marketsVoided: 0,
      messages: [],
    };
  }

  const marketRows = await tx
    .select({
      id: markets.id,
      type: markets.type,
      line: markets.line,
      status: markets.status,
      resultedInPlay: markets.resultedInPlay,
      voidedAt: markets.voidedAt,
    })
    .from(markets)
    .where(eq(markets.eventId, eventId))
    .orderBy(asc(markets.id))
    .for('update');
  // The first resulting keeps the markets already final. A correction re-resolves
  // them, except that only a final score re-resolves the markets decided in play.
  // A market a trader voided is never resolved again.
  const toResolve = marketRows.filter(
    (market) =>
      market.voidedAt === null &&
      (resulted
        ? resolution.status === 'finished' || !market.resultedInPlay
        : market.status !== 'settled' && market.status !== 'void'),
  );
  const selectionRows =
    toResolve.length === 0
      ? []
      : await tx
          .select({
            id: selections.id,
            marketId: selections.marketId,
            code: selections.code,
            result: selections.result,
            voidedAt: selections.voidedAt,
          })
          .from(selections)
          .where(
            inArray(
              selections.marketId,
              toResolve.map((market) => market.id),
            ),
          )
          .orderBy(asc(selections.id))
          .for('update');

  // Resolve everything in memory first, so a RangeError leaves no partial writes.
  const byResult: Record<SelectionResult, string[]> = { won: [], lost: [], void: [] };
  const selectionsByMarket = new Map<
    string,
    Array<{ id: string; code: string; result: SelectionResult | null; voidedAt: Date | null }>
  >();
  for (const selection of selectionRows) {
    const list = selectionsByMarket.get(selection.marketId) ?? [];
    list.push(selection);
    selectionsByMarket.set(selection.marketId, list);
  }
  const marketStatus = new Map<string, MarketStatus>();
  // Markets decided in play whose result this (final-score) correction overturns.
  const overturned: string[] = [];
  for (const market of toResolve) {
    if (!Object.hasOwn(MARKET_TYPES, market.type)) {
      throw new RangeError(`market ${market.id} has an unknown type "${market.type}"`);
    }
    const type = market.type as MarketTypeCode;
    let allVoid = true;
    for (const selection of selectionsByMarket.get(market.id) ?? []) {
      let result: SelectionResult;
      try {
        // A selection a trader voided stays void.
        result =
          selection.voidedAt !== null
            ? 'void'
            : resolveSelection({ type, line: market.line }, selection.code, resolution);
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        throw new RangeError(`cannot result market ${market.id} (${type}): ${reason}`, {
          cause: error,
        });
      }
      byResult[result].push(selection.id);
      if (result !== 'void') allVoid = false;
      if (market.resultedInPlay && result !== selection.result && !overturned.includes(market.id)) {
        overturned.push(market.id);
      }
    }
    marketStatus.set(market.id, allVoid ? 'void' : 'settled');
  }

  for (const result of ['won', 'lost', 'void'] as const) {
    const ids = byResult[result];
    if (ids.length === 0) continue;
    await tx
      .update(selections)
      .set({ result, status: 'settled', updatedAt: sql`now()` })
      .where(inArray(selections.id, ids));
  }
  const settledIds = toResolve.filter((m) => marketStatus.get(m.id) === 'settled').map((m) => m.id);
  const voidIds = toResolve.filter((m) => marketStatus.get(m.id) === 'void').map((m) => m.id);
  for (const [status, ids] of [
    ['settled', settledIds],
    ['void', voidIds],
  ] as const) {
    if (ids.length === 0) continue;
    await tx
      .update(markets)
      .set({ status, suspendedBy: null, settledAt: sql`now()`, updatedAt: sql`now()` })
      .where(inArray(markets.id, ids));
  }
  if (overturned.length > 0) {
    await tx.update(markets).set({ resultedInPlay: false }).where(inArray(markets.id, overturned));
  }

  const [updated] = await tx
    .update(events)
    .set({
      status: resolution.status,
      ...(score === null
        ? {}
        : {
            scoreHome: score.home,
            scoreAway: score.away,
            htScoreHome: score.htHome,
            htScoreAway: score.htAway,
          }),
      resultedAt: sql`now()`,
      stateChangedAt: sql`now()`,
      updatedAt: sql`now()`,
    })
    .where(eq(events.id, eventId))
    .returning();
  if (updated === undefined) throw new CatalogNotFoundError('event', eventId);

  const payload: Record<string, unknown> = { eventId, status: resolution.status, score };
  if (resulted) {
    payload.previous = { status: event.status, score: previousScore };
  }
  await enqueueOutbox(tx, {
    type: resulted ? EVENT_RESULT_CORRECTED : EVENT_RESULTED,
    aggregateType: 'event',
    aggregateId: eventId,
    payload,
  });

  return {
    outcome: resulted ? 'corrected' : 'resulted',
    eventId,
    status: resolution.status,
    marketsSettled: settledIds.length,
    marketsVoided: voidIds.length,
    messages: [
      matchMessage(updated),
      ...toResolve.map((market) =>
        marketMessage(eventId, market.id, marketStatus.get(market.id) ?? 'settled'),
      ),
    ],
  };
}

function checkedResolution(input: ResolutionInput): ResolutionInput {
  if (typeof input !== 'object' || input === null || !RESULT_STATUSES.has(input.status)) {
    throw new RangeError(
      `result status must be finished, cancelled, abandoned or postponed (got "${String(
        (input as { status?: unknown } | null)?.status,
      )}")`,
    );
  }
  if (input.status !== 'finished') return { status: input.status };
  const score = scoreOf(input.score);
  return { status: 'finished', score };
}

function scoreOf(score: unknown): ResultScore {
  if (typeof score !== 'object' || score === null) {
    throw new RangeError('a finished event needs a score');
  }
  const { home, away, htHome, htAway } = score as Record<string, unknown>;
  const ft = { home: count(home, 'home score'), away: count(away, 'away score') };
  const ht = {
    home: htHome === null || htHome === undefined ? null : count(htHome, 'half-time home score'),
    away: htAway === null || htAway === undefined ? null : count(htAway, 'half-time away score'),
  };
  if ((ht.home === null) !== (ht.away === null)) {
    throw new RangeError('half-time scores must both be given or both be omitted');
  }
  if (ht.home !== null && ht.away !== null && (ht.home > ft.home || ht.away > ft.away)) {
    throw new RangeError(
      `half-time score ${ht.home}-${ht.away} exceeds the full-time score ${ft.home}-${ft.away}`,
    );
  }
  return { home: ft.home, away: ft.away, htHome: ht.home, htAway: ht.away };
}

function count(value: unknown, what: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`invalid ${what}: ${String(value)}`);
  }
  return value;
}

function sameScore(a: ResultScore | null, b: ResultScore | null): boolean {
  if (a === null || b === null) return a === b;
  return a.home === b.home && a.away === b.away && a.htHome === b.htHome && a.htAway === b.htAway;
}

export interface ResultMarketInput {
  /**
   * The in-play score the market is decided on: it must be the event's live
   * score as stored (applyLiveState), so a market is only ever resulted on
   * the score players see.
   */
  score: InPlayScore;
}

export interface ResultMarketOutcome {
  /**
   * 'resulted' when this call settled the market; 'unchanged' when it was
   * already resulted with the same results (nothing written).
   */
  outcome: 'resulted' | 'unchanged';
  eventId: string;
  marketId: string;
  status: 'settled' | 'void';
  /** The market delta; publish after COMMIT (empty when unchanged). */
  messages: LiveMessage[];
}

/**
 * Results ONE market of a live event before full time, when its outcome is
 * already certain from the in-play score (core certainMarketResult: 'over'
 * once the line is passed, 'yes' once both teams scored, correct score
 * 'other' past 4 goals, the half-time result after half time). Sets the
 * selections' results (status 'settled') and the market 'settled' (or
 * 'void' when every selection is void, as resultEvent does), and writes a
 * `market.resulted` outbox event in the same transaction, so settlement
 * settles the bets with a leg on this market (settlePlacedBet settles each
 * once core canSettle allows it).
 *
 * Locks like resultEvent: the event FOR UPDATE, then the market, then its
 * selections, so it serialises with resulting, the live simulator and
 * cash-outs (which take the event FOR SHARE).
 *
 * - Refused (CatalogStateError, nothing written) when the event is not live,
 *   when `score` is not the event's stored live score, and when the outcome
 *   is not certain yet.
 * - Idempotent: a market already resulted with the same results returns
 *   'unchanged' and writes nothing; a market already final with other
 *   results is refused (corrections go through resultEvent, which
 *   re-resolves every market of the event on a final-score correction).
 * - The market is marked resulted_in_play: resultEvent at full time, and
 *   resulting or correcting the event as cancelled, abandoned or postponed,
 *   leave it as it is and result the rest.
 *
 * - A market a trader voided (voidMarket) is left as it is ('unchanged'); a
 *   selection a trader voided (voidSelection) keeps the result void.
 *
 * Invalid input (a bad score, an unknown market type, a selection code the
 * market type does not have) throws RangeError before anything is written.
 */
export async function resultMarket(
  tx: DbTransaction,
  marketId: string,
  input: ResultMarketInput,
): Promise<ResultMarketOutcome> {
  const score = input?.score;
  const [ref] = await tx
    .select({ eventId: markets.eventId })
    .from(markets)
    .where(eq(markets.id, marketId));
  if (ref === undefined) throw new CatalogNotFoundError('market', marketId);

  const [event] = await tx.select().from(events).where(eq(events.id, ref.eventId)).for('update');
  if (event === undefined) throw new CatalogNotFoundError('event', ref.eventId);
  const [market] = await tx
    .select({
      id: markets.id,
      eventId: markets.eventId,
      type: markets.type,
      line: markets.line,
      key: markets.key,
      status: markets.status,
      voidedAt: markets.voidedAt,
    })
    .from(markets)
    .where(eq(markets.id, marketId))
    .for('update');
  if (market === undefined || market.eventId !== event.id) {
    throw new CatalogNotFoundError('market', marketId);
  }
  if (market.voidedAt !== null) {
    return { outcome: 'unchanged', eventId: event.id, marketId, status: 'void', messages: [] };
  }
  if (!Object.hasOwn(MARKET_TYPES, market.type)) {
    throw new RangeError(`market ${market.id} has an unknown type "${market.type}"`);
  }
  const type = market.type as MarketTypeCode;
  const selectionRows = await tx
    .select({
      id: selections.id,
      code: selections.code,
      result: selections.result,
      voidedAt: selections.voidedAt,
    })
    .from(selections)
    .where(eq(selections.marketId, marketId))
    .orderBy(asc(selections.id))
    .for('update');

  let decided: MarketResult | null;
  try {
    decided = certainMarketResult({ type, line: market.line }, score);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new RangeError(`cannot result market ${market.id} (${market.key}): ${reason}`, {
      cause: error,
    });
  }
  // The result of each selection row (RangeError for a code the market type does not have).
  const results =
    decided === null
      ? null
      : selectionRows.map((row) => {
          const decidedResult = decided[row.code];
          if (decidedResult === undefined) {
            throw new RangeError(
              `market ${market.id} (${market.key}) has an unknown selection "${row.code}"`,
            );
          }
          // A selection a trader voided stays void.
          const result: SelectionResult = row.voidedAt !== null ? 'void' : decidedResult;
          return { id: row.id, stored: row.result, result };
        });
  const status = results?.every((row) => row.result === 'void') ? 'void' : 'settled';

  if (market.status === 'settled' || market.status === 'void') {
    const same =
      results !== null &&
      market.status === status &&
      results.every((row) => row.stored === row.result);
    if (!same) {
      throw new CatalogStateError(
        `market ${market.id} is already ${market.status} with other results; correct it with resultEvent`,
      );
    }
    return { outcome: 'unchanged', eventId: event.id, marketId, status, messages: [] };
  }
  if (event.status !== 'live') {
    throw new CatalogStateError(
      `cannot result market ${market.id} in play: event ${event.id} is ${event.status}`,
    );
  }
  if (!isLiveScore(event, score)) {
    throw new CatalogStateError(
      `cannot result market ${market.id}: the score is not event ${event.id}'s live score`,
    );
  }
  if (results === null) {
    throw new CatalogStateError(
      `cannot result market ${market.id} (${market.key}): its outcome is not certain yet`,
    );
  }

  const byResult: Record<SelectionResult, string[]> = { won: [], lost: [], void: [] };
  for (const row of results) byResult[row.result].push(row.id);
  for (const result of ['won', 'lost', 'void'] as const) {
    const ids = byResult[result];
    if (ids.length === 0) continue;
    await tx
      .update(selections)
      .set({ result, status: 'settled', updatedAt: sql`now()` })
      .where(inArray(selections.id, ids));
  }
  await tx
    .update(markets)
    .set({
      status,
      suspendedBy: null,
      resultedInPlay: true,
      settledAt: sql`now()`,
      updatedAt: sql`now()`,
    })
    .where(eq(markets.id, marketId));
  await enqueueOutbox(tx, {
    type: MARKET_RESULTED,
    aggregateType: 'market',
    aggregateId: marketId,
    payload: {
      eventId: event.id,
      marketId,
      status,
      score: {
        home: score.home,
        away: score.away,
        htHome: score.htHome ?? null,
        htAway: score.htAway ?? null,
      },
    },
  });
  return {
    outcome: 'resulted',
    eventId: event.id,
    marketId,
    status,
    messages: [marketMessage(event.id, marketId, status)],
  };
}

/** Whether `score` is the event's stored live score (half-time score included). */
function isLiveScore(
  event: {
    scoreHome: number | null;
    scoreAway: number | null;
    htScoreHome: number | null;
    htScoreAway: number | null;
  },
  score: InPlayScore,
): boolean {
  return (
    event.scoreHome === score.home &&
    event.scoreAway === score.away &&
    event.htScoreHome === (score.htHome ?? null) &&
    event.htScoreAway === (score.htAway ?? null)
  );
}
