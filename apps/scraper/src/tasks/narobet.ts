import { findEventByTeams, upsertBoardOdds, type BoardOddsInput } from '@vamos/db';
import {
  MARKET_ODDS_LINK_WINDOW_MS,
  MRZ_MATCHES_PATH,
  NAROBET_BOARD,
  parseMrzMatches,
} from '@vamos/scraper';
import type { ScraperContext } from '../context';
import { intervalTask, type IntervalTask } from '../lib/interval';
import { aliasIndexCache, resolveNames, type UnknownName } from '../pipeline/run-source';

/**
 * Reads Narobet's odds from the owner's mr-z service (owner, 21 Nov 2026; docs/plans/narobet-feed.md)
 * and stores each upcoming football match in scrape_board_odds as board `narobet`, linked to the
 * Nahubet event with the same two teams and a kickoff within MARKET_ODDS_LINK_WINDOW_MS. Nothing here
 * changes a price: the pricing step uses Narobet's board only while the back office switch
 * `narobet_pricing` is on, and only for markets Nahubet already prices (event-pricing.ts,
 * boardRule). Unlike Hulusport's board, a match Nahubet does not list never becomes an event.
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
  const rows: BoardOddsInput[] = [];
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
    rows.push({
      sourceKey: `${NAROBET_BOARD}:${match.id}`,
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
    });
  }
  await ctx.db.transaction((tx) => upsertBoardOdds(tx, rows));
  ctx.logger.info({ ...summary }, 'narobet board read');
  return summary;
}

/** The interval task, or null when SCRAPER_NAROBET_URL is not set. */
export function narobetTask(ctx: ScraperContext): IntervalTask | null {
  const { url, intervalMs } = ctx.config.scraper.narobet;
  if (url === null) return null;
  return intervalTask({
    name: 'narobet',
    intervalMs,
    run: async () => {
      await readNarobetBoard(ctx);
    },
    logger: ctx.logger,
  });
}
