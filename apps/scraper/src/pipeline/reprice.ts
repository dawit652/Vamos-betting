import { marketKey, SCRAPED_FEED_PROVIDER, type MarketTypeCode } from '@vamos/core';
import {
  closeReviewItemsBySubject,
  getTeamRatings,
  listCompetitionPolicies,
  listEventPricing,
  listReviewItems,
  listScrapedEvents,
  lockEvent,
  marketsWithSelections,
  recordEventHeld,
  recordEventPriced,
  upsertFixture,
  type LiveMessage,
  type ScrapedEvent,
} from '@vamos/db';
import { events as eventsTable } from '@vamos/db/schema';
import { priceFixture } from '@vamos/feed';
import {
  buildReviews,
  checkMarkets,
  checkReprice,
  isCalibrated,
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

/** Added to a held key while the policy is off, so switching it on again looks at the event anew. */
const POLICY_OFF = '#policy_off';

type Outcome =
  | { kind: 'repriced' | 'held'; messages: LiveMessage[] }
  | { kind: 'current' | 'skipped'; messages: [] };

const current = (): Outcome => ({ kind: 'current', messages: [] });
const skipped = (): Outcome => ({ kind: 'skipped', messages: [] });

/**
 * Rule O3, re-pricing after ratings change. Every applied result moves two
 * teams' ratings; events already created for those teams keep the prices they
 * were created with. This step prices the book again for the scheduled events
 * whose teams' ratings differ from the ratings their prices were computed from
 * (`scrape_event_pricing`, stamped when an event is created or re-priced) and:
 *
 * - applies it when `checkReprice` accepts it (same markets and selections, O2,
 *   no selection moved by more than MAX_PRICE_MOVE_RATIO), with
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
 * `auto_open` is read only when an event is created (F7); an event that was
 * created uncalibrated is opened by a person from the feed screen. Bets
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
  const enabledOf = new Map(
    policyRows.filter((row) => row.configured).map((row) => [row.competitionId, row.enabled]),
  );
  if (enabledOf.size === 0) return summary;

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
      enabledOf.has(event.competitionId),
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
    const key = ratingsKey(
      ratings.get(event.homeTeamId)?.ratings,
      ratings.get(event.awayTeamId)?.ratings,
    );
    const stamp = stamps.get(event.eventId);
    if (
      stamp?.ratingsKey === key ||
      stamp?.heldKey === heldKeyOf(key, enabledOf.get(event.competitionId)!)
    ) {
      continue;
    }
    summary.events += 1;
    try {
      const outcome = await repriceOne(ctx, event, enabledOf.get(event.competitionId)!, now);
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
  await handOverCalibrated(ctx, scheduled, enabledOf, now, summary);
  ctx.logger[
    summary.repriced + summary.held + summary.calibrated + summary.failed > 0 ? 'info' : 'debug'
  ]({ ...summary }, 'repricing run');
  return summary;
}

const heldKeyOf = (key: string, enabled: boolean): string =>
  enabled ? key : `${key}${POLICY_OFF}`;

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
async function repriceOne(
  ctx: ScraperContext,
  event: ScrapedEvent,
  enabled: boolean,
  now: Date,
): Promise<Outcome> {
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

    const rated = await getTeamRatings(tx, [row.homeTeamId, row.awayTeamId]);
    const home = rated.get(row.homeTeamId)?.ratings ?? null;
    const away = rated.get(row.awayTeamId)?.ratings ?? null;
    const key = ratingsKey(home, away);
    const held = heldKeyOf(key, enabled);
    const stamp = (await listEventPricing(tx, [event.eventId])).get(event.eventId);
    if (stamp?.ratingsKey === key || stamp?.heldKey === held) return current();
    const min = ctx.config.scraper.minRatingMatches;
    // O1: teams that stopped being calibrated are not priced from (nothing to compare either).
    if (!isCalibrated(home, min) || !isCalibrated(away, min)) return skipped();

    // Only markets the upsert may touch take part: a closed market keeps its price.
    const stored = await marketsWithSelections(tx, event.eventId);
    const open = stored.filter((m) => m.status === 'open' || m.status === 'suspended');
    const frozen = new Set(stored.filter((m) => !open.includes(m)).map((m) => m.key));
    const previous = open.map((m) => asGate(m.type, m.line, m.selections));
    const next = priceFixture('football', home, away).filter(
      (m) => !frozen.has(marketKey(m.type, m.line)),
    );
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
      },
    );
    await openGateReviews(tx, [review], now);
    await recordEventHeld(tx, event.eventId, held, now);
    return { kind: 'held', messages: [] };
  });
}

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
 * is open, once both teams are calibrated (O1) and the stored prices come from
 * the teams' current ratings (the stamp equals the ratings key: the re-price was
 * applied just now, nothing needed changing, or a trader applied the held
 * proposal), the item is resolved by the system (`{"decision":"calibrated"}`)
 * and an `odds_approval` item in the contract's odds payload shape asks a trader
 * to open betting. A held re-price keeps the item open, because the stamp is not
 * moved until the proposal is applied. Betting is never opened here.
 */
async function handOverCalibrated(
  ctx: ScraperContext,
  scheduled: readonly ScrapedEvent[],
  enabledOf: ReadonlyMap<string, boolean>,
  now: Date,
  summary: RepriceSummary,
): Promise<void> {
  const waiting = await openUncalibratedSubjects(ctx);
  if (waiting.size === 0) return;
  for (const event of scheduled) {
    if (!waiting.has(event.feedRef) || enabledOf.get(event.competitionId) !== true) continue;
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
    const rated = await getTeamRatings(tx, [row.homeTeamId, row.awayTeamId]);
    const home = rated.get(row.homeTeamId)?.ratings ?? null;
    const away = rated.get(row.awayTeamId)?.ratings ?? null;
    const min = ctx.config.scraper.minRatingMatches;
    if (!isCalibrated(home, min) || !isCalibrated(away, min)) return false;
    const key = ratingsKey(home, away);
    const stamp = (await listEventPricing(tx, [event.eventId])).get(event.eventId);
    // The stored prices must come from these ratings (not an older book, nor a held proposal).
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
      const pricesSane = checkMarkets(priceFixture('football', home, away)).ok;
      const names = await teamNames(tx, [row.homeTeamId, row.awayTeamId]);
      const reason = pricesSane ? 'ratings_calibrated' : 'prices_not_sane';
      const [review] = buildReviews(
        row.feedRef,
        [{ kind: 'odds_approval', rule: 'F7', reason }],
        () => ({
          feedRef: row.feedRef,
          kickoff: row.startTime.toISOString(),
          calibrated: true,
          pricesSane,
          // auto_open is read at creation only; this event waits for a person.
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
        },
      };
      await openGateReviews(tx, [approval], now);
      asked = true;
    }
    await auditScraper(tx, {
      action: 'scrape.fixture.calibrated',
      targetType: 'event',
      targetId: event.eventId,
      metadata: { feedRef: row.feedRef, ratingsKey: key, approvalOpened: asked },
    });
    return true;
  });
}
