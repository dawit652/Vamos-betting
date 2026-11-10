import { SCRAPED_FEED_PROVIDER } from '@vamos/core';
import {
  closeReviewItemsBySubject,
  getTeamRatings,
  listCompetitionPolicies,
  listCurrentObservations,
  listScrapedEvents,
  listSourceKickoffFacts,
  lockEvent,
  recordEventPriced,
  setEventBettingOpen,
  upsertFixture,
  type LiveMessage,
  type ScrapedEvent,
} from '@vamos/db';
import type { priceFixture } from '@vamos/feed';
import {
  agreementCovers,
  assessKickoff,
  buildReviews,
  clusterObservations,
  CONFLICT_AGREED_RESOLUTION,
  decideFixture,
  DAY_MS,
  findMissingFixtures,
  FIXTURE_HORIZON_MS,
  fixtureFeedRef,
  holdSeveralClusters,
  isCalibrated,
  KICKOFF_EVIDENCE_WINDOW_MS,
  matchEvent,
  MATCH_WINDOW_MS,
  MIN_MATCH_DURATION_MS,
  MIN_RATING_MATCHES,
  nextConflictStep,
  reviewsOf,
  SOURCE_STALE_AFTER_MS,
  sourcesAgree,
  type CompetitionPolicy,
  type EventMatch,
  type FixtureAgreement,
  type FixtureCreate,
  type FixtureDecision,
  type FixtureObservation,
  type FixtureUpdateKickoff,
  type GateReview,
  type KickoffAssessment,
  type KickoffStatement,
  type ResolvedObservation,
} from '@vamos/scraper';
import { betLegs, events as eventsTable, scrapeReviewItems } from '@vamos/db/schema';
import { and, eq } from 'drizzle-orm';
import type { ScraperContext } from '../context';
import { publishAfterCommit } from '../lib/publish';
import { priceEvent } from './event-pricing';
import { halfTimeCheck, type HalfTimeCheck } from './half-time';
import {
  auditScraper,
  display,
  OBSERVATION_ROW_LIMIT,
  openGateReviews,
  teamNames,
  toResolved,
  undecidedFrom,
  type PromoteOptions,
} from './common';

export interface PromoteFixturesSummary {
  clusters: number;
  created: number;
  kickoffMoved: number;
  held: number;
  /** Clusters left for a later pass because the observation read hit its row limit. */
  deferred: number;
  /** fixture_missing items opened or refreshed. */
  missing: number;
  /** Open kickoff_change items closed because their cause went away (F4), moves not counted. */
  kickoffItemsClosed: number;
  /** Open fixture_conflict items closed because the sources agreed again for two passes (F6c). */
  conflictItemsClosed: number;
  failed: number;
  published: number;
}

/** Resolutions of the gate's kickoff_change items that close by themselves (F4). */
const KICKOFF_ITEM_AGREED = 'every source agrees with the kickoff of the event again';
const KICKOFF_ITEM_MOVED = 'the sources moved the kickoff';
const KICKOFF_ITEM_CLOSED = 'the event has a result or is no longer scheduled';

/** Fixture observations are read from this far back (clusters straddle the start) ... */
const LOOK_BACK_MS = 2 * DAY_MS;
/** ... to this far ahead (a source may move a fixture beyond the creation horizon). */
export const LOOK_AHEAD_MS = FIXTURE_HORIZON_MS + 14 * DAY_MS;

/**
 * Promotes the current fixture observations (rules F1 to F7): for every
 * competition that has a policy row, cluster the resolved observations, find
 * the event each belongs to and apply what `decideFixture` returns, and
 * nothing else. Also flags events no source lists any more (F5) and closes the
 * fixture conflicts whose sources agreed again for two passes (F6c). This code
 * has no way to cancel, void or result an event.
 */
export async function promoteFixtures(
  ctx: ScraperContext,
  options: PromoteOptions = {},
): Promise<PromoteFixturesSummary> {
  const now = ctx.clock();
  const summary: PromoteFixturesSummary = {
    clusters: 0,
    created: 0,
    kickoffMoved: 0,
    held: 0,
    deferred: 0,
    missing: 0,
    kickoffItemsClosed: 0,
    conflictItemsClosed: 0,
    failed: 0,
    published: 0,
  };
  const policyRows = await listCompetitionPolicies(ctx.db, { sportId: 'football' });
  const slugs = new Map(policyRows.map((row) => [row.competitionId, row.slug]));
  const policies = new Map<string, CompetitionPolicy>(
    policyRows
      .filter((row) => row.configured)
      .map((row) => [
        row.competitionId,
        {
          competitionId: row.competitionId,
          enabled: row.enabled,
          autoOpen: row.autoOpen,
          autoResults: row.autoResults,
          extraTime: row.extraTime,
        },
      ]),
  );
  if (policies.size === 0) return summary;

  const limit = options.rowLimit ?? OBSERVATION_ROW_LIMIT;
  const rows = await listCurrentObservations(ctx.db, {
    kind: 'fixture',
    resolvedOnly: true,
    kickoffFrom: new Date(now.getTime() - LOOK_BACK_MS),
    kickoffTo: new Date(now.getTime() + LOOK_AHEAD_MS),
    limit,
  });
  // Fails closed: a read that hit its limit may have hidden sources of the last kickoffs.
  const cutoff = undecidedFrom(rows, limit, ctx.logger, 'fixtures');
  const observations = rows.flatMap((row) => {
    const resolved = toResolved(row, slugs);
    return resolved !== null &&
      resolved.obs.kind === 'fixture' &&
      policies.has(resolved.names.competitionId)
      ? [resolved as ResolvedObservation<FixtureObservation>]
      : [];
  });
  const events = await scrapedEvents(ctx, now);
  const openKickoffItems = await openKickoffSubjects(ctx);
  /** F4: closes the event's open kickoff_change item, once its cause went away. */
  const closeKickoffItem = async (feedRef: string, resolution: string): Promise<void> => {
    if (!openKickoffItems.delete(feedRef)) return;
    const closed = await ctx.db.transaction((tx) =>
      closeReviewItemsBySubject(tx, feedRef, { kinds: ['kickoff_change'], resolution, now }),
    );
    summary.kickoffItemsClosed += closed.length;
  };
  // F6c: the open fixture_conflict items, the subjects this pass raised one for again, and the
  // clusters the gate found in agreement (read after the loop, see `stepConflictItems`).
  const openConflicts = await openConflictItems(ctx);
  const disagreed = new Set<string>();
  const agreements: FixtureAgreement[] = [];
  const noteRaised = (decision: { action: string }): void => {
    for (const review of reviewsOf(decision)) {
      if (review.kind === 'fixture_conflict') disagreed.add(review.subjectKey);
    }
  };

  const clusters = clusterObservations(observations).filter((c) => policies.has(c.competitionId));
  // O6: which competitions' new events get the half-time markets (read once, when first needed).
  let halfTime: Promise<HalfTimeCheck> | undefined;
  const halfTimeOf = async (competitionId: string): Promise<boolean> =>
    (await (halfTime ??= halfTimeCheck(ctx)))(competitionId);
  const plan = planClusters(clusters, events);
  const deferred = cutoff === null ? new Set<number>() : deferredClusters(clusters, plan, cutoff);
  for (const [index, cluster] of clusters.entries()) {
    summary.clusters += 1;
    const policy = policies.get(cluster.competitionId);
    if (policy === undefined) continue;
    if (deferred.has(index)) {
      summary.deferred += 1;
      continue;
    }
    try {
      const several = plan.several.get(index);
      if (several !== undefined) {
        // Review finding 1: one decision for all the clusters of a fixture, taken once.
        if (several.first === index) {
          const decision = holdSeveralClusters(several.input);
          noteRaised(decision);
          await ctx.db.transaction((tx) => openGateReviews(tx, reviewsOf(decision), now));
          summary.held += 1;
        }
        continue;
      }
      const match = plan.matches[index]!;
      const candidates =
        match.kind === 'existing'
          ? [match.event]
          : match.kind === 'ambiguous'
            ? match.candidates
            : [];
      const pricing =
        candidates.length === 0
          ? await pricingFor(
              ctx,
              cluster.homeTeamId,
              cluster.awayTeamId,
              await halfTimeOf(cluster.competitionId),
            )
          : null;
      const gateInput = {
        observations: cluster.items,
        candidates,
        policy,
        now,
        calibrated: pricing?.calibrated ?? false,
        pricesSane: pricing?.pricesSane ?? false,
      };
      // K2 at creation: the kickoff must be confirmed before the gate may open betting (F7). It is
      // assessed only for a fixture that would be created, with the same pure function as everywhere.
      let decision = decideFixture({ ...gateInput, kickoffConfirmed: false });
      let kickoff: KickoffAssessment | null = null;
      if (decision.action === 'create') {
        kickoff = await assessCreation(ctx, decision, now);
        if (kickoff.confirmed) {
          const confirmed = decideFixture({ ...gateInput, kickoffConfirmed: true });
          if (
            confirmed.action === 'create' &&
            confirmed.kickoff.getTime() === decision.kickoff.getTime()
          ) {
            decision = confirmed;
          }
        }
      }
      let messages: LiveMessage[] = [];
      /** The create found the feed_ref taken and raised `feed_ref_exists` (F3) instead. */
      let feedRefTaken = false;
      switch (decision.action) {
        case 'create': {
          const created = await applyCreate(ctx, decision, pricing, now, kickoff);
          messages = created.messages;
          if (created.created) summary.created += 1;
          else {
            summary.held += 1;
            feedRefTaken = true;
            disagreed.add(decision.feedRef);
          }
          break;
        }
        case 'update-kickoff': {
          const moved = await applyKickoff(
            ctx,
            decision,
            events.find((e) => e.eventId === decision.eventId)!,
            now,
          );
          messages = moved.messages;
          if (moved.moved) {
            summary.kickoffMoved += 1;
            openKickoffItems.delete(decision.feedRef);
          }
          break;
        }
        case 'hold':
          noteRaised(decision);
          await ctx.db.transaction((tx) => openGateReviews(tx, reviewsOf(decision), now));
          summary.held += 1;
          break;
        case 'none':
          // F4: every source agrees with the event's kickoff, so a proposal to move it is stale.
          // (A closed event's item is closed after the loop, a postponed one's is kept.)
          if (match.kind === 'existing' && decision.reason === 'unchanged') {
            await closeKickoffItem(match.event.feedRef, KICKOFF_ITEM_AGREED);
          }
          break;
      }
      // F6c: recorded only once the decision was applied (a failed cluster agrees with nothing).
      if (sourcesAgree(decision) && !feedRefTaken) {
        agreements.push(agreementOf(cluster, decision, match));
      }
      summary.published += await publishAfterCommit(ctx.redis, messages, ctx.channel, ctx.logger);
    } catch (error) {
      summary.failed += 1;
      ctx.logger.error(
        { err: error, competitionId: cluster.competitionId, home: cluster.homeTeamId },
        'fixture promotion failed',
      );
    }
  }

  // F4: an event that has a result, or is live or over, has no kickoff left to move, whether or
  // not a source still lists it. Such an event is never held for its kickoff (`movable`, F4c, and
  // the gate's `event_closed`), so this cannot close an item the loop just opened.
  for (const event of events) {
    if (!openKickoffItems.has(event.feedRef) || !kickoffSettled(event)) continue;
    try {
      await closeKickoffItem(event.feedRef, KICKOFF_ITEM_CLOSED);
    } catch (error) {
      summary.failed += 1;
      ctx.logger.error({ err: error, eventId: event.eventId }, 'closing a kickoff item failed');
    }
  }

  await stepConflictItems(ctx, openConflicts, now, summary, (subjectKey) => {
    if (disagreed.has(subjectKey)) return false;
    return agreements.some((agreement) => agreementCovers(agreement, subjectKey));
  });

  summary.missing = await flagMissing(ctx, events, now);
  const changes =
    summary.created +
    summary.kickoffMoved +
    summary.held +
    summary.missing +
    summary.kickoffItemsClosed +
    summary.conflictItemsClosed;
  ctx.logger[changes > 0 ? 'info' : 'debug']({ ...summary }, 'fixture promotion run');
  return summary;
}

/**
 * The subjects of the open kickoff_change items: the gate's (rule F4) use the event's feed_ref.
 * K1's items (`<feedRef>|earlier`) have another subject, so nothing here ever closes them.
 */
async function openKickoffSubjects(ctx: ScraperContext): Promise<Set<string>> {
  const rows = await ctx.db
    .select({ subjectKey: scrapeReviewItems.subjectKey })
    .from(scrapeReviewItems)
    .where(and(eq(scrapeReviewItems.status, 'open'), eq(scrapeReviewItems.kind, 'kickoff_change')));
  return new Set(rows.map((row) => row.subjectKey));
}

interface OpenConflict {
  id: string;
  subjectKey: string;
  payload: Record<string, unknown>;
}

/** The open fixture_conflict items (rule F6c reads them before the pass decides anything). */
async function openConflictItems(ctx: ScraperContext): Promise<OpenConflict[]> {
  return ctx.db
    .select({
      id: scrapeReviewItems.id,
      subjectKey: scrapeReviewItems.subjectKey,
      payload: scrapeReviewItems.payload,
    })
    .from(scrapeReviewItems)
    .where(
      and(eq(scrapeReviewItems.status, 'open'), eq(scrapeReviewItems.kind, 'fixture_conflict')),
    );
}

/**
 * What an agreeing cluster answers (F6c): its pairing and kickoffs, and the feed_ref it was
 * decided under (the created, moved or matched event's, or the key the fixture would be created
 * under when only the switched-off policy stopped it).
 */
function agreementOf(cluster: ClusterOf, decision: FixtureDecision, match: EventMatch) {
  const feedRef =
    decision.action === 'create' || decision.action === 'update-kickoff'
      ? decision.feedRef
      : match.kind === 'existing'
        ? match.event.feedRef
        : fixtureFeedRef(cluster, cluster.firstKickoff);
  return {
    competitionId: cluster.competitionId,
    homeTeamId: cluster.homeTeamId,
    awayTeamId: cluster.awayTeamId,
    firstKickoff: cluster.firstKickoff,
    lastKickoff: cluster.lastKickoff,
    feedRefs: [feedRef],
  } satisfies FixtureAgreement;
}

/**
 * Rule F6c (docs/scraper.md 6.1): a fixture_conflict raised only because the sources disagreed
 * (status_disagreement, kickoff_disagreement, sources_disagree) closes once the gate found them
 * in agreement on CONFLICT_AGREED_PASSES consecutive passes. `agreed(subject)` says whether this
 * pass did (an agreeing cluster covers it and no conflict was raised for it). The streak is the
 * item's `agreedPasses`: counted on an agreeing pass, set back to 0 on any other pass, and gone
 * when the conflict is raised again (the refresh replaces the payload). `feed_ref_exists` and the
 * other person-only reasons are never touched (`conflictClosesOnAgreement`).
 *
 * Each item that needs a write gets its own transaction: the item is locked and the step decided
 * again from its current payload, then the counter is stored, or the item is resolved by the
 * scraper (`CONFLICT_AGREED_RESOLUTION`, audited `scrape.review.resolved` by the close and
 * `scrape.review.agreed` here). Only the item changes: never an event, a price or betting.
 */
async function stepConflictItems(
  ctx: ScraperContext,
  items: readonly OpenConflict[],
  now: Date,
  summary: Pick<PromoteFixturesSummary, 'conflictItemsClosed' | 'failed'>,
  agreed: (subjectKey: string) => boolean,
): Promise<void> {
  for (const item of items) {
    const agrees = agreed(item.subjectKey);
    if (nextConflictStep(item.payload, agrees).action === 'keep') continue;
    try {
      summary.conflictItemsClosed += await stepConflictItem(ctx, item.id, agrees, now);
    } catch (error) {
      summary.failed += 1;
      ctx.logger.error({ err: error, subjectKey: item.subjectKey }, 'fixture conflict step failed');
    }
  }
}

async function stepConflictItem(
  ctx: ScraperContext,
  id: string,
  agrees: boolean,
  now: Date,
): Promise<number> {
  return ctx.db.transaction(async (tx) => {
    const [row] = await tx
      .select({ subjectKey: scrapeReviewItems.subjectKey, payload: scrapeReviewItems.payload })
      .from(scrapeReviewItems)
      .where(and(eq(scrapeReviewItems.id, id), eq(scrapeReviewItems.status, 'open')))
      .for('update');
    if (row === undefined) return 0;
    const step = nextConflictStep(row.payload, agrees);
    if (step.action === 'keep') return 0;
    if (step.action !== 'close') {
      await tx
        .update(scrapeReviewItems)
        .set({ payload: { ...row.payload, agreedPasses: step.agreedPasses } })
        .where(eq(scrapeReviewItems.id, id));
      return 0;
    }
    const closedItems = await closeReviewItemsBySubject(tx, row.subjectKey, {
      kinds: ['fixture_conflict'],
      resolution: CONFLICT_AGREED_RESOLUTION,
      now,
    });
    for (const item of closedItems) {
      await auditScraper(tx, {
        action: 'scrape.review.agreed',
        targetType: 'scrape_review_item',
        targetId: item.id,
        metadata: {
          kind: item.kind,
          subjectKey: row.subjectKey,
          rule: 'F6c',
          reasons: row.payload.reasons ?? null,
          agreedPasses: step.agreedPasses,
        },
      });
    }
    return closedItems.length;
  });
}

/**
 * The event has a result, or is live or over (the gate's `event_closed`, F4, read from the event
 * alone). A postponed or cancelled event is left out: a source listing a new date for it keeps its
 * item (`event_not_scheduled`) open for a person, even while another source has no new date.
 */
function kickoffSettled(event: ScrapedEvent): boolean {
  if (event.resultedAt !== null || event.score !== null) return true;
  return !['scheduled', 'postponed', 'cancelled'].includes(event.status);
}

type ClusterOf = ReturnType<typeof clusterObservations>[number];
type FixtureObs = ResolvedObservation<FixtureObservation>;
type SeveralInput = Parameters<typeof holdSeveralClusters>[0];

interface ClusterPlan {
  /** F3 outcome of every cluster (same index as the clusters). */
  matches: EventMatch[];
  /**
   * Clusters that belong to one fixture together (review finding 1): by cluster
   * index, the clusters' shared hold input and the first index of the group (the
   * one that raises it).
   */
  several: Map<number, { first: number; input: SeveralInput }>;
}

/** An event the scraper may still move: scheduled and not resulted. */
const movable = (event: ScrapedEvent): boolean =>
  event.status === 'scheduled' && event.resultedAt === null && event.score === null;

/**
 * Matches every cluster to an event (F3) and finds the fixtures that were split
 * into several clusters: clusters matching the same open event, and clusters of
 * one pairing that match no event but lie within MATCH_WINDOW_MS of each other
 * (they would create the fixture twice). Those are never decided one by one.
 */
function planClusters(
  clusters: readonly ClusterOf[],
  events: readonly ScrapedEvent[],
): ClusterPlan {
  const matches = clusters.map((cluster) => matchEvent(cluster, events));
  const several: ClusterPlan['several'] = new Map();
  const itemsOf = (indexes: readonly number[]): FixtureObs[][] =>
    indexes.map((i) => clusters[i]!.items as FixtureObs[]);

  const byEvent = new Map<string, { event: ScrapedEvent; indexes: number[] }>();
  const newByPairing = new Map<string, number[]>();
  matches.forEach((match, index) => {
    const cluster = clusters[index]!;
    if (match.kind === 'existing' && movable(match.event as ScrapedEvent)) {
      const entry = byEvent.get(match.event.eventId) ?? {
        event: match.event as ScrapedEvent,
        indexes: [],
      };
      entry.indexes.push(index);
      byEvent.set(match.event.eventId, entry);
    } else if (match.kind === 'new') {
      const key = `${cluster.competitionId}|${cluster.homeTeamId}|${cluster.awayTeamId}`;
      newByPairing.set(key, [...(newByPairing.get(key) ?? []), index]);
    }
  });
  for (const { event, indexes } of byEvent.values()) {
    if (indexes.length < 2) continue;
    const input = { event, clusters: itemsOf(indexes) };
    for (const i of indexes) several.set(i, { first: indexes[0]!, input });
  }
  for (const indexes of newByPairing.values()) {
    const sorted = [...indexes].sort(
      (a, b) => clusters[a]!.firstKickoff.getTime() - clusters[b]!.firstKickoff.getTime(),
    );
    // Chains of clusters closer than MATCH_WINDOW_MS (a later cluster could match what an earlier one creates).
    let group: number[] = [];
    const flush = (): void => {
      if (group.length > 1) {
        const first = clusters[group[0]!]!;
        const input = {
          pairing: {
            competitionId: first.competitionId,
            homeTeamId: first.homeTeamId,
            awayTeamId: first.awayTeamId,
          },
          clusters: itemsOf(group),
        };
        for (const i of group) several.set(i, { first: Math.min(...group), input });
      }
      group = [];
    };
    let lastMs = Number.NEGATIVE_INFINITY;
    for (const i of sorted) {
      const cluster = clusters[i]!;
      if (group.length > 0 && cluster.firstKickoff.getTime() - lastMs > MATCH_WINDOW_MS) flush();
      group.push(i);
      lastMs = Math.max(lastMs, cluster.lastKickoff.getTime());
    }
    flush();
  }
  return { matches, several };
}

/**
 * The clusters nothing may be decided for when the observation read was cut
 * (see `undecidedFrom`): clusters, or the events they match, at or after the
 * cut-off, and with them every cluster of the same fixture group (several
 * clusters of one event are only ever decided together).
 */
function deferredClusters(
  clusters: readonly ClusterOf[],
  plan: ClusterPlan,
  cutoff: Date,
): Set<number> {
  const late = (ms: number): boolean => ms >= cutoff.getTime();
  const unsafe = (index: number): boolean => {
    const match = plan.matches[index]!;
    const events =
      match.kind === 'existing'
        ? [match.event]
        : match.kind === 'ambiguous'
          ? match.candidates
          : [];
    return (
      late(clusters[index]!.lastKickoff.getTime()) ||
      events.some((e) => late(e.startTime.getTime()))
    );
  };
  const groupOf = (index: number): number => plan.several.get(index)?.first ?? index;
  const lateGroups = new Set<number>();
  clusters.forEach((_, index) => {
    if (unsafe(index)) lateGroups.add(groupOf(index));
  });
  const out = new Set<number>();
  clusters.forEach((_, index) => {
    if (lateGroups.has(groupOf(index))) out.add(index);
  });
  return out;
}

async function scrapedEvents(ctx: ScraperContext, now: Date): Promise<ScrapedEvent[]> {
  return listScrapedEvents(ctx.db, {
    from: new Date(now.getTime() - MATCH_WINDOW_MS),
    to: new Date(now.getTime() + MATCH_WINDOW_MS + LOOK_AHEAD_MS),
    includeFinished: true,
  });
}

/** The statements of the evidence read at most this many rows (a competition within +-7 days of a start). */
const CREATION_EVIDENCE_LIMIT = 5000;

/**
 * Rule K2 for a fixture that has no event yet: `assessKickoff` for the kickoff that would be created,
 * over the statements the definitions of docs/scraper.md 6.1a give (listed rows of enabled sources
 * about this pairing within `KICKOFF_EVIDENCE_WINDOW_MS`, fixtures and results, so another cluster of
 * the same pairing counts as dissent), the freshness of each source from `listSourceKickoffFacts`,
 * and no person record (nobody can confirm an event that does not exist).
 */
async function assessCreation(
  ctx: ScraperContext,
  decision: FixtureCreate,
  now: Date,
): Promise<KickoffAssessment> {
  const start = decision.kickoff;
  const facts = new Map(
    (
      await listSourceKickoffFacts(ctx.db, {
        now,
        minMatchDurationMs: MIN_MATCH_DURATION_MS,
        staleAfterMs: SOURCE_STALE_AFTER_MS,
      })
    ).map((fact) => [fact.sourceId, fact]),
  );
  const rows = await listCurrentObservations(ctx.db, {
    competitionId: decision.competitionId,
    resolvedOnly: true,
    kickoffFrom: new Date(start.getTime() - KICKOFF_EVIDENCE_WINDOW_MS),
    // `kickoffTo` is exclusive.
    kickoffTo: new Date(start.getTime() + KICKOFF_EVIDENCE_WINDOW_MS + 1),
    limit: CREATION_EVIDENCE_LIMIT,
  });
  // Fails closed: a cut read may have hidden a dissenting statement.
  if (rows.length >= CREATION_EVIDENCE_LIMIT) {
    throw new Error(`kickoff evidence of ${decision.feedRef} reached its row limit`);
  }
  const statements: KickoffStatement[] = [];
  for (const row of rows) {
    const fact = facts.get(row.sourceId);
    if (
      row.homeTeamId !== decision.homeTeamId ||
      row.awayTeamId !== decision.awayTeamId ||
      fact === undefined ||
      fact.latestOkRunStartedAt === null ||
      // A listed row: seen at the source's latest successful read.
      row.lastSeenAt.getTime() < fact.latestOkRunStartedAt.getTime()
    ) {
      continue;
    }
    statements.push({
      sourceId: row.sourceId,
      upstream: fact.upstream,
      kind: row.kind,
      status: row.status as KickoffStatement['status'],
      kickoff: row.kickoff,
      changedAt: row.changedAt,
      sourceFresh: fact.fresh,
    });
  }
  return assessKickoff({ start, now, statements, person: null });
}

/**
 * O1 and O2 for a fixture that has no event yet. A new event is always created with the model's
 * prices (rule O5: the market has nothing to be read for before the event exists); the next
 * re-pricing pass moves it to the market prices when its competition takes them from the feed.
 * `halfTimeMarkets` is rule O6 for the fixture's competition (halfTimeCheck; default true: every
 * market): false leaves the half-time markets out, as re-pricing does for the event later.
 */
export async function pricingFor(
  ctx: ScraperContext,
  homeTeamId: string,
  awayTeamId: string,
  halfTimeMarkets = true,
) {
  const ratings = await getTeamRatings(ctx.db, [homeTeamId, awayTeamId]);
  const price = await priceEvent(ctx.db, {
    competitionPricingSource: 'model',
    eventId: null,
    homeRatings: ratings.get(homeTeamId)?.ratings ?? null,
    awayRatings: ratings.get(awayTeamId)?.ratings ?? null,
    minRatingMatches: ctx.config.scraper.minRatingMatches,
    now: ctx.clock(),
    halfTimeMarkets,
  });
  return {
    calibrated: price.calibrated,
    markets: price.markets,
    ratingsKey: price.key,
    pricesSane: price.pricesSane,
    halfTimeOmitted: price.halfTimeOmitted === true,
  };
}

/** Why a trader is asked: the gate's reason codes, as text. */
function reviewReason(payload: GateReview['payload']): string | null {
  const reasons = payload.reasons;
  return Array.isArray(reasons) && reasons.length > 0 ? reasons.join('; ') : null;
}

/** A team that keeps a match from opening on the model (O1), as a `ratings_uncalibrated` item names it. */
// A type, not an interface, so it is assignable to the gate's JSON payload.
export type UncalibratedTeam = {
  teamId: string;
  name: string;
  /** Matches its ratings learned from (0 without ratings). */
  matches: number;
  /** Matches O1 asks for (config scraper.minRatingMatches, never below MIN_RATING_MATCHES). */
  needed: number;
};

/**
 * R-2: the teams of a pairing whose ratings are not calibrated (O1), with their match counts, so
 * the review item says which team needs a backfill or a hand-set rating, and how far it is.
 */
export async function uncalibratedTeams(
  exec: Parameters<typeof getTeamRatings>[0],
  teamIds: readonly string[],
  names: ReadonlyMap<string, string>,
  minMatches: number,
): Promise<UncalibratedTeam[]> {
  const rated = await getTeamRatings(exec, teamIds);
  // isCalibrated never takes the bar below MIN_RATING_MATCHES.
  const needed = Math.max(minMatches, MIN_RATING_MATCHES);
  const out: UncalibratedTeam[] = [];
  for (const teamId of teamIds) {
    const ratings = rated.get(teamId)?.ratings ?? null;
    if (isCalibrated(ratings, minMatches)) continue;
    const matches = ratings !== null && Number.isFinite(ratings.matches) ? ratings.matches! : 0;
    out.push({ teamId, name: names.get(teamId) ?? teamId, matches, needed });
  }
  return out;
}

/** "Rochdale 0 of 8 rated matches; York City 3 of 8 rated matches". */
export function uncalibratedReason(teams: readonly UncalibratedTeam[]): string {
  return teams.map((t) => `${t.name} ${t.matches} of ${t.needed} rated matches`).join('; ');
}

/** The feed_ref of a create decision is already taken (review finding 2). */
class FeedRefTaken extends Error {}

/**
 * Creates the event of a `create` decision. INSERT ONLY: a decision to create
 * was taken because no event matched within MATCH_WINDOW_MS, but an event with
 * the same feed_ref may still exist (a trader rescheduled it far out); the
 * upsert would then move its start and re-price it with no F4, O3 or trader.
 * If the feed_ref exists, nothing changes and a `fixture_conflict`
 * (`feed_ref_exists`) asks a person. `kickoff` is the K2 assessment the gate's `kickoffConfirmed` came
 * from, recorded in the audit row (null: not assessed, as in the demo seed).
 */
export async function applyCreate(
  ctx: ScraperContext,
  decision: FixtureCreate,
  pricing: {
    markets: ReturnType<typeof priceFixture>;
    ratingsKey: string;
    /** Rule O6 left the half-time markets out (audited). */
    halfTimeOmitted?: boolean;
  } | null,
  now: Date,
  kickoff: Pick<KickoffAssessment, 'confirmed' | 'basis'> | null = null,
): Promise<{ created: boolean; messages: LiveMessage[] }> {
  try {
    const messages = await ctx.db.transaction(async (tx) => {
      const [taken] = await tx
        .select({ id: eventsTable.id })
        .from(eventsTable)
        .where(
          and(
            eq(eventsTable.feedProvider, SCRAPED_FEED_PROVIDER),
            eq(eventsTable.feedRef, decision.feedRef),
          ),
        );
      if (taken !== undefined) throw new FeedRefTaken();
      const result = await upsertFixture(
        tx,
        {
          feedProvider: SCRAPED_FEED_PROVIDER,
          feedRef: decision.feedRef,
          sport: 'football',
          competitionId: decision.competitionId,
          homeTeamId: decision.homeTeamId,
          awayTeamId: decision.awayTeamId,
          startTime: decision.kickoff,
        },
        pricing?.markets ?? [],
        { now },
      );
      // Another transaction created it after the check: the upsert took its update path; undo it.
      if (!result.created) throw new FeedRefTaken();
      // O3: remember the ratings the prices come from, so only a later change re-prices the event.
      if (pricing !== null) await recordEventPriced(tx, result.eventId, pricing.ratingsKey, now);
      const messages = [...result.messages];
      // F7: closed unless the decision says it may open.
      const changed = await setEventBettingOpen(tx, result.eventId, decision.openBetting);
      messages.push(...changed.messages);
      // The F7 item is read by `open_betting` and the review page, so it carries the
      // contract's odds payload (event, names, proposed prices) next to the gate's own fields.
      const names = await teamNames(tx, [decision.homeTeamId, decision.awayTeamId]);
      const proposed = display(
        [],
        (pricing?.markets ?? []).map((m) => ({
          type: m.type,
          line: m.line,
          selections: m.selections.map((s) => ({ code: s.code, oddsMilli: s.oddsMilli })),
        })),
      );
      // R-2: a ratings item names the teams O1 waits for, with their match counts.
      const unrated = reviewsOf(decision).some((r) => r.kind === 'ratings_uncalibrated')
        ? await uncalibratedTeams(
            tx,
            [decision.homeTeamId, decision.awayTeamId],
            names,
            ctx.config.scraper.minRatingMatches,
          )
        : [];
      const reviews = reviewsOf(decision).map((review): GateReview => {
        const ratingsItem = review.kind === 'ratings_uncalibrated' && unrated.length > 0;
        const gateReason = reviewReason(review.payload);
        return {
          ...review,
          payload: {
            ...review.payload,
            eventId: result.eventId,
            gameId: String(result.gameId),
            home: names.get(decision.homeTeamId) ?? decision.homeTeamId,
            away: names.get(decision.awayTeamId) ?? decision.awayTeamId,
            kickoff: decision.kickoff.toISOString(),
            reason: ratingsItem
              ? `${gateReason ?? 'ratings_uncalibrated'}: ${uncalibratedReason(unrated)}`
              : gateReason,
            markets: proposed,
            ...(ratingsItem ? { uncalibratedTeams: unrated } : {}),
          },
        };
      });
      await openGateReviews(tx, reviews, now);
      await auditScraper(tx, {
        action: 'scrape.fixture.created',
        targetType: 'event',
        targetId: result.eventId,
        metadata: {
          feedRef: decision.feedRef,
          kickoff: decision.kickoff.toISOString(),
          sources: [...decision.sources],
          bettingOpen: decision.openBetting,
          kickoffConfirmed: kickoff?.confirmed ?? null,
          kickoffBasis: kickoff?.basis ?? null,
          reviews: reviewsOf(decision).map((r: GateReview) => r.kind),
          ...(pricing?.halfTimeOmitted === true ? { halfTimeMarkets: 'omitted (O6)' } : {}),
        },
      });
      return messages;
    });
    return { created: true, messages };
  } catch (error) {
    if (!(error instanceof FeedRefTaken)) throw error;
    await ctx.db.transaction(async (tx) => {
      const [existing] = await tx
        .select({
          id: eventsTable.id,
          status: eventsTable.status,
          startTime: eventsTable.startTime,
        })
        .from(eventsTable)
        .where(
          and(
            eq(eventsTable.feedProvider, SCRAPED_FEED_PROVIDER),
            eq(eventsTable.feedRef, decision.feedRef),
          ),
        );
      const [review] = buildReviews(
        decision.feedRef,
        [{ kind: 'fixture_conflict', rule: 'F3', reason: 'feed_ref_exists' }],
        () => ({
          feedRef: decision.feedRef,
          eventId: existing?.id ?? null,
          eventStatus: existing?.status ?? null,
          eventStart: existing?.startTime.toISOString() ?? null,
          observedKickoff: decision.kickoff.toISOString(),
          sources: [...decision.sources],
        }),
      );
      await openGateReviews(tx, [review!], now);
    });
    return { created: false, messages: [] };
  }
}

/**
 * Moves the kickoff of an event. The decision was taken on a snapshot, so
 * everything it rests on is checked again under the event's row lock: the
 * event is still scheduled, still starts at `decision.from`, and, for the
 * one-source rule F4b, still has betting closed (K4) and no bets. Otherwise nothing changes (the next
 * pass decides again from the current state).
 */
export async function applyKickoff(
  ctx: ScraperContext,
  decision: FixtureUpdateKickoff,
  event: ScrapedEvent,
  now: Date,
): Promise<{ moved: boolean; messages: LiveMessage[] }> {
  return ctx.db.transaction(async (tx) => {
    const locked = await lockEvent(tx, decision.eventId);
    if (locked.status !== 'scheduled') return { moved: false, messages: [] };
    const [current] = await tx
      .select({ startTime: eventsTable.startTime })
      .from(eventsTable)
      .where(eq(eventsTable.id, decision.eventId));
    if (current === undefined || current.startTime.getTime() !== decision.from.getTime()) {
      return { moved: false, messages: [] };
    }
    if (decision.rule === 'F4b') {
      // K4: the one-source move needs betting closed (it was checked on a snapshot).
      if (locked.bettingOpen !== false) return { moved: false, messages: [] };
      const [bet] = await tx
        .select({ id: betLegs.id })
        .from(betLegs)
        .where(eq(betLegs.eventId, decision.eventId))
        .limit(1);
      if (bet !== undefined) return { moved: false, messages: [] };
    }
    // No markets: a kickoff change must never reprice.
    const result = await upsertFixture(
      tx,
      {
        feedProvider: SCRAPED_FEED_PROVIDER,
        feedRef: event.feedRef,
        sport: 'football',
        competitionId: event.competitionId,
        homeTeamId: event.homeTeamId,
        awayTeamId: event.awayTeamId,
        startTime: decision.to,
      },
      [],
      { now },
    );
    await auditScraper(tx, {
      action: 'scrape.fixture.kickoff_moved',
      targetType: 'event',
      targetId: decision.eventId,
      metadata: {
        feedRef: decision.feedRef,
        from: decision.from.toISOString(),
        to: decision.to.toISOString(),
        rule: decision.rule,
        upstreams: [...decision.upstreams],
      },
    });
    // F4: the move answers the gate's open proposal for the event, if there is one.
    await closeReviewItemsBySubject(tx, decision.feedRef, {
      kinds: ['kickoff_change'],
      resolution: `${KICKOFF_ITEM_MOVED} (${decision.rule})`,
      now,
    });
    return { moved: true, messages: result.messages };
  });
}

async function flagMissing(
  ctx: ScraperContext,
  events: readonly ScrapedEvent[],
  now: Date,
): Promise<number> {
  const missing = findMissingFixtures(
    events.map((event) => ({ event, lastListedAt: event.lastListedAt })),
    now,
  );
  for (const item of missing) {
    await ctx.db.transaction((tx) => openGateReviews(tx, [item.review], now));
  }
  return missing.length;
}
