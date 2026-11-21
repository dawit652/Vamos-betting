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

/** The competitor boards read as price sources: Hulusport (mr-x) and Narobet (mr-z). */
export type BoardName = 'hulusport' | 'narobet';

export interface BoardOddsInput {
  /** The board's key for the match, e.g. 'hulusport:2281709' or 'narobet:<mr-z id>'. */
  sourceKey: string;
  board: BoardName;
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
  /** API-Football's fixture id, when the board carries it (Narobet). */
  fixtureId?: number | null;
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
      .values(rows.slice(i, i + WRITE_CHUNK).map((r) => ({ ...r, fixtureId: r.fixtureId ?? null })))
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
          fixtureId: sql`excluded.fixture_id`,
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
 * The board prices the pricing step may use for an event: the one row of `board` (default
 * Hulusport) linked to it whose prices were confirmed upstream and read by us within `maxAgeMs`.
 * Two rows of that board linked to one event (the board lists the match twice) is a conflict: null,
 * as with no row at all.
 */
export async function latestBoardOdds(
  exec: DbExecutor,
  query: { eventId: string; now: Date; maxAgeMs: number; board?: BoardName },
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
        // One board at a time: a match on both boards is not a conflict.
        eq(scrapeBoardOdds.board, query.board ?? 'hulusport'),
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

/** When the prices of these board keys were confirmed upstream and read, and the kickoff stored. */
export async function boardOddsTimes(
  exec: DbExecutor,
  sourceKeys: readonly string[],
): Promise<Map<string, { pricesAt: Date; observedAt: Date; kickoff: Date }>> {
  const out = new Map<string, { pricesAt: Date; observedAt: Date; kickoff: Date }>();
  const keys = [...new Set(sourceKeys)];
  for (let i = 0; i < keys.length; i += 1000) {
    const rows = await exec
      .select({
        key: scrapeBoardOdds.sourceKey,
        pricesAt: scrapeBoardOdds.pricesAt,
        observedAt: scrapeBoardOdds.observedAt,
        kickoff: scrapeBoardOdds.kickoff,
      })
      .from(scrapeBoardOdds)
      .where(inArray(scrapeBoardOdds.sourceKey, keys.slice(i, i + 1000)));
    for (const r of rows) {
      out.set(r.key, { pricesAt: r.pricesAt, observedAt: r.observedAt, kickoff: r.kickoff });
    }
  }
  return out;
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

/** What the back office shows about a board (default Hulusport). */
export async function boardOddsSummary(
  exec: DbExecutor,
  options: {
    now: Date;
    maxAgeMs: number;
    limit: number;
    board?: BoardName;
    /**
     * A graded freshness instead of one age (Narobet: by the time left to the kickoff): the first
     * step whose `aheadMs` the kickoff is within gives the age; beyond the last step, `maxAgeMs`.
     */
    steps?: ReadonlyArray<{ aheadMs: number; maxAgeMs: number }>;
  },
): Promise<BoardOddsSummary> {
  const cutoff = new Date(options.now.getTime() - options.maxAgeMs);
  const board = options.board ?? 'hulusport';
  const nowAt = sql`${options.now.toISOString()}::timestamptz`;
  const ms = (n: number) => sql`(${n} * interval '1 millisecond')`;
  // The oldest prices still fresh for this row's kickoff.
  const freshFrom =
    options.steps === undefined || options.steps.length === 0
      ? sql`${cutoff.toISOString()}::timestamptz`
      : sql`(${nowAt} - CASE ${sql.join(
          options.steps.map(
            (step) =>
              sql`WHEN ${scrapeBoardOdds.kickoff} <= ${nowAt} + ${ms(step.aheadMs)} THEN ${ms(step.maxAgeMs)}`,
          ),
          sql` `,
        )} ELSE ${ms(options.maxAgeMs)} END)`;
  const ofBoard = eq(scrapeBoardOdds.board, board);
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
        sql<number>`count(*) FILTER (WHERE ${scrapeBoardOdds.kickoff} > ${nowAt} AND ${scrapeBoardOdds.eventId} IS NOT NULL AND ${scrapeBoardOdds.pricesAt} >= ${freshFrom} AND ${scrapeBoardOdds.observedAt} >= ${freshFrom})`.mapWith(
          Number,
        ),
      lastReadAt: sql<Date | null>`max(${scrapeBoardOdds.observedAt})`.mapWith(
        scrapeBoardOdds.observedAt,
      ),
      newestPricesAt: sql<Date | null>`max(${scrapeBoardOdds.pricesAt})`.mapWith(
        scrapeBoardOdds.pricesAt,
      ),
    })
    .from(scrapeBoardOdds)
    .where(ofBoard);
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
        ofBoard,
        upcoming,
        isNull(scrapeBoardOdds.eventId),
        // A match listed as a board event of its own is not "not linked" (the board's events have
        // the board's name as feed provider, and source keys '<board>:<feed ref>').
        sql`NOT EXISTS (SELECT 1 FROM events e WHERE e.feed_provider = ${board}
              AND ${board} || ':' || e.feed_ref = ${scrapeBoardOdds.sourceKey})`,
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
// The back office switches (settings keys `hulusport_pricing` and `narobet_pricing`)

export const HULUSPORT_PRICING_SETTING = 'hulusport_pricing';
export const NAROBET_PRICING_SETTING = 'narobet_pricing';

const PRICING_SETTING: Readonly<Record<BoardName, string>> = {
  hulusport: HULUSPORT_PRICING_SETTING,
  narobet: NAROBET_PRICING_SETTING,
};

export interface BoardPricing {
  /** On: events with fresh prices of this board take them (with our margin). Off (the default): not. */
  enabled: boolean;
  updatedAt: Date | null;
  updatedBy: string | null;
}
/** The Hulusport switch (the name it had before Narobet). */
export type HulusportPricing = BoardPricing;

/** A board's switch; no row, or anything but `{ "enabled": true }`, is off (fail closed). */
export async function getBoardPricing(exec: DbExecutor, board: BoardName): Promise<BoardPricing> {
  const key = PRICING_SETTING[board];
  const [row] = await exec
    .select({ value: settings.value, updatedAt: settings.updatedAt, updatedBy: settings.updatedBy })
    .from(settings)
    .where(eq(settings.key, key));
  if (row === undefined) return { enabled: false, updatedAt: null, updatedBy: null };
  const value = row.value as { enabled?: unknown } | null;
  return {
    enabled: typeof value === 'object' && value !== null && value.enabled === true,
    updatedAt: row.updatedAt,
    updatedBy: row.updatedBy,
  };
}

/**
 * Turns a board's switch on or off, audited (`scrape.<board>_pricing.updated`) with before and
 * after; a call that changes nothing writes nothing.
 */
export async function setBoardPricing(
  tx: DbTransaction,
  board: BoardName,
  enabled: boolean,
  actor: ScrapeActor,
): Promise<BoardPricing> {
  const key = PRICING_SETTING[board];
  await tx
    .insert(settings)
    .values({ key, value: { enabled: false }, updatedBy: actorLabel(actor) })
    .onConflictDoNothing();
  await tx.select({ key: settings.key }).from(settings).where(eq(settings.key, key)).for('update');
  const before = await getBoardPricing(tx, board);
  if (before.enabled === enabled) return before;
  await tx
    .update(settings)
    .set({ value: { enabled }, updatedAt: sql`now()`, updatedBy: actorLabel(actor) })
    .where(eq(settings.key, key));
  await auditScrape(tx, actor, {
    action: `scrape.${key}.updated`,
    targetType: 'setting',
    targetId: key,
    metadata: { before: { enabled: before.enabled }, after: { enabled } },
  });
  return getBoardPricing(tx, board);
}

// ---------------------------------------------------------------------------
// Narobet-only matches (settings key `narobet_events`, docs/plans/narobet-events.md)

export const NAROBET_EVENTS_SETTING = 'narobet_events';
/** How far ahead Narobet-only matches are listed by default (owner, 21 Nov 2026: 30 days). */
export const NAROBET_EVENTS_DEFAULT_HORIZON_DAYS = 30;
/** mr-z reads Narobet 30 days ahead: a longer horizon would list nothing more. */
export const NAROBET_EVENTS_MAX_HORIZON_DAYS = 30;

export interface NarobetEventsSwitch {
  /** On: Narobet matches Nahubet does not list become events of their own. Off (the default): not. */
  enabled: boolean;
  /** How many days ahead they are listed (1..NAROBET_EVENTS_MAX_HORIZON_DAYS). */
  horizonDays: number;
  updatedAt: Date | null;
  updatedBy: string | null;
}

function horizonOf(value: unknown): number {
  return typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= 1 &&
    value <= NAROBET_EVENTS_MAX_HORIZON_DAYS
    ? value
    : NAROBET_EVENTS_DEFAULT_HORIZON_DAYS;
}

/** The switch; no row, or anything but `enabled: true`, is off (fail closed). */
export async function getNarobetEvents(exec: DbExecutor): Promise<NarobetEventsSwitch> {
  const [row] = await exec
    .select({ value: settings.value, updatedAt: settings.updatedAt, updatedBy: settings.updatedBy })
    .from(settings)
    .where(eq(settings.key, NAROBET_EVENTS_SETTING));
  if (row === undefined) {
    return {
      enabled: false,
      horizonDays: NAROBET_EVENTS_DEFAULT_HORIZON_DAYS,
      updatedAt: null,
      updatedBy: null,
    };
  }
  const value = (row.value ?? {}) as { enabled?: unknown; horizonDays?: unknown };
  return {
    enabled: typeof value === 'object' && value.enabled === true,
    horizonDays: horizonOf(value.horizonDays),
    updatedAt: row.updatedAt,
    updatedBy: row.updatedBy,
  };
}

/**
 * Turns Narobet-only matches on or off and/or sets how many days ahead they are listed, audited
 * (`scrape.narobet_events.updated`) with before and after; a call that changes nothing writes
 * nothing. A horizon outside 1..NAROBET_EVENTS_MAX_HORIZON_DAYS is refused (RangeError).
 */
export async function setNarobetEvents(
  tx: DbTransaction,
  change: { enabled?: boolean; horizonDays?: number },
  actor: ScrapeActor,
): Promise<NarobetEventsSwitch> {
  if (change.horizonDays !== undefined && horizonOf(change.horizonDays) !== change.horizonDays) {
    throw new RangeError(`horizonDays must be an integer 1..${NAROBET_EVENTS_MAX_HORIZON_DAYS}`);
  }
  await tx
    .insert(settings)
    .values({
      key: NAROBET_EVENTS_SETTING,
      value: { enabled: false, horizonDays: NAROBET_EVENTS_DEFAULT_HORIZON_DAYS },
      updatedBy: actorLabel(actor),
    })
    .onConflictDoNothing();
  await tx
    .select({ key: settings.key })
    .from(settings)
    .where(eq(settings.key, NAROBET_EVENTS_SETTING))
    .for('update');
  const before = await getNarobetEvents(tx);
  const after = {
    enabled: change.enabled ?? before.enabled,
    horizonDays: change.horizonDays ?? before.horizonDays,
  };
  if (after.enabled === before.enabled && after.horizonDays === before.horizonDays) return before;
  await tx
    .update(settings)
    .set({ value: after, updatedAt: sql`now()`, updatedBy: actorLabel(actor) })
    .where(eq(settings.key, NAROBET_EVENTS_SETTING));
  await auditScrape(tx, actor, {
    action: `scrape.${NAROBET_EVENTS_SETTING}.updated`,
    targetType: 'setting',
    targetId: NAROBET_EVENTS_SETTING,
    metadata: {
      before: { enabled: before.enabled, horizonDays: before.horizonDays },
      after,
    },
  });
  return getNarobetEvents(tx);
}

/** The Hulusport switch (unchanged callers). */
export const getHulusportPricing = (exec: DbExecutor): Promise<BoardPricing> =>
  getBoardPricing(exec, 'hulusport');
export const setHulusportPricing = (
  tx: DbTransaction,
  enabled: boolean,
  actor: ScrapeActor,
): Promise<BoardPricing> => setBoardPricing(tx, 'hulusport', enabled, actor);
