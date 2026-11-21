import { createHash } from 'node:crypto';
import { countryCodeOfName } from '@vamos/core';
import { and, asc, eq, gt, gte, inArray, isNull, lt, lte, sql } from 'drizzle-orm';
import type { DbExecutor, DbTransaction } from '../ledger/types';
import { categories, competitions, events, teams } from '../schema/catalog';
import {
  scrapeBoardCompetitions,
  scrapeBoardResults,
  scrapeBoardTeams,
  scrapeSources,
} from '../schema/scrape';
import type { BoardName } from './board-odds';
import { clampLimit } from './common';

/**
 * Matches of a competitor board (Hulusport, docs/plans/hulusport-feed.md; Narobet, docs/plans/
 * narobet-events.md) that Nahubet does not list itself become events of their own: feed_provider
 * the board's name, in competitions and with teams the scraper creates for them
 * (scrape_board_competitions, scrape_board_teams). These are the catalogue writes; the decisions
 * are in apps/scraper (pipeline/board-events.ts).
 */

export const BOARD_FEED_PROVIDER = 'hulusport';
/**
 * Every feed provider of a competitor board's own matches: Hulusport's (mr-x) and Narobet's (mr-z,
 * docs/plans/narobet-events.md). Their matches take the board caps (`board_risk_limits`) when a bet
 * is placed.
 */
export const BOARD_FEED_PROVIDERS: readonly string[] = ['hulusport', 'narobet'];
const SPORT = 'football';
/** Board competitions sort after Nahubet's own. */
const BOARD_SORT_ORDER = 1000;
/**
 * The slug prefix of a board's competitions (their league keys are the board's own ids, which may
 * clash between boards). Categories are shared: one per country, `hl-<country>`, whichever board
 * made it first.
 */
const COMPETITION_SLUG_PREFIX: Readonly<Record<BoardName, string>> = {
  hulusport: 'hl',
  narobet: 'nb',
};

/** ASCII slug: accents dropped, anything else not a letter or digit becomes one dash. */
export function boardSlug(text: string): string {
  const slug = text
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return slug === '' ? 'x' : slug;
}

export interface BoardCatalog {
  /** Board league key -> competition id. */
  competitionByLeague: Map<string, string>;
  /** Raw team name -> team id. */
  teamByName: Map<string, string>;
  competitionIds: Set<string>;
  teamIds: Set<string>;
  /**
   * The teams every board created (this board's and the others'): a board match may use another
   * board's team, so a club both boards list is one team, and one match is never listed twice.
   */
  anyBoardTeamIds: Set<string>;
}

/** What the board created so far (small tables: read whole once per pass). */
export async function loadBoardCatalog(exec: DbExecutor, board: BoardName): Promise<BoardCatalog> {
  const [comps, teamRows] = await Promise.all([
    exec
      .select({ key: scrapeBoardCompetitions.leagueKey, id: scrapeBoardCompetitions.competitionId })
      .from(scrapeBoardCompetitions)
      .where(eq(scrapeBoardCompetitions.board, board)),
    exec
      .select({
        board: scrapeBoardTeams.board,
        name: scrapeBoardTeams.rawName,
        id: scrapeBoardTeams.teamId,
      })
      .from(scrapeBoardTeams),
  ]);
  const own = teamRows.filter((r) => r.board === board);
  return {
    competitionByLeague: new Map(comps.map((r) => [r.key, r.id])),
    teamByName: new Map(own.map((r) => [r.name, r.id])),
    competitionIds: new Set(comps.map((r) => r.id)),
    teamIds: new Set(own.map((r) => r.id)),
    anyBoardTeamIds: new Set(teamRows.map((r) => r.id)),
  };
}

/**
 * The competition of a board league, created on first sight: in a category named after the league's
 * country or region (`group`; 'Other' when unknown), slug `<board prefix>-<league key>` (`hl-` for
 * Hulusport, `nb-` for Narobet), sorted after ours.
 */
export async function ensureBoardCompetition(
  tx: DbTransaction,
  input: { board: BoardName; leagueKey: string; name: string; group: string | null },
): Promise<string> {
  const [mapped] = await tx
    .select({ id: scrapeBoardCompetitions.competitionId })
    .from(scrapeBoardCompetitions)
    .where(
      and(
        eq(scrapeBoardCompetitions.board, input.board),
        eq(scrapeBoardCompetitions.leagueKey, input.leagueKey),
      ),
    );
  if (mapped !== undefined) return mapped.id;
  const groupName = input.group ?? 'Other';
  const categorySlug = `hl-${boardSlug(groupName)}`;
  await tx
    .insert(categories)
    .values({
      sportId: SPORT,
      slug: categorySlug,
      name: { en: groupName },
      countryCode: countryCodeOfName(groupName),
      sortOrder: BOARD_SORT_ORDER,
    })
    .onConflictDoNothing();
  const [category] = await tx
    .select({ id: categories.id })
    .from(categories)
    .where(and(eq(categories.sportId, SPORT), eq(categories.slug, categorySlug)));
  const slug = `${COMPETITION_SLUG_PREFIX[input.board]}-${boardSlug(input.leagueKey)}`;
  // Many leagues share a name ("Premier League"). A second competition with a name the catalogue
  // already has would make that name ambiguous for every source that resolves it by name, so the
  // board's league takes its country, then its key, until the name is free.
  let name = input.name;
  for (const candidate of [
    input.name,
    `${input.name} (${groupName})`,
    `${input.name} (${groupName}, ${input.leagueKey})`,
  ]) {
    name = candidate;
    const [taken] = await tx
      .select({ id: competitions.id })
      .from(competitions)
      .where(
        and(
          eq(competitions.sportId, SPORT),
          sql`lower(${competitions.name}->>'en') = lower(${candidate})`,
        ),
      )
      .limit(1);
    if (taken === undefined) break;
  }
  await tx
    .insert(competitions)
    .values({
      sportId: SPORT,
      categoryId: category!.id,
      slug,
      name: { en: name },
      sortOrder: BOARD_SORT_ORDER,
    })
    .onConflictDoNothing();
  const [competition] = await tx
    .select({ id: competitions.id })
    .from(competitions)
    .where(and(eq(competitions.sportId, SPORT), eq(competitions.slug, slug)));
  await tx
    .insert(scrapeBoardCompetitions)
    .values({ board: input.board, leagueKey: input.leagueKey, competitionId: competition!.id })
    .onConflictDoNothing();
  return competition!.id;
}

/**
 * Gives the board's categories created before they carried a country (slug `hl-...`, no code) the
 * code of the country their name says. Idempotent; returns how many it filled. A name that is not a
 * country (International, Africa) stays without one and is looked at again next time (few rows).
 */
export async function fillBoardCategoryCountries(exec: DbExecutor): Promise<number> {
  const open = await exec
    .select({ id: categories.id, name: sql<string>`${categories.name}->>'en'` })
    .from(categories)
    .where(and(sql`${categories.slug} LIKE 'hl-%'`, isNull(categories.countryCode)));
  let filled = 0;
  for (const row of open) {
    const code = countryCodeOfName(row.name ?? '');
    if (code === null) continue;
    await exec
      .update(categories)
      .set({ countryCode: code })
      .where(and(eq(categories.id, row.id), isNull(categories.countryCode)));
    filled += 1;
  }
  return filled;
}

/**
 * The team of a board team name, created on first sight with the name as given. The short name must
 * be unique per sport: when another team already has it (a spelling the alias rules did not match
 * to it), the new team gets the name with a short tag.
 */
export async function ensureBoardTeam(
  tx: DbTransaction,
  input: { board: BoardName; rawName: string },
): Promise<string> {
  const [mapped] = await tx
    .select({ id: scrapeBoardTeams.teamId })
    .from(scrapeBoardTeams)
    .where(
      and(eq(scrapeBoardTeams.board, input.board), eq(scrapeBoardTeams.rawName, input.rawName)),
    );
  if (mapped !== undefined) return mapped.id;
  const tag = createHash('sha256').update(input.rawName).digest('hex').slice(0, 4);
  let teamId: string | undefined;
  for (const shortName of [input.rawName, `${input.rawName} (${tag})`]) {
    const [row] = await tx
      .insert(teams)
      .values({ sportId: SPORT, name: { en: input.rawName }, shortName })
      .onConflictDoNothing()
      .returning({ id: teams.id });
    if (row !== undefined) {
      teamId = row.id;
      break;
    }
  }
  if (teamId === undefined) throw new Error(`no free short name for board team "${input.rawName}"`);
  await tx.insert(scrapeBoardTeams).values({ board: input.board, rawName: input.rawName, teamId });
  return teamId;
}

export interface BoardEventRow {
  eventId: string;
  feedRef: string;
  startTime: Date;
  bettingOpen: boolean;
}

/** Scheduled, unresulted board events (default Hulusport's) that start after `after`. */
export async function listBoardEvents(
  exec: DbExecutor,
  after: Date,
  feedProvider: string = BOARD_FEED_PROVIDER,
): Promise<BoardEventRow[]> {
  return exec
    .select({
      eventId: events.id,
      feedRef: events.feedRef,
      startTime: events.startTime,
      bettingOpen: events.bettingOpen,
    })
    .from(events)
    .where(
      and(
        eq(events.feedProvider, feedProvider),
        eq(events.status, 'scheduled'),
        isNull(events.resultedAt),
        gt(events.startTime, after),
      ),
    )
    .orderBy(asc(events.startTime));
}

export interface BoardEventNear {
  eventId: string;
  feedProvider: string;
  feedRef: string;
  homeTeamId: string;
  awayTeamId: string;
  home: string;
  away: string;
  startTime: Date;
  /** Its open markets (0: suspended whole, by the feed or a trader). */
  openMarkets: number;
}

/**
 * Every board's unresulted events (scheduled or live) starting in [from, to]: what a new board
 * match is compared with, so that one match is never listed twice (docs/plans/narobet-events.md).
 */
export async function listBoardEventsBetween(
  exec: DbExecutor,
  window: { from: Date; to: Date },
): Promise<BoardEventNear[]> {
  const home = sql<string>`(SELECT t.name->>'en' FROM teams t WHERE t.id = ${events.homeTeamId})`;
  const away = sql<string>`(SELECT t.name->>'en' FROM teams t WHERE t.id = ${events.awayTeamId})`;
  return exec
    .select({
      eventId: events.id,
      feedProvider: events.feedProvider,
      feedRef: events.feedRef,
      homeTeamId: events.homeTeamId,
      awayTeamId: events.awayTeamId,
      home,
      away,
      startTime: events.startTime,
      // Qualified by hand: inside a subquery drizzle prints a bare "id", which would be markets.id.
      openMarkets: sql<number>`(SELECT count(*) FROM markets m
          WHERE m.event_id = "events"."id" AND m.status = 'open')`.mapWith(Number),
    })
    .from(events)
    .where(
      and(
        inArray(events.feedProvider, [...BOARD_FEED_PROVIDERS]),
        inArray(events.status, ['scheduled', 'live']),
        isNull(events.resultedAt),
        gte(events.startTime, window.from),
        lte(events.startTime, window.to),
      ),
    );
}

/**
 * The API-Football leagues Nahubet follows itself: the `leagueIds` of every enabled API-Football
 * source. A board league with one of these ids is ours, never a board's.
 */
export async function followedApiFootballLeagueIds(exec: DbExecutor): Promise<Set<number>> {
  const rows = await exec
    .select({ config: scrapeSources.config })
    .from(scrapeSources)
    .where(and(eq(scrapeSources.adapter, 'apifootball'), eq(scrapeSources.enabled, true)));
  const ids = new Set<number>();
  for (const row of rows) {
    const list = (row.config as { leagueIds?: unknown }).leagueIds;
    if (!Array.isArray(list)) continue;
    for (const id of list) if (Number.isSafeInteger(id)) ids.add(id as number);
  }
  return ids;
}

export interface BoardEventsSummary {
  /** Upcoming board events. */
  upcoming: number;
  /** Of those, with betting open. */
  bettingOpen: number;
  /** Board events whose kickoff is more than `resultLagMs` ago and that have no result yet. */
  awaitingResult: Array<{
    eventId: string;
    gameId: number;
    competition: string;
    home: string;
    away: string;
    kickoff: Date;
  }>;
  awaitingResultTotal: number;
}

/** What the back office shows about board events: how many, and which wait for a person's result. */
export async function boardEventsSummary(
  exec: DbExecutor,
  options: { now: Date; resultLagMs: number; limit: number; feedProvider?: string },
): Promise<BoardEventsSummary> {
  const provider = options.feedProvider ?? BOARD_FEED_PROVIDER;
  const nowIso = options.now.toISOString();
  const [counts] = await exec
    .select({
      upcoming:
        sql<number>`count(*) FILTER (WHERE ${events.startTime} > ${nowIso}::timestamptz)`.mapWith(
          Number,
        ),
      bettingOpen:
        sql<number>`count(*) FILTER (WHERE ${events.startTime} > ${nowIso}::timestamptz AND ${events.bettingOpen})`.mapWith(
          Number,
        ),
    })
    .from(events)
    .where(and(eq(events.feedProvider, provider), eq(events.status, 'scheduled')));
  const overdue = and(
    eq(events.feedProvider, provider),
    inArray(events.status, ['scheduled', 'live']),
    isNull(events.resultedAt),
    lt(events.startTime, new Date(options.now.getTime() - options.resultLagMs)),
  );
  const [total] = await exec
    .select({ n: sql<number>`count(*)`.mapWith(Number) })
    .from(events)
    .where(overdue);
  const home = sql<string>`(SELECT t.name->>'en' FROM teams t WHERE t.id = ${events.homeTeamId})`;
  const away = sql<string>`(SELECT t.name->>'en' FROM teams t WHERE t.id = ${events.awayTeamId})`;
  const competition = sql<string>`(SELECT c.name->>'en' FROM competitions c WHERE c.id = ${events.competitionId})`;
  const awaitingResult = await exec
    .select({
      eventId: events.id,
      gameId: events.gameId,
      competition,
      home,
      away,
      kickoff: events.startTime,
    })
    .from(events)
    .where(overdue)
    .orderBy(asc(events.startTime))
    .limit(clampLimit(options.limit, 50, 200));
  return {
    upcoming: counts?.upcoming ?? 0,
    bettingOpen: counts?.bettingOpen ?? 0,
    awaitingResult,
    awaitingResultTotal: total?.n ?? 0,
  };
}

export interface BoardEventPendingResult {
  eventId: string;
  home: string;
  away: string;
  kickoff: Date;
}

/**
 * Board events that should have a result by now: kickoff between `now - maxAgeMs` and
 * `now - lagMs`, not resulted, soonest first.
 */
export async function boardEventsWithoutResult(
  exec: DbExecutor,
  options: { now: Date; lagMs: number; maxAgeMs: number; limit: number },
): Promise<BoardEventPendingResult[]> {
  const home = sql<string>`(SELECT t.name->>'en' FROM teams t WHERE t.id = ${events.homeTeamId})`;
  const away = sql<string>`(SELECT t.name->>'en' FROM teams t WHERE t.id = ${events.awayTeamId})`;
  return exec
    .select({ eventId: events.id, home, away, kickoff: events.startTime })
    .from(events)
    .where(
      and(
        eq(events.feedProvider, BOARD_FEED_PROVIDER),
        inArray(events.status, ['scheduled', 'live']),
        isNull(events.resultedAt),
        lt(events.startTime, new Date(options.now.getTime() - options.lagMs)),
        gt(events.startTime, new Date(options.now.getTime() - options.maxAgeMs)),
      ),
    )
    .orderBy(asc(events.startTime))
    .limit(clampLimit(options.limit, 200, 1000));
}

export interface BoardResultSighting {
  eventId: string;
  fixtureId: number;
  status: string;
  home: number;
  away: number;
  htHome: number | null;
  htAway: number | null;
  seenAt: Date;
}

/**
 * Records a reported final score; returns since when it has stood unchanged (the same fixture,
 * score and half-time score; a change restarts the clock).
 */
export async function recordBoardResultSighting(
  tx: DbTransaction,
  s: BoardResultSighting,
): Promise<{ firstSeenAt: Date; appliedAt: Date | null }> {
  const [row] = await tx
    .insert(scrapeBoardResults)
    .values({
      eventId: s.eventId,
      fixtureId: s.fixtureId,
      status: s.status,
      home: s.home,
      away: s.away,
      htHome: s.htHome,
      htAway: s.htAway,
      firstSeenAt: s.seenAt,
      lastSeenAt: s.seenAt,
    })
    .onConflictDoUpdate({
      target: scrapeBoardResults.eventId,
      set: {
        firstSeenAt: sql`CASE WHEN ${scrapeBoardResults.fixtureId} = excluded.fixture_id
            AND ${scrapeBoardResults.home} = excluded.home AND ${scrapeBoardResults.away} = excluded.away
            AND ${scrapeBoardResults.htHome} IS NOT DISTINCT FROM excluded.ht_home
            AND ${scrapeBoardResults.htAway} IS NOT DISTINCT FROM excluded.ht_away
          THEN ${scrapeBoardResults.firstSeenAt} ELSE excluded.first_seen_at END`,
        fixtureId: sql`excluded.fixture_id`,
        status: sql`excluded.status`,
        home: sql`excluded.home`,
        away: sql`excluded.away`,
        htHome: sql`excluded.ht_home`,
        htAway: sql`excluded.ht_away`,
        lastSeenAt: sql`excluded.last_seen_at`,
      },
    })
    .returning({
      firstSeenAt: scrapeBoardResults.firstSeenAt,
      appliedAt: scrapeBoardResults.appliedAt,
    });
  return row!;
}

/** Marks the reported score of an event as applied. */
export async function markBoardResultApplied(
  tx: DbTransaction,
  eventId: string,
  at: Date,
): Promise<void> {
  await tx
    .update(scrapeBoardResults)
    .set({ appliedAt: at })
    .where(eq(scrapeBoardResults.eventId, eventId));
}
