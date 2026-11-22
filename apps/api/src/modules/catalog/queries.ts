import type {
  CompetitionsResponse,
  EventDetail,
  EventListQuery,
  EventListResponse,
  EventSummary,
  SearchQuery,
  SearchResponse,
  SportsResponse,
} from '@vamos/contracts';
import { parseGameId } from '@vamos/core';
import type { DbExecutor } from '@vamos/db';
import { normalizeName } from '@vamos/scraper';
import {
  categories,
  competitionAliases,
  competitions,
  events,
  markets,
  selections,
  sports,
  teamAliases,
  teams,
  teamLogos,
} from '@vamos/db/schema';
import { and, asc, eq, gt, gte, inArray, lt, or, sql, type AnyColumn, type SQL } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { badRequest } from '../../lib/errors';
import {
  eventDetailView,
  eventSummaryView,
  findMainMarket,
  groupBy,
  isSportCode,
  localized,
  type EventRow,
  type MarketRow,
  type SelectionRow,
  type ViewOptions,
} from './views';

const HOUR_MS = 60 * 60_000;
/** "Upcoming" (and a competition's event count) looks this far ahead (owner, 23 Nov 2026: 30 days). */
export const UPCOMING_WINDOW_MS = 30 * 24 * HOUR_MS;
/**
 * A match still marked live this long after its kick-off has ended in reality (its result is
 * late): it is no longer listed (owner, 23 Nov 2026: finished matches disappear from the lists).
 */
export const LIVE_LISTED_FOR_MS = 4 * HOUR_MS;
/** Highlights show scheduled events of featured competitions starting this soon. */
export const HIGHLIGHTS_WINDOW_MS = 24 * HOUR_MS;
/** Africa/Addis_Ababa is UTC+3 all year (no daylight saving). */
export const ADDIS_ABABA_OFFSET_MS = 3 * HOUR_MS;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CURSOR_RE = /^[A-Za-z0-9_-]{1,200}$/;
/** start_time as written by `cursorTime` below: UTC with microseconds. */
const CURSOR_TIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;

export function isUuid(value: string): boolean {
  return UUID_RE.test(value);
}

/** [start, end) of the Addis Ababa calendar day that contains `now`. */
export function addisAbabaDay(now: Date): { start: Date; end: Date } {
  const local = new Date(now.getTime() + ADDIS_ABABA_OFFSET_MS);
  const start =
    Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate()) -
    ADDIS_ABABA_OFFSET_MS;
  return { start: new Date(start), end: new Date(start + 24 * HOUR_MS) };
}

/** Position of an event in a list: its exact start time (microseconds) and id. */
export interface EventCursor {
  startTime: string;
  id: string;
}

/** Opaque page cursor: base64url of `[startTime, id]`. */
export function encodeEventCursor(cursor: EventCursor): string {
  return Buffer.from(JSON.stringify([cursor.startTime, cursor.id])).toString('base64url');
}

/** Decodes a page cursor; anything malformed is a 400 `invalid_cursor`. */
export function decodeEventCursor(cursor: string): EventCursor {
  const invalid = () =>
    badRequest('invalid_cursor', 'The page cursor is not valid. Start again from the first page.');
  if (!CURSOR_RE.test(cursor)) throw invalid();
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  } catch {
    throw invalid();
  }
  if (!Array.isArray(parsed) || parsed.length !== 2) throw invalid();
  const [startTime, id] = parsed as unknown[];
  if (typeof startTime !== 'string' || typeof id !== 'string') throw invalid();
  if (!CURSOR_TIME_RE.test(startTime) || !isUuid(id)) throw invalid();
  // Reject impossible dates (month 13, 30 February) before Postgres sees them,
  // and year 0000, which JavaScript accepts but PostgreSQL has no year for.
  const millis = `${startTime.slice(0, 23)}Z`;
  const date = new Date(millis);
  if (Number.isNaN(date.getTime()) || date.toISOString() !== millis) throw invalid();
  if (date.getUTCFullYear() < 1) throw invalid();
  return { startTime, id };
}

/** Live and kicked off within LIVE_LISTED_FOR_MS of `now` (an older "live" match has ended). */
function liveNow(now: Date): SQL {
  return and(
    eq(events.status, 'live'),
    gt(events.startTime, new Date(now.getTime() - LIVE_LISTED_FOR_MS)),
  )!;
}

/**
 * Scheduled and starting in [from, to), or live now. `from` is the present: a scheduled match
 * whose kick-off has passed is not listed (it cannot be bet on, and API-Football never reports
 * in-play, so it would stay until its result arrived: owner, 23 Nov 2026).
 */
function liveOrStartingBetween(from: Date, to: Date): SQL {
  return or(
    liveNow(from),
    and(eq(events.status, 'scheduled'), gte(events.startTime, from), lt(events.startTime, to)),
  )!;
}

/** GET /sports: active sports with their live and upcoming (next 30 days) event counts. */
export async function listSports(db: DbExecutor, now: Date): Promise<SportsResponse> {
  const upcomingEnd = new Date(now.getTime() + UPCOMING_WINDOW_MS);
  const [sportRows, countRows] = await Promise.all([
    db
      .select({ id: sports.id, name: sports.name })
      .from(sports)
      .where(eq(sports.active, true))
      .orderBy(asc(sports.sortOrder), asc(sports.id)),
    db
      .select({
        sportId: events.sportId,
        live: sql<number>`count(*) FILTER (WHERE ${events.status} = 'live')`.mapWith(Number),
        upcoming: sql<number>`count(*) FILTER (WHERE ${events.status} = 'scheduled')`.mapWith(
          Number,
        ),
      })
      .from(events)
      .innerJoin(competitions, eq(competitions.id, events.competitionId))
      .where(and(eq(competitions.active, true), liveOrStartingBetween(now, upcomingEnd)))
      .groupBy(events.sportId),
  ]);
  const counts = new Map(countRows.map((row) => [row.sportId, row]));
  return {
    items: sportRows.flatMap((sport) => {
      if (!isSportCode(sport.id)) return [];
      const count = counts.get(sport.id);
      return [
        {
          id: sport.id,
          name: localized(sport.name),
          liveCount: count?.live ?? 0,
          upcomingCount: count?.upcoming ?? 0,
        },
      ];
    }),
  };
}

/**
 * GET /sports/:sport/competitions: the sport's active competitions grouped by
 * category, each with its live and next-72h scheduled event count. Null when
 * the sport is unknown or inactive.
 */
export async function listCompetitions(
  db: DbExecutor,
  sport: string,
  now: Date,
): Promise<CompetitionsResponse | null> {
  if (!isSportCode(sport)) return null;
  const [sportRow] = await db
    .select({ id: sports.id })
    .from(sports)
    .where(and(eq(sports.id, sport), eq(sports.active, true)));
  if (sportRow === undefined) return null;

  const counts = db
    .select({
      competitionId: events.competitionId,
      eventCount: sql<number>`count(*)::int`.as('event_count'),
    })
    .from(events)
    .where(
      and(
        eq(events.sportId, sport),
        liveOrStartingBetween(now, new Date(now.getTime() + UPCOMING_WINDOW_MS)),
      ),
    )
    .groupBy(events.competitionId)
    .as('counts');
  const rows = await db
    .select({
      categorySlug: categories.slug,
      categoryName: categories.name,
      categoryCountryCode: categories.countryCode,
      slug: competitions.slug,
      name: competitions.name,
      featured: competitions.featured,
      eventCount: sql<number>`coalesce(${counts.eventCount}, 0)`.mapWith(Number),
    })
    .from(competitions)
    .innerJoin(categories, eq(categories.id, competitions.categoryId))
    .leftJoin(counts, eq(counts.competitionId, competitions.id))
    .where(and(eq(competitions.sportId, sport), eq(competitions.active, true)))
    .orderBy(
      asc(categories.sortOrder),
      asc(categories.slug),
      asc(competitions.sortOrder),
      asc(competitions.slug),
    );

  return {
    items: [...groupBy(rows, (row) => row.categorySlug).values()].map((group) => {
      const [first] = group as [(typeof rows)[number], ...typeof rows];
      return {
        category: {
          slug: first.categorySlug,
          name: localized(first.categoryName),
          countryCode: first.categoryCountryCode,
        },
        competitions: group.map((row) => ({
          slug: row.slug,
          name: localized(row.name),
          eventCount: row.eventCount,
          featured: row.featured,
        })),
      };
    }),
  };
}

const homeTeam = alias(teams, 'home_team');
const awayTeam = alias(teams, 'away_team');

/** Event rows with their competition, category and teams (one query). */
function selectEvents(db: DbExecutor) {
  return db
    .select({
      id: events.id,
      gameId: events.gameId,
      sport: events.sportId,
      startTime: events.startTime,
      // Exact (microsecond) start time for the page cursor; a JS Date keeps milliseconds only.
      cursorTime: sql<string>`to_char(${events.startTime} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`,
      status: events.status,
      bettingOpen: events.bettingOpen,
      closeLeadMs: events.closeLeadMs,
      liveMinute: events.liveMinute,
      period: events.period,
      scoreHome: events.scoreHome,
      scoreAway: events.scoreAway,
      htScoreHome: events.htScoreHome,
      htScoreAway: events.htScoreAway,
      competitionSlug: competitions.slug,
      competitionName: competitions.name,
      categoryName: categories.name,
      homeId: homeTeam.id,
      homeName: homeTeam.name,
      homeShortName: homeTeam.shortName,
      homeLogoAt: homeTeam.logoAt,
      awayId: awayTeam.id,
      awayName: awayTeam.name,
      awayShortName: awayTeam.shortName,
      awayLogoAt: awayTeam.logoAt,
    })
    .from(events)
    .innerJoin(competitions, eq(competitions.id, events.competitionId))
    .innerJoin(categories, eq(categories.id, competitions.categoryId))
    .innerJoin(sports, eq(sports.id, events.sportId))
    .innerJoin(homeTeam, eq(homeTeam.id, events.homeTeamId))
    .innerJoin(awayTeam, eq(awayTeam.id, events.awayTeamId));
}

type SelectedEvent = Awaited<ReturnType<ReturnType<typeof selectEvents>['execute']>>[number];

function toEventRow(row: SelectedEvent): EventRow | null {
  if (!isSportCode(row.sport)) return null;
  return {
    id: row.id,
    gameId: row.gameId,
    sport: row.sport,
    competitionSlug: row.competitionSlug,
    competitionName: row.competitionName,
    categoryName: row.categoryName,
    home: {
      id: row.homeId,
      name: row.homeName,
      shortName: row.homeShortName,
      logoAt: row.homeLogoAt,
    },
    away: {
      id: row.awayId,
      name: row.awayName,
      shortName: row.awayShortName,
      logoAt: row.awayLogoAt,
    },
    startTime: row.startTime,
    status: row.status,
    bettingOpen: row.bettingOpen,
    closeLeadMs: row.closeLeadMs,
    liveMinute: row.liveMinute,
    period: row.period,
    scoreHome: row.scoreHome,
    scoreAway: row.scoreAway,
    htScoreHome: row.htScoreHome,
    htScoreAway: row.htScoreAway,
  };
}

async function loadMarkets(db: DbExecutor, eventIds: readonly string[]): Promise<MarketRow[]> {
  if (eventIds.length === 0) return [];
  return db
    .select({
      id: markets.id,
      eventId: markets.eventId,
      type: markets.type,
      line: markets.line,
      status: markets.status,
      priceValidUntil: markets.priceValidUntil,
    })
    .from(markets)
    .where(inArray(markets.eventId, [...eventIds]));
}

async function loadSelections(
  db: DbExecutor,
  marketIds: readonly string[],
): Promise<SelectionRow[]> {
  if (marketIds.length === 0) return [];
  return db
    .select({
      id: selections.id,
      marketId: selections.marketId,
      code: selections.code,
      oddsMilli: selections.oddsMilli,
      status: selections.status,
    })
    .from(selections)
    .where(inArray(selections.marketId, [...marketIds]));
}

/**
 * Number of selections per market of the given events, in one grouped query (the list rows' option
 * count; no per-row queries).
 */
async function loadSelectionCounts(
  db: DbExecutor,
  eventIds: readonly string[],
): Promise<Map<string, number>> {
  if (eventIds.length === 0) return new Map();
  const rows = await db
    .select({ marketId: selections.marketId, n: sql<number>`count(*)::int` })
    .from(selections)
    .innerJoin(markets, eq(markets.id, selections.marketId))
    .where(inArray(markets.eventId, [...eventIds]))
    .groupBy(selections.marketId);
  return new Map(rows.map((row) => [row.marketId, row.n]));
}

/** [start, end) of an Addis Ababa calendar day given as YYYY-MM-DD. */
function addisAbabaDayOf(day: string): { start: Date; end: Date } {
  const start = Date.parse(`${day}T00:00:00Z`) - ADDIS_ABABA_OFFSET_MS;
  return { start: new Date(start), end: new Date(start + 24 * HOUR_MS) };
}

/**
 * Highlights fall back to every league (owner's report of 16 Nov 2026: the tab stayed empty
 * through an international break) when no featured competition of the sport has a match live or
 * starting within HIGHLIGHTS_WINDOW_MS: then they show what is live or starts soonest anywhere.
 */
async function highlightsHaveFeatured(db: DbExecutor, sport: string, now: Date): Promise<boolean> {
  const [row] = await db
    .select({ id: events.id })
    .from(events)
    .innerJoin(competitions, eq(competitions.id, events.competitionId))
    .where(
      and(
        eq(events.sportId, sport),
        eq(competitions.active, true),
        eq(competitions.featured, true),
        liveOrStartingBetween(now, new Date(now.getTime() + HIGHLIGHTS_WINDOW_MS)),
      ),
    )
    .limit(1);
  return row !== undefined;
}

function filterCondition(query: EventListQuery, now: Date, featuredOnly = true): SQL {
  if (query.day !== undefined && (query.filter === 'today' || query.filter === 'upcoming')) {
    // An explicit day replaces the tab's own window; upcoming never lists what has started.
    const { start, end } = addisAbabaDayOf(query.day);
    return query.filter === 'today'
      ? and(
          liveOrStartingBetween(now, end),
          gte(events.startTime, start),
          lt(events.startTime, end),
        )!
      : and(
          eq(events.status, 'scheduled'),
          gte(events.startTime, now > start ? now : start),
          lt(events.startTime, end),
        )!;
  }
  switch (query.filter) {
    case 'highlights': {
      const soon = liveOrStartingBetween(now, new Date(now.getTime() + HIGHLIGHTS_WINDOW_MS));
      return featuredOnly ? and(eq(competitions.featured, true), soon)! : soon;
    }
    case 'today': {
      // Today's matches still to start, and those live now: nothing that has ended.
      const { start, end } = addisAbabaDay(now);
      return and(
        liveOrStartingBetween(now, end),
        gte(events.startTime, start),
        lt(events.startTime, end),
      )!;
    }
    case 'upcoming':
      return and(
        eq(events.status, 'scheduled'),
        gte(events.startTime, now),
        lt(events.startTime, new Date(now.getTime() + UPCOMING_WINDOW_MS)),
      )!;
    case 'live':
      return liveNow(now);
    default: {
      const unreachable: never = query.filter;
      throw new RangeError(`unknown event filter: ${String(unreachable)}`);
    }
  }
}

/**
 * The `country` filter (a category slug): that category and every other category of the same
 * country, so our "Brazil" and the Hulusport board's are one country chip (owner, 17 Nov 2026). A
 * category without a country code is only itself.
 */
async function countryCondition(
  db: DbExecutor,
  sport: string | undefined,
  slug: string,
): Promise<SQL> {
  const [row] = await db
    .select({ code: categories.countryCode })
    .from(categories)
    .where(
      sport === undefined
        ? eq(categories.slug, slug)
        : and(eq(categories.slug, slug), eq(categories.sportId, sport)),
    )
    .limit(1);
  const code = row?.code ?? null;
  return code === null
    ? eq(categories.slug, slug)
    : (or(eq(categories.slug, slug), eq(categories.countryCode, code)) ??
        eq(categories.slug, slug));
}

/**
 * GET /events: a page of a sport's events of active competitions.
 * - highlights: featured competitions, live or starting within 24h (every competition when no
 *   featured one has such a match: highlightsHaveFeatured);
 * - today: starting on today's Addis Ababa date and still to start, or live now (a scheduled
 *   event whose start has passed, or a live one older than LIVE_LISTED_FOR_MS, is not listed);
 * - upcoming: scheduled, starting within 30 days (UPCOMING_WINDOW_MS);
 * - live: in play, kicked off within LIVE_LISTED_FOR_MS.
 * Ordered by (start time, id), which puts live events (already started)
 * first, and paged by keyset on the same pair.
 */
export async function listEvents(
  db: DbExecutor,
  query: EventListQuery,
  now: Date,
  options: ViewOptions = {},
): Promise<EventListResponse> {
  const cursor = query.cursor === undefined ? undefined : decodeEventCursor(query.cursor);
  const conditions: SQL[] = [
    eq(events.sportId, query.sport),
    eq(sports.active, true),
    eq(competitions.active, true),
    filterCondition(
      query,
      now,
      query.filter !== 'highlights' || (await highlightsHaveFeatured(db, query.sport, now)),
    ),
  ];
  if (query.competition !== undefined) conditions.push(eq(competitions.slug, query.competition));
  if (query.country !== undefined) {
    conditions.push(await countryCondition(db, query.sport, query.country));
  }
  if (query.day !== undefined && (query.filter === 'highlights' || query.filter === 'live')) {
    const { start, end } = addisAbabaDayOf(query.day);
    conditions.push(gte(events.startTime, start), lt(events.startTime, end));
  }
  if (query.startsWithinHours !== undefined && query.filter !== 'live') {
    conditions.push(
      gte(events.startTime, now),
      lt(events.startTime, new Date(now.getTime() + query.startsWithinHours * HOUR_MS)),
    );
  }
  if (cursor !== undefined) {
    conditions.push(
      sql`(${events.startTime}, ${events.id}) > (${cursor.startTime}::timestamptz, ${cursor.id}::uuid)`,
    );
  }

  const rows = await selectEvents(db)
    .where(and(...conditions))
    .orderBy(asc(events.startTime), asc(events.id))
    .limit(query.limit + 1);
  const page = rows.slice(0, query.limit);
  const last = page.at(-1);
  const nextCursor =
    rows.length > query.limit && last !== undefined
      ? encodeEventCursor({ startTime: last.cursorTime, id: last.id })
      : null;

  const eventRows = page.map(toEventRow).filter((row): row is EventRow => row !== null);
  return {
    items: await summarizeEvents(
      db,
      eventRows,
      query.market === 'dc' ? 'dc' : undefined,
      now,
      options,
    ),
    nextCursor,
  };
}

/** List rows (with their main market's odds) for already selected events, in the given order. */
async function summarizeEvents(
  db: DbExecutor,
  eventRows: readonly EventRow[],
  mainType: 'dc' | undefined,
  now: Date,
  options: ViewOptions,
): Promise<EventSummary[]> {
  const eventIds = eventRows.map((event) => event.id);
  const [marketRows, selectionCounts] = await Promise.all([
    loadMarkets(db, eventIds),
    loadSelectionCounts(db, eventIds),
  ]);
  const marketsByEvent = groupBy(marketRows, (market) => market.eventId);
  const mainMarketIds = eventRows.flatMap((event) => {
    const main = findMainMarket(event, marketsByEvent.get(event.id) ?? [], mainType);
    return main === null ? [] : [main.id];
  });
  const selectionsByMarket = groupBy(
    await loadSelections(db, mainMarketIds),
    (selection) => selection.marketId,
  );
  return eventRows.map((event) => {
    const eventMarkets = marketsByEvent.get(event.id) ?? [];
    const main = findMainMarket(event, eventMarkets, mainType);
    return eventSummaryView(
      event,
      eventMarkets,
      main === null ? [] : (selectionsByMarket.get(main.id) ?? []),
      now,
      mainType,
      options,
      selectionCounts,
    );
  });
}

/** Search looks this far ahead for matches. */
export const SEARCH_WINDOW_MS = 14 * 24 * HOUR_MS;
export const SEARCH_MAX_EVENTS = 30;
export const SEARCH_MAX_COMPETITIONS = 20;

/** Escapes LIKE wildcards (and the escape character) so user text matches literally. */
export function escapeLike(text: string): string {
  return text.replace(/[\\%_]/g, '\\$&');
}

/**
 * GET /search: teams and competitions whose name matches `query.q`.
 *
 * Names (English, Amharic, short name) are compared as raw text with a
 * case-insensitive substring match (ILIKE; Ethiopic has no case, so Amharic is
 * matched as typed). Aliases are stored in normalised form (normalizeName), so
 * they are matched against the normalised query, and also against the raw
 * lower-cased text, which covers a query that normalises to nothing. LIKE
 * wildcards in the query are escaped; every value is a bound parameter.
 * Events: live or starting within 14 days, by start time, at most 30, of
 * teams that match. Competitions: at most 20. Active sports and competitions only.
 */
export async function searchCatalog(
  db: DbExecutor,
  query: SearchQuery,
  now: Date,
  options: ViewOptions = {},
): Promise<SearchResponse> {
  const raw = `%${escapeLike(query.q)}%`;
  const normalized = normalizeName(query.q);
  const norm = normalized === '' ? undefined : `%${escapeLike(normalized)}%`;
  const aliasMatch = (column: AnyColumn): SQL =>
    or(sql`${column} ILIKE ${raw}`, norm === undefined ? undefined : sql`${column} LIKE ${norm}`)!;
  const nameMatch = (name: AnyColumn): SQL =>
    or(sql`${name}->>'en' ILIKE ${raw}`, sql`${name}->>'am' ILIKE ${raw}`)!;

  const matchingTeams = db
    .select({ id: teams.id })
    .from(teams)
    .where(
      or(
        nameMatch(teams.name),
        sql`${teams.shortName} ILIKE ${raw}`,
        inArray(
          teams.id,
          db
            .select({ id: teamAliases.teamId })
            .from(teamAliases)
            .where(aliasMatch(teamAliases.aliasNorm)),
        ),
      ),
    );
  const sportFilter = (column: AnyColumn): SQL[] =>
    query.sport === undefined ? [] : [eq(column, query.sport)];

  const counts = db
    .select({
      competitionId: events.competitionId,
      eventCount: sql<number>`count(*)::int`.as('event_count'),
    })
    .from(events)
    .where(liveOrStartingBetween(now, new Date(now.getTime() + UPCOMING_WINDOW_MS)))
    .groupBy(events.competitionId)
    .as('counts');
  const [competitionRows, eventSelected] = await Promise.all([
    db
      .select({
        sport: competitions.sportId,
        slug: competitions.slug,
        name: competitions.name,
        categorySlug: categories.slug,
        categoryName: categories.name,
        categoryCountryCode: categories.countryCode,
        eventCount: sql<number>`coalesce(${counts.eventCount}, 0)`.mapWith(Number),
      })
      .from(competitions)
      .innerJoin(categories, eq(categories.id, competitions.categoryId))
      .innerJoin(sports, eq(sports.id, competitions.sportId))
      .leftJoin(counts, eq(counts.competitionId, competitions.id))
      .where(
        and(
          eq(competitions.active, true),
          eq(sports.active, true),
          ...sportFilter(competitions.sportId),
          or(
            nameMatch(competitions.name),
            inArray(
              competitions.id,
              db
                .select({ id: competitionAliases.competitionId })
                .from(competitionAliases)
                .where(aliasMatch(competitionAliases.aliasNorm)),
            ),
          ),
        ),
      )
      .orderBy(
        asc(sports.sortOrder),
        asc(categories.sortOrder),
        asc(competitions.sortOrder),
        asc(competitions.slug),
      )
      .limit(SEARCH_MAX_COMPETITIONS),
    selectEvents(db)
      .where(
        and(
          eq(sports.active, true),
          eq(competitions.active, true),
          ...sportFilter(events.sportId),
          liveOrStartingBetween(now, new Date(now.getTime() + SEARCH_WINDOW_MS)),
          or(inArray(events.homeTeamId, matchingTeams), inArray(events.awayTeamId, matchingTeams)),
        ),
      )
      .orderBy(asc(events.startTime), asc(events.id))
      .limit(SEARCH_MAX_EVENTS),
  ]);

  const eventRows = eventSelected.map(toEventRow).filter((row): row is EventRow => row !== null);
  return {
    competitions: competitionRows.flatMap((row) =>
      isSportCode(row.sport)
        ? [
            {
              slug: row.slug,
              sport: row.sport,
              name: localized(row.name),
              category: {
                slug: row.categorySlug,
                name: localized(row.categoryName),
                countryCode: row.categoryCountryCode,
              },
              eventCount: row.eventCount,
            },
          ]
        : [],
    ),
    events: await summarizeEvents(db, eventRows, undefined, now, options),
  };
}

/**
 * One event page. Events of an inactive competition or sport are not part of
 * the public catalogue (no list shows them), so they are not found here either.
 */
async function eventDetail(
  db: DbExecutor,
  where: SQL,
  now: Date,
  options: ViewOptions,
): Promise<EventDetail | null> {
  const [row] = await selectEvents(db)
    .where(and(where, eq(competitions.active, true), eq(sports.active, true)))
    .limit(1);
  const event = row === undefined ? null : toEventRow(row);
  if (event === null) return null;
  const marketRows = await loadMarkets(db, [event.id]);
  const selectionRows = await loadSelections(
    db,
    marketRows.map((market) => market.id),
  );
  return eventDetailView(
    event,
    marketRows,
    groupBy(selectionRows, (selection) => selection.marketId),
    now,
    options,
  );
}

/**
 * GET /events/:id. Null for an unknown or malformed id, or an event of an
 * inactive competition or sport.
 */
export async function getEventById(
  db: DbExecutor,
  id: string,
  now: Date,
  options: ViewOptions = {},
): Promise<EventDetail | null> {
  if (!isUuid(id)) return null;
  return eventDetail(db, eq(events.id, id), now, options);
}

/**
 * GET /events/by-game-id/:gameId ('0123' or '123'). Null for an unknown or
 * malformed id, or an event of an inactive competition or sport.
 */
export async function getEventByGameId(
  db: DbExecutor,
  gameId: string,
  now: Date,
  options: ViewOptions = {},
): Promise<EventDetail | null> {
  const parsed = parseGameId(gameId);
  if (parsed === null) return null;
  return eventDetail(db, eq(events.gameId, parsed), now, options);
}

/** A team's stored logo (64 px PNG, team_logos), or null when it has none or the id is not a uuid. */
export async function getTeamLogo(db: DbExecutor, teamId: string): Promise<Buffer | null> {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(teamId)) return null;
  const [row] = await db
    .select({ png: teamLogos.png })
    .from(teamLogos)
    .where(eq(teamLogos.teamId, teamId))
    .limit(1);
  return row?.png ?? null;
}
