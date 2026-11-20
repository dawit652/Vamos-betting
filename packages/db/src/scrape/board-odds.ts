import { SCRAPED_FEED_PROVIDER } from '@vamos/core';
import { and, asc, eq, gt, gte, inArray, isNull, lt, sql } from 'drizzle-orm';
import type { DbExecutor, DbTransaction } from '../ledger/types';
import { events } from '../schema/catalog';
import { settings } from '../schema/platform';
import { scrapeBoardOdds, type BoardMarketJson } from '../schema/scrape';
import { actorLabel, auditScrape, clampLimit, type ScrapeActor } from './common';

/**
 * A competitor's board read as a price source (table scrape_board_odds, docs/plans/hulusport-feed.md):
 * one row per match of the board, rewritten by every read, and the back office switch that decides
 * whether the pricing step uses it. Structural types only (this package does not import
 * @vamos/scraper).
 */

export interface BoardOddsInput {
  /** The board's key for the match, e.g. 'hulusport:2281709'. */
  sourceKey: string;
  board: 'hulusport';
  competitionRaw: string;
  homeRaw: string;
  awayRaw: string;
  kickoff: Date;
  homeTeamId: string | null;
  awayTeamId: string | null;
  eventId: string | null;
  markets: BoardMarketJson[];
  /** When the board's service last confirmed the prices upstream. */
  pricesAt: Date;
  /** When we read them. */
  observedAt: Date;
}

const WRITE_CHUNK = 200;
const MIN_PRICE_MILLI = 1010;
const MAX_PRICE_MILLI = 1_000_000;

/**
 * Writes the rows of one read, in a stable order (two concurrent reads cannot deadlock). A row that
 * exists is rewritten by a newer read; an older read never overwrites a newer one. Returns the
 * number of rows written.
 */
export async function upsertBoardOdds(
  tx: DbTransaction,
  input: readonly BoardOddsInput[],
): Promise<number> {
  const rows = [...input].sort((a, b) =>
    a.sourceKey < b.sourceKey ? -1 : a.sourceKey > b.sourceKey ? 1 : 0,
  );
  for (const r of rows) {
    for (const at of [r.kickoff, r.pricesAt, r.observedAt]) {
      if (Number.isNaN(at.getTime())) throw new RangeError('board odds dates must be valid');
    }
    for (const market of r.markets) {
      for (const p of market.prices) {
        if (
          !Number.isInteger(p.priceMilli) ||
          p.priceMilli < MIN_PRICE_MILLI ||
          p.priceMilli > MAX_PRICE_MILLI
        ) {
          throw new RangeError(
            `priceMilli must be an integer from ${MIN_PRICE_MILLI} to ${MAX_PRICE_MILLI}`,
          );
        }
      }
    }
  }
  for (let i = 0; i < rows.length; i += WRITE_CHUNK) {
    await tx
      .insert(scrapeBoardOdds)
      .values(rows.slice(i, i + WRITE_CHUNK).map((r) => ({ ...r })))
      .onConflictDoUpdate({
        target: scrapeBoardOdds.sourceKey,
        set: {
          competitionRaw: sql`excluded.competition_raw`,
          homeRaw: sql`excluded.home_raw`,
          awayRaw: sql`excluded.away_raw`,
          kickoff: sql`excluded.kickoff`,
          homeTeamId: sql`excluded.home_team_id`,
          awayTeamId: sql`excluded.away_team_id`,
          eventId: sql`excluded.event_id`,
          markets: sql`excluded.markets`,
          pricesAt: sql`excluded.prices_at`,
          observedAt: sql`excluded.observed_at`,
        },
        setWhere: sql`excluded.observed_at >= ${scrapeBoardOdds.observedAt}`,
      });
  }
  return rows.length;
}

/**
 * The scraped event of a board match by its two teams: start within `windowMs` of the kickoff and
 * exactly one such event (none or several: null, nothing is guessed). The competition is not
 * compared: boards name competitions their own way, and two teams do not meet twice within hours.
 */
export async function findEventByTeams(
  exec: DbExecutor,
  match: { homeTeamId: string; awayTeamId: string; kickoff: Date },
  windowMs: number,
): Promise<string | null> {
  const found = await exec
    .select({ id: events.id })
    .from(events)
    .where(
      and(
        eq(events.feedProvider, SCRAPED_FEED_PROVIDER),
        eq(events.homeTeamId, match.homeTeamId),
        eq(events.awayTeamId, match.awayTeamId),
        gte(events.startTime, new Date(match.kickoff.getTime() - windowMs)),
        sql`${events.startTime} <= ${new Date(match.kickoff.getTime() + windowMs).toISOString()}::timestamptz`,
      ),
    )
    .limit(2);
  return found.length === 1 ? (found[0]?.id ?? null) : null;
}

export interface LatestBoardOdds {
  sourceKey: string;
  markets: BoardMarketJson[];
  pricesAt: Date;
}

/**
 * The board prices the pricing step may use for an event: the one row linked to it whose prices
 * were confirmed upstream and read by us within `maxAgeMs`. Two rows linked to one event (the board
 * lists the match twice) is a conflict: null, as with no row at all.
 */
export async function latestBoardOdds(
  exec: DbExecutor,
  query: { eventId: string; now: Date; maxAgeMs: number },
): Promise<LatestBoardOdds | null> {
  const cutoff = new Date(query.now.getTime() - query.maxAgeMs);
  const rows = await exec
    .select({
      sourceKey: scrapeBoardOdds.sourceKey,
      markets: scrapeBoardOdds.markets,
      pricesAt: scrapeBoardOdds.pricesAt,
    })
    .from(scrapeBoardOdds)
    .where(
      and(
        eq(scrapeBoardOdds.eventId, query.eventId),
        gte(scrapeBoardOdds.pricesAt, cutoff),
        gte(scrapeBoardOdds.observedAt, cutoff),
      ),
    )
    .limit(2);
  return rows.length === 1 ? rows[0]! : null;
}

/** Of these board keys, those whose prices are fresh (confirmed upstream and read within `maxAgeMs`). */
export async function freshBoardKeys(
  exec: DbExecutor,
  query: { sourceKeys: readonly string[]; now: Date; maxAgeMs: number },
): Promise<Set<string>> {
  if (query.sourceKeys.length === 0) return new Set();
  const cutoff = new Date(query.now.getTime() - query.maxAgeMs);
  const rows = await exec
    .select({ key: scrapeBoardOdds.sourceKey })
    .from(scrapeBoardOdds)
    .where(
      and(
        inArray(scrapeBoardOdds.sourceKey, [...new Set(query.sourceKeys)]),
        gte(scrapeBoardOdds.pricesAt, cutoff),
        gte(scrapeBoardOdds.observedAt, cutoff),
      ),
    );
  return new Set(rows.map((r) => r.key));
}

/** Deletes rows no read has listed since `olderThan`, at most `limit` per call, oldest first. */
export async function pruneBoardOdds(
  exec: DbExecutor,
  olderThan: Date,
  limit: number,
): Promise<number> {
  const rows = await exec
    .delete(scrapeBoardOdds)
    .where(
      inArray(
        scrapeBoardOdds.sourceKey,
        exec
          .select({ key: scrapeBoardOdds.sourceKey })
          .from(scrapeBoardOdds)
          .where(lt(scrapeBoardOdds.observedAt, olderThan))
          .orderBy(asc(scrapeBoardOdds.observedAt))
          .limit(clampLimit(limit, 1000, 20_000)),
      ),
    )
    .returning({ key: scrapeBoardOdds.sourceKey });
  return rows.length;
}

export interface BoardOddsSummary {
  /** Upcoming matches on the board as last read. */
  upcoming: number;
  /** Of those, linked to a Nahubet event. */
  linked: number;
  /** Linked with prices fresh enough to use (`maxAgeMs`). */
  fresh: number;
  lastReadAt: Date | null;
  newestPricesAt: Date | null;
  /** Upcoming matches that did not link, soonest first (`limit`): names to map. */
  unlinked: Array<{
    competitionRaw: string;
    homeRaw: string;
    awayRaw: string;
    kickoff: Date;
    teamsResolved: boolean;
  }>;
}

/** What the back office shows about the board. */
export async function boardOddsSummary(
  exec: DbExecutor,
  options: { now: Date; maxAgeMs: number; limit: number },
): Promise<BoardOddsSummary> {
  const cutoff = new Date(options.now.getTime() - options.maxAgeMs);
  const upcoming = gt(scrapeBoardOdds.kickoff, options.now);
  const [counts] = await exec
    .select({
      upcoming:
        sql<number>`count(*) FILTER (WHERE ${scrapeBoardOdds.kickoff} > ${options.now.toISOString()}::timestamptz)`.mapWith(
          Number,
        ),
      linked:
        sql<number>`count(*) FILTER (WHERE ${scrapeBoardOdds.kickoff} > ${options.now.toISOString()}::timestamptz AND ${scrapeBoardOdds.eventId} IS NOT NULL)`.mapWith(
          Number,
        ),
      fresh:
        sql<number>`count(*) FILTER (WHERE ${scrapeBoardOdds.kickoff} > ${options.now.toISOString()}::timestamptz AND ${scrapeBoardOdds.eventId} IS NOT NULL AND ${scrapeBoardOdds.pricesAt} >= ${cutoff.toISOString()}::timestamptz AND ${scrapeBoardOdds.observedAt} >= ${cutoff.toISOString()}::timestamptz)`.mapWith(
          Number,
        ),
      lastReadAt: sql<Date | null>`max(${scrapeBoardOdds.observedAt})`.mapWith(
        scrapeBoardOdds.observedAt,
      ),
      newestPricesAt: sql<Date | null>`max(${scrapeBoardOdds.pricesAt})`.mapWith(
        scrapeBoardOdds.pricesAt,
      ),
    })
    .from(scrapeBoardOdds);
  const unlinked = await exec
    .select({
      competitionRaw: scrapeBoardOdds.competitionRaw,
      homeRaw: scrapeBoardOdds.homeRaw,
      awayRaw: scrapeBoardOdds.awayRaw,
      kickoff: scrapeBoardOdds.kickoff,
      teamsResolved: sql<boolean>`${scrapeBoardOdds.homeTeamId} IS NOT NULL AND ${scrapeBoardOdds.awayTeamId} IS NOT NULL`,
    })
    .from(scrapeBoardOdds)
    .where(
      and(
        upcoming,
        isNull(scrapeBoardOdds.eventId),
        // A match listed as a board event of its own is not "not linked".
        sql`NOT EXISTS (SELECT 1 FROM events e WHERE e.feed_provider = 'hulusport'
              AND 'hulusport:' || e.feed_ref = ${scrapeBoardOdds.sourceKey})`,
      ),
    )
    .orderBy(asc(scrapeBoardOdds.kickoff), asc(scrapeBoardOdds.sourceKey))
    .limit(clampLimit(options.limit, 20, 200));
  return {
    upcoming: counts?.upcoming ?? 0,
    linked: counts?.linked ?? 0,
    fresh: counts?.fresh ?? 0,
    lastReadAt: counts?.lastReadAt ?? null,
    newestPricesAt: counts?.newestPricesAt ?? null,
    unlinked,
  };
}

// ---------------------------------------------------------------------------
// The back office switch (settings key `hulusport_pricing`)

export const HULUSPORT_PRICING_SETTING = 'hulusport_pricing';

export interface HulusportPricing {
  /** On: events with fresh Hulusport prices take them (with our margin). Off (the default): our own prices. */
  enabled: boolean;
  updatedAt: Date | null;
  updatedBy: string | null;
}

/** The switch; no row, or anything but `{ "enabled": true }`, is off (fail closed). */
export async function getHulusportPricing(exec: DbExecutor): Promise<HulusportPricing> {
  const [row] = await exec
    .select({ value: settings.value, updatedAt: settings.updatedAt, updatedBy: settings.updatedBy })
    .from(settings)
    .where(eq(settings.key, HULUSPORT_PRICING_SETTING));
  if (row === undefined) return { enabled: false, updatedAt: null, updatedBy: null };
  const value = row.value as { enabled?: unknown } | null;
  return {
    enabled: typeof value === 'object' && value !== null && value.enabled === true,
    updatedAt: row.updatedAt,
    updatedBy: row.updatedBy,
  };
}

/** Turns the switch on or off, audited with before and after; a call that changes nothing writes nothing. */
export async function setHulusportPricing(
  tx: DbTransaction,
  enabled: boolean,
  actor: ScrapeActor,
): Promise<HulusportPricing> {
  await tx
    .insert(settings)
    .values({
      key: HULUSPORT_PRICING_SETTING,
      value: { enabled: false },
      updatedBy: actorLabel(actor),
    })
    .onConflictDoNothing();
  await tx
    .select({ key: settings.key })
    .from(settings)
    .where(eq(settings.key, HULUSPORT_PRICING_SETTING))
    .for('update');
  const before = await getHulusportPricing(tx);
  if (before.enabled === enabled) return before;
  await tx
    .update(settings)
    .set({ value: { enabled }, updatedAt: sql`now()`, updatedBy: actorLabel(actor) })
    .where(eq(settings.key, HULUSPORT_PRICING_SETTING));
  await auditScrape(tx, actor, {
    action: 'scrape.hulusport_pricing.updated',
    targetType: 'setting',
    targetId: HULUSPORT_PRICING_SETTING,
    metadata: { before: { enabled: before.enabled }, after: { enabled } },
  });
  return getHulusportPricing(tx);
}
