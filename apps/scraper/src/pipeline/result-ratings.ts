import { SCRAPED_FEED_PROVIDER, SCRAPER_ACTOR } from '@vamos/core';
import {
  competitionGoalEvidence,
  getTeamRatings,
  lockEvent,
  markRatingApplied,
  setTeamRatings,
  type DbTransaction,
} from '@vamos/db';
import {
  competitions,
  events as eventsTable,
  scrapeCompetitionPolicy,
  scrapeRatingApplied,
} from '@vamos/db/schema';
import { ratingsAfterResult, setsHomeAdvantage, type HomeAdvantageCompetition } from '@vamos/feed';
import { DAY_MS } from '@vamos/scraper';
import { and, asc, eq, gte, isNotNull, notExists, sql } from 'drizzle-orm';
import type { ScraperContext } from '../context';
import { auditScraper } from './common';

export interface ResultRatingsInput {
  /** The fixture key the once-only guard is kept under (the event's feed_ref). */
  feedRef: string;
  competitionId: string;
  homeTeamId: string;
  awayTeamId: string;
  /** The regular-time score. */
  score: { home: number; away: number };
}

/**
 * Rule O4: a finished result moves both teams' ratings once per fixture key
 * (scrape_rating_applied), and for a league result the competition's home advantage is re-derived
 * from its finished scraped results and written on both teams' ratings (F-07: pricing and the next
 * update read it there; a new league keeps the default until it has results of its own). A cup or
 * European result (P-8: setsHomeAdvantage false) moves attack and defence only and leaves the
 * home advantage of the team's league as it is (ratingsAfterResult). Call it in the result's
 * transaction, after the event is resulted, so its score counts as evidence: everything commits or
 * rolls back together. Returns whether the ratings moved (false: this fixture already moved them).
 */
export async function updateRatingsForResult(
  tx: DbTransaction,
  input: ResultRatingsInput,
): Promise<boolean> {
  if (!(await markRatingApplied(tx, input.feedRef))) return false;
  const ratings = await getTeamRatings(tx, [input.homeTeamId, input.awayTeamId], {
    forUpdate: true,
  });
  const league = setsHomeAdvantage(await homeAdvantageCompetition(tx, input.competitionId));
  const next = ratingsAfterResult(
    ratings.get(input.homeTeamId)?.ratings ?? null,
    ratings.get(input.awayTeamId)?.ratings ?? null,
    input.score,
    {
      league,
      evidence: league ? await competitionGoalEvidence(tx, input.competitionId) : null,
    },
  );
  await setTeamRatings(tx, input.homeTeamId, next.home, { system: SCRAPER_ACTOR });
  await setTeamRatings(tx, input.awayTeamId, next.away, { system: SCRAPER_ACTOR });
  return true;
}

/**
 * P-8: the competition's slug and policy `extraTime` (false without a policy row), which decide
 * with setsHomeAdvantage whether its results write the home advantage. An unknown competition (it
 * cannot be: events reference it) counts as a cup, so nothing is overwritten.
 */
async function homeAdvantageCompetition(
  tx: DbTransaction,
  competitionId: string,
): Promise<HomeAdvantageCompetition> {
  const [row] = await tx
    .select({ slug: competitions.slug, extraTime: scrapeCompetitionPolicy.extraTime })
    .from(competitions)
    .leftJoin(scrapeCompetitionPolicy, eq(scrapeCompetitionPolicy.competitionId, competitions.id))
    .where(eq(competitions.id, competitionId));
  if (row === undefined) return { slug: '', extraTime: true };
  return { slug: row.slug, extraTime: row.extraTime ?? false };
}

export interface HandResultRatingsSummary {
  /** Scraped events resulted by hand whose ratings had not moved, looked at this pass. */
  checked: number;
  /** Events whose teams' ratings this pass moved. */
  rated: number;
  /** Events that raised an error (logged, the pass goes on with the next event). */
  failed: number;
}

/** A hand result is rated only for a match that kicked off at most this long ago; older ones are history. */
export const HAND_RESULT_RATING_WINDOW_MS = 7 * DAY_MS;

/**
 * Rule O4 for a result a person entered (S-5): only the scraper's result gate
 * (applyConfirmedResult) moves the ratings in the result's transaction, so a scraped football event
 * a trader resulted by hand in Trading taught the ratings nothing. This step (in the promotion
 * pass, before re-pricing) finds the scraped football events resulted `finished` with a score that
 * kicked off in the last HAND_RESULT_RATING_WINDOW_MS (ratings learn in match order, so an old match
 * stays history) whose fixture key has no `scrape_rating_applied` row,
 * oldest kickoff first, and moves both teams' ratings once with updateRatingsForResult (the same
 * update, home advantage and once-only guard as the gate), in one transaction per event with its
 * row locked and everything read again; audit `scrape.result.rated` (`via: 'hand'`). As for the
 * gate's results, a later correction does not move the ratings again. Nothing else changes: no
 * event, market, bet or settlement.
 */
export async function rateHandResults(ctx: ScraperContext): Promise<HandResultRatingsSummary> {
  const now = ctx.clock();
  const summary: HandResultRatingsSummary = { checked: 0, rated: 0, failed: 0 };
  const since = new Date(now.getTime() - HAND_RESULT_RATING_WINDOW_MS);
  const rows = await ctx.db
    .select({ id: eventsTable.id })
    .from(eventsTable)
    .where(
      and(
        eq(eventsTable.feedProvider, SCRAPED_FEED_PROVIDER),
        eq(eventsTable.sportId, 'football'),
        eq(eventsTable.status, 'finished'),
        isNotNull(eventsTable.feedRef),
        isNotNull(eventsTable.scoreHome),
        isNotNull(eventsTable.scoreAway),
        isNotNull(eventsTable.resultedAt),
        gte(eventsTable.startTime, since),
        notExists(
          ctx.db
            .select({ one: sql`1` })
            .from(scrapeRatingApplied)
            .where(eq(scrapeRatingApplied.fixtureKey, eventsTable.feedRef)),
        ),
      ),
    )
    .orderBy(asc(eventsTable.startTime), asc(eventsTable.id));

  for (const { id } of rows) {
    summary.checked += 1;
    try {
      if (await rateOne(ctx, id)) summary.rated += 1;
    } catch (error) {
      summary.failed += 1;
      ctx.logger.error({ err: error, eventId: id }, 'rating a hand result failed');
    }
  }
  ctx.logger[summary.rated + summary.failed > 0 ? 'info' : 'debug'](
    { ...summary },
    'hand result ratings run',
  );
  return summary;
}

async function rateOne(ctx: ScraperContext, eventId: string): Promise<boolean> {
  return ctx.db.transaction(async (tx) => {
    const locked = await lockEvent(tx, eventId);
    const [row] = await tx
      .select({
        feedRef: eventsTable.feedRef,
        competitionId: eventsTable.competitionId,
        homeTeamId: eventsTable.homeTeamId,
        awayTeamId: eventsTable.awayTeamId,
        resultedAt: eventsTable.resultedAt,
      })
      .from(eventsTable)
      .where(eq(eventsTable.id, eventId));
    if (
      row === undefined ||
      row.feedRef === null ||
      row.resultedAt === null ||
      locked.status !== 'finished' ||
      locked.scoreHome === null ||
      locked.scoreAway === null
    ) {
      return false;
    }
    const score = { home: locked.scoreHome, away: locked.scoreAway };
    const rated = await updateRatingsForResult(tx, {
      feedRef: row.feedRef,
      competitionId: row.competitionId,
      homeTeamId: row.homeTeamId,
      awayTeamId: row.awayTeamId,
      score,
    });
    if (!rated) return false;
    await auditScraper(tx, {
      action: 'scrape.result.rated',
      targetType: 'event',
      targetId: eventId,
      metadata: { feedRef: row.feedRef, via: 'hand', score, rule: 'O4' },
    });
    return true;
  });
}
