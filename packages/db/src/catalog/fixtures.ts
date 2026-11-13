import {
  canonicalFactoryLine,
  canonicalLine,
  factoryMarket,
  factoryMarketKey,
  factoryMarketSortOrder,
  isFactoryOnlyMarketType,
  isValidOddsMilli,
  MARKET_TYPES,
  marketKey,
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

/**
 * A priced market from the feed (structurally a FeedMarket from @vamos/feed), or a football market
 * of the market factory (plan task 2.3: a factory-only type such as 'htft', with any non-empty
 * subset of its selections, since pricing does not list long shots).
 */
export interface FixtureMarketInput {
  type: MarketTypeCode | (string & {});
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
   * Price expiry (rule P7): when given, every market of `feedMarkets` that this call inserts, or
   * finds open or suspended, gets `price_valid_until` = this instant (also when no price moved:
   * the read confirmed them). Markets not passed keep theirs and so expire unless another read
   * refreshes them. Omitted (the default), `price_valid_until` is not touched.
   */
  priceValidUntil?: Date;
  /**
   * Plan task 2.3: `feedMarkets` holds the COMPLETE set of the market factory's markets for this
   * event as priced now. A stored factory-only market that is not in it (pricing no longer offers
   * it, e.g. its favourite would pay under 1.02, or factory markets were switched off) is
   * suspended by the feed, so its last prices cannot be bet; a feed-suspended one that is in it
   * again is reopened. A trader's suspension is never lifted (setMarketStatus). Today's market
   * types are never touched by this.
   */
  factoryComplete?: boolean;
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
  /** Deltas for an existing event (new markets, odds changes); publish after COMMIT. */
  messages: LiveMessage[];
}

interface PlannedMarket {
  type: string;
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
 * - Live, finished or otherwise resulted events are left untouched.
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
    const inserted = await insertEvent(tx, fixture, options);
    if (inserted !== null) {
      await insertMarkets(tx, inserted.id, planned, source, options.priceValidUntil);
      return {
        eventId: inserted.id,
        gameId: inserted.gameId,
        created: true,
        status: 'scheduled',
        marketsAdded: planned.length,
        oddsChanged: 0,
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
    messages: [],
  };
  if (existing.status !== 'scheduled') return unchanged;

  if (existing.startTime.getTime() !== fixture.startTime.getTime()) {
    await tx
      .update(events)
      .set({ startTime: fixture.startTime, updatedAt: sql`now()` })
      .where(eq(events.id, existing.id));
  }

  const marketRows = await tx
    .select({ id: markets.id, key: markets.key, type: markets.type, status: markets.status })
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
  const missingMarkets: PlannedMarket[] = [];
  const missingSelections: Array<typeof selections.$inferInsert> = [];
  const changes: OddsChange[] = [];
  // The market factory's selections (plan task 2.3): repriced without history rows or live deltas.
  const quietChanges: OddsChange[] = [];
  const quietMarketIds = new Set<string>();
  const refreshed: string[] = [];
  for (const market of planned) {
    const row = marketByKey.get(market.key);
    if (row === undefined) {
      missingMarkets.push(market);
      continue;
    }
    if (!UPDATABLE_MARKETS.has(row.status)) continue;
    refreshed.push(row.id);
    const quiet = isFactoryOnlyMarketType(market.type);
    if (quiet) quietMarketIds.add(row.id);
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
      if (selection.oddsMilli !== reference) {
        (quiet ? quietChanges : changes).push({
          selectionId: current.id,
          oddsMilli: selection.oddsMilli,
          source,
        });
      }
    }
  }

  const added = await insertMarkets(
    tx,
    existing.id,
    missingMarkets,
    source,
    options.priceValidUntil,
  );
  // A factory market is announced by the page load, not by a live delta (plan task 2.3).
  for (const market of added) {
    if (!market.factory) messages.push(marketMessage(existing.id, market.id, 'open'));
  }
  if (options.priceValidUntil !== undefined && refreshed.length > 0) {
    await tx
      .update(markets)
      .set({ priceValidUntil: options.priceValidUntil })
      .where(inArray(markets.id, refreshed));
  }
  if (missingSelections.length > 0) {
    const rows = await tx
      .insert(selections)
      .values(missingSelections)
      .onConflictDoNothing({ target: [selections.marketId, selections.code] })
      .returning({
        id: selections.id,
        marketId: selections.marketId,
        oddsMilli: selections.oddsMilli,
      });
    const recorded = rows.filter((r) => !quietMarketIds.has(r.marketId));
    if (recorded.length > 0) {
      await tx
        .insert(oddsHistory)
        .values(recorded.map((r) => ({ selectionId: r.id, oddsMilli: r.oddsMilli, source })));
    }
  }
  const at = options.now === undefined ? {} : { now: options.now };
  const repriced = await setSelectionOdds(tx, changes, at);
  messages.push(...repriced.messages);
  const quietlyRepriced = await setSelectionOdds(tx, quietChanges, { ...at, record: false });

  if (options.factoryComplete === true) {
    const priced = new Set(planned.map((market) => market.key));
    for (const row of marketRows) {
      if (!isFactoryOnlyMarketType(row.type)) continue;
      const listed = priced.has(row.key);
      if (!listed && row.status === 'open') {
        messages.push(...(await setMarketStatus(tx, row.id, 'suspended')).messages);
      } else if (listed && row.status === 'suspended') {
        // Reopens only a suspension the feed made (setMarketStatus without an actor).
        messages.push(...(await setMarketStatus(tx, row.id, 'open')).messages);
      }
    }
  }

  return {
    ...unchanged,
    marketsAdded: added.length,
    oddsChanged: repriced.changed.length + quietlyRepriced.changed.length,
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
  priceValidUntil?: Date,
): Promise<Array<{ id: string; key: string; factory: boolean }>> {
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
        ...(priceValidUntil === undefined ? {} : { priceValidUntil }),
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
  const selectionRows = await tx.insert(selections).values(selectionValues).returning({
    id: selections.id,
    marketId: selections.marketId,
    oddsMilli: selections.oddsMilli,
  });
  // Opening prices are history for today's markets; a factory market's are in its recipe.
  const factoryKeys = new Set(
    planned.filter((m) => isFactoryOnlyMarketType(m.type)).map((m) => m.key),
  );
  const factoryIds = new Set(
    marketRows.filter((row) => factoryKeys.has(row.key)).map((row) => row.id),
  );
  const recorded = selectionRows.filter((row) => !factoryIds.has(row.marketId));
  if (recorded.length > 0) {
    await tx
      .insert(oddsHistory)
      .values(recorded.map((row) => ({ selectionId: row.id, oddsMilli: row.oddsMilli, source })));
  }
  return marketRows.map((row) => ({ id: row.id, key: row.key, factory: factoryIds.has(row.id) }));
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
  const offered: readonly string[] = SPORT_MARKETS[sport];
  const keys = new Set<string>();
  return feedMarkets.map((market) => {
    if (sport === 'football' && isFactoryOnlyMarketType(market.type)) {
      return planFactoryMarket(market, keys);
    }
    if (!offered.includes(market.type)) {
      throw new RangeError(`market "${String(market.type)}" is not offered for ${sport}`);
    }
    const type = market.type as MarketTypeCode;
    const key = marketKey(type, market.line);
    if (keys.has(key)) throw new RangeError(`market ${key} appears twice`);
    keys.add(key);

    const codes = selectionsFor(type);
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
    const definition = MARKET_TYPES[type];
    return {
      type,
      line: canonicalLine(type, market.line),
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

/**
 * A factory-only football market (plan task 2.3): a market the factory defines, with a non-empty
 * subset of its selections (pricing does not list long shots), each at most once and at valid
 * odds. Ordered after today's types, in catalogue order.
 */
function planFactoryMarket(market: FixtureMarketInput, keys: Set<string>): PlannedMarket {
  const key = factoryMarketKey(market.type, market.line);
  if (keys.has(key)) throw new RangeError(`market ${key} appears twice`);
  keys.add(key);
  const definition = factoryMarket(market.type, market.line);
  const odds = new Map<string, number>();
  for (const selection of market.selections) {
    if (!definition.selections.includes(selection.code)) {
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
  if (odds.size === 0) throw new RangeError(`market ${key} has no selections`);
  return {
    type: definition.type,
    line: canonicalFactoryLine(market.line),
    key,
    sortOrder: factoryMarketSortOrder(market.type, market.line),
    selections: definition.selections.flatMap((code, index) => {
      const price = odds.get(code);
      return price === undefined ? [] : [{ code, oddsMilli: price, sortOrder: index }];
    }),
  };
}
