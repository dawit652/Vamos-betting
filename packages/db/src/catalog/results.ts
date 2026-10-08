import {
  MARKET_TYPES,
  resolveSelection,
  type MarketTypeCode,
  type ResolutionInput,
  type SelectionResult,
} from '@vamos/core';
import { asc, eq, inArray, sql } from 'drizzle-orm';
import type { DbTransaction } from '../ledger/types';
import { enqueueOutbox } from '../platform/outbox';
import { events, markets, selections } from '../schema/catalog';
import { CatalogNotFoundError } from './errors';
import { marketMessage, matchMessage, type LiveMessage, type MarketStatus } from './live';

/** Outbox event types written by resultEvent (aggregate type 'event'). */
export const EVENT_RESULTED = 'event.resulted';
export const EVENT_RESULT_CORRECTED = 'event.result_corrected';

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
 *   they are.
 * - Calling it again with the same result is a no-op ('unchanged').
 * - Calling it with a different result (a correction) re-resolves every
 *   market of the event and writes 'event.result_corrected' with the
 *   previous result, so settlement can re-settle affected bets.
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
    .select({ id: markets.id, type: markets.type, line: markets.line, status: markets.status })
    .from(markets)
    .where(eq(markets.eventId, eventId))
    .orderBy(asc(markets.id))
    .for('update');
  // A correction re-resolves everything; the first resulting keeps markets already final.
  const toResolve = resulted
    ? marketRows
    : marketRows.filter((market) => market.status !== 'settled' && market.status !== 'void');
  const selectionRows =
    toResolve.length === 0
      ? []
      : await tx
          .select({ id: selections.id, marketId: selections.marketId, code: selections.code })
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
  const selectionsByMarket = new Map<string, Array<{ id: string; code: string }>>();
  for (const selection of selectionRows) {
    const list = selectionsByMarket.get(selection.marketId) ?? [];
    list.push(selection);
    selectionsByMarket.set(selection.marketId, list);
  }
  const marketStatus = new Map<string, MarketStatus>();
  for (const market of toResolve) {
    if (!Object.hasOwn(MARKET_TYPES, market.type)) {
      throw new RangeError(`market ${market.id} has an unknown type "${market.type}"`);
    }
    const type = market.type as MarketTypeCode;
    let allVoid = true;
    for (const selection of selectionsByMarket.get(market.id) ?? []) {
      let result: SelectionResult;
      try {
        result = resolveSelection({ type, line: market.line }, selection.code, resolution);
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        throw new RangeError(`cannot result market ${market.id} (${type}): ${reason}`, {
          cause: error,
        });
      }
      byResult[result].push(selection.id);
      if (result !== 'void') allVoid = false;
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
      .set({ status, settledAt: sql`now()`, updatedAt: sql`now()` })
      .where(inArray(markets.id, ids));
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
