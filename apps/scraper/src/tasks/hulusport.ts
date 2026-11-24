import {
  fillBoardCategoryCountries,
  findEventByTeams,
  getBoardPricing,
  reportServiceFailure,
  reportServiceOk,
  upsertBoardOdds,
  type BoardOddsInput,
} from '@vamos/db';
import {
  HULUSPORT_SOURCE_ID,
  MARKET_ODDS_LINK_WINDOW_MS,
  parseMrxBoard,
  resolveCompetition,
} from '@vamos/scraper';
import type { ScraperContext } from '../context';
import { intervalTask, type IntervalTask } from '../lib/interval';
import {
  sweepBoardEvents,
  syncBoardEvents,
  type BoardEntry,
  type BoardEventsSummary,
} from '../pipeline/board-events';
import { aliasIndexCache, resolveNames, type UnknownName } from '../pipeline/run-source';

/**
 * Reads Hulusport's board from the owner's mr-x service (docs/plans/hulusport-feed.md) and stores
 * it per match (scrape_board_odds), linked to the Nahubet event with the same two teams and a
 * kickoff within MARKET_ODDS_LINK_WINDOW_MS. Nothing here changes a price: the pricing step uses
 * the stored board only while the back office switch `hulusport_pricing` is on.
 *
 * Team names resolve as every source's do (rule N2: aliases, catalogue names, the name without its
 * legal form), with no source aliases of its own: a name that does not resolve leaves the match
 * unlinked (listed in the back office), and a global alias added there fixes it on the next read.
 * The competition is not used to link, since boards name competitions their own way.
 */

export const HULUSPORT_BOARD_PATH = '/api/board';
/** Ask mr-x for every match it tracks in the next 14 days. */
const BOARD_HOURS = 336;
const FETCH_TIMEOUT_MS = 20_000;
const MAX_BODY_BYTES = 32 * 1024 * 1024;
/** A poller that has not succeeded for this long is reported (the prices then expire by themselves). */
const POLLER_QUIET_WARN_MS = 30 * 60_000;

export interface HulusportReadSummary {
  /** Upcoming matches on the board with odds mr-x has read. */
  matches: number;
  linked: number;
  /** Matches whose team names did not both resolve. */
  unresolved: number;
  /** Matches mr-x has not read odds for yet, or that started: not stored. */
  skipped: number;
  /** Matches the board listed that could not be read. */
  rejected: number;
  /** Matches Nahubet does not list itself, listed as board events (pipeline/board-events.ts). */
  boardEvents: BoardEventsSummary;
}

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

/** One read of the board (a failed read throws; the interval task logs it and carries on). */
export async function readHulusportBoard(
  ctx: ScraperContext,
  fetchImpl: FetchLike = fetch,
): Promise<HulusportReadSummary> {
  const base = ctx.config.scraper.hulusport.url;
  const summary: HulusportReadSummary = {
    matches: 0,
    linked: 0,
    unresolved: 0,
    skipped: 0,
    rejected: 0,
    boardEvents: { created: 0, updated: 0, skipped: 0 },
  };
  if (base === null) return summary;
  const response = await fetchImpl(`${base}${HULUSPORT_BOARD_PATH}?hours=${BOARD_HOURS}`, {
    headers: { accept: 'application/json' },
    redirect: 'error',
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`mr-x board: HTTP ${response.status}`);
  const body = await response.text();
  if (body.length > MAX_BODY_BYTES)
    throw new Error(`mr-x board: ${body.length} bytes is too large`);
  const board = parseMrxBoard(body);
  if (board === null) throw new Error('mr-x board: the response is not a board');

  const now = ctx.clock();
  summary.rejected = board.rejected;
  if (
    board.lastSuccessAt === null ||
    now.getTime() - board.lastSuccessAt.getTime() > POLLER_QUIET_WARN_MS
  ) {
    ctx.logger.warn(
      { lastSuccessAt: board.lastSuccessAt?.toISOString() ?? null },
      'mr-x poller has not read Hulusport recently: its prices are expiring',
    );
    // mr-x answers but reads nothing (the PC, its Chrome or the tunnel is off): a failure for the
    // service-health task (docs/plans/counter-codes-and-deposit-recovery.md, G7).
    await reportServiceFailure(
      ctx.db,
      'mrx',
      now,
      'mr-x has not read Hulusport lately (PC, Chrome or tunnel off?)',
    );
  } else {
    await reportServiceOk(ctx.db, 'mrx', now);
  }

  const index = await aliasIndexCache(ctx).get('football');
  const rows: BoardOddsInput[] = [];
  const entries: BoardEntry[] = [];
  for (const match of board.matches) {
    if (match.pricesAt === null || match.expired || match.kickoff.getTime() <= now.getTime()) {
      summary.skipped += 1;
      continue;
    }
    summary.matches += 1;
    const competition =
      match.leagueName === null
        ? `league ${match.leagueId ?? '?'}`
        : match.leagueGroup === null
          ? match.leagueName
          : `${match.leagueGroup} - ${match.leagueName}`;
    const unknown: UnknownName[] = [];
    const ids = resolveNames(
      index,
      {
        sport: 'football',
        sourceId: HULUSPORT_SOURCE_ID,
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
    // The league as one of our competitions: by its full name, else by its plain name.
    const plain =
      match.leagueName === null
        ? null
        : resolveCompetition(index, {
            sportId: 'football',
            sourceId: HULUSPORT_SOURCE_ID,
            raw: match.leagueName,
          });
    entries.push({
      match,
      competitionId: ids.competitionId ?? (plain?.status === 'resolved' ? plain.id : null),
      homeTeamId: sameTeam ? null : ids.homeTeamId,
      awayTeamId: sameTeam ? null : ids.awayTeamId,
      eventId,
    });
    rows.push({
      sourceKey: `${HULUSPORT_SOURCE_ID}:${match.id}`,
      board: 'hulusport',
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
  summary.boardEvents = await syncBoardEvents(ctx, entries, now);
  // Categories made before they carried a country code get their flag; never fails the read.
  try {
    const filled = await fillBoardCategoryCountries(ctx.db);
    if (filled > 0) ctx.logger.info({ filled }, 'hulusport board categories got a country');
  } catch (err) {
    ctx.logger.error({ err }, 'could not fill the country of board categories');
  }
  ctx.logger.info({ ...summary }, 'hulusport board read');
  return summary;
}

/**
 * Whether mr-x is read at all: only while the back office switch `hulusport_pricing` is on (owner,
 * 23 Nov 2026: an API switched off is not called and raises no alert). Off, nothing would use the
 * board anyway: no price and no Hulusport-only match is made from it.
 */
export async function hulusportReadWanted(ctx: Pick<ScraperContext, 'db'>): Promise<boolean> {
  return (await getBoardPricing(ctx.db, 'hulusport')).enabled;
}

/**
 * The interval task, or null when SCRAPER_HULUSPORT_URL is not set. While `hulusport_pricing` is
 * off it does not call mr-x; it only closes the stale prices of Hulusport-only matches.
 */
export function hulusportTask(ctx: ScraperContext): IntervalTask | null {
  const { url, intervalMs } = ctx.config.scraper.hulusport;
  if (url === null) return null;
  return intervalTask({
    name: 'hulusport',
    intervalMs,
    run: async () => {
      try {
        if (!(await hulusportReadWanted(ctx))) return;
        await readHulusportBoard(ctx);
      } catch (error) {
        await reportServiceFailure(ctx.db, 'mrx', ctx.clock(), (error as Error).message);
        throw error;
      } finally {
        // Also after a failed read: stale prices must not stay open.
        await sweepBoardEvents(ctx, ctx.clock());
      }
    },
    logger: ctx.logger,
  });
}
