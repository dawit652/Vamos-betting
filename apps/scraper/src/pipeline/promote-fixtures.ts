import { SCRAPED_FEED_PROVIDER } from '@vamos/core';
import {
  getTeamRatings,
  listCompetitionPolicies,
  listCurrentObservations,
  listScrapedEvents,
  lockEvent,
  recordEventPriced,
  setEventBettingOpen,
  upsertFixture,
  type LiveMessage,
  type ScrapedEvent,
} from '@vamos/db';
import { priceFixture } from '@vamos/feed';
import {
  buildReviews,
  checkMarkets,
  clusterObservations,
  decideFixture,
  DAY_MS,
  findMissingFixtures,
  FIXTURE_HORIZON_MS,
  holdSeveralClusters,
  isCalibrated,
  matchEvent,
  MATCH_WINDOW_MS,
  ratingsKey,
  reviewsOf,
  type CompetitionPolicy,
  type EventMatch,
  type FixtureCreate,
  type FixtureObservation,
  type FixtureUpdateKickoff,
  type GateReview,
  type ResolvedObservation,
} from '@vamos/scraper';
import { betLegs, events as eventsTable } from '@vamos/db/schema';
import { and, eq } from 'drizzle-orm';
import type { ScraperContext } from '../context';
import { publishAfterCommit } from '../lib/publish';
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
  failed: number;
  published: number;
}

/** Fixture observations are read from this far back (clusters straddle the start) ... */
const LOOK_BACK_MS = 2 * DAY_MS;
/** ... to this far ahead (a source may move a fixture beyond the creation horizon). */
export const LOOK_AHEAD_MS = FIXTURE_HORIZON_MS + 14 * DAY_MS;

/**
 * Promotes the current fixture observations (rules F1 to F7): for every
 * competition that has a policy row, cluster the resolved observations, find
 * the event each belongs to and apply what `decideFixture` returns, and
 * nothing else. Also flags events no source lists any more (F5). This code
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

  const clusters = clusterObservations(observations).filter((c) => policies.has(c.competitionId));
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
          ? await pricingFor(ctx, cluster.homeTeamId, cluster.awayTeamId)
          : null;
      const decision = decideFixture({
        observations: cluster.items,
        candidates,
        policy,
        now,
        calibrated: pricing?.calibrated ?? false,
        pricesSane: pricing?.pricesSane ?? false,
        // wired to the real assessment in step 4 of docs/scraper-plan/kickoff-safety.md
        kickoffConfirmed: true,
      });
      let messages: LiveMessage[] = [];
      switch (decision.action) {
        case 'create': {
          const created = await applyCreate(ctx, decision, pricing, now);
          messages = created.messages;
          if (created.created) summary.created += 1;
          else summary.held += 1;
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
          if (moved.moved) summary.kickoffMoved += 1;
          break;
        }
        case 'hold':
          await ctx.db.transaction((tx) => openGateReviews(tx, reviewsOf(decision), now));
          summary.held += 1;
          break;
        case 'none':
          break;
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

  summary.missing = await flagMissing(ctx, events, now);
  ctx.logger[
    summary.created + summary.kickoffMoved + summary.held + summary.missing > 0 ? 'info' : 'debug'
  ]({ ...summary }, 'fixture promotion run');
  return summary;
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

/** O1 and O2 for a fixture that has no event yet. */
export async function pricingFor(ctx: ScraperContext, homeTeamId: string, awayTeamId: string) {
  const ratings = await getTeamRatings(ctx.db, [homeTeamId, awayTeamId]);
  const home = ratings.get(homeTeamId)?.ratings ?? null;
  const away = ratings.get(awayTeamId)?.ratings ?? null;
  const min = ctx.config.scraper.minRatingMatches;
  const calibrated = isCalibrated(home, min) && isCalibrated(away, min);
  const markets = priceFixture('football', home, away);
  return {
    calibrated,
    markets,
    ratingsKey: ratingsKey(home, away),
    pricesSane: checkMarkets(markets).ok,
  };
}

/** Why a trader is asked: the gate's reason codes, as text. */
function reviewReason(payload: GateReview['payload']): string | null {
  const reasons = payload.reasons;
  return Array.isArray(reasons) && reasons.length > 0 ? reasons.join('; ') : null;
}

/** The feed_ref of a create decision is already taken (review finding 2). */
class FeedRefTaken extends Error {}

/**
 * Creates the event of a `create` decision. INSERT ONLY: a decision to create
 * was taken because no event matched within MATCH_WINDOW_MS, but an event with
 * the same feed_ref may still exist (a trader rescheduled it far out); the
 * upsert would then move its start and re-price it with no F4, O3 or trader.
 * If the feed_ref exists, nothing changes and a `fixture_conflict`
 * (`feed_ref_exists`) asks a person.
 */
export async function applyCreate(
  ctx: ScraperContext,
  decision: FixtureCreate,
  pricing: { markets: ReturnType<typeof priceFixture>; ratingsKey: string } | null,
  now: Date,
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
      const reviews = reviewsOf(decision).map((review): GateReview => ({
        ...review,
        payload: {
          ...review.payload,
          eventId: result.eventId,
          gameId: String(result.gameId),
          home: names.get(decision.homeTeamId) ?? decision.homeTeamId,
          away: names.get(decision.awayTeamId) ?? decision.awayTeamId,
          kickoff: decision.kickoff.toISOString(),
          reason: reviewReason(review.payload),
          markets: proposed,
        },
      }));
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
          reviews: reviewsOf(decision).map((r: GateReview) => r.kind),
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
