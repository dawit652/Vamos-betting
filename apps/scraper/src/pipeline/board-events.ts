import { anyMarketKey, type FactoryPricingPlan } from '@vamos/core';
import {
  BOARD_FEED_PROVIDER,
  ensureBoardCompetition,
  ensureBoardTeam,
  freshBoardKeys,
  getHulusportPricing,
  listBoardEvents,
  loadBoardCatalog,
  loadFactoryPricingPlan,
  marketsWithSelections,
  raiseCloseLead,
  setMarketStatus,
  suspendEvent,
  upsertFixture,
  type BoardCatalog,
  type LiveMessage,
} from '@vamos/db';
import { boardGoalsFit, priceBoardMarkets } from '@vamos/feed';
import {
  BOARD_PRICES_MAX_AGE_MS,
  checkMarkets,
  HULUSPORT_SOURCE_ID,
  MARKET_CLOSE_LEAD_MS,
  MIN_LEAD_MS,
  type BoardMatch,
} from '@vamos/scraper';
import type { ScraperContext } from '../context';
import { publishAfterCommit } from '../lib/publish';
import { factoryMarketsFrom, type PricedMarket } from './event-pricing';

/**
 * Hulusport matches Nahubet does not list itself (owner's decision of 14 Nov 2026, docs/plans/
 * hulusport-feed.md): every league the mr-x board brings is shown, in competitions and with teams
 * created for it, priced from the board alone (with our margin), betting open while the board's
 * prices are fresh. Results are entered by a person (the back office lists the ones waiting).
 *
 * Only while the switch `hulusport_pricing` is on. Never in a league Nahubet lists itself: a league
 * is ours when one of its board matches links to our event, or its name resolves to one of our
 * competitions; a match with a team of our own catalogue is never created either. Both fail closed
 * (the match is not listed), so the board cannot put a second copy of one of our matches on the site.
 *
 * The market factory (SCRAPER_FACTORY_MARKETS=on, owner's request of 16 Nov 2026: about 500
 * options per match): a board event also gets the factory's own markets, priced from the expected
 * goals that explain the board's own 1X2 and goal line (boardGoalsFit: the conditions of rule O5,
 * a goal line to fit and a fit residual within MAX_MARKET_FIT_RESIDUAL), at the factory's margins
 * and without the families the weekly job suspended or turned off (loadFactoryPricingPlan), each
 * market passing O2 on its own (factoryMarketsFrom), exactly as on a market-priced event of ours.
 * Without a usable fit, or switched off, its stored factory markets are suspended by the feed and
 * re-open with the next read that prices them.
 *
 * Every pass (sweepBoardEvents, also when reading the board failed): an upcoming board event whose
 * board prices are not fresh (BOARD_PRICES_MAX_AGE_MS), or every one while the switch is off, has its
 * markets suspended; the next fresh read re-opens what the board quotes.
 */

export interface BoardEntry {
  match: BoardMatch;
  /** Our competition the league's name resolved to (alias rules), or null. */
  competitionId: string | null;
  /** Our teams the names resolved to (alias rules), or null. */
  homeTeamId: string | null;
  awayTeamId: string | null;
  /** Our scraped event the match linked to, or null. */
  eventId: string | null;
}

export interface BoardEventsSummary {
  created: number;
  updated: number;
  /** Matches not listed: our league or team, stale or unpriceable, too close to kickoff. */
  skipped: number;
}

/** The factory's markets of a board match (see the module notes); none without a plan or a fit. */
export function boardFactoryMarkets(
  match: Pick<BoardMatch, 'markets'>,
  plan: FactoryPricingPlan | null,
): PricedMarket[] {
  if (plan === null) return [];
  const fit = boardGoalsFit(match.markets);
  return fit === null ? [] : factoryMarketsFrom(fit.lambdaHome, fit.lambdaAway, plan);
}

const leagueKeyOf = (m: BoardMatch): string | null =>
  m.leagueId === null ? null : String(m.leagueId);

type Side = { kind: 'board'; id: string } | { kind: 'new' } | { kind: 'ours' };

function sideOf(catalog: BoardCatalog, raw: string, resolved: string | null): Side {
  const owned = catalog.teamByName.get(raw);
  if (owned !== undefined) return { kind: 'board', id: owned };
  if (resolved === null) return { kind: 'new' };
  return catalog.teamIds.has(resolved) ? { kind: 'board', id: resolved } : { kind: 'ours' };
}

/** Creates and re-prices the board events of one read (see the module notes). */
export async function syncBoardEvents(
  ctx: ScraperContext,
  entries: readonly BoardEntry[],
  now: Date,
): Promise<BoardEventsSummary> {
  const summary: BoardEventsSummary = { created: 0, updated: 0, skipped: 0 };
  if (!(await getHulusportPricing(ctx.db)).enabled) return summary;
  const catalog = await loadBoardCatalog(ctx.db, 'hulusport');
  const factoryPlan = ctx.config.scraper.factoryMarkets
    ? await loadFactoryPricingPlan(ctx.db)
    : null;

  // Leagues Nahubet lists itself: never add board events there.
  const ours = new Set<string>();
  for (const e of entries) {
    const key = leagueKeyOf(e.match);
    if (key === null) continue;
    if (e.eventId !== null) ours.add(key);
    if (e.competitionId !== null && !catalog.competitionIds.has(e.competitionId)) ours.add(key);
  }

  for (const e of entries) {
    if (e.eventId !== null) continue; // our own event: boardRule prices it
    const m = e.match;
    const key = leagueKeyOf(m);
    const fresh =
      m.pricesAt !== null && now.getTime() - m.pricesAt.getTime() <= BOARD_PRICES_MAX_AGE_MS;
    if (
      key === null ||
      ours.has(key) ||
      m.leagueName === null ||
      !fresh ||
      m.kickoff.getTime() <= now.getTime() + MIN_LEAD_MS
    ) {
      summary.skipped += 1;
      continue;
    }
    const home = sideOf(catalog, m.home, e.homeTeamId);
    const away = sideOf(catalog, m.away, e.awayTeamId);
    if (home.kind === 'ours' || away.kind === 'ours') {
      summary.skipped += 1;
      continue;
    }
    const boardMarkets = priceBoardMarkets(m.markets);
    if (!boardMarkets.some((x) => x.type === '1x2') || !checkMarkets(boardMarkets).ok) {
      summary.skipped += 1;
      continue;
    }
    const markets: PricedMarket[] = [...boardMarkets, ...boardFactoryMarkets(m, factoryPlan)];
    const messages: LiveMessage[] = [];
    const outcome = await ctx.db.transaction(async (tx) => {
      const competitionId = await ensureBoardCompetition(tx, {
        board: 'hulusport',
        leagueKey: key,
        name: m.leagueName!,
        group: m.leagueGroup,
      });
      const homeTeamId =
        home.kind === 'board'
          ? home.id
          : await ensureBoardTeam(tx, { board: 'hulusport', rawName: m.home });
      const awayTeamId =
        away.kind === 'board'
          ? away.id
          : await ensureBoardTeam(tx, { board: 'hulusport', rawName: m.away });
      if (homeTeamId === awayTeamId) return null;
      const result = await upsertFixture(
        tx,
        {
          feedProvider: BOARD_FEED_PROVIDER,
          feedRef: String(m.id),
          sport: 'football',
          competitionId,
          homeTeamId,
          awayTeamId,
          startTime: m.kickoff,
        },
        markets,
        { now, source: HULUSPORT_SOURCE_ID },
      );
      messages.push(...result.messages);
      if (result.status !== 'scheduled') return result;
      // The board's prices can be up to BOARD_PRICES_MAX_AGE_MS old: close a little before kickoff.
      await raiseCloseLead(tx, result.eventId, MARKET_CLOSE_LEAD_MS);
      // What the board quotes (and the factory prices from it) is open, unless a trader suspended
      // it; what it dropped is suspended.
      const quoted = new Set(markets.map((x) => anyMarketKey(x.type, x.line)));
      for (const stored of await marketsWithSelections(tx, result.eventId)) {
        if (stored.status === 'open' && !quoted.has(stored.key)) {
          messages.push(...(await setMarketStatus(tx, stored.id, 'suspended')).messages);
        } else if (
          stored.status === 'suspended' &&
          stored.suspendedBy === 'feed' &&
          quoted.has(stored.key)
        ) {
          messages.push(...(await setMarketStatus(tx, stored.id, 'open')).messages);
        }
      }
      return result;
    });
    if (outcome === null) {
      summary.skipped += 1;
      continue;
    }
    if (outcome.created) summary.created += 1;
    else summary.updated += 1;
    await publishAfterCommit(ctx.redis, messages, ctx.channel, ctx.logger);
  }
  return summary;
}

/**
 * Suspends every upcoming board event whose board prices are not fresh, or all of them while the
 * switch is off. Runs after every read, also a failed one. Returns the events suspended.
 */
export async function sweepBoardEvents(ctx: ScraperContext, now: Date): Promise<number> {
  const upcoming = await listBoardEvents(ctx.db, now);
  if (upcoming.length === 0) return 0;
  const keyOf = (feedRef: string) => `${HULUSPORT_SOURCE_ID}:${feedRef}`;
  const fresh = (await getHulusportPricing(ctx.db)).enabled
    ? await freshBoardKeys(ctx.db, {
        sourceKeys: upcoming.map((e) => keyOf(e.feedRef)),
        now,
        maxAgeMs: BOARD_PRICES_MAX_AGE_MS,
      })
    : new Set<string>();
  let suspended = 0;
  for (const event of upcoming) {
    if (fresh.has(keyOf(event.feedRef))) continue;
    const change = await ctx.db.transaction((tx) => suspendEvent(tx, event.eventId));
    if (!change.changed) continue;
    suspended += 1;
    await publishAfterCommit(ctx.redis, change.messages, ctx.channel, ctx.logger);
  }
  if (suspended > 0) ctx.logger.warn({ suspended }, 'hulusport events suspended: no fresh prices');
  return suspended;
}
