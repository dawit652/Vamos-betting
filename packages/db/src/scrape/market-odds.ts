import {
  type MarketPriceRow,
  SCRAPED_FEED_PROVIDER,
  type ScrapeOddsMarket,
  type ScrapeOddsSelection,
} from '@vamos/core';
import { and, asc, eq, gt, gte, inArray, isNull, lt, sql } from 'drizzle-orm';
import type { DbExecutor, DbTransaction } from '../ledger/types';
import { events } from '../schema/catalog';
import { scrapeMarketOdds, scrapeSources } from '../schema/scrape';
import { clampLimit } from './common';

/**
 * Bookmaker prices from a licensed market feed (docs/scraper.md 3.1, table scrape_market_odds).
 * One row per (source, source key, bookmaker, market, line, selection): the state as of the latest
 * fetch that listed it. Structural types only (this package does not import @vamos/scraper).
 */

export interface MarketOddsInput {
  /** The source's own key for the match (its event id, else a composite). */
  sourceKey: string;
  sport: string;
  competitionRaw: string;
  homeRaw: string;
  awayRaw: string;
  kickoff: Date;
  market: ScrapeOddsMarket;
  line: string | null;
  selection: ScrapeOddsSelection;
  bookmaker: string;
  priceMilli: number;
  priceUpdatedAt: Date;
  /** When the source was read (the document's fetch time). */
  observedAt: Date;
  competitionId: string | null;
  homeTeamId: string | null;
  awayTeamId: string | null;
  eventId: string | null;
}

const WRITE_CHUNK = 400;

/**
 * Writes the rows a document listed, in a stable order (concurrent runs of two sources cannot
 * deadlock). A row that exists is rewritten by the newer sighting; an older sighting never
 * overwrites a newer one. Returns the number of rows written.
 */
export async function upsertMarketOdds(
  tx: DbTransaction,
  input: {
    sourceId: string;
    runId: string;
    rawId: string | null;
    rows: readonly MarketOddsInput[];
  },
): Promise<number> {
  const rows = [...input.rows].sort(
    (a, b) =>
      cmp(a.sourceKey, b.sourceKey) ||
      cmp(a.bookmaker, b.bookmaker) ||
      cmp(a.market, b.market) ||
      cmp(a.line ?? '', b.line ?? '') ||
      cmp(a.selection, b.selection),
  );
  for (const r of rows) {
    if (!Number.isInteger(r.priceMilli) || r.priceMilli < 1010 || r.priceMilli > 1_000_000) {
      throw new RangeError('priceMilli must be an integer from 1010 to 1000000');
    }
    if (Number.isNaN(r.observedAt.getTime()) || Number.isNaN(r.priceUpdatedAt.getTime())) {
      throw new RangeError('observedAt and priceUpdatedAt must be valid dates');
    }
  }
  for (let i = 0; i < rows.length; i += WRITE_CHUNK) {
    await tx
      .insert(scrapeMarketOdds)
      .values(
        rows.slice(i, i + WRITE_CHUNK).map((r) => ({
          sourceId: input.sourceId,
          runId: input.runId,
          rawId: input.rawId,
          sourceKey: r.sourceKey,
          sport: r.sport,
          competitionRaw: r.competitionRaw,
          homeRaw: r.homeRaw,
          awayRaw: r.awayRaw,
          kickoff: r.kickoff,
          competitionId: r.competitionId,
          homeTeamId: r.homeTeamId,
          awayTeamId: r.awayTeamId,
          eventId: r.eventId,
          market: r.market,
          line: r.line,
          selection: r.selection,
          bookmaker: r.bookmaker,
          priceMilli: r.priceMilli,
          priceUpdatedAt: r.priceUpdatedAt,
          observedAt: r.observedAt,
        })),
      )
      .onConflictDoUpdate({
        target: [
          scrapeMarketOdds.sourceId,
          scrapeMarketOdds.sourceKey,
          scrapeMarketOdds.bookmaker,
          scrapeMarketOdds.market,
          scrapeMarketOdds.lineKey,
          scrapeMarketOdds.selection,
        ],
        set: {
          runId: sql`excluded.run_id`,
          rawId: sql`excluded.raw_id`,
          sport: sql`excluded.sport`,
          competitionRaw: sql`excluded.competition_raw`,
          homeRaw: sql`excluded.home_raw`,
          awayRaw: sql`excluded.away_raw`,
          kickoff: sql`excluded.kickoff`,
          competitionId: sql`excluded.competition_id`,
          homeTeamId: sql`excluded.home_team_id`,
          awayTeamId: sql`excluded.away_team_id`,
          eventId: sql`excluded.event_id`,
          priceMilli: sql`excluded.price_milli`,
          priceUpdatedAt: sql`excluded.price_updated_at`,
          observedAt: sql`excluded.observed_at`,
        },
        setWhere: sql`excluded.observed_at >= ${scrapeMarketOdds.observedAt}`,
      });
  }
  return rows.length;
}

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/**
 * A `304 Not Modified` is a sighting of every price the unchanged page lists: moves observed_at,
 * run_id and raw_id of the source's rows that came from snapshot `fromRawId` onto the new run and
 * snapshot. Returns how many rows were touched.
 */
export async function touchMarketOddsOfRaw(
  tx: DbTransaction,
  input: { sourceId: string; fromRawId: string; toRawId: string; runId: string; seenAt: Date },
): Promise<number> {
  const rows = await tx
    .update(scrapeMarketOdds)
    .set({
      observedAt: sql`greatest(${scrapeMarketOdds.observedAt}, ${input.seenAt.toISOString()}::timestamptz)`,
      runId: input.runId,
      rawId: input.toRawId,
    })
    .where(
      and(
        eq(scrapeMarketOdds.sourceId, input.sourceId),
        eq(scrapeMarketOdds.rawId, input.fromRawId),
      ),
    )
    .returning({ id: scrapeMarketOdds.id });
  return rows.length;
}

/**
 * The scraped event a match resolved to, or null: same competition, home and away, start within
 * `windowMs` of the kickoff, and exactly one such event (none or several: null, nothing is
 * guessed). Mirrors rule F3 with a window the caller chooses.
 */
export async function findScrapedEventId(
  exec: DbExecutor,
  match: { competitionId: string; homeTeamId: string; awayTeamId: string; kickoff: Date },
  windowMs: number,
): Promise<string | null> {
  const found = await exec
    .select({ id: events.id })
    .from(events)
    .where(
      and(
        eq(events.feedProvider, SCRAPED_FEED_PROVIDER),
        eq(events.competitionId, match.competitionId),
        eq(events.homeTeamId, match.homeTeamId),
        eq(events.awayTeamId, match.awayTeamId),
        gte(events.startTime, new Date(match.kickoff.getTime() - windowMs)),
        sql`${events.startTime} <= ${new Date(match.kickoff.getTime() + windowMs).toISOString()}::timestamptz`,
      ),
    )
    .limit(2);
  return found.length === 1 ? (found[0]?.id ?? null) : null;
}

/**
 * Links rows that have no event yet (the event was created after the prices were read) to their
 * event, for rows seen since `since`. Returns the number of rows linked.
 */
export async function linkMarketOddsToEvents(
  tx: DbExecutor,
  input: { since: Date; windowMs: number },
): Promise<number> {
  const pending = await tx
    .selectDistinct({
      competitionId: scrapeMarketOdds.competitionId,
      homeTeamId: scrapeMarketOdds.homeTeamId,
      awayTeamId: scrapeMarketOdds.awayTeamId,
      kickoff: scrapeMarketOdds.kickoff,
    })
    .from(scrapeMarketOdds)
    .where(
      and(
        isNull(scrapeMarketOdds.eventId),
        gte(scrapeMarketOdds.observedAt, input.since),
        sql`${scrapeMarketOdds.competitionId} IS NOT NULL AND ${scrapeMarketOdds.homeTeamId} IS NOT NULL AND ${scrapeMarketOdds.awayTeamId} IS NOT NULL`,
      ),
    )
    .orderBy(asc(scrapeMarketOdds.kickoff))
    .limit(500);
  let linked = 0;
  for (const p of pending) {
    if (p.competitionId === null || p.homeTeamId === null || p.awayTeamId === null) continue;
    const eventId = await findScrapedEventId(
      tx,
      {
        competitionId: p.competitionId,
        homeTeamId: p.homeTeamId,
        awayTeamId: p.awayTeamId,
        kickoff: p.kickoff,
      },
      input.windowMs,
    );
    if (eventId === null) continue;
    const rows = await tx
      .update(scrapeMarketOdds)
      .set({ eventId })
      .where(
        and(
          isNull(scrapeMarketOdds.eventId),
          eq(scrapeMarketOdds.competitionId, p.competitionId),
          eq(scrapeMarketOdds.homeTeamId, p.homeTeamId),
          eq(scrapeMarketOdds.awayTeamId, p.awayTeamId),
          eq(scrapeMarketOdds.kickoff, p.kickoff),
        ),
      )
      .returning({ id: scrapeMarketOdds.id });
    linked += rows.length;
  }
  return linked;
}

export interface UnresolvedMarketOddsNames {
  sourceId: string;
  sport: string;
  competitionRaw: string;
  homeRaw: string;
  awayRaw: string;
  competitionId: string | null;
  homeTeamId: string | null;
  awayTeamId: string | null;
}

/** The distinct (source, names) of price rows with a name that has not resolved yet, oldest first. */
export async function listUnresolvedMarketOddsNames(
  exec: DbExecutor,
  options: { since: Date; limit: number },
): Promise<UnresolvedMarketOddsNames[]> {
  return exec
    .selectDistinct({
      sourceId: scrapeMarketOdds.sourceId,
      sport: scrapeMarketOdds.sport,
      competitionRaw: scrapeMarketOdds.competitionRaw,
      homeRaw: scrapeMarketOdds.homeRaw,
      awayRaw: scrapeMarketOdds.awayRaw,
      competitionId: scrapeMarketOdds.competitionId,
      homeTeamId: scrapeMarketOdds.homeTeamId,
      awayTeamId: scrapeMarketOdds.awayTeamId,
    })
    .from(scrapeMarketOdds)
    .where(
      and(
        gte(scrapeMarketOdds.observedAt, options.since),
        sql`(${scrapeMarketOdds.competitionId} IS NULL OR ${scrapeMarketOdds.homeTeamId} IS NULL OR ${scrapeMarketOdds.awayTeamId} IS NULL)`,
      ),
    )
    .orderBy(
      asc(scrapeMarketOdds.sourceId),
      asc(scrapeMarketOdds.competitionRaw),
      asc(scrapeMarketOdds.homeRaw),
      asc(scrapeMarketOdds.awayRaw),
    )
    .limit(clampLimit(options.limit, 1000, 20_000));
}

/**
 * Sets the resolved catalogue ids of every price row of one source with these raw names (after
 * the aliases changed). The event link is cleared when an id is still missing and is made again
 * by `linkMarketOddsToEvents`. Returns the number of rows changed.
 */
export async function setMarketOddsResolution(
  tx: DbTransaction,
  names: {
    sourceId: string;
    sport: string;
    competitionRaw: string;
    homeRaw: string;
    awayRaw: string;
  },
  ids: { competitionId: string | null; homeTeamId: string | null; awayTeamId: string | null },
): Promise<number> {
  const rows = await tx
    .update(scrapeMarketOdds)
    .set({
      competitionId: ids.competitionId,
      homeTeamId: ids.homeTeamId,
      awayTeamId: ids.awayTeamId,
    })
    .where(
      and(
        eq(scrapeMarketOdds.sourceId, names.sourceId),
        eq(scrapeMarketOdds.sport, names.sport),
        eq(scrapeMarketOdds.competitionRaw, names.competitionRaw),
        eq(scrapeMarketOdds.homeRaw, names.homeRaw),
        eq(scrapeMarketOdds.awayRaw, names.awayRaw),
      ),
    )
    .returning({ id: scrapeMarketOdds.id });
  return rows.length;
}

export interface LatestMarketOdd {
  eventId: string;
  sourceId: string;
  /** scrape_sources.upstream: sources sharing it are one voice. */
  upstream: string;
  bookmaker: string;
  market: ScrapeOddsMarket;
  line: string | null;
  selection: ScrapeOddsSelection;
  priceMilli: number;
  /** When the bookmaker last moved the price (the feed's timestamp). */
  priceUpdatedAt: Date;
  /** When a fetch last listed the price: the freshness that counts. */
  observedAt: Date;
}

export interface LatestMarketOddsQuery {
  eventIds: readonly string[];
  now: Date;
  /** Prices last listed longer ago than this are left out. */
  maxAgeMs: number;
}

/**
 * The market prices the pricing step may use, by event: for each (event, source) only what that
 * source's NEWEST sighting of the event listed, kept only if it was listed at or after
 * `now - maxAgeMs` and at or after the start of the source's latest successful (`ok`) run. So:
 *
 * - freshness is when WE last saw the price listed (`observed_at`), not the price's own
 *   `updated_at`: a price that has not moved for 12 hours is current if the latest fetch lists it;
 * - a bookmaker that the source's latest fetch of the event no longer lists drops out whole (its
 *   rows keep an older `observed_at`); an event the latest successful run no longer lists at all
 *   (it started, or every book was dropped) drops out too;
 * - a disabled source never votes (S4);
 * - rows with no event yet are never returned: pricing reads by event id only.
 *
 * It answers for the present: the table holds the current state, not a history to replay.
 *
 * Sorted by event, source, market, line, bookmaker, selection.
 */
export async function latestMarketOdds(
  exec: DbExecutor,
  query: LatestMarketOddsQuery,
): Promise<LatestMarketOdd[]> {
  if (query.eventIds.length === 0) return [];
  const cutoff = new Date(query.now.getTime() - query.maxAgeMs);
  const rows = await exec
    .select({
      eventId: scrapeMarketOdds.eventId,
      sourceId: scrapeMarketOdds.sourceId,
      upstream: scrapeSources.upstream,
      bookmaker: scrapeMarketOdds.bookmaker,
      market: scrapeMarketOdds.market,
      line: scrapeMarketOdds.line,
      selection: scrapeMarketOdds.selection,
      priceMilli: scrapeMarketOdds.priceMilli,
      priceUpdatedAt: scrapeMarketOdds.priceUpdatedAt,
      observedAt: scrapeMarketOdds.observedAt,
    })
    .from(scrapeMarketOdds)
    .innerJoin(scrapeSources, eq(scrapeSources.id, scrapeMarketOdds.sourceId))
    .where(
      and(
        inArray(scrapeMarketOdds.eventId, [...new Set(query.eventIds)]),
        eq(scrapeSources.enabled, true),
        gte(scrapeMarketOdds.observedAt, cutoff),
        sql`${scrapeMarketOdds.observedAt} = (
          SELECT max(m.observed_at) FROM scrape_market_odds m
          WHERE m.event_id = ${scrapeMarketOdds.eventId} AND m.source_id = ${scrapeMarketOdds.sourceId})`,
        sql`${scrapeMarketOdds.observedAt} >= coalesce(
          (SELECT r.started_at FROM scrape_runs r
           WHERE r.source_id = ${scrapeMarketOdds.sourceId} AND r.status = 'ok'
           ORDER BY r.started_at DESC, r.id DESC LIMIT 1),
          '-infinity'::timestamptz)`,
      ),
    )
    .orderBy(
      asc(scrapeMarketOdds.eventId),
      asc(scrapeMarketOdds.sourceId),
      asc(scrapeMarketOdds.market),
      sql`${scrapeMarketOdds.line} ASC NULLS FIRST`,
      asc(scrapeMarketOdds.bookmaker),
      asc(scrapeMarketOdds.selection),
    );
  return rows.map((r) => ({
    eventId: r.eventId as string,
    sourceId: r.sourceId,
    upstream: r.upstream,
    bookmaker: r.bookmaker,
    market: r.market as ScrapeOddsMarket,
    line: r.line,
    selection: r.selection as ScrapeOddsSelection,
    priceMilli: r.priceMilli,
    priceUpdatedAt: r.priceUpdatedAt,
    observedAt: r.observedAt,
  }));
}

/**
 * The rows of latestMarketOdds as consensus input, one bookmaker per (upstream, bookmaker): if
 * several sources of one upstream list the same bookmaker, only the source that saw it last is
 * read (ties: the lowest source id), so one feed never counts twice. The bookmaker is named
 * `<upstream>:<bookmaker>`.
 */
export function consensusRows(rows: readonly LatestMarketOdd[]): MarketPriceRow[] {
  const winner = new Map<string, { sourceId: string; observedAt: number }>();
  for (const row of rows) {
    const key = `${row.upstream}\u0000${row.bookmaker}`;
    const seen = winner.get(key);
    const at = row.observedAt.getTime();
    if (
      seen === undefined ||
      at > seen.observedAt ||
      (at === seen.observedAt && row.sourceId < seen.sourceId)
    ) {
      winner.set(key, { sourceId: row.sourceId, observedAt: at });
    }
  }
  return rows
    .filter((row) => winner.get(`${row.upstream}\u0000${row.bookmaker}`)?.sourceId === row.sourceId)
    .map((row) => ({
      bookmaker: `${row.upstream}:${row.bookmaker}`,
      market: row.market,
      line: row.line,
      selection: row.selection,
      priceMilli: row.priceMilli,
    }));
}

/**
 * Deletes price rows last seen before `olderThan` (the table holds the current state, so these
 * are matches that stopped being listed long ago). At most `limit` rows per call, oldest first.
 */
export async function pruneMarketOdds(
  exec: DbExecutor,
  olderThan: Date,
  limit: number,
): Promise<number> {
  const rows = await exec
    .delete(scrapeMarketOdds)
    .where(
      inArray(
        scrapeMarketOdds.id,
        exec
          .select({ id: scrapeMarketOdds.id })
          .from(scrapeMarketOdds)
          .where(lt(scrapeMarketOdds.observedAt, olderThan))
          .orderBy(asc(scrapeMarketOdds.observedAt), asc(scrapeMarketOdds.id))
          .limit(clampLimit(limit, 1000, 20_000)),
      ),
    )
    .returning({ id: scrapeMarketOdds.id });
  return rows.length;
}

/**
 * Per source, the next kickoff in its own price rows after `after` (the odds reading schedule,
 * docs/theoddsapi-plan/README.md 4.5). A source with no such row is absent from the map.
 */
export async function nextMarketOddsKickoffs(
  exec: DbExecutor,
  input: { sourceIds: readonly string[]; after: Date },
): Promise<Map<string, Date>> {
  if (input.sourceIds.length === 0) return new Map();
  const rows = await exec
    .select({
      sourceId: scrapeMarketOdds.sourceId,
      kickoff: sql<Date>`min(${scrapeMarketOdds.kickoff})`.mapWith(scrapeMarketOdds.kickoff),
    })
    .from(scrapeMarketOdds)
    .where(
      and(
        inArray(scrapeMarketOdds.sourceId, [...input.sourceIds]),
        gt(scrapeMarketOdds.kickoff, input.after),
      ),
    )
    .groupBy(scrapeMarketOdds.sourceId);
  return new Map(rows.map((row) => [row.sourceId, row.kickoff]));
}
