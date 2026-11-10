import {
  MARKET_PRICING_KEY_PREFIX,
  marketConsensus,
  SCRAPED_FEED_PROVIDER,
  type MarketTypeCode,
} from '@vamos/core';
import {
  consensusRows,
  getCompetitionPolicy,
  getTeamRatings,
  latestMarketOdds,
  listEventPricing,
  marketsWithSelections,
  type DbExecutor,
  type DbTransaction,
} from '@vamos/db';
import { events, teams } from '@vamos/db/schema';
import {
  checkMarkets,
  isCalibrated,
  MARKET_ODDS_MAX_AGE_MS,
  marketBacksOpening,
  type GateMarket,
} from '@vamos/scraper';
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
 * Rule O1m for a person: the competition takes market prices, the event's stored prices were made
 * from the market (its pricing stamp is a market key) and the fresh 1X2 consensus behind it now has
 * at least 3 distinct bookmakers, one of them sharp (marketBacksOpening), counted as the scraper
 * counts them (consensusRows).
 */
async function backedByMarket(
  exec: DbExecutor,
  eventId: string,
  competitionId: string,
  now: Date,
): Promise<boolean> {
  if ((await getCompetitionPolicy(exec, competitionId)).pricingSource !== 'market') return false;
  const stamp = (await listEventPricing(exec, [eventId])).get(eventId);
  if (!(stamp?.ratingsKey ?? '').startsWith(`${MARKET_PRICING_KEY_PREFIX}|`)) return false;
  const rows = await latestMarketOdds(exec, {
    eventIds: [eventId],
    now,
    maxAgeMs: MARKET_ODDS_MAX_AGE_MS,
  });
  const x12 = marketConsensus(consensusRows(rows)).find((c) => c.market === '1x2');
  return marketBacksOpening(x12?.bookmakers);
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
 *   before it prices a fixture, and the event's prices do not come from a market strong enough to
 *   stand in for them (O1m: a market-priced competition, prices made from the market, 3 distinct
 *   books in its fresh 1X2, one sharp);
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
  now: Date,
): Promise<void> {
  const [event] = await tx
    .select({
      feedProvider: events.feedProvider,
      bettingOpen: events.bettingOpen,
      competitionId: events.competitionId,
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
  if (unreviewed.length > 0 && !(await backedByMarket(tx, eventId, event.competitionId, now))) {
    const labels = await teamLabels(tx, unreviewed);
    const names = unreviewed.map((id) => labels.get(id) ?? id);
    throw unprocessable(
      'teams_uncalibrated',
      `Betting cannot open until the ratings of ${names.join(' and ')} have been reviewed, ` +
        'or the prices come from at least 3 bookmakers including a sharp one',
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
