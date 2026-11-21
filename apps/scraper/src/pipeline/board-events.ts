import { anyMarketKey, type FactoryPricingPlan } from '@vamos/core';
import {
  BOARD_FEED_PROVIDER,
  boardOddsTimes,
  ensureBoardCompetition,
  ensureBoardTeam,
  followedApiFootballLeagueIds,
  getHulusportPricing,
  getNarobetEvents,
  listBoardEvents,
  listBoardEventsBetween,
  loadBoardCatalog,
  loadFactoryPricingPlan,
  marketsWithSelections,
  raiseCloseLead,
  setMarketStatus,
  suspendEvent,
  upsertFixture,
  type BoardCatalog,
  type BoardEventNear,
  type BoardName,
  type LiveMessage,
} from '@vamos/db';
import { boardGoalsFit, priceBoardMarkets } from '@vamos/feed';
import {
  BOARD_PRICES_MAX_AGE_MS,
  checkMarkets,
  HULUSPORT_SOURCE_ID,
  MARKET_CLOSE_LEAD_MS,
  MARKET_ODDS_LINK_WINDOW_MS,
  MIN_LEAD_MS,
  NAROBET_BOARD,
  NAROBET_EVENTS_MAX_NEW_PER_READ,
  NAROBET_EXCLUDED_LEAGUE_IDS,
  NAROBET_FACTORY_WITHIN_MS,
  narobetPricesMaxAgeMs,
  sameMatchLikely,
  type BoardMatch,
  type NarobetMatch,
} from '@vamos/scraper';
import type { ScraperContext } from '../context';
import { publishAfterCommit } from '../lib/publish';
import { factoryMarketsFrom, type PricedMarket } from './event-pricing';

/**
 * Competitor board matches Nahubet does not list itself become events of their own:
 *
 * - Hulusport's (owner's decision of 14 Nov 2026, docs/plans/hulusport-feed.md), while the switch
 *   `hulusport_pricing` is on;
 * - Narobet's through mr-z (owner's decisions of 21 Nov 2026, docs/plans/narobet-events.md), while
 *   the switch `narobet_events` is on, up to its horizon (30 days by default). Only matches that
 *   carry API-Football's fixture and league ids (the results are looked up by them), never a club
 *   friendly (league 667), at most NAROBET_EVENTS_MAX_NEW_PER_READ new ones per read, re-priced
 *   only when mr-z re-read the match (or its markets are all suspended), and the factory's markets
 *   only within NAROBET_FACTORY_WITHIN_MS of the kickoff.
 *
 * Every league the board brings is shown, in competitions and with teams created for it, priced
 * from the board alone (with our margin), betting open while the board's prices are fresh.
 *
 * Never in a league Nahubet lists itself: a league is ours when one of its board matches links to
 * our event, or its name resolves to one of our competitions (for Narobet also: its API-Football id
 * is one Nahubet follows itself); a match with a team of our own catalogue is never created either.
 * Never a second copy of a match another board already listed: a club both boards list is one team
 * (a board may use any board's team), the same two teams within MARKET_ODDS_LINK_WINDOW_MS are one
 * match, and another board's listing under other names is caught by `sameMatchLikely`. All of this
 * fails closed (the match is not listed).
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
 * Every pass (the sweep, also when reading the board failed): an upcoming board event whose board
 * prices are not fresh (the board's freshness rule), or every one while the switch is off, has its
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

/** A Narobet match of one read (tasks/narobet.ts), as BoardEntry is for Hulusport. */
export interface NarobetEntry {
  match: NarobetMatch;
  competitionId: string | null;
  homeTeamId: string | null;
  awayTeamId: string | null;
  eventId: string | null;
  /**
   * False when mr-z has not re-read the match since our last read (same `pricesAt`, same kickoff):
   * its event is then not re-priced, unless its markets are all suspended.
   */
  reprice: boolean;
}

export interface NarobetEventsSummary extends BoardEventsSummary {
  /** Events left as they were: mr-z did not re-read the match. */
  unchanged: number;
  /** New matches left for a later read (at most NAROBET_EVENTS_MAX_NEW_PER_READ per read). */
  deferred: number;
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

/** What the generic pass needs of a board. */
interface BoardSpec {
  board: BoardName;
  feedProvider: string;
  /** odds_history.source of its prices, and the prefix of its board keys ('<id>:<match id>'). */
  sourceId: string;
  maxAgeMs: (kickoff: Date, now: Date) => number;
  maxNewPerPass: number | null;
  factoryWithinMs: number | null;
}

const HULUSPORT: BoardSpec = {
  board: 'hulusport',
  feedProvider: BOARD_FEED_PROVIDER,
  sourceId: HULUSPORT_SOURCE_ID,
  maxAgeMs: () => BOARD_PRICES_MAX_AGE_MS,
  maxNewPerPass: null,
  factoryWithinMs: null,
};

const NAROBET: BoardSpec = {
  board: 'narobet',
  feedProvider: NAROBET_BOARD,
  sourceId: NAROBET_BOARD,
  maxAgeMs: narobetPricesMaxAgeMs,
  maxNewPerPass: NAROBET_EVENTS_MAX_NEW_PER_READ,
  factoryWithinMs: NAROBET_FACTORY_WITHIN_MS,
};

/** A board match as the generic pass sees it. */
interface Listed {
  id: string;
  home: string;
  away: string;
  kickoff: Date;
  pricesAt: Date | null;
  leagueKey: string | null;
  leagueName: string | null;
  leagueGroup: string | null;
  markets: BoardMatch['markets'];
}

interface ListedEntry {
  match: Listed;
  competitionId: string | null;
  homeTeamId: string | null;
  awayTeamId: string | null;
  eventId: string | null;
  reprice: boolean;
  /** Not listed whatever else holds (Narobet: no ids, a club friendly, a fixture listed twice). */
  excluded: boolean;
}

type Side = { kind: 'board'; id: string } | { kind: 'new' } | { kind: 'ours' };

function sideOf(catalog: BoardCatalog, raw: string, resolved: string | null): Side {
  const owned = catalog.teamByName.get(raw);
  if (owned !== undefined) return { kind: 'board', id: owned };
  if (resolved === null) return { kind: 'new' };
  return catalog.anyBoardTeamIds.has(resolved) ? { kind: 'board', id: resolved } : { kind: 'ours' };
}

/** True when another listing of this match is already an event (see the module notes). */
function duplicateOf(
  spec: BoardSpec,
  m: Listed,
  home: Side,
  away: Side,
  near: readonly BoardEventNear[],
): boolean {
  for (const e of near) {
    if (e.feedProvider === spec.feedProvider && e.feedRef === m.id) continue;
    const apart = Math.abs(e.startTime.getTime() - m.kickoff.getTime());
    if (
      home.kind === 'board' &&
      away.kind === 'board' &&
      e.homeTeamId === home.id &&
      e.awayTeamId === away.id &&
      apart <= MARKET_ODDS_LINK_WINDOW_MS
    ) {
      return true;
    }
    if (
      e.feedProvider !== spec.feedProvider &&
      sameMatchLikely(
        { home: m.home, away: m.away, kickoff: m.kickoff },
        { home: e.home, away: e.away, kickoff: e.startTime },
      )
    ) {
      return true;
    }
  }
  return false;
}

/** The generic pass: creates and re-prices the board events of one read. */
async function syncBoard(
  ctx: ScraperContext,
  spec: BoardSpec,
  entries: readonly ListedEntry[],
  now: Date,
  options: { horizonMs: number | null; oursLeagueKeys: ReadonlySet<string> },
): Promise<NarobetEventsSummary> {
  const summary: NarobetEventsSummary = {
    created: 0,
    updated: 0,
    skipped: 0,
    unchanged: 0,
    deferred: 0,
  };
  const catalog = await loadBoardCatalog(ctx.db, spec.board);
  const factoryPlan = ctx.config.scraper.factoryMarkets
    ? await loadFactoryPricingPlan(ctx.db)
    : null;

  // Leagues Nahubet lists itself: never add board events there.
  const ours = new Set<string>(options.oursLeagueKeys);
  for (const e of entries) {
    const key = e.match.leagueKey;
    if (key === null) continue;
    if (e.eventId !== null) ours.add(key);
    if (e.competitionId !== null && !catalog.competitionIds.has(e.competitionId)) ours.add(key);
  }

  // Every board's events around these kickoffs: this board's own (by feed ref) and the others'.
  let latest = now.getTime();
  for (const e of entries) latest = Math.max(latest, e.match.kickoff.getTime());
  const near = await listBoardEventsBetween(ctx.db, {
    from: new Date(now.getTime() - MARKET_ODDS_LINK_WINDOW_MS),
    to: new Date(latest + MARKET_ODDS_LINK_WINDOW_MS),
  });
  const own = new Map(
    near.filter((e) => e.feedProvider === spec.feedProvider).map((e) => [e.feedRef, e]),
  );

  for (const e of entries) {
    if (e.eventId !== null) continue; // our own event: boardRule prices it
    const m = e.match;
    const key = m.leagueKey;
    const fresh =
      m.pricesAt !== null && now.getTime() - m.pricesAt.getTime() <= spec.maxAgeMs(m.kickoff, now);
    if (
      e.excluded ||
      key === null ||
      ours.has(key) ||
      m.leagueName === null ||
      !fresh ||
      m.kickoff.getTime() <= now.getTime() + MIN_LEAD_MS ||
      (options.horizonMs !== null && m.kickoff.getTime() > now.getTime() + options.horizonMs)
    ) {
      summary.skipped += 1;
      continue;
    }
    const existing = own.get(m.id);
    if (existing !== undefined && !e.reprice && existing.openMarkets > 0) {
      summary.unchanged += 1;
      continue;
    }
    const home = sideOf(catalog, m.home, e.homeTeamId);
    const away = sideOf(catalog, m.away, e.awayTeamId);
    if (home.kind === 'ours' || away.kind === 'ours') {
      summary.skipped += 1;
      continue;
    }
    if (existing === undefined) {
      if (spec.maxNewPerPass !== null && summary.created >= spec.maxNewPerPass) {
        summary.deferred += 1;
        continue;
      }
      if (duplicateOf(spec, m, home, away, near)) {
        summary.skipped += 1;
        continue;
      }
    }
    const boardMarkets = priceBoardMarkets(m.markets);
    if (!boardMarkets.some((x) => x.type === '1x2') || !checkMarkets(boardMarkets).ok) {
      summary.skipped += 1;
      continue;
    }
    const withFactory =
      spec.factoryWithinMs === null || m.kickoff.getTime() - now.getTime() <= spec.factoryWithinMs;
    const markets: PricedMarket[] = [
      ...boardMarkets,
      ...(withFactory ? boardFactoryMarkets(m, factoryPlan) : []),
    ];
    const messages: LiveMessage[] = [];
    const outcome = await ctx.db.transaction(async (tx) => {
      const competitionId = await ensureBoardCompetition(tx, {
        board: spec.board,
        leagueKey: key,
        name: m.leagueName!,
        group: m.leagueGroup,
      });
      const homeTeamId =
        home.kind === 'board'
          ? home.id
          : await ensureBoardTeam(tx, { board: spec.board, rawName: m.home });
      const awayTeamId =
        away.kind === 'board'
          ? away.id
          : await ensureBoardTeam(tx, { board: spec.board, rawName: m.away });
      if (homeTeamId === awayTeamId) return null;
      const result = await upsertFixture(
        tx,
        {
          feedProvider: spec.feedProvider,
          feedRef: String(m.id),
          sport: 'football',
          competitionId,
          homeTeamId,
          awayTeamId,
          startTime: m.kickoff,
        },
        markets,
        { now, source: spec.sourceId },
      );
      messages.push(...result.messages);
      if (result.status !== 'scheduled') return { result, homeTeamId, awayTeamId };
      // The board's prices can be some minutes old: close a little before kickoff.
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
      return { result, homeTeamId, awayTeamId };
    });
    if (outcome === null) {
      summary.skipped += 1;
      continue;
    }
    if (outcome.result.created) {
      summary.created += 1;
      // A later match of this read is compared with it too.
      near.push({
        eventId: outcome.result.eventId,
        feedProvider: spec.feedProvider,
        feedRef: String(m.id),
        homeTeamId: outcome.homeTeamId,
        awayTeamId: outcome.awayTeamId,
        home: m.home,
        away: m.away,
        startTime: m.kickoff,
        openMarkets: 1,
      });
    } else {
      summary.updated += 1;
    }
    await publishAfterCommit(ctx.redis, messages, ctx.channel, ctx.logger);
  }
  return summary;
}

/** Creates and re-prices the Hulusport events of one read (see the module notes). */
export async function syncBoardEvents(
  ctx: ScraperContext,
  entries: readonly BoardEntry[],
  now: Date,
): Promise<BoardEventsSummary> {
  if (!(await getHulusportPricing(ctx.db)).enabled) return { created: 0, updated: 0, skipped: 0 };
  const listed = entries.map((e): ListedEntry => ({
    match: {
      id: String(e.match.id),
      home: e.match.home,
      away: e.match.away,
      kickoff: e.match.kickoff,
      pricesAt: e.match.pricesAt,
      leagueKey: e.match.leagueId === null ? null : String(e.match.leagueId),
      leagueName: e.match.leagueName,
      leagueGroup: e.match.leagueGroup,
      markets: e.match.markets,
    },
    competitionId: e.competitionId,
    homeTeamId: e.homeTeamId,
    awayTeamId: e.awayTeamId,
    eventId: e.eventId,
    reprice: true,
    excluded: false,
  }));
  const { created, updated, skipped } = await syncBoard(ctx, HULUSPORT, listed, now, {
    horizonMs: null,
    oursLeagueKeys: new Set(),
  });
  return { created, updated, skipped };
}

/** Creates and re-prices the Narobet events of one read of mr-z (see the module notes). */
export async function syncNarobetEvents(
  ctx: ScraperContext,
  entries: readonly NarobetEntry[],
  now: Date,
): Promise<NarobetEventsSummary> {
  const zero: NarobetEventsSummary = {
    created: 0,
    updated: 0,
    skipped: 0,
    unchanged: 0,
    deferred: 0,
  };
  const switchState = await getNarobetEvents(ctx.db);
  if (!switchState.enabled) return zero;
  // A fixture listed twice in one read is listed by neither (fail closed).
  const seen = new Map<number, number>();
  for (const e of entries) {
    if (e.match.apiId !== null) seen.set(e.match.apiId, (seen.get(e.match.apiId) ?? 0) + 1);
  }
  const listed = entries.map((e): ListedEntry => {
    const m = e.match;
    return {
      match: {
        id: m.id,
        home: m.home,
        away: m.away,
        kickoff: m.kickoff,
        pricesAt: m.pricesAt,
        leagueKey: m.leagueApiId === null ? null : String(m.leagueApiId),
        leagueName: m.league,
        leagueGroup: m.country,
        markets: m.markets,
      },
      competitionId: e.competitionId,
      homeTeamId: e.homeTeamId,
      awayTeamId: e.awayTeamId,
      eventId: e.eventId,
      reprice: e.reprice,
      excluded:
        m.apiId === null ||
        m.leagueApiId === null ||
        NAROBET_EXCLUDED_LEAGUE_IDS.has(m.leagueApiId) ||
        (seen.get(m.apiId) ?? 0) > 1,
    };
  });
  const followed = await followedApiFootballLeagueIds(ctx.db);
  return syncBoard(ctx, NAROBET, listed, now, {
    horizonMs: switchState.horizonDays * 24 * 60 * 60_000,
    oursLeagueKeys: new Set([...followed].map(String)),
  });
}

/** Suspends a board's upcoming events whose prices are not fresh, or all while it is off. */
async function sweepBoard(
  ctx: ScraperContext,
  spec: BoardSpec,
  enabled: boolean,
  now: Date,
): Promise<number> {
  const upcoming = await listBoardEvents(ctx.db, now, spec.feedProvider);
  if (upcoming.length === 0) return 0;
  const keyOf = (feedRef: string) => `${spec.sourceId}:${feedRef}`;
  const times = enabled
    ? await boardOddsTimes(
        ctx.db,
        upcoming.map((e) => keyOf(e.feedRef)),
      )
    : new Map<string, { pricesAt: Date; observedAt: Date }>();
  let suspended = 0;
  for (const event of upcoming) {
    const row = times.get(keyOf(event.feedRef));
    const maxAge = spec.maxAgeMs(event.startTime, now);
    if (
      row !== undefined &&
      now.getTime() - row.pricesAt.getTime() <= maxAge &&
      now.getTime() - row.observedAt.getTime() <= maxAge
    ) {
      continue;
    }
    const change = await ctx.db.transaction((tx) => suspendEvent(tx, event.eventId));
    if (!change.changed) continue;
    suspended += 1;
    await publishAfterCommit(ctx.redis, change.messages, ctx.channel, ctx.logger);
  }
  if (suspended > 0) {
    ctx.logger.warn({ suspended }, `${spec.board} events suspended: no fresh prices`);
  }
  return suspended;
}

/**
 * Suspends every upcoming Hulusport event whose board prices are not fresh, or all of them while
 * the switch is off. Runs after every read, also a failed one. Returns the events suspended.
 */
export async function sweepBoardEvents(ctx: ScraperContext, now: Date): Promise<number> {
  return sweepBoard(ctx, HULUSPORT, (await getHulusportPricing(ctx.db)).enabled, now);
}

/** The same for Narobet's events (switch `narobet_events`). */
export async function sweepNarobetEvents(ctx: ScraperContext, now: Date): Promise<number> {
  return sweepBoard(ctx, NAROBET, (await getNarobetEvents(ctx.db)).enabled, now);
}
