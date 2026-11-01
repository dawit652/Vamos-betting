import {
  marketKey,
  SCRAPER_ACTOR,
  selectionsFor,
  SPORT_MARKETS,
  type MarketTypeCode,
  type SportCode,
} from '@vamos/core';
import {
  lockEvent,
  marketsWithSelections,
  openReviewItem,
  raiseCloseLead,
  replaceReferenceBookPrices,
  setEventBettingOpen,
  suspendMarketForGuard,
  upsertReferenceConsensus,
  upsertReferenceEventMap,
  type LiveMessage,
  type ReferenceBookPriceInput,
  type ReferenceCandidate,
  type ReferenceConsensusInput,
  type ScrapeSource,
} from '@vamos/db';
import { events as eventsTable, scrapeReviewItems } from '@vamos/db/schema';
import { consensus, DEFAULT_BOOK_WEIGHTS, type BookQuote } from '@vamos/feed';
import {
  closeLeadMs,
  guardMarket,
  KICKOFF_MATCH_TOLERANCE_MS,
  kickoffVerdict,
  REFERENCE_TIERS,
  REFERENCE_SUBJECT_MARK,
  referenceAsOf,
  referenceTier,
  resolveCompetition,
  resolveTeam,
  THERUNDOWN_MONEYLINE,
  THERUNDOWN_TOTAL,
  type TherundownConfig,
  type TherundownEvent,
  type TherundownPrice,
} from '@vamos/scraper';
import { and, desc, eq, sql } from 'drizzle-orm';
import type { ScraperContext } from '../context';
import { publishAfterCommit } from '../lib/publish';
import type { AliasIndexCache } from './run-source';
import { auditScraper, teamNames } from './common';

/**
 * TheRundown as a reference for our own prices (docs/therundown-plan/README.md, phase 1): what a
 * response means for our events. Matching (rule M1), the kickoff rule (their data is a minute or
 * more late, so any sign that a match started closes our betting), the event map and the close
 * lead, the book prices and the consensus, and the odds-error guard (rule P6).
 *
 * Nothing here writes a price. The only things that change the catalogue are closing betting on
 * an event (setEventBettingOpen(false): it only reduces exposure) and suspending a market for the
 * guard (as the scraper's own actor, so only a person re-opens it).
 */

export const REFERENCE_PROVIDER = 'therundown' as const;

/** The subject of a kickoff item raised from TheRundown: `<feedRef>|therundown`. */
export const THERUNDOWN_SUBJECT_SUFFIX = '|therundown';

/** An event of ours matches a TheRundown event when its start is within this of their kickoff (rule M1). */
export const MATCH_WINDOW_MS = 36 * 3_600_000;

const SPORTS_TRIED: readonly SportCode[] = ['football', 'basketball', 'tennis', 'volleyball'];
const SLOWEST_TIER_MAX_BOOK_AGE_MS = REFERENCE_TIERS[REFERENCE_TIERS.length - 1]!.maxBookAgeMs;

export const guardSubject = (feedRef: string, marketKeyText: string): string =>
  `${feedRef}${REFERENCE_SUBJECT_MARK}|${marketKeyText}`;
export const kickoffSubject = (feedRef: string): string => `${feedRef}${THERUNDOWN_SUBJECT_SUFFIX}`;

// --- Competitions ---------------------------------------------------------------------------

export interface ResolvedCompetition {
  /** TheRundown's sport id. */
  sportId: number;
  /** The label of the source config. */
  label: string;
  competitionId: string;
  sport: SportCode;
}

/**
 * Resolves each configured competition label to a competition of ours through the competition
 * aliases, exactly like the observation pipeline (a source-specific alias first, then a global
 * one, then a catalogue name; never fuzzy). A label that does not resolve is skipped and named in
 * `unresolved`.
 */
export async function resolveCompetitions(
  indexes: AliasIndexCache,
  source: ScrapeSource,
  config: TherundownConfig,
): Promise<{ resolved: Map<number, ResolvedCompetition>; unresolved: string[] }> {
  const resolved = new Map<number, ResolvedCompetition>();
  const unresolved: string[] = [];
  for (const entry of config.competitions) {
    let found: ResolvedCompetition | null = null;
    for (const sport of SPORTS_TRIED) {
      const resolution = resolveCompetition(await indexes.get(sport), {
        sportId: sport,
        sourceId: source.id,
        raw: entry.competition,
      });
      if (resolution.status === 'resolved') {
        found = {
          sportId: entry.sportId,
          label: entry.competition,
          competitionId: resolution.id,
          sport,
        };
        break;
      }
    }
    if (found === null) unresolved.push(entry.competition);
    else resolved.set(entry.sportId, found);
  }
  return { resolved, unresolved };
}

// --- Prices into our markets ---------------------------------------------------------------

interface OurOutcome {
  type: MarketTypeCode;
  line: string | null;
  /** Our selection code. */
  code: string;
}

/** Our market and selection for one TheRundown price; null when we do not offer it for the sport. */
export function ourOutcome(sport: SportCode, price: TherundownPrice): OurOutcome | null {
  let type: MarketTypeCode | null = null;
  let code: string | null = null;
  if (price.marketId === THERUNDOWN_MONEYLINE) {
    type =
      sport === 'football'
        ? '1x2'
        : sport === 'basketball'
          ? 'ml'
          : sport === 'tennis'
            ? 'winner'
            : null;
    if (price.outcome === 'home') code = '1';
    else if (price.outcome === 'away') code = '2';
    else if (price.outcome === 'draw' && sport === 'football') code = 'X';
  } else if (price.marketId === THERUNDOWN_TOTAL) {
    type = sport === 'football' ? 'ou' : sport === 'basketball' ? 'total' : null;
    if (price.outcome === 'over' || price.outcome === 'under') code = price.outcome;
  }
  if (type === null || code === null) return null;
  if (!SPORT_MARKETS[sport].includes(type)) return null;
  if (!selectionsFor(type).includes(code)) return null;
  // A total always has its line.
  if (price.marketId === THERUNDOWN_TOTAL && price.line === null) return null;
  return { type, line: price.line, code };
}

interface BookInMarket {
  probabilities: Record<string, number>;
  updatedAt: Date;
  liquidity: number[];
}

export interface PricedMarket {
  key: string;
  type: MarketTypeCode;
  rows: ReferenceBookPriceInput[];
  books: Map<number, BookInMarket>;
}

/** The prices of one event grouped by our market key. */
export function groupPrices(
  sport: SportCode,
  prices: readonly TherundownPrice[],
): Map<string, PricedMarket> {
  const markets = new Map<string, PricedMarket>();
  for (const price of prices) {
    const ours = ourOutcome(sport, price);
    if (ours === null) continue;
    const key = marketKey(ours.type, ours.line);
    let market = markets.get(key);
    if (market === undefined) {
      market = { key, type: ours.type, rows: [], books: new Map() };
      markets.set(key, market);
    }
    market.rows.push({
      marketKey: key,
      outcome: ours.code,
      bookId: price.bookId,
      american: price.american,
      oddsMilli: price.oddsMilli,
      vendorUpdatedAt: price.updatedAt,
      liquidityUsd: price.liquidityUsd,
    });
    let book = market.books.get(price.bookId);
    if (book === undefined) {
      book = { probabilities: {}, updatedAt: price.updatedAt, liquidity: [] };
      market.books.set(price.bookId, book);
    }
    book.probabilities[ours.code] = price.probability;
    if (price.updatedAt.getTime() > book.updatedAt.getTime()) book.updatedAt = price.updatedAt;
    if (price.liquidityUsd !== null) book.liquidity.push(price.liquidityUsd);
  }
  return markets;
}

function quotesOf(market: PricedMarket): BookQuote[] {
  return [...market.books.entries()]
    .sort(([a], [b]) => a - b)
    .map(([bookId, book]) => ({
      bookId,
      probabilities: book.probabilities,
      updatedAt: book.updatedAt,
      // The book's smallest stated limit over the outcomes: what it would take on the thinnest side.
      liquidityUsd: book.liquidity.length === 0 ? null : Math.min(...book.liquidity),
    }));
}

// --- Matching (rule M1) ---------------------------------------------------------------------

type Match =
  | { status: 'matched'; candidate: ReferenceCandidate }
  | { status: 'none' | 'unresolved' | 'ambiguous' };

/**
 * Rule M1: our event in the same competition with the same home and away team (through the
 * source's own team aliases, exact as for observations) and a start within MATCH_WINDOW_MS of
 * their kickoff. Exactly one: matched; otherwise nothing happens.
 */
async function matchOurs(
  indexes: AliasIndexCache,
  source: ScrapeSource,
  competition: ResolvedCompetition,
  event: TherundownEvent,
  candidates: readonly ReferenceCandidate[],
): Promise<Match> {
  const index = await indexes.get(competition.sport);
  const query = (raw: string) => ({ sportId: competition.sport, sourceId: source.id, raw });
  const home = resolveTeam(index, query(event.home.name));
  const away = resolveTeam(index, query(event.away.name));
  if (home.status !== 'resolved' || away.status !== 'resolved') return { status: 'unresolved' };
  const hits = candidates.filter(
    (c) =>
      c.competitionId === competition.competitionId &&
      c.homeTeamId === home.id &&
      c.awayTeamId === away.id &&
      Math.abs(c.startTime.getTime() - event.kickoff.getTime()) <= MATCH_WINDOW_MS,
  );
  const [only] = hits;
  if (hits.length === 0 || only === undefined) return { status: 'none' };
  return hits.length === 1 ? { status: 'matched', candidate: only } : { status: 'ambiguous' };
}

// --- The kickoff rule -----------------------------------------------------------------------

/**
 * The kickoff rule (the top requirement: no bet after a match starts; their data is 60 s or more
 * late). In one transaction under the event's row lock, which re-reads the event: when TheRundown
 * says the match started, is not a plain scheduled fixture, or kicks off earlier than we say, and
 * our event is scheduled with betting open, betting closes (nothing else is touched), the audit
 * `reference.betting_closed` is written and the critical `kickoff_change` item
 * `<feedRef>|therundown` is opened or refreshed. A person who dismissed the item for exactly this
 * kickoff and status of theirs has looked at it: betting is not closed again for the same pair.
 * Idempotent: it changes something only while betting is open. Deltas are returned for the caller
 * to publish after COMMIT.
 */
async function closeOnKickoff(
  ctx: ScraperContext,
  source: ScrapeSource,
  input: { eventId: string; event: TherundownEvent; fetchedAt: Date; now: Date },
): Promise<{ closed: boolean; messages: LiveMessage[] }> {
  const { eventId, event, fetchedAt, now } = input;
  const nothing = { closed: false, messages: [] as LiveMessage[] };
  return ctx.db.transaction(async (tx) => {
    const locked = await lockEvent(tx, eventId);
    const [row] = await tx
      .select({
        gameId: eventsTable.gameId,
        feedRef: eventsTable.feedRef,
        homeTeamId: eventsTable.homeTeamId,
        awayTeamId: eventsTable.awayTeamId,
        startTime: eventsTable.startTime,
        hasBets: sql<boolean>`EXISTS (SELECT 1 FROM bet_legs bl WHERE bl.event_id = ${eventsTable.id})`,
      })
      .from(eventsTable)
      .where(eq(eventsTable.id, eventId));
    if (row === undefined || locked.status !== 'scheduled' || !locked.bettingOpen) return nothing;
    // The snapshot the decision started from may be old: decide again on the row as it is now.
    const verdict = kickoffVerdict({
      ourStart: row.startTime,
      theirKickoff: event.kickoff,
      theirStatus: event.status,
      now,
    });
    if (verdict.action !== 'close') return nothing;

    const subjectKey = kickoffSubject(row.feedRef);
    const theirKickoff = event.kickoff.toISOString();
    const [latest] = await tx
      .select({ status: scrapeReviewItems.status, payload: scrapeReviewItems.payload })
      .from(scrapeReviewItems)
      .where(
        and(
          eq(scrapeReviewItems.kind, 'kickoff_change'),
          eq(scrapeReviewItems.subjectKey, subjectKey),
        ),
      )
      .orderBy(desc(scrapeReviewItems.createdAt), desc(scrapeReviewItems.id))
      .limit(1);
    if (
      latest?.status === 'dismissed' &&
      latest.payload.theirKickoff === theirKickoff &&
      latest.payload.theirStatus === event.status
    ) {
      return nothing;
    }

    const change = await setEventBettingOpen(tx, eventId, false);
    const names = await teamNames(tx, [row.homeTeamId, row.awayTeamId]);
    await auditScraper(tx, {
      action: 'reference.betting_closed',
      targetType: 'event',
      targetId: eventId,
      metadata: {
        rule: 'M1',
        reason: verdict.reason,
        providerEventId: event.eventId,
        theirKickoff,
        theirStatus: event.status,
        feedRef: row.feedRef,
        ourStart: row.startTime.toISOString(),
      },
    });
    await openReviewItem(tx, {
      kind: 'kickoff_change',
      subjectKey,
      severity: 'critical',
      title: `TheRundown says ${names.get(row.homeTeamId) ?? 'the home team'} v ${names.get(row.awayTeamId) ?? 'the away team'} may have started: betting closed`,
      payload: {
        rules: ['M1'],
        reasons: [verdict.reason],
        rule: 'M1',
        reason: verdict.reason,
        detail: `TheRundown shows ${event.status} with kickoff ${theirKickoff}; our start is ${row.startTime.toISOString()}. Betting was closed automatically. Open it again only after checking the real kickoff.`,
        // The `kickoff_change` contract, so the review page and apply_kickoff can read the item.
        eventId,
        feedRef: row.feedRef,
        gameId: String(row.gameId),
        home: names.get(row.homeTeamId) ?? row.homeTeamId,
        away: names.get(row.awayTeamId) ?? row.awayTeamId,
        currentKickoff: row.startTime.toISOString(),
        proposedKickoff: theirKickoff,
        sources: [
          { sourceId: source.id, upstream: source.upstream, changedAt: fetchedAt.toISOString() },
        ],
        hasBets: row.hasBets,
        // What TheRundown said, and the dismissal rule's key.
        providerEventId: event.eventId,
        theirKickoff,
        theirStatus: event.status,
      },
      now,
    });
    return { closed: true, messages: change.messages };
  });
}

// --- Applying a response --------------------------------------------------------------------

export interface ApplyInput {
  ctx: ScraperContext;
  source: ScrapeSource;
  config: TherundownConfig;
  competitions: ReadonlyMap<number, ResolvedCompetition>;
  /** Our scheduled events of the competitions, read at the start of the tick. */
  candidates: readonly ReferenceCandidate[];
  indexes: AliasIndexCache;
  events: readonly TherundownEvent[];
  /** When the response arrived. */
  fetchedAt: Date;
  /** The data delay to assume for it (rule A1), seconds. */
  delaySeconds: number;
  /** Books `/api/v2/affiliates` calls healthy; null when unknown. */
  healthyBooks: ReadonlySet<number> | null;
}

export interface ApplySummary {
  /** Events looked at. */
  events: number;
  /** Matched to exactly one of ours (rule M1). */
  matched: number;
  /** Closed for the kickoff rule. */
  closed: number;
  /** Mapped, with close lead and prices stored. */
  mapped: number;
  /** Consensus rows written. */
  consensus: number;
  /** Markets the guard suspended. */
  suspended: number;
  /** Markets the guard only reported (we are far worse than the market). */
  info: number;
  /** Events not matched: names unresolved, none, ambiguous, or a competition that is not configured. */
  skipped: number;
  /** Events whose processing failed (logged; tried again on the next poll). */
  failed: number;
  published: number;
}

export const emptyApplySummary = (): ApplySummary => ({
  events: 0,
  matched: 0,
  closed: 0,
  mapped: 0,
  consensus: 0,
  suspended: 0,
  info: 0,
  skipped: 0,
  failed: 0,
  published: 0,
});

const warnedPublish = new WeakSet<object>();

/**
 * Applies the events of one response: for each, match ours (M1), apply the kickoff rule, and for
 * a match whose kickoff agrees map it, raise the close lead, store the book prices and the
 * consensus, and run the odds-error guard (P6). Each step is its own transaction; deltas are
 * published after each COMMIT. Idempotent: the same response again changes nothing but the
 * timestamps of what is stored.
 */
export async function applyTherundownEvents(input: ApplyInput): Promise<ApplySummary> {
  const { ctx, source, config, competitions, candidates, indexes, fetchedAt } = input;
  const summary = emptyApplySummary();
  const now = ctx.clock();
  const oddsUse = ctx.config.therundown.oddsUse;
  if (oddsUse === 'publish' && !warnedPublish.has(ctx)) {
    warnedPublish.add(ctx);
    ctx.logger.warn(
      'THERUNDOWN_ODDS_USE=publish is not built yet: TheRundown is used as a reference only',
    );
  }
  const asOf = referenceAsOf(fetchedAt, input.delaySeconds);

  // Match first: two TheRundown events of one match (an old id and the id of a rescheduled one)
  // are not both mapped; the kickoff rule still looks at each of them.
  const matched: Array<{
    event: TherundownEvent;
    candidate: ReferenceCandidate;
    sport: SportCode;
  }> = [];
  for (const event of input.events) {
    summary.events += 1;
    const competition = competitions.get(event.sportId);
    if (competition === undefined) {
      summary.skipped += 1;
      continue;
    }
    const match = await matchOurs(indexes, source, competition, event, candidates);
    if (match.status !== 'matched') {
      summary.skipped += 1;
      ctx.logger.debug(
        { providerEventId: event.eventId, match: match.status },
        'TheRundown event not matched to one of ours',
      );
      continue;
    }
    summary.matched += 1;
    matched.push({ event, candidate: match.candidate, sport: competition.sport });
  }
  const perOurs = new Map<string, number>();
  for (const m of matched)
    perOurs.set(m.candidate.eventId, (perOurs.get(m.candidate.eventId) ?? 0) + 1);

  // 1. The kickoff rule first, for every event, so that nothing below can hold up a close. It is
  // decided again in the transaction, on the event as it is now. One event failing (a database
  // error) is logged and does not stop the others; the next poll tries it again.
  const closing = new Set<TherundownEvent>();
  for (const { event, candidate } of matched) {
    const verdict = kickoffVerdict({
      ourStart: candidate.startTime,
      theirKickoff: event.kickoff,
      theirStatus: event.status,
      now,
    });
    if (verdict.action !== 'close') continue;
    closing.add(event);
    try {
      const closed = await closeOnKickoff(ctx, source, {
        eventId: candidate.eventId,
        event,
        fetchedAt,
        now,
      });
      if (closed.closed) summary.closed += 1;
      summary.published += await publishAfterCommit(
        ctx.redis,
        closed.messages,
        ctx.channel,
        ctx.logger,
      );
    } catch (error) {
      summary.failed += 1;
      ctx.logger.error(
        { err: error, eventId: candidate.eventId, providerEventId: event.eventId },
        'closing betting on a kickoff failed',
      );
    }
  }

  // 2. Only a kickoff that agrees maps (a later one is left to the kickoff rules), and an event
  // of ours that two TheRundown events claim is not mapped to either. Then the prices, the
  // consensus and the odds-error guard (P6).
  for (const { event, candidate, sport } of matched) {
    if (
      closing.has(event) ||
      Math.abs(event.kickoff.getTime() - candidate.startTime.getTime()) >
        KICKOFF_MATCH_TOLERANCE_MS ||
      perOurs.get(candidate.eventId) !== 1 ||
      oddsUse === 'off'
    ) {
      continue;
    }
    try {
      const tier = referenceTier(candidate.startTime, now);
      const priced = groupPrices(sport, event.prices);
      const rows: ReferenceConsensusInput[] = [];
      const results = new Map<string, ReturnType<typeof consensus>>();
      for (const market of priced.values()) {
        const result = consensus(quotesOf(market), {
          outcomes: selectionsFor(market.type),
          anchors: config.books.anchors,
          weights: DEFAULT_BOOK_WEIGHTS,
          now,
          maxBookAgeMs: tier?.maxBookAgeMs ?? SLOWEST_TIER_MAX_BOOK_AGE_MS,
          healthyBooks: input.healthyBooks,
        });
        results.set(market.key, result);
        if (result.ok) {
          rows.push({
            eventId: candidate.eventId,
            provider: REFERENCE_PROVIDER,
            marketKey: market.key,
            fair: result.fair,
            booksUsed: result.booksUsed,
            dispersion: result.dispersion,
            confidence: result.confidence,
            asOf,
            computedAt: now,
          });
        }
      }
      await ctx.db.transaction(async (tx) => {
        await upsertReferenceEventMap(tx, {
          provider: REFERENCE_PROVIDER,
          providerEventId: event.eventId,
          eventId: candidate.eventId,
          providerSportId: event.sportId,
          homeTeamRef: event.home.teamId,
          awayTeamRef: event.away.teamId,
          kickoff: event.kickoff,
          status: event.status,
          seenAt: fetchedAt,
        });
        await raiseCloseLead(tx, candidate.eventId, closeLeadMs(input.delaySeconds));
        await replaceReferenceBookPrices(tx, {
          provider: REFERENCE_PROVIDER,
          providerEventId: event.eventId,
          fetchedAt,
          asOf,
          prices: [...priced.values()].flatMap((market) => market.rows),
        });
        summary.consensus += await upsertReferenceConsensus(tx, rows);
      });
      summary.mapped += 1;

      // The odds-error guard (P6).
      for (const row of rows) {
        const outcome = await guardOne(ctx, source, {
          candidate,
          providerEventId: event.eventId,
          row,
          now,
        });
        if (outcome.kind === 'suspended') summary.suspended += 1;
        else if (outcome.kind === 'info') summary.info += 1;
        summary.published += await publishAfterCommit(
          ctx.redis,
          outcome.messages,
          ctx.channel,
          ctx.logger,
        );
      }
    } catch (error) {
      summary.failed += 1;
      ctx.logger.error(
        { err: error, eventId: candidate.eventId, providerEventId: event.eventId },
        'applying TheRundown prices failed',
      );
    }
  }
  return summary;
}

// --- The odds-error guard (P6) --------------------------------------------------------------

type GuardOutcome =
  { kind: 'suspended'; messages: LiveMessage[] } | { kind: 'info' | 'none'; messages: [] };

const noGuardAction: GuardOutcome = { kind: 'none', messages: [] };

/**
 * Rule P6 on one market: for our OPEN market with this key and its open selections, the player's
 * edge against the consensus. A suspension is audited, made as the scraper's own actor (a person
 * re-opens it: automatic code never does), and opens or refreshes the `odds_approval` item
 * `<feedRef>|reference|<marketKey>`, which never offers "Open betting". An edge far below the
 * market only counts as `info`. A market that is not open (a trader's suspension, or the guard's
 * own from an earlier tick) is not looked at, so the item opens once per stop.
 */
async function guardOne(
  ctx: ScraperContext,
  source: ScrapeSource,
  input: {
    candidate: ReferenceCandidate;
    providerEventId: string;
    row: ReferenceConsensusInput;
    now: Date;
  },
): Promise<GuardOutcome> {
  const { candidate, row, now } = input;
  // A cheap look before a transaction: most markets pass.
  const stored = await marketsWithSelections(ctx.db, candidate.eventId);
  const look = (list: typeof stored) => {
    const market = list.find((m) => m.key === row.marketKey && m.status === 'open');
    if (market === undefined) return null;
    const selections = market.selections
      .filter((s) => s.status === 'open')
      .map((s) => ({ selectionId: s.id, code: s.code, oddsMilli: s.oddsMilli }));
    return { market, selections, verdict: guardMarket(selections, row.fair, row.confidence) };
  };
  const first = look(stored);
  if (first === null || first.verdict.action === 'none') return noGuardAction;
  if (first.verdict.action === 'info') return { kind: 'info', messages: [] };

  return ctx.db.transaction(async (tx): Promise<GuardOutcome> => {
    const locked = await lockEvent(tx, candidate.eventId);
    if (locked.status !== 'scheduled' && locked.status !== 'live') return noGuardAction;
    const again = look(await marketsWithSelections(tx, candidate.eventId));
    if (again === null || again.verdict.action !== 'suspend') return noGuardAction;
    const { market, selections, verdict } = again;

    const change = await suspendMarketForGuard(tx, market.id);
    const [event] = await tx
      .select({
        gameId: eventsTable.gameId,
        homeTeamId: eventsTable.homeTeamId,
        awayTeamId: eventsTable.awayTeamId,
        startTime: eventsTable.startTime,
      })
      .from(eventsTable)
      .where(eq(eventsTable.id, candidate.eventId));
    if (event === undefined) return noGuardAction;
    const names = await teamNames(tx, [event.homeTeamId, event.awayTeamId]);
    const home = names.get(event.homeTeamId) ?? event.homeTeamId;
    const away = names.get(event.awayTeamId) ?? event.awayTeamId;
    const consensusView = {
      fair: row.fair,
      confidence: row.confidence,
      dispersion: row.dispersion,
      booksUsed: row.booksUsed,
      asOf: row.asOf.toISOString(),
    };
    const edges = verdict.edges.map((e) => ({ code: e.code, edge: e.edge }));
    await auditScraper(tx, {
      action: 'reference.market_suspended',
      targetType: 'market',
      targetId: market.id,
      metadata: {
        rule: 'P6',
        eventId: candidate.eventId,
        feedRef: candidate.feedRef,
        marketKey: row.marketKey,
        providerEventId: input.providerEventId,
        actor: SCRAPER_ACTOR,
        consensus: consensusView,
        edges,
        worst: { code: verdict.worst.code, edge: verdict.worst.edge },
      },
    });
    await openReviewItem(tx, {
      kind: 'odds_approval',
      subjectKey: guardSubject(candidate.feedRef, row.marketKey),
      severity: 'warning',
      title: `Odds differ from the market: ${home} v ${away}, ${row.marketKey} suspended`,
      payload: {
        rules: ['P6'],
        reasons: ['market_divergence'],
        // The odds payload of the contract (the page shows our prices and the reason).
        eventId: candidate.eventId,
        feedRef: candidate.feedRef,
        gameId: String(event.gameId),
        home,
        away,
        kickoff: event.startTime.toISOString(),
        reason: 'market_divergence',
        markets: [
          {
            market: row.marketKey,
            selections: selections.map((s) => ({ name: s.code, oddsMilli: s.oddsMilli })),
          },
        ],
        // What the guard saw.
        marketKey: row.marketKey,
        providerEventId: input.providerEventId,
        consensus: consensusView,
        edges,
        worst: { code: verdict.worst.code, edge: verdict.worst.edge },
      },
      now,
    });
    return { kind: 'suspended', messages: change.messages };
  });
}
