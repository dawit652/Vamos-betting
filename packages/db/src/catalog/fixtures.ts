import {
  isValidOddsMilli,
  MARKET_TYPES,
  marketKey,
  parseLine,
  selectionsFor,
  SPORT_MARKETS,
  type MarketTypeCode,
  type SportCode,
} from '@vamos/core';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import type { DbTransaction } from '../ledger/types';
import { events, markets, oddsHistory, selections } from '../schema/catalog';
import { isUniqueViolation } from './errors';
import { allocateGameId, GAME_ID_CONSTRAINT, type AllocateGameIdOptions } from './game-id';
import { marketMessage, type EventStatus, type LiveMessage, type MarketStatus } from './live';
import { oddsProvenance, setSelectionOdds, type OddsChange } from './odds';
import { setMarketStatus } from './status';

/** odds_history.source of prematch prices from the feed. */
export const FEED_ODDS_SOURCE = 'feed';

/** A fixture from the feed with its catalogue ids resolved (structurally a FeedFixture & ids). */
export interface UpsertFixtureInput {
  /** OddsFeedProvider.name ('mock', …). */
  feedProvider: string;
  /** Stable reference within the provider. */
  feedRef: string;
  sport: SportCode;
  competitionId: string;
  homeTeamId: string;
  awayTeamId: string;
  startTime: Date;
}

/** A priced market from the feed (structurally a FeedMarket from @vamos/feed). */
export interface FixtureMarketInput {
  type: MarketTypeCode;
  line: string | null;
  selections: ReadonlyArray<{ code: string; oddsMilli: number }>;
}

export interface UpsertFixtureOptions {
  /** odds_history.source of these prices (default 'feed'). */
  source?: string;
  /** The current time, for the bettability of odds deltas (see setSelectionOdds). */
  now?: Date;
  /** Random source for the Game ID (tests). */
  randomInt?: AllocateGameIdOptions['randomInt'];
  /**
   * Also reprice a live event (a real feed's in-play prices). Its start time
   * is left alone.
   */
  allowLive?: boolean;
  /**
   * Treat the given markets as the event's whole priced book: open markets
   * missing from it are suspended (as the feed), and markets the feed had
   * suspended are re-opened when they are back. A real feed passes what has
   * a fresh consensus, so nothing stale stays open.
   */
  suspendMissing?: boolean;
  /**
   * Whether a selection's feed price moved enough to be written, given the
   * reference (the feed's previous price) and the new price. Default: any
   * change.
   */
  shouldWrite?: (reference: number, next: number) => boolean;
  /** When the feed priced the event (events.odds_updated_at); unset leaves it. */
  pricedAt?: Date;
}

export interface UpsertFixtureResult {
  eventId: string;
  gameId: number;
  /** true when the event was inserted by this call. */
  created: boolean;
  /** The event's status; only 'scheduled' events are updated. */
  status: EventStatus;
  marketsAdded: number;
  oddsChanged: number;
  /** Markets suspended or re-opened by `suspendMissing`. */
  marketsSuspended: number;
  marketsReopened: number;
  /** Deltas for an existing event (new markets, odds changes); publish after COMMIT. */
  messages: LiveMessage[];
}

interface PlannedMarket {
  type: MarketTypeCode;
  line: string | null;
  key: string;
  sortOrder: number;
  selections: Array<{ code: string; oddsMilli: number; sortOrder: number }>;
}

/** Attempts at inserting a new event before a Game ID race is given up. */
const MAX_GAME_ID_ATTEMPTS = 5;
const UPDATABLE_MARKETS: ReadonlySet<MarketStatus> = new Set(['open', 'suspended']);

/**
 * Inserts or refreshes one feed fixture, keyed by (feedProvider, feedRef).
 *
 * - New fixture: inserts the event (status 'scheduled', a fresh Game ID), its
 *   markets and selections, and one odds_history row per selection.
 * - Existing scheduled event: moves its start time if the feed did, adds
 *   markets it does not have yet, and reprices open selections of open or
 *   suspended markets whose feed price moved since the feed's previous price
 *   for that selection (odds_history with the same source). A price set since
 *   by a trader or the demo drift therefore stays until the feed itself
 *   moves. odds_history rows are written only for odds that change.
 * - Live events are left untouched unless `allowLive` (a real feed's in-play
 *   prices); finished or otherwise resulted events always are.
 * - With `suspendMissing` (real feeds), the given markets are the whole priced
 *   book: open markets missing from it are suspended as the feed, and the
 *   ones the feed suspended are re-opened once they are back.
 *
 * Markets are validated first (RangeError): a type the sport offers, a valid
 * line, exactly the selections of the type and odds within 1001..1000000.
 * Safe against concurrent calls for the same fixture (the event row is
 * locked; a concurrent insert falls through to the update path).
 */
export async function upsertFixture(
  tx: DbTransaction,
  fixture: UpsertFixtureInput,
  feedMarkets: readonly FixtureMarketInput[],
  options: UpsertFixtureOptions = {},
): Promise<UpsertFixtureResult> {
  checkFixture(fixture);
  const planned = planMarkets(fixture.sport, feedMarkets);
  const source = options.source ?? FEED_ODDS_SOURCE;

  let existing = await lockByRef(tx, fixture);
  if (existing === null) {
    // A real feed (suspendMissing) never creates an event players cannot bet on.
    if (planned.length === 0 && options.suspendMissing === true) {
      throw new RangeError(`fixture ${fixture.feedRef}: a new event needs at least one market`);
    }
    const inserted = await insertEvent(tx, fixture, options);
    if (inserted !== null) {
      await insertMarkets(tx, inserted.id, planned, source);
      return {
        eventId: inserted.id,
        gameId: inserted.gameId,
        created: true,
        status: 'scheduled',
        marketsAdded: planned.length,
        oddsChanged: 0,
        marketsSuspended: 0,
        marketsReopened: 0,
        messages: [],
      };
    }
    // Another transaction inserted the same fixture after our lookup.
    existing = await lockByRef(tx, fixture);
    if (existing === null) {
      throw new Error(`fixture ${fixture.feedProvider}/${fixture.feedRef} vanished during upsert`);
    }
  }

  const unchanged: UpsertFixtureResult = {
    eventId: existing.id,
    gameId: existing.gameId,
    created: false,
    status: existing.status,
    marketsAdded: 0,
    oddsChanged: 0,
    marketsSuspended: 0,
    marketsReopened: 0,
    messages: [],
  };
  const live = existing.status === 'live' && options.allowLive === true;
  if (existing.status !== 'scheduled' && !live) return unchanged;

  if (!live && existing.startTime.getTime() !== fixture.startTime.getTime()) {
    await tx
      .update(events)
      .set({ startTime: fixture.startTime, updatedAt: sql`now()` })
      .where(eq(events.id, existing.id));
  }
  if (options.pricedAt !== undefined) {
    await tx
      .update(events)
      .set({ oddsUpdatedAt: options.pricedAt })
      .where(eq(events.id, existing.id));
  }

  const marketRows = await tx
    .select({
      id: markets.id,
      key: markets.key,
      status: markets.status,
      suspendedBy: markets.suspendedBy,
    })
    .from(markets)
    .where(eq(markets.eventId, existing.id))
    .orderBy(asc(markets.id));
  const marketByKey = new Map(marketRows.map((row) => [row.key, row]));
  const selectionRows =
    marketRows.length === 0
      ? []
      : await tx
          .select({
            id: selections.id,
            marketId: selections.marketId,
            code: selections.code,
            oddsMilli: selections.oddsMilli,
            status: selections.status,
          })
          .from(selections)
          .where(
            inArray(
              selections.marketId,
              marketRows.map((row) => row.id),
            ),
          );
  const selectionByKey = new Map(selectionRows.map((row) => [`${row.marketId}|${row.code}`, row]));
  const provenance = await oddsProvenance(
    tx,
    selectionRows.map((row) => row.id),
  );

  const messages: LiveMessage[] = [];
  const write = options.shouldWrite ?? ((reference: number, next: number) => reference !== next);
  const missingMarkets: PlannedMarket[] = [];
  const missingSelections: Array<typeof selections.$inferInsert> = [];
  const changes: OddsChange[] = [];
  for (const market of planned) {
    const row = marketByKey.get(market.key);
    if (row === undefined) {
      missingMarkets.push(market);
      continue;
    }
    if (!UPDATABLE_MARKETS.has(row.status)) continue;
    for (const selection of market.selections) {
      const current = selectionByKey.get(`${row.id}|${selection.code}`);
      if (current === undefined) {
        missingSelections.push({
          marketId: row.id,
          code: selection.code,
          oddsMilli: selection.oddsMilli,
          sortOrder: selection.sortOrder,
        });
        continue;
      }
      if (current.status !== 'open') continue;
      const previousFeedPrice = provenance.get(current.id)?.bySource.get(source);
      const reference = previousFeedPrice ?? current.oddsMilli;
      if (write(reference, selection.oddsMilli)) {
        changes.push({ selectionId: current.id, oddsMilli: selection.oddsMilli, source });
      }
    }
  }

  // Statuses change before prices, so each odds delta carries the committed bettability.
  let marketsSuspended = 0;
  let marketsReopened = 0;
  if (options.suspendMissing === true) {
    const offered = new Set(planned.map((market) => market.key));
    for (const row of marketRows) {
      const target =
        row.status === 'open' && !offered.has(row.key)
          ? 'suspended'
          : row.status === 'suspended' && row.suspendedBy === 'feed' && offered.has(row.key)
            ? 'open'
            : null;
      if (target === null) continue;
      const change = await setMarketStatus(tx, row.id, target);
      if (!change.changed) continue;
      messages.push(...change.messages);
      if (target === 'open') marketsReopened++;
      else marketsSuspended++;
    }
  }

  const added = await insertMarkets(tx, existing.id, missingMarkets, source);
  for (const marketId of added) messages.push(marketMessage(existing.id, marketId, 'open'));
  if (missingSelections.length > 0) {
    const rows = await tx
      .insert(selections)
      .values(missingSelections)
      .onConflictDoNothing({ target: [selections.marketId, selections.code] })
      .returning({ id: selections.id, oddsMilli: selections.oddsMilli });
    if (rows.length > 0) {
      await tx
        .insert(oddsHistory)
        .values(rows.map((r) => ({ selectionId: r.id, oddsMilli: r.oddsMilli, source })));
    }
  }
  const repriced = await setSelectionOdds(
    tx,
    changes,
    options.now === undefined ? {} : { now: options.now },
  );
  messages.push(...repriced.messages);

  return {
    ...unchanged,
    marketsAdded: added.length,
    oddsChanged: repriced.changed.length,
    marketsSuspended,
    marketsReopened,
    messages,
  };
}

async function lockByRef(
  tx: DbTransaction,
  fixture: UpsertFixtureInput,
): Promise<{ id: string; gameId: number; status: EventStatus; startTime: Date } | null> {
  const [row] = await tx
    .select({
      id: events.id,
      gameId: events.gameId,
      status: events.status,
      startTime: events.startTime,
    })
    .from(events)
    .where(and(eq(events.feedProvider, fixture.feedProvider), eq(events.feedRef, fixture.feedRef)))
    .for('update');
  return row ?? null;
}

/**
 * Inserts the event with a fresh Game ID, retrying (in a savepoint) when a
 * concurrent insert took the same ID. Returns null when the fixture itself
 * was inserted concurrently (ON CONFLICT on the feed reference).
 */
async function insertEvent(
  tx: DbTransaction,
  fixture: UpsertFixtureInput,
  options: UpsertFixtureOptions,
): Promise<{ id: string; gameId: number } | null> {
  const lost = new Set<number>();
  for (let attempt = 1; ; attempt++) {
    const gameId = await allocateGameId(tx, {
      exclude: lost,
      ...(options.randomInt === undefined ? {} : { randomInt: options.randomInt }),
    });
    try {
      const rows = await tx.transaction((sp) =>
        sp
          .insert(events)
          .values({
            gameId,
            sportId: fixture.sport,
            competitionId: fixture.competitionId,
            homeTeamId: fixture.homeTeamId,
            awayTeamId: fixture.awayTeamId,
            startTime: fixture.startTime,
            status: 'scheduled',
            feedProvider: fixture.feedProvider,
            feedRef: fixture.feedRef,
            oddsUpdatedAt: options.pricedAt ?? null,
          })
          .onConflictDoNothing({ target: [events.feedProvider, events.feedRef] })
          .returning({ id: events.id, gameId: events.gameId }),
      );
      return rows[0] ?? null;
    } catch (error) {
      if (attempt >= MAX_GAME_ID_ATTEMPTS || !isUniqueViolation(error, GAME_ID_CONSTRAINT)) {
        throw error;
      }
      lost.add(gameId);
    }
  }
}

/** Inserts markets with their selections and opening odds history; returns the new market ids. */
async function insertMarkets(
  tx: DbTransaction,
  eventId: string,
  planned: readonly PlannedMarket[],
  source: string,
): Promise<string[]> {
  if (planned.length === 0) return [];
  const marketRows = await tx
    .insert(markets)
    .values(
      planned.map((market) => ({
        eventId,
        type: market.type,
        line: market.line,
        key: market.key,
        status: 'open' as const,
        sortOrder: market.sortOrder,
      })),
    )
    .returning({ id: markets.id, key: markets.key });
  const idByKey = new Map(marketRows.map((row) => [row.key, row.id]));
  const selectionValues = planned.flatMap((market) => {
    const marketId = idByKey.get(market.key);
    if (marketId === undefined) throw new Error(`market ${market.key} was not inserted`);
    return market.selections.map((selection) => ({
      marketId,
      code: selection.code,
      oddsMilli: selection.oddsMilli,
      sortOrder: selection.sortOrder,
    }));
  });
  const selectionRows = await tx
    .insert(selections)
    .values(selectionValues)
    .returning({ id: selections.id, oddsMilli: selections.oddsMilli });
  await tx
    .insert(oddsHistory)
    .values(
      selectionRows.map((row) => ({ selectionId: row.id, oddsMilli: row.oddsMilli, source })),
    );
  return marketRows.map((row) => row.id);
}

function checkFixture(fixture: UpsertFixtureInput): void {
  if (typeof fixture.feedProvider !== 'string' || fixture.feedProvider.length === 0) {
    throw new RangeError('fixture.feedProvider is required');
  }
  if (typeof fixture.feedRef !== 'string' || fixture.feedRef.length === 0) {
    throw new RangeError('fixture.feedRef is required');
  }
  if (!Object.hasOwn(SPORT_MARKETS, fixture.sport)) {
    throw new RangeError(`unknown sport: "${String(fixture.sport)}"`);
  }
  if (!(fixture.startTime instanceof Date) || Number.isNaN(fixture.startTime.getTime())) {
    throw new RangeError(`fixture ${fixture.feedRef} has an invalid start time`);
  }
  if (fixture.homeTeamId === fixture.awayTeamId) {
    throw new RangeError(`fixture ${fixture.feedRef}: a team cannot play itself`);
  }
}

/** Validates the feed's markets and puts their selections in display order. */
function planMarkets(
  sport: SportCode,
  feedMarkets: readonly FixtureMarketInput[],
): PlannedMarket[] {
  const offered = SPORT_MARKETS[sport];
  const keys = new Set<string>();
  return feedMarkets.map((market) => {
    if (!offered.includes(market.type)) {
      throw new RangeError(`market "${String(market.type)}" is not offered for ${sport}`);
    }
    const key = marketKey(market.type, market.line);
    if (keys.has(key)) throw new RangeError(`market ${key} appears twice`);
    keys.add(key);

    const codes = selectionsFor(market.type);
    const odds = new Map<string, number>();
    for (const selection of market.selections) {
      if (!codes.includes(selection.code)) {
        throw new RangeError(`invalid selection "${selection.code}" for market ${key}`);
      }
      if (odds.has(selection.code)) {
        throw new RangeError(`selection "${selection.code}" appears twice in market ${key}`);
      }
      if (!isValidOddsMilli(selection.oddsMilli)) {
        throw new RangeError(
          `invalid odds (milli) ${selection.oddsMilli} for ${key} "${selection.code}"`,
        );
      }
      odds.set(selection.code, selection.oddsMilli);
    }
    if (odds.size !== codes.length) {
      throw new RangeError(`market ${key} must price all ${codes.length} selections`);
    }
    const definition = MARKET_TYPES[market.type];
    return {
      type: market.type,
      line: definition.hasLine && market.line !== null ? String(parseLine(market.line)) : null,
      key,
      sortOrder: definition.sortOrder,
      selections: codes.map((code, index) => ({
        code,
        oddsMilli: odds.get(code) ?? 0,
        sortOrder: index,
      })),
    };
  });
}
