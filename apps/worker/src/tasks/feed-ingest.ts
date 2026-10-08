import { loadCatalogIds, loadFeedTeams, upsertFixture, type Database } from '@vamos/db';
import { MockFeedProvider, type MockFeedProviderConfig } from '@vamos/feed';
import { intervalTask, type IntervalTask } from '../lib/interval';
import { publishAfterCommit } from '../lib/publish';
import type { TaskContext } from './context';

/**
 * Feed ingest (demo mode, FEED_PROVIDER=mock): every minute, and at start,
 * the MockFeedProvider generates the fixtures of the next 72 hours plus a
 * rolling demo fixture every 5 minutes over the next 2 hours. Each fixture
 * is upserted in its own transaction (new events and markets, moved feed
 * prices) and the resulting deltas are published after COMMIT.
 *
 * The provider is rebuilt from the catalogue on every run, so teams,
 * ratings and competitions edited in the back office apply at the next run.
 */

export interface RollingOptions {
  everyMinutes: number;
  horizonMinutes: number;
  /** Competitions the rolling fixtures rotate through (default: the featured ones). */
  competitionSlugs?: readonly string[];
}

export interface FeedIngestOptions {
  /** Default 60 s. */
  intervalMs?: number;
  /** Default 72 h. */
  horizonHours?: number;
  /** Rolling demo fixtures (default every 5 minutes over 2 hours); null turns them off. */
  rolling?: RollingOptions | null;
  /** MockFeedProvider seed (default: the provider's own). */
  seed?: string;
}

export const FEED_INGEST_INTERVAL_MS = 60_000;
export const FEED_HORIZON_HOURS = 72;
export const DEFAULT_ROLLING: Readonly<RollingOptions> = Object.freeze({
  everyMinutes: 5,
  horizonMinutes: 120,
});

export interface FeedIngestSummary {
  fixtures: number;
  created: number;
  /** Existing events that got new markets or moved prices. */
  updated: number;
  unchanged: number;
  /** Fixtures naming a competition or team that is not in the catalogue. */
  skipped: number;
  failed: number;
  /** Live deltas published. */
  published: number;
}

/** A MockFeedProvider over the current catalogue (competitions, team pools, ratings). */
export async function createMockFeedProvider(
  db: Database,
  options: Pick<FeedIngestOptions, 'rolling' | 'seed'> = {},
): Promise<MockFeedProvider> {
  const catalogue = await loadFeedTeams(db);
  const config: MockFeedProviderConfig = {
    competitions: catalogue.competitions,
    teams: catalogue.teams,
  };
  const rolling = options.rolling === undefined ? DEFAULT_ROLLING : options.rolling;
  if (rolling !== null) {
    const available = catalogue.competitions.map((competition) => competition.slug);
    const featured = catalogue.competitions.filter((c) => c.featured).map((c) => c.slug);
    const slugs =
      rolling.competitionSlugs?.filter((slug) => available.includes(slug)) ??
      (featured.length > 0 ? featured : available);
    if (slugs.length > 0) {
      config.rolling = {
        everyMinutes: rolling.everyMinutes,
        horizonMinutes: rolling.horizonMinutes,
        competitionSlugs: [...slugs],
      };
    }
  }
  if (options.seed !== undefined) config.seed = options.seed;
  return new MockFeedProvider(config);
}

/** One ingest run: generate, upsert and publish. */
export async function runFeedIngest(
  ctx: TaskContext,
  options: FeedIngestOptions = {},
): Promise<FeedIngestSummary> {
  const now = ctx.clock();
  const provider = await createMockFeedProvider(ctx.db, options);
  const fixtures = provider.fixtures(now, options.horizonHours ?? FEED_HORIZON_HOURS);
  const ids = await loadCatalogIds(ctx.db);
  const summary: FeedIngestSummary = {
    fixtures: fixtures.length,
    created: 0,
    updated: 0,
    unchanged: 0,
    skipped: 0,
    failed: 0,
    published: 0,
  };

  for (const fixture of fixtures) {
    const competitionId = ids.competitions.get(`${fixture.sport}/${fixture.competitionSlug}`);
    const homeTeamId = ids.teams.get(`${fixture.sport}/${fixture.homeShortName}`);
    const awayTeamId = ids.teams.get(`${fixture.sport}/${fixture.awayShortName}`);
    if (competitionId === undefined || homeTeamId === undefined || awayTeamId === undefined) {
      summary.skipped++;
      ctx.logger.warn({ feedRef: fixture.feedRef }, 'fixture names an unknown competition or team');
      continue;
    }
    try {
      const result = await ctx.db.transaction((tx) =>
        upsertFixture(
          tx,
          {
            feedProvider: provider.name,
            feedRef: fixture.feedRef,
            sport: fixture.sport,
            competitionId,
            homeTeamId,
            awayTeamId,
            startTime: fixture.startTime,
          },
          provider.price(fixture),
        ),
      );
      if (result.created) summary.created++;
      else if (result.marketsAdded > 0 || result.oddsChanged > 0) summary.updated++;
      else summary.unchanged++;
      summary.published += await publishAfterCommit(
        ctx.redis,
        result.messages,
        ctx.channel,
        ctx.logger,
      );
    } catch (error) {
      summary.failed++;
      ctx.logger.error({ err: error, feedRef: fixture.feedRef }, 'feed fixture upsert failed');
    }
  }

  const changed = summary.created + summary.updated + summary.skipped + summary.failed > 0;
  ctx.logger[changed ? 'info' : 'debug']({ ...summary }, 'feed ingest run');
  return summary;
}

export function feedIngestTask(ctx: TaskContext, options: FeedIngestOptions = {}): IntervalTask {
  return intervalTask({
    name: 'feed-ingest',
    intervalMs: options.intervalMs ?? FEED_INGEST_INTERVAL_MS,
    logger: ctx.logger,
    run: () => runFeedIngest(ctx, options),
  });
}
