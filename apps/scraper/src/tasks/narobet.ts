import {
  boardOddsTimes,
  findEventByTeams,
  getBoardPricing,
  getNarobetEvents,
  reportServiceFailure,
  reportServiceOk,
  upsertBoardOdds,
  type BoardOddsInput,
} from '@vamos/db';
import {
  MARKET_ODDS_LINK_WINDOW_MS,
  MRZ_MATCHES_PATH,
  NAROBET_BOARD,
  parseMrzMatches,
} from '@vamos/scraper';
import type { ScraperContext } from '../context';
import { intervalTask, type IntervalTask } from '../lib/interval';
import {
  sweepNarobetEvents,
  syncNarobetEvents,
  type NarobetEntry,
  type NarobetEventsSummary,
} from '../pipeline/board-events';
import { aliasIndexCache, resolveNames, type UnknownName } from '../pipeline/run-source';

/**
 * Reads Narobet's odds from the owner's mr-z service (owner, 21 Nov 2026; docs/plans/narobet-feed.md)
 * and stores each upcoming football match in scrape_board_odds as board `narobet`, linked to the
 * Nahubet event with the same two teams and a kickoff within MARKET_ODDS_LINK_WINDOW_MS. Nothing here
 * changes a price: the pricing step uses Narobet's board only while the back office switch
 * `narobet_pricing` is on, and only for markets Nahubet already prices (event-pricing.ts,
 * boardRule). A match Nahubet does not list becomes an event of its own only while the switch
 * `narobet_events` is on (docs/plans/narobet-events.md; pipeline/board-events.ts). Only mr-z talks
 * to Narobet: this reads mr-z's own copy, and nothing here makes mr-z read more.
 *
 * Team names resolve as every source's do (rule N2: aliases, catalogue names, the name without its
 * legal form). Narobet's data comes from API-Football, whose names the catalogue mostly uses already;
 * a name that does not resolve leaves the match unlinked.
 */

const FETCH_TIMEOUT_MS = 30_000;
const MAX_BODY_BYTES = 32 * 1024 * 1024;

export interface NarobetReadSummary {
  /** Upcoming matches with markets mr-z has read from Narobet. */
  matches: number;
  linked: number;
  /** Matches whose team names did not both resolve. */
  unresolved: number;
  /** Matches without markets yet, started, or listed past their kickoff: not stored. */
  skipped: number;
  /** Entries of mr-z's answer that could not be read. */
  rejected: number;
  /** Matches Nahubet does not list, as events of their own (pipeline/board-events.ts). */
  boardEvents: NarobetEventsSummary;
}

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

/** One read of mr-z (a failed read throws; the interval task logs it and carries on). */
export async function readNarobetBoard(
  ctx: ScraperContext,
  fetchImpl: FetchLike = fetch,
): Promise<NarobetReadSummary> {
  const base = ctx.config.scraper.narobet.url;
  const summary: NarobetReadSummary = {
    matches: 0,
    linked: 0,
    unresolved: 0,
    skipped: 0,
    rejected: 0,
    boardEvents: { created: 0, updated: 0, skipped: 0, unchanged: 0, deferred: 0 },
  };
  if (base === null) return summary;
  const response = await fetchImpl(`${base}${MRZ_MATCHES_PATH}`, {
    headers: { accept: 'application/json' },
    redirect: 'error',
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`mr-z matches: HTTP ${response.status}`);
  const body = await response.text();
  if (body.length > MAX_BODY_BYTES) {
    throw new Error(`mr-z matches: ${body.length} bytes is too large`);
  }
  const list = parseMrzMatches(body);
  if (list === null) throw new Error('mr-z matches: the response is not a list of matches');

  const now = ctx.clock();
  summary.rejected = list.rejected;
  const index = await aliasIndexCache(ctx).get('football');
  // What the last read stored: a match mr-z has not re-read since is not re-priced.
  const before = await boardOddsTimes(
    ctx.db,
    list.matches.map((m) => `${NAROBET_BOARD}:${m.id}`),
  );
  const rows: BoardOddsInput[] = [];
  const entries: NarobetEntry[] = [];
  for (const match of list.matches) {
    if (
      match.pricesAt === null ||
      match.markets.length === 0 ||
      match.pastKickoff ||
      match.kickoff.getTime() <= now.getTime()
    ) {
      summary.skipped += 1;
      continue;
    }
    summary.matches += 1;
    const competition =
      match.league === null
        ? `league ${match.leagueApiId ?? '?'}`
        : match.country === null
          ? match.league
          : `${match.country} - ${match.league}`;
    const unknown: UnknownName[] = [];
    const ids = resolveNames(
      index,
      {
        sport: 'football',
        sourceId: NAROBET_BOARD,
        competition,
        home: match.home,
        away: match.away,
        kickoff: match.kickoff,
      },
      unknown,
    );
    let eventId: string | null = null;
    if (ids.homeTeamId !== null && ids.awayTeamId !== null && ids.homeTeamId !== ids.awayTeamId) {
      eventId = await findEventByTeams(
        ctx.db,
        { homeTeamId: ids.homeTeamId, awayTeamId: ids.awayTeamId, kickoff: match.kickoff },
        MARKET_ODDS_LINK_WINDOW_MS,
      );
    } else {
      summary.unresolved += 1;
    }
    if (eventId !== null) summary.linked += 1;
    const sameTeam = ids.homeTeamId !== null && ids.homeTeamId === ids.awayTeamId;
    const sourceKey = `${NAROBET_BOARD}:${match.id}`;
    const previous = before.get(sourceKey);
    entries.push({
      match,
      competitionId: ids.competitionId,
      homeTeamId: sameTeam ? null : ids.homeTeamId,
      awayTeamId: sameTeam ? null : ids.awayTeamId,
      eventId,
      reprice:
        previous === undefined ||
        previous.pricesAt.getTime() !== match.pricesAt.getTime() ||
        previous.kickoff.getTime() !== match.kickoff.getTime(),
    });
    rows.push({
      sourceKey,
      board: 'narobet',
      competitionRaw: competition,
      homeRaw: match.home,
      awayRaw: match.away,
      kickoff: match.kickoff,
      homeTeamId: sameTeam ? null : ids.homeTeamId,
      awayTeamId: sameTeam ? null : ids.awayTeamId,
      eventId,
      markets: match.markets.map((m) => ({ type: m.type, line: m.line, prices: m.prices })),
      pricesAt: match.pricesAt,
      observedAt: now,
      fixtureId: match.apiId,
    });
  }
  await ctx.db.transaction((tx) => upsertBoardOdds(tx, rows));
  summary.boardEvents = await syncNarobetEvents(ctx, entries, now);
  ctx.logger.info({ ...summary }, 'narobet board read');
  return summary;
}

/**
 * Whether mr-z itself still reads Narobet: its `/api/health` answers from its own database (503 when
 * its poller has not finished a cycle lately). Null when it is fine, else why. Local only: this
 * makes mr-z read nothing from Narobet.
 */
export async function mrzPollerProblem(
  ctx: ScraperContext,
  fetchImpl: FetchLike = fetch,
): Promise<string | null> {
  const base = ctx.config.scraper.narobet.url;
  if (base === null) return null;
  try {
    const response = await fetchImpl(`${base}/api/health`, {
      headers: { accept: 'application/json' },
      redirect: 'error',
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (response.status === 503) return 'mr-z has not read Narobet lately';
    if (!response.ok) return `mr-z health: HTTP ${response.status}`;
    return null;
  } catch (error) {
    return `mr-z health: ${(error as Error).message}`;
  }
}

/**
 * Whether mr-z's board is read: while `narobet_pricing` or `narobet_events` is on (owner, 23 Nov
 * 2026: an API switched off is not called and raises no alert). The results cross-check of
 * Narobet-only matches reads mr-z's stored results apart (board-results.ts) and goes on.
 */
export async function narobetReadWanted(ctx: Pick<ScraperContext, 'db'>): Promise<boolean> {
  return (
    (await getBoardPricing(ctx.db, 'narobet')).enabled || (await getNarobetEvents(ctx.db)).enabled
  );
}

/**
 * The interval task, or null when SCRAPER_NAROBET_URL is not set. While both Narobet switches are
 * off it does not call mr-z; it only closes the stale prices of Narobet-only matches.
 */
export function narobetTask(ctx: ScraperContext): IntervalTask | null {
  const { url, intervalMs } = ctx.config.scraper.narobet;
  if (url === null) return null;
  return intervalTask({
    name: 'narobet',
    intervalMs,
    run: async () => {
      try {
        if (!(await narobetReadWanted(ctx))) return;
        await readNarobetBoard(ctx);
        // mr-z's health (service-health task, docs/plans/counter-codes-and-deposit-recovery.md G7).
        const problem = await mrzPollerProblem(ctx);
        if (problem === null) await reportServiceOk(ctx.db, 'mrz', ctx.clock());
        else await reportServiceFailure(ctx.db, 'mrz', ctx.clock(), problem);
      } catch (error) {
        await reportServiceFailure(ctx.db, 'mrz', ctx.clock(), (error as Error).message);
        throw error;
      } finally {
        // Also after a failed read: stale prices must not stay open.
        await sweepNarobetEvents(ctx, ctx.clock());
      }
    },
    logger: ctx.logger,
  });
}
