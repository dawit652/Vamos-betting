import { SCRAPED_FEED_PROVIDER, type MarketTypeCode } from '@vamos/core';
import {
  getTeamRatings,
  marketsWithSelections,
  type DbExecutor,
  type DbTransaction,
} from '@vamos/db';
import { events, teams } from '@vamos/db/schema';
import { checkMarkets, isCalibrated, type GateMarket } from '@vamos/scraper';
import { eq, inArray } from 'drizzle-orm';
import { unprocessable } from '../../lib/errors';

async function teamLabels(exec: DbExecutor, ids: readonly string[]): Promise<Map<string, string>> {
  const rows = await exec
    .select({ id: teams.id, name: teams.name, shortName: teams.shortName })
    .from(teams)
    .where(inArray(teams.id, [...ids]));
  return new Map(rows.map((row) => [row.id, row.name.en || row.shortName]));
}

/**
 * The calibration and price checks of the data scraper (rules O1 and O2), for a person who opens
 * betting by hand on an event the scraper created. The scraper's own route for this (a review item
 * of kind odds_approval) only exists once both checks passed; this is the same promise for the
 * generic trading control, which would otherwise let a trader open prices that nobody reviewed.
 *
 * Events of any other feed are not affected, and an event whose betting is already open is left to
 * the caller (repeating the request changes nothing). Refuses with 422:
 *
 * - `teams_uncalibrated`: a team's ratings were never reviewed (O1), the same test the scraper uses
 *   before it prices a fixture;
 * - `prices_failed_checks`: the prices that would become bettable (the event's open and suspended
 *   markets) fail the sanity checks (O2), or there are none.
 *
 * Closing betting is never checked: the caller does not call this for it. The event row is locked,
 * so a re-price by the scraper cannot slip in between the check and the change.
 */
export async function assertScrapedEventMayOpen(
  tx: DbTransaction,
  eventId: string,
  minRatingMatches: number,
): Promise<void> {
  const [event] = await tx
    .select({
      feedProvider: events.feedProvider,
      bettingOpen: events.bettingOpen,
      homeTeamId: events.homeTeamId,
      awayTeamId: events.awayTeamId,
    })
    .from(events)
    .where(eq(events.id, eventId))
    .for('update');
  // An unknown event is the caller's 404.
  if (event === undefined || event.feedProvider !== SCRAPED_FEED_PROVIDER || event.bettingOpen) {
    return;
  }

  const rated = await getTeamRatings(tx, [event.homeTeamId, event.awayTeamId]);
  const unreviewed = [event.homeTeamId, event.awayTeamId].filter(
    (id) => !isCalibrated(rated.get(id)?.ratings ?? null, minRatingMatches),
  );
  if (unreviewed.length > 0) {
    const labels = await teamLabels(tx, unreviewed);
    const names = unreviewed.map((id) => labels.get(id) ?? id);
    throw unprocessable(
      'teams_uncalibrated',
      `Betting cannot open until the ratings of ${names.join(' and ')} have been reviewed`,
      { teams: unreviewed.map((id, index) => ({ id, name: names[index] })) },
    );
  }

  const stored = await marketsWithSelections(tx, eventId);
  const bettable: GateMarket[] = stored
    .filter((market) => market.status === 'open' || market.status === 'suspended')
    .map((market) => ({
      type: market.type as MarketTypeCode,
      line: market.line,
      selections: market.selections.map((s) => ({ code: s.code, oddsMilli: s.oddsMilli })),
    }));
  const check = checkMarkets(bettable);
  if (!check.ok) {
    throw unprocessable(
      'prices_failed_checks',
      'Betting cannot open: the prices of the event fail the price checks',
      {
        issues: check.issues.map(({ code, market, selection }) => ({ code, market, selection })),
      },
    );
  }
}
