import { syncMarketStaleAlarm } from './credit-alarms';
import {
  marketKey,
  SCRAPED_FEED_PROVIDER,
  type MarketTypeCode,
  type ScrapePricingSource,
} from '@vamos/core';
import {
  closeReviewItemsBySubject,
  getCompetitionPolicy,
  getTeamRatings,
  listCompetitionPolicies,
  listEventPricing,
  listReviewItems,
  listScrapedEvents,
  lockEvent,
  marketsWithSelections,
  raiseCloseLead,
  recordEventHeld,
  recordEventPriced,
  upsertFixture,
  type LiveMessage,
  type ScrapedEvent,
} from '@vamos/db';
import { events as eventsTable } from '@vamos/db/schema';
import type { TeamRatings } from '@vamos/feed';
import {
  buildReviews,
  checkReprice,
  heldKeyOf,
  isCalibrated,
  MARKET_CLOSE_LEAD_MS,
  MIN_LEAD_MS,
  ratingsKey,
  REPRICE_SUBJECT_SUFFIX,
  repriceReview,
  type GateMarket,
  type GateReview,
  type OddsCheck,
  type OddsIssue,
} from '@vamos/scraper';
import { eq } from 'drizzle-orm';
import type { ScraperContext } from '../context';
import { publishAfterCommit } from '../lib/publish';
import { LOOK_AHEAD_MS } from './promote-fixtures';
import { auditScraper, display, openGateReviews, teamNames } from './common';
import { isMarketKey, priceEvent, type EventPrice } from './event-pricing';

export interface RepriceSummary {
  /** Scheduled events whose ratings changed since they were priced. */
  events: number;
  /** Re-priced within the bounds (prices moved or not). */
  repriced: number;
  /** Proposals held for a person (the old prices stay). */
  held: number;
  /** Not looked at: uncalibrated teams, or the event changed under us. */
  skipped: number;
  /** Events whose `ratings_uncalibrated` item was closed and handed to a trader (`odds_approval`). */
  calibrated: number;
  failed: number;
  published: number;
}

/** What the pricing step reads of a competition's policy. */
interface PricingPolicy {
  enabled: boolean;
  pricingSource: ScrapePricingSource;
}

type Outcome =
  | { kind: 'repriced' | 'held'; messages: LiveMessage[] }
  | { kind: 'current' | 'skipped'; messages: [] };

/** market_stale is raised for matches this close to kickoff (docs/theoddsapi-plan/README.md 4.8). */
const MARKET_STALE_ALARM_LEAD_MS = 24 * 60 * 60_000;

const current = (): Outcome => ({ kind: 'current', messages: [] });
const skipped = (): Outcome => ({ kind: 'skipped', messages: [] });

/**
 * Rule O3, re-pricing after ratings change (and rule O5, after the bookmaker market changes
 * for a competition whose policy takes its prices from the licensed feed: see event-pricing.ts;
 * the stamp then holds a market key, the same bounds, O2, trader hold and lead time apply, and a
 * market-priced event whose market goes stale keeps its prices). Every applied result moves two
 * teams' ratings; events already created for those teams keep the prices they
 * were created with. This step prices the book again for the scheduled events
 * whose teams' ratings differ from the ratings their prices were computed from
 * (`scrape_event_pricing`, stamped when an event is created or re-priced) and:
 *
 * - applies it when `checkReprice` accepts it (same markets and selections, O2
 *   on every market, no selection of the 1X2 or the 2.5 goals line moved by more
 *   than MAX_PRICE_MOVE_RATIO; the other markets follow them and may move more), with
 *   `upsertFixture`: only open selections whose feed price moved change, a
 *   trader's or the drift's price stays until the model itself moves; in one
 *   transaction with the stamp and the audit, deltas published after COMMIT;
 * - otherwise keeps the old prices and opens the `odds_approval` item
 *   `<feedRef>|reprice` with the proposal (a trader applies it with the
 *   `apply_reprice` decision, or dismisses it);
 * - holds a proposal for a person too, whatever its size, when the competition's
 *   policy is not `enabled` (S4: a switched-off competition changes nothing by
 *   itself; the hold keeps the proposal visible, and switching the policy on
 *   again looks at the event anew);
 * - hands an event over once its teams are calibrated and its prices follow the
 *   ratings (`handOverCalibrated`): the `ratings_uncalibrated` item closes
 *   and an `odds_approval` item asks a trader to open betting;
 * - never touches an event that is not scheduled, has a result, starts within
 *   MIN_LEAD_MS, belongs to a competition without a policy row, or whose
 *   teams are not calibrated (O1).
 *
 * Betting stays as it is: a closed event is re-priced and stays closed. This
 * step never opens betting, not even for a competition with `auto_open` on:
 * F7 opens at creation, and later F7b (the last step of the promotion pass,
 * `auto-open.ts`) once the kickoff is confirmed; a held proposal keeps F7b
 * from opening until a person applies or dismisses it. Bets
 * already placed keep their odds (a leg stores the odds it was accepted at).
 * Idempotent: a stamped event is not looked at again until its ratings change,
 * and a held proposal is not raised again for the same ratings.
 */
export async function repriceScheduledEvents(ctx: ScraperContext): Promise<RepriceSummary> {
  const now = ctx.clock();
  const summary: RepriceSummary = {
    events: 0,
    repriced: 0,
    held: 0,
    skipped: 0,
    calibrated: 0,
    failed: 0,
    published: 0,
  };
  const policyRows = await listCompetitionPolicies(ctx.db, { sportId: 'football' });
  const policyOf = new Map<string, PricingPolicy>(
    policyRows
      .filter((row) => row.configured)
      .map((row) => [
        row.competitionId,
        { enabled: row.enabled, pricingSource: row.pricingSource },
      ]),
  );
  if (policyOf.size === 0) return summary;

  const scheduled = (
    await listScrapedEvents(ctx.db, {
      from: new Date(now.getTime() + MIN_LEAD_MS),
      to: new Date(now.getTime() + LOOK_AHEAD_MS),
    })
  ).filter(
    (event) =>
      event.status === 'scheduled' &&
      event.resultedAt === null &&
      event.score === null &&
      policyOf.has(event.competitionId),
  );
  if (scheduled.length === 0) return summary;

  // A cheap look at a snapshot decides which events deserve a transaction.
  const ratings = await getTeamRatings(
    ctx.db,
    scheduled.flatMap((event) => [event.homeTeamId, event.awayTeamId]),
  );
  const stamps = await listEventPricing(
    ctx.db,
    scheduled.map((event) => event.eventId),
  );
  for (const event of scheduled) {
    const policy = policyOf.get(event.competitionId)!;
    const home = ratings.get(event.homeTeamId)?.ratings ?? null;
    const away = ratings.get(event.awayTeamId)?.ratings ?? null;
    // Only a competition that takes market prices needs the market read; the others look at the ratings alone.
    const price =
      policy.pricingSource === 'market'
        ? await priceEvent(ctx.db, pricingInput(ctx, policy, event.eventId, home, away, now))
        : null;
    const key = price?.key ?? ratingsKey(home, away);
    const state = settled(stamps.get(event.eventId), key, price?.source ?? 'model', policy);
    // 4.8 market_stale: a market-priced match within 24 h keeps prices the market no longer backs.
    if (price !== null) {
      await ctx.db.transaction((tx) =>
        syncMarketStaleAlarm(tx, {
          eventId: event.eventId,
          kickoff: event.startTime,
          stale:
            state === 'keep' &&
            price.fallback === 'no_consensus' &&
            event.startTime.getTime() - now.getTime() <= MARKET_STALE_ALARM_LEAD_MS,
          now,
        }),
      );
    }
    if (state !== 'go') continue;
    summary.events += 1;
    try {
      const outcome = await repriceOne(ctx, event, now);
      if (outcome.kind === 'repriced') summary.repriced += 1;
      else if (outcome.kind === 'held') summary.held += 1;
      else if (outcome.kind === 'skipped') summary.skipped += 1;
      summary.published += await publishAfterCommit(
        ctx.redis,
        outcome.messages,
        ctx.channel,
        ctx.logger,
      );
    } catch (error) {
      summary.failed += 1;
      ctx.logger.error({ err: error, eventId: event.eventId }, 're-pricing failed');
    }
  }
  await handOverCalibrated(ctx, scheduled, policyOf, now, summary);
  ctx.logger[
    summary.repriced + summary.held + summary.calibrated + summary.failed > 0 ? 'info' : 'debug'
  ]({ ...summary }, 'repricing run');
  return summary;
}

const pricingInput = (
  ctx: ScraperContext,
  policy: PricingPolicy,
  eventId: string,
  home: TeamRatings | null,
  away: TeamRatings | null,
  now: Date,
) => ({
  competitionPricingSource: policy.pricingSource,
  eventId,
  homeRatings: home,
  awayRatings: away,
  minRatingMatches: ctx.config.scraper.minRatingMatches,
  now,
});

/**
 * Whether an event's stamp already covers the prices it would get now:
 * - 'current': the stamp (or the held proposal) is this very key;
 * - 'keep': a competition on market prices whose event was priced from the market, and the market
 *   is not usable now (stale, one book, poor fit): the prices stay as they are; they never fall
 *   back to the model by themselves;
 * - 'go': the event needs a new price (or a proposal) from `key`.
 */
function settled(
  stamp: { ratingsKey: string | null; heldKey: string | null } | undefined,
  key: string,
  source: 'market' | 'model',
  policy: PricingPolicy,
): 'current' | 'keep' | 'go' {
  if (stamp?.ratingsKey === key || stamp?.heldKey === heldKeyOf(key, policy.enabled)) {
    return 'current';
  }
  if (policy.pricingSource === 'market' && source === 'model' && isMarketKey(stamp?.ratingsKey)) {
    return 'keep';
  }
  return 'go';
}

const asGate = (
  type: string,
  line: string | null,
  selections: ReadonlyArray<{ code: string; oddsMilli: number }>,
): GateMarket => ({
  type: type as MarketTypeCode,
  line,
  selections: selections.map((s) => ({ code: s.code, oddsMilli: s.oddsMilli })),
});

/**
 * One event, in one transaction with its row locked: everything the snapshot
 * said is read again (status, kickoff, ratings, stamp, prices) so a result, a
 * trader or a second worker in between cannot make the decision stale.
 */
async function repriceOne(ctx: ScraperContext, event: ScrapedEvent, now: Date): Promise<Outcome> {
  return ctx.db.transaction(async (tx): Promise<Outcome> => {
    const locked = await lockEvent(tx, event.eventId);
    const [row] = await tx
      .select({
        gameId: eventsTable.gameId,
        feedRef: eventsTable.feedRef,
        competitionId: eventsTable.competitionId,
        homeTeamId: eventsTable.homeTeamId,
        awayTeamId: eventsTable.awayTeamId,
        startTime: eventsTable.startTime,
        resultedAt: eventsTable.resultedAt,
      })
      .from(eventsTable)
      .where(eq(eventsTable.id, event.eventId));
    if (
      row === undefined ||
      locked.status !== 'scheduled' ||
      row.resultedAt !== null ||
      row.startTime.getTime() < now.getTime() + MIN_LEAD_MS
    ) {
      return skipped();
    }

    // The policy as it is now (it may have been switched since the snapshot).
    const policy = await getCompetitionPolicy(tx, row.competitionId);
    const enabled = policy.enabled;
    const rated = await getTeamRatings(tx, [row.homeTeamId, row.awayTeamId]);
    const home = rated.get(row.homeTeamId)?.ratings ?? null;
    const away = rated.get(row.awayTeamId)?.ratings ?? null;
    // O5: where the prices come from (the market when the policy says so and a fresh consensus exists).
    const price = await priceEvent(tx, pricingInput(ctx, policy, event.eventId, home, away, now));
    // The market's data is late: an event of a market-priced competition closes betting early.
    if (policy.pricingSource === 'market') {
      await raiseCloseLead(tx, event.eventId, MARKET_CLOSE_LEAD_MS);
    }
    const key = price.key;
    const held = heldKeyOf(key, enabled);
    const stamp = (await listEventPricing(tx, [event.eventId])).get(event.eventId);
    const state = settled(stamp, key, price.source, policy);
    if (state === 'current') return current();
    // A market-priced event whose market is not usable now keeps its prices.
    if (state === 'keep') return skipped();
    // O1: teams that stopped being calibrated are not priced from (nothing to compare either);
    // market prices do not use the ratings, so they do not need them.
    if (!price.calibrated) return skipped();

    // Only markets the upsert may touch take part: a closed market keeps its price.
    const stored = await marketsWithSelections(tx, event.eventId);
    const open = stored.filter((m) => m.status === 'open' || m.status === 'suspended');
    const frozen = new Set(stored.filter((m) => !open.includes(m)).map((m) => m.key));
    const previous = open.map((m) => asGate(m.type, m.line, m.selections));
    const next = price.markets.filter((m) => !frozen.has(marketKey(m.type, m.line)));
    const check = checkReprice(previous, next);

    if (check.ok && enabled) {
      const result = await upsertFixture(
        tx,
        {
          feedProvider: SCRAPED_FEED_PROVIDER,
          feedRef: row.feedRef,
          sport: 'football',
          competitionId: row.competitionId,
          homeTeamId: row.homeTeamId,
          awayTeamId: row.awayTeamId,
          startTime: row.startTime,
        },
        next,
        { now },
      );
      await recordEventPriced(tx, event.eventId, key, now);
      await closeReviewItemsBySubject(tx, `${row.feedRef}${REPRICE_SUBJECT_SUFFIX}`, {
        kinds: ['odds_approval'],
        resolution: 'the prices were re-priced within the bounds',
        now,
      });
      if (result.oddsChanged > 0 || result.marketsAdded > 0) {
        await auditScraper(tx, {
          action: 'scrape.fixture.repriced',
          targetType: 'event',
          targetId: event.eventId,
          metadata: {
            feedRef: row.feedRef,
            via: 'auto',
            ratingsKey: key,
            previousRatingsKey: stamp?.ratingsKey ?? null,
            oddsChanged: result.oddsChanged,
            ...pricingAudit(price),
          },
        });
      }
      return { kind: 'repriced', messages: result.messages };
    }

    // Nothing would change and nobody needs to look: just remember the ratings.
    if (check.ok && !differs(previous, next)) {
      await recordEventPriced(tx, event.eventId, key, now);
      return { kind: 'repriced', messages: [] };
    }

    const issues: OddsIssue[] = [
      ...(enabled
        ? []
        : [
            {
              code: 'policy_disabled' as const,
              market: null,
              selection: null,
              detail: 'the competition policy is switched off: nothing is re-priced by itself',
            },
          ]),
      ...(check.ok ? [] : check.issues),
    ];
    const names = await teamNames(tx, [row.homeTeamId, row.awayTeamId]);
    const review = repriceReview(
      { eventId: event.eventId, feedRef: row.feedRef },
      next,
      { ok: false, issues } satisfies Extract<OddsCheck, { ok: false }>,
      {
        gameId: String(row.gameId),
        home: names.get(row.homeTeamId) ?? row.homeTeamId,
        away: names.get(row.awayTeamId) ?? row.awayTeamId,
        kickoff: row.startTime.toISOString(),
        reason: issues
          .slice(0, 3)
          .map((i) => [i.code, i.market, i.selection, i.detail].filter(Boolean).join(' '))
          .join('; '),
        markets: display(previous, next),
        ratingsKey: key,
        pricing: pricingNote(price),
      },
    );
    await openGateReviews(tx, [review], now);
    await recordEventHeld(tx, event.eventId, held, now);
    return { kind: 'held', messages: [] };
  });
}

/** How the prices were made, for the audit trail. */
const pricingAudit = (price: EventPrice) => ({
  pricingSource: price.source,
  ...(price.books === undefined ? {} : { books: price.books }),
  ...(price.bookmakers === undefined ? {} : { bookmakers: price.bookmakers }),
  ...(price.residual === undefined ? {} : { fitResidual: price.residual }),
  ...(price.totalsLine === undefined ? {} : { totalsLine: price.totalsLine }),
  ...(price.fallback === undefined ? {} : { marketFallback: price.fallback }),
});

/** How the prices were made, as the review payload shows it (contract: OddsReviewPayload.pricing). */
const pricingNote = (price: EventPrice) => ({
  source: price.source,
  ...(price.books === undefined ? {} : { books: price.books }),
  ...(price.residual === undefined ? {} : { residual: price.residual }),
  ...(price.fallback === undefined ? {} : { fallback: price.fallback }),
});

/** True when some selection of `next` has another price than the same one of `previous`. */
function differs(previous: readonly GateMarket[], next: readonly GateMarket[]): boolean {
  const old = new Map<string, number>();
  for (const m of previous) {
    for (const s of m.selections) old.set(`${marketKey(m.type, m.line)}|${s.code}`, s.oddsMilli);
  }
  return next.some((m) =>
    m.selections.some((s) => old.get(`${marketKey(m.type, m.line)}|${s.code}`) !== s.oddsMilli),
  );
}

/** The subject keys (event feed refs) of every open `ratings_uncalibrated` item. */
async function openUncalibratedSubjects(ctx: ScraperContext): Promise<Set<string>> {
  const subjects = new Set<string>();
  const PAGE = 200;
  let last: { createdAt: Date; id: string } | undefined;
  for (;;) {
    const page = await listReviewItems(ctx.db, {
      kind: 'ratings_uncalibrated',
      status: 'open',
      limit: PAGE,
      ...(last === undefined ? {} : { after: last }),
    });
    for (const item of page) subjects.add(item.subjectKey);
    const tail = page.at(-1);
    if (tail === undefined || page.length < PAGE) return subjects;
    last = { createdAt: tail.createdAt, id: tail.id };
  }
}

/**
 * The uncalibrated to calibrated flow. An event created for teams without
 * calibrated ratings has betting closed and an open `ratings_uncalibrated` item
 * (F7), which the API refuses to open betting on. Nothing else closes that
 * item, so here: for every scheduled event of an enabled competition whose item
 * is open, once both teams are calibrated (O1) or the event is priced from a market
 * whose 1X2 books back opening without them (O1m: 3 distinct books, one sharp), and
 * the stored prices are the current ones (the stamp equals the current key: the re-price was
 * applied just now, nothing needed changing, or a trader applied the held
 * proposal), the item is resolved by the system (`{"decision":"calibrated"}`)
 * and an `odds_approval` item in the contract's odds payload shape asks a trader
 * to open betting. A held re-price keeps the item open, because the stamp is not
 * moved until the proposal is applied. Betting is never opened here.
 */
async function handOverCalibrated(
  ctx: ScraperContext,
  scheduled: readonly ScrapedEvent[],
  policyOf: ReadonlyMap<string, PricingPolicy>,
  now: Date,
  summary: RepriceSummary,
): Promise<void> {
  const waiting = await openUncalibratedSubjects(ctx);
  if (waiting.size === 0) return;
  for (const event of scheduled) {
    if (!waiting.has(event.feedRef) || policyOf.get(event.competitionId)?.enabled !== true)
      continue;
    try {
      if (await handOverOne(ctx, event, now)) summary.calibrated += 1;
    } catch (error) {
      summary.failed += 1;
      ctx.logger.error(
        { err: error, eventId: event.eventId },
        'handing over a calibrated event failed',
      );
    }
  }
}

async function handOverOne(ctx: ScraperContext, event: ScrapedEvent, now: Date): Promise<boolean> {
  return ctx.db.transaction(async (tx) => {
    const locked = await lockEvent(tx, event.eventId);
    const [row] = await tx
      .select({
        gameId: eventsTable.gameId,
        feedRef: eventsTable.feedRef,
        competitionId: eventsTable.competitionId,
        homeTeamId: eventsTable.homeTeamId,
        awayTeamId: eventsTable.awayTeamId,
        startTime: eventsTable.startTime,
        resultedAt: eventsTable.resultedAt,
        bettingOpen: eventsTable.bettingOpen,
      })
      .from(eventsTable)
      .where(eq(eventsTable.id, event.eventId));
    if (
      row === undefined ||
      locked.status !== 'scheduled' ||
      row.resultedAt !== null ||
      row.startTime.getTime() < now.getTime() + MIN_LEAD_MS
    ) {
      return false;
    }
    const policy = await getCompetitionPolicy(tx, row.competitionId);
    const rated = await getTeamRatings(tx, [row.homeTeamId, row.awayTeamId]);
    const home = rated.get(row.homeTeamId)?.ratings ?? null;
    const away = rated.get(row.awayTeamId)?.ratings ?? null;
    // Ready: calibrated teams (O1), or market prices strong enough to open without them (O1m),
    // the same test a person's "Open betting" applies, and ...
    const price = await priceEvent(tx, pricingInput(ctx, policy, event.eventId, home, away, now));
    const minMatches = ctx.config.scraper.minRatingMatches;
    const teamsCalibrated = isCalibrated(home, minMatches) && isCalibrated(away, minMatches);
    if (!teamsCalibrated && !(price.source === 'market' && price.backsOpening)) return false;
    const key = price.key;
    const stamp = (await listEventPricing(tx, [event.eventId])).get(event.eventId);
    // ... the stored prices come from what the prices are now (not an older book, nor a held
    // proposal; a market-priced event whose market has gone stale waits for a fresh one).
    if (stamp?.ratingsKey !== key) return false;

    const closed = await closeReviewItemsBySubject(tx, row.feedRef, {
      kinds: ['ratings_uncalibrated'],
      resolution: JSON.stringify({ decision: 'calibrated' }),
      now,
    });
    if (closed.length === 0) return false;

    // A person may have opened betting meanwhile: then there is nothing to ask.
    let asked = false;
    if (!row.bettingOpen) {
      const stored = await marketsWithSelections(tx, event.eventId);
      const book = stored
        .filter((m) => m.status === 'open' || m.status === 'suspended')
        .map((m) => asGate(m.type, m.line, m.selections));
      const pricesSane = price.pricesSane;
      const names = await teamNames(tx, [row.homeTeamId, row.awayTeamId]);
      const reason = !pricesSane
        ? 'prices_not_sane'
        : price.source === 'market'
          ? 'market_priced'
          : 'ratings_calibrated';
      const [review] = buildReviews(
        row.feedRef,
        [{ kind: 'odds_approval', rule: 'F7', reason }],
        () => ({
          feedRef: row.feedRef,
          kickoff: row.startTime.toISOString(),
          calibrated: true,
          pricesSane,
          // F7 did not open it at creation; this event waits for a person, or for F7b once
          // its kickoff is confirmed in a competition with auto_open.
          autoOpen: false,
        }),
      );
      const approval: GateReview = {
        ...review!,
        payload: {
          ...review!.payload,
          eventId: event.eventId,
          gameId: String(row.gameId),
          home: names.get(row.homeTeamId) ?? row.homeTeamId,
          away: names.get(row.awayTeamId) ?? row.awayTeamId,
          reason,
          markets: display([], book),
          pricing: pricingNote(price),
        },
      };
      await openGateReviews(tx, [approval], now);
      asked = true;
    }
    await auditScraper(tx, {
      action: 'scrape.fixture.calibrated',
      targetType: 'event',
      targetId: event.eventId,
      metadata: {
        feedRef: row.feedRef,
        ratingsKey: key,
        approvalOpened: asked,
        ...pricingAudit(price),
      },
    });
    return true;
  });
}
