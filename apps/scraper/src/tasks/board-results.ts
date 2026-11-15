import {
  boardEventsWithoutResult,
  markBoardResultApplied,
  recordBoardResultSighting,
  resultEvent,
} from '@vamos/db';
import {
  API_FOOTBALL_FINISHED,
  API_FOOTBALL_HOST,
  API_FOOTBALL_KEY_HEADER,
  API_FOOTBALL_SECRET,
  apiFootballFixturesUrl,
  DAY_MS,
  matchApiFootballFixture,
  parseApiFootballFixtures,
  type ApiFootballFixture,
} from '@vamos/scraper';
import type { ScraperContext } from '../context';
import { intervalTask, type IntervalTask } from '../lib/interval';
import { publishAfterCommit } from '../lib/publish';
import { auditScraper } from '../pipeline/common';

/**
 * Automatic results for the Hulusport-only matches (owner's decision of 14 Nov 2026, docs/plans/
 * hulusport-feed.md) from API-Football, the owner's results subscription (key in
 * SCRAPER_SECRET_API_FOOTBALL, read by the fetcher, never stored).
 *
 * Every BOARD_RESULTS_INTERVAL_MS: the board events whose kickoff is between BOARD_RESULT_LAG_MS and
 * BOARD_RESULT_WINDOW_MS ago and that have no result; one request per kickoff day lists that day's
 * fixtures; each event is matched to exactly one fixture (kickoff and both team names, home as home).
 * A finished fixture (FT, AET, PEN) gives the 90-minute score and the half-time score. It is applied
 * (resultEvent: the bets settle) only once API-Football has reported the same score for at least
 * BOARD_RESULT_CONFIRM_MS. One source settles these matches: that is the owner's choice, and the wait
 * is its guard against a score corrected minutes after the whistle.
 *
 * Nothing else is decided here: no match found, a postponed, cancelled or abandoned match, or a score
 * the event cannot take (a half-time score missing for a half-time market) stays in the back office's
 * "waiting for a result" list for a person.
 */

export const BOARD_RESULTS_INTERVAL_MS = 15 * 60_000;
/** Do not ask before this long after kickoff (a match lasts about two hours with the break). */
export const BOARD_RESULT_LAG_MS = 2 * 60 * 60_000;
/** Stop asking after this long: what is still open is left to a person. */
export const BOARD_RESULT_WINDOW_MS = 3 * DAY_MS;
/** A reported score must stand this long before it settles. */
export const BOARD_RESULT_CONFIRM_MS = 15 * 60_000;
/** Kickoff days asked per pass (each is one request). */
const MAX_DAYS_PER_PASS = 4;

export interface BoardResultsSummary {
  pending: number;
  /** Matched to an API-Football fixture. */
  matched: number;
  /** A finished score seen, waiting to stand for BOARD_RESULT_CONFIRM_MS. */
  confirming: number;
  applied: number;
  /** Requests that did not give fixtures (key missing or refused, limit, network). */
  failedRequests: number;
}

const dayOf = (at: Date): string => at.toISOString().slice(0, 10);

export async function runBoardResults(ctx: ScraperContext): Promise<BoardResultsSummary> {
  const now = ctx.clock();
  const summary: BoardResultsSummary = {
    pending: 0,
    matched: 0,
    confirming: 0,
    applied: 0,
    failedRequests: 0,
  };
  const pending = await boardEventsWithoutResult(ctx.db, {
    now,
    lagMs: BOARD_RESULT_LAG_MS,
    maxAgeMs: BOARD_RESULT_WINDOW_MS,
    limit: 500,
  });
  summary.pending = pending.length;
  if (pending.length === 0) return summary;

  const fixturesByDay = new Map<string, ApiFootballFixture[]>();
  for (const day of [...new Set(pending.map((e) => dayOf(e.kickoff)))].slice(
    0,
    MAX_DAYS_PER_PASS,
  )) {
    const url = apiFootballFixturesUrl(day);
    // Always the full body: a 304 would leave nothing to match against.
    await ctx.fetcher.forgetValidators(url);
    const result = await ctx.fetcher.fetch(
      {
        url,
        purpose: 'results',
        auth: { header: API_FOOTBALL_KEY_HEADER, secret: API_FOOTBALL_SECRET },
      },
      { allowedHosts: [API_FOOTBALL_HOST], sourceKey: 'api-football-board-results' },
    );
    if (result.kind !== 'ok') {
      summary.failedRequests += 1;
      ctx.logger.warn(
        { day, result: result.kind, reason: 'reason' in result ? result.reason : undefined },
        'api-football results request failed',
      );
      continue;
    }
    const parsed = parseApiFootballFixtures(new TextDecoder().decode(result.body));
    if (parsed === null || parsed.errors.length > 0) {
      summary.failedRequests += 1;
      ctx.logger.warn(
        { day, errors: parsed?.errors ?? ['not a fixtures response'] },
        'api-football results refused',
      );
      if (parsed === null || parsed.fixtures.length === 0) continue;
    }
    fixturesByDay.set(day, parsed.fixtures);
  }

  for (const event of pending) {
    const fixtures = fixturesByDay.get(dayOf(event.kickoff));
    if (fixtures === undefined) continue;
    const fixture = matchApiFootballFixture(event, fixtures);
    if (fixture === null) continue;
    summary.matched += 1;
    if (
      !(API_FOOTBALL_FINISHED as readonly string[]).includes(fixture.status) ||
      fixture.fullTime === null
    ) {
      continue;
    }
    const score = fixture.fullTime;
    const half = fixture.halfTime;
    try {
      const outcome = await ctx.db.transaction(async (tx) => {
        const seen = await recordBoardResultSighting(tx, {
          eventId: event.eventId,
          fixtureId: fixture.id,
          status: fixture.status,
          home: score.home,
          away: score.away,
          htHome: half?.home ?? null,
          htAway: half?.away ?? null,
          seenAt: now,
        });
        if (now.getTime() - seen.firstSeenAt.getTime() < BOARD_RESULT_CONFIRM_MS) return null;
        const result = await resultEvent(tx, event.eventId, {
          status: 'finished',
          score: {
            home: score.home,
            away: score.away,
            htHome: half?.home ?? null,
            htAway: half?.away ?? null,
          },
        });
        await markBoardResultApplied(tx, event.eventId, now);
        await auditScraper(tx, {
          action: 'scrape.board.result_applied',
          targetType: 'event',
          targetId: event.eventId,
          metadata: {
            source: 'api-football',
            fixtureId: fixture.id,
            status: fixture.status,
            score,
            halfTime: half,
            firstSeenAt: seen.firstSeenAt.toISOString(),
            outcome: result.outcome,
          },
        });
        return result;
      });
      if (outcome === null) {
        summary.confirming += 1;
        continue;
      }
      summary.applied += 1;
      await publishAfterCommit(ctx.redis, outcome.messages, ctx.channel, ctx.logger);
    } catch (error) {
      // A score the event cannot take (no half-time score for a half-time market): a person decides.
      if (!(error instanceof RangeError)) throw error;
      ctx.logger.warn(
        { eventId: event.eventId, fixtureId: fixture.id, err: error.message },
        'api-football result not applied',
      );
    }
  }
  ctx.logger.info({ ...summary }, 'hulusport results from api-football');
  return summary;
}

/** The interval task, or null without an API-Football key in the scraper's environment. */
export function boardResultsTask(ctx: ScraperContext): IntervalTask | null {
  if ((process.env[API_FOOTBALL_SECRET] ?? '').trim() === '') return null;
  return intervalTask({
    name: 'hulusport-results',
    intervalMs: BOARD_RESULTS_INTERVAL_MS,
    run: () => runBoardResults(ctx),
    logger: ctx.logger,
  });
}
