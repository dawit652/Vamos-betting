import { SCRAPED_FEED_PROVIDER } from '@vamos/core';
import {
  getTeamRatings,
  listCompetitionPolicies,
  listCurrentObservations,
  listScrapedEvents,
  lockEvent,
  setEventBettingOpen,
  upsertFixture,
  type LiveMessage,
  type ScrapedEvent,
} from '@vamos/db';
import { priceFixture } from '@vamos/feed';
import {
  checkMarkets,
  clusterObservations,
  decideFixture,
  DAY_MS,
  findMissingFixtures,
  FIXTURE_HORIZON_MS,
  isCalibrated,
  matchEvent,
  MATCH_WINDOW_MS,
  reviewsOf,
  type CompetitionPolicy,
  type FixtureCreate,
  type FixtureObservation,
  type FixtureUpdateKickoff,
  type GateReview,
  type ResolvedObservation,
} from '@vamos/scraper';
import type { ScraperContext } from '../context';
import { publishAfterCommit } from '../lib/publish';
import { auditScraper, openGateReviews, toResolved } from './common';

export interface PromoteFixturesSummary {
  clusters: number;
  created: number;
  kickoffMoved: number;
  held: number;
  /** fixture_missing items opened or refreshed. */
  missing: number;
  failed: number;
  published: number;
}

/** Fixture observations are read from this far back (clusters straddle the start) ... */
const LOOK_BACK_MS = 2 * DAY_MS;
/** ... to this far ahead (a source may move a fixture beyond the creation horizon). */
const LOOK_AHEAD_MS = FIXTURE_HORIZON_MS + 14 * DAY_MS;

/**
 * Promotes the current fixture observations (rules F1 to F7): for every
 * competition that has a policy row, cluster the resolved observations, find
 * the event each belongs to and apply what `decideFixture` returns, and
 * nothing else. Also flags events no source lists any more (F5). This code
 * has no way to cancel, void or result an event.
 */
export async function promoteFixtures(ctx: ScraperContext): Promise<PromoteFixturesSummary> {
  const now = ctx.clock();
  const summary: PromoteFixturesSummary = {
    clusters: 0,
    created: 0,
    kickoffMoved: 0,
    held: 0,
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

  const rows = await listCurrentObservations(ctx.db, {
    kind: 'fixture',
    resolvedOnly: true,
    kickoffFrom: new Date(now.getTime() - LOOK_BACK_MS),
    kickoffTo: new Date(now.getTime() + LOOK_AHEAD_MS),
    limit: 20_000,
  });
  const observations = rows.flatMap((row) => {
    const resolved = toResolved(row, slugs);
    return resolved !== null &&
      resolved.obs.kind === 'fixture' &&
      policies.has(resolved.names.competitionId)
      ? [resolved as ResolvedObservation<FixtureObservation>]
      : [];
  });
  const events = await scrapedEvents(ctx, now);

  for (const cluster of clusterObservations(observations)) {
    summary.clusters += 1;
    const policy = policies.get(cluster.competitionId);
    if (policy === undefined) continue;
    try {
      const match = matchEvent(cluster, events);
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
      });
      let messages: LiveMessage[] = [];
      switch (decision.action) {
        case 'create':
          messages = await applyCreate(ctx, decision, pricing?.markets ?? [], now);
          summary.created += 1;
          break;
        case 'update-kickoff':
          messages = await applyKickoff(
            ctx,
            decision,
            events.find((e) => e.eventId === decision.eventId)!,
            now,
          );
          summary.kickoffMoved += 1;
          break;
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

async function scrapedEvents(ctx: ScraperContext, now: Date): Promise<ScrapedEvent[]> {
  return listScrapedEvents(ctx.db, {
    from: new Date(now.getTime() - MATCH_WINDOW_MS),
    to: new Date(now.getTime() + MATCH_WINDOW_MS + LOOK_AHEAD_MS),
    includeFinished: true,
  });
}

/** O1 and O2 for a fixture that has no event yet. */
async function pricingFor(ctx: ScraperContext, homeTeamId: string, awayTeamId: string) {
  const ratings = await getTeamRatings(ctx.db, [homeTeamId, awayTeamId]);
  const home = ratings.get(homeTeamId)?.ratings ?? null;
  const away = ratings.get(awayTeamId)?.ratings ?? null;
  const min = ctx.config.scraper.minRatingMatches;
  const calibrated = isCalibrated(home, min) && isCalibrated(away, min);
  const markets = priceFixture('football', home, away);
  return { calibrated, markets, pricesSane: checkMarkets(markets).ok };
}

async function applyCreate(
  ctx: ScraperContext,
  decision: FixtureCreate,
  markets: ReturnType<typeof priceFixture>,
  now: Date,
): Promise<LiveMessage[]> {
  return ctx.db.transaction(async (tx) => {
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
      markets,
      { now },
    );
    const messages = [...result.messages];
    if (result.created) {
      // F7: closed unless the decision says it may open.
      const changed = await setEventBettingOpen(tx, result.eventId, decision.openBetting);
      messages.push(...changed.messages);
      await openGateReviews(tx, reviewsOf(decision), now);
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
    }
    return messages;
  });
}

async function applyKickoff(
  ctx: ScraperContext,
  decision: FixtureUpdateKickoff,
  event: ScrapedEvent,
  now: Date,
): Promise<LiveMessage[]> {
  return ctx.db.transaction(async (tx) => {
    const locked = await lockEvent(tx, decision.eventId);
    if (locked.status !== 'scheduled') return [];
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
    return result.messages;
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
