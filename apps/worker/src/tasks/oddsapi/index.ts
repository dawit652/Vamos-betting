import type { OddsApiConfig, OperatingMode } from '@vamos/config';
import type { SportCode } from '@vamos/core';
import {
  applyLiveState,
  deactivateMissingLeagues,
  dueFeedResults,
  ensureLeagueCompetition,
  feedCreditsSpent,
  feedEventsByRef,
  latestFeedQuota,
  listDueLeagues,
  listFeedLeagues,
  lockEvent,
  markFeedResultApplied,
  overdueFeedEvents,
  pendingFeedResultIds,
  pruneFeedCalls,
  recordFeedCall,
  recordFeedResult,
  resolveFeedTeam,
  resultEvent,
  setEventBettingOpen,
  staleFeedEvents,
  startedFeedEvents,
  suspendEvent,
  updateFeedLeaguePoll,
  upsertFeedLeague,
  upsertFixture,
  type FeedLeagueRow,
  type FeedReviewReason,
  type LiveMessage,
} from '@vamos/db';
import {
  enabledByDefault,
  estimateOddsCost,
  estimateScoresCost,
  eventConsensus,
  FEATURED_MARKETS,
  hasFeedScores,
  leagueFor,
  NO_FEED_SCORES_REVIEW_AFTER_MS,
  MOCK_PROVIDER_NAME,
  OddsApiError,
  priceEvent,
  pricingMargins,
  shouldWritePrice,
  type LeagueEntry,
  type OddsApiClient,
  type OddsApiEvent,
  type OddsApiResult,
  type OddsApiScore,
  type OddsQuery,
} from '@vamos/feed';
import { intervalTask } from '../../lib/interval';
import { tryLock } from '../../lib/lock';
import { publishAfterCommit } from '../../lib/publish';
import type { WorkerTask } from '../../worker';
import type { TaskContext } from '../context';
import {
  HOUR_MS,
  IN_PLAY_QUOTE_MAX_AGE_MS,
  IN_PLAY_STALE_MS,
  MINUTE_MS,
  nextOddsPollAt,
  freshnessFactor,
  nextScoresPollAt,
  ODDS_HORIZON_MS,
  planBudget,
  prematchQuoteMaxAgeMs,
  staleBuckets,
  type Budget,
} from './schedule';

/**
 * The real odds feed (FEED_PROVIDER=theoddsapi; docs/odds-api-integration-plan.md):
 * - catalogue sync (every 30 min, free calls): the provider's leagues, and
 *   for the enabled ones their upcoming events, which plan the odds polls;
 * - odds poll (30 s tick): each due league's bookmaker odds become our prices
 *   through the consensus (priceEvent); new events are created only with a
 *   priced market, and what has no fresh consensus is suspended;
 * - scores poll (60 s tick): kick-offs and scores of started events (every
 *   market suspended on each, until a consensus newer than the change), final
 *   scores recorded and applied after the confirmation wait;
 * - sweeps (60 s): stale prices suspended, overdue events sent to review
 *   (voided after 72 h in demo mode), old call records pruned.
 * Each run holds a Redis lock, so two workers never spend credits twice. A
 * key or quota error pauses every call for an hour.
 */

export const ODDS_API_PROVIDER = 'theoddsapi';

/** What the tasks use of the client (tests pass a fake). */
export type OddsApiSource = Pick<OddsApiClient, 'sports' | 'events' | 'odds' | 'scores'>;

export interface OddsApiTaskDeps {
  client: OddsApiSource;
  config: OddsApiConfig;
  mode: OperatingMode;
  /** Most leagues read per odds or scores tick (default 6). */
  leaguesPerTick?: number;
}

export interface OddsApiTaskOptions {
  client?: OddsApiSource;
  catalogIntervalMs?: number;
  oddsIntervalMs?: number;
  scoresIntervalMs?: number;
  sweepIntervalMs?: number;
  leaguesPerTick?: number;
}

const PAUSE_KEY = 'vamos:oddsapi:paused';
const LOCK_PREFIX = 'vamos:oddsapi:lock:';
const DAY_MS = 24 * HOUR_MS;
/** No result this long after the start: the event goes to staff review. */
export const OVERDUE_AFTER_MS = 48 * HOUR_MS;
/** Demo mode voids an overdue event this long after its start. */
export const DEMO_VOID_AFTER_MS = 72 * HOUR_MS;
/** Later than any start time (and still a timestamp Postgres accepts). */
const END_OF_TIME = new Date('9999-12-31T00:00:00Z');
/** How long API call records are kept. */
const CALL_RETENTION_MS = 35 * DAY_MS;

type Called<T> = { ok: true; result: OddsApiResult<T> } | { ok: false; error: OddsApiError };

/** One API call, logged with its cost; an API failure comes back as a value, never thrown. */
async function call<T>(
  ctx: TaskContext,
  endpoint: string,
  sportKey: string | null,
  estimate: number,
  run: () => Promise<OddsApiResult<T>>,
): Promise<Called<T>> {
  const calledAt = ctx.clock();
  try {
    const result = await run();
    await recordFeedCall(ctx.db, {
      provider: ODDS_API_PROVIDER,
      endpoint,
      sportKey,
      status: 200,
      cost: result.quota.last ?? estimate,
      remaining: result.quota.remaining,
      used: result.quota.used,
      calledAt,
    });
    if (result.dropped > 0) {
      ctx.logger.warn(
        { endpoint, sportKey, dropped: result.dropped },
        'odds api: malformed items dropped',
      );
    }
    return { ok: true, result };
  } catch (error) {
    if (!(error instanceof OddsApiError)) throw error;
    await recordFeedCall(ctx.db, {
      provider: ODDS_API_PROVIDER,
      endpoint,
      sportKey,
      status: error.status,
      cost: error.quota?.last ?? 0,
      remaining: error.quota?.remaining ?? null,
      used: error.quota?.used ?? null,
      errorKind: error.kind,
      calledAt,
    });
    if (error.kind === 'auth' || error.kind === 'quota') {
      await ctx.redis.set(PAUSE_KEY, error.kind, 'PX', HOUR_MS);
    } else if (error.kind === 'rate_limited') {
      await ctx.redis.set(PAUSE_KEY, error.kind, 'PX', 2 * MINUTE_MS);
    }
    ctx.logger.error({ endpoint, sportKey, kind: error.kind, status: error.status }, error.message);
    return { ok: false, error };
  }
}

async function isPaused(ctx: TaskContext): Promise<boolean> {
  return (await ctx.redis.exists(PAUSE_KEY)) === 1;
}

/** Runs `work` under the task's Redis lock; skips the run when another worker holds it. */
async function exclusive<T>(
  ctx: TaskContext,
  name: string,
  ttlMs: number,
  work: () => Promise<T>,
): Promise<T | null> {
  const lock = await tryLock(ctx.redis, `${LOCK_PREFIX}${name}`, ttlMs);
  if (lock === null) return null;
  try {
    return await work();
  } finally {
    await lock.release();
  }
}

/** The governor's budget from the credit log. */
export async function currentBudget(ctx: TaskContext, config: OddsApiConfig): Promise<Budget> {
  const now = ctx.clock();
  const spentLast24h = await feedCreditsSpent(
    ctx.db,
    ODDS_API_PROVIDER,
    new Date(now.getTime() - DAY_MS),
  );
  const quota = await latestFeedQuota(ctx.db, ODDS_API_PROVIDER);
  return planBudget({
    spentLast24h,
    monthlyCredits: config.monthlyCredits,
    reservePercent: config.reservePercent,
    remaining: quota?.remaining ?? null,
    used: quota?.used ?? null,
  });
}

function entryOf(league: FeedLeagueRow): LeagueEntry | null {
  return leagueFor({
    key: league.sportKey,
    group: league.sportGroup,
    title: league.title,
    description: league.description,
    active: league.active,
    hasOutrights: false,
  });
}

function eventStats(events: readonly { commenceTime: Date }[], now: Date) {
  let nextStartAt: Date | null = null;
  let live = 0;
  let count = 0;
  for (const event of events) {
    const start = event.commenceTime.getTime();
    if (start - now.getTime() > ODDS_HORIZON_MS) continue;
    count++;
    if (start <= now.getTime()) live++;
    else if (nextStartAt === null || start < nextStartAt.getTime())
      nextStartAt = event.commenceTime;
  }
  return { nextStartAt, live, count };
}

const errorText = (error: OddsApiError): string => error.message.slice(0, 500);

export interface CatalogSyncSummary {
  leagues: number;
  supported: number;
  deactivated: number;
  eventsRead: number;
  failed: number;
}

/** Catalogue sync: the provider's leagues, then the upcoming events of the enabled ones (free calls). */
export async function runOddsApiCatalogSync(
  ctx: TaskContext,
  deps: OddsApiTaskDeps,
): Promise<CatalogSyncSummary> {
  const summary: CatalogSyncSummary = {
    leagues: 0,
    supported: 0,
    deactivated: 0,
    eventsRead: 0,
    failed: 0,
  };
  if (await isPaused(ctx)) return summary;
  const now = ctx.clock();
  const sports = await call(ctx, 'sports', null, 0, () => deps.client.sports());
  if (!sports.ok) return { ...summary, failed: 1 };
  summary.leagues = sports.result.data.length;
  const supported: string[] = [];
  for (const sport of sports.result.data) {
    const entry = leagueFor(sport);
    if (entry === null) continue;
    supported.push(sport.key);
    await upsertFeedLeague(ctx.db, {
      provider: ODDS_API_PROVIDER,
      sportKey: sport.key,
      sport: entry.sport,
      group: sport.group,
      title: sport.title,
      description: sport.description,
      active: sport.active,
      cup: entry.cup,
      tier: entry.tier,
      enabled: enabledByDefault(entry, deps.config.sports),
    });
  }
  summary.supported = supported.length;
  summary.deactivated = await deactivateMissingLeagues(ctx.db, ODDS_API_PROVIDER, supported);

  const budget = await currentBudget(ctx, deps.config);
  for (const league of await listFeedLeagues(ctx.db, ODDS_API_PROVIDER, { enabled: true })) {
    if (!league.active) continue;
    const events = await call(ctx, 'events', league.sportKey, 0, () =>
      deps.client.events(league.sportKey),
    );
    if (!events.ok) {
      summary.failed++;
      await updateFeedLeaguePoll(ctx.db, ODDS_API_PROVIDER, league.sportKey, {
        lastError: errorText(events.error),
        lastErrorAt: now,
      });
      continue;
    }
    summary.eventsRead++;
    const stats = eventStats(events.result.data, now);
    const planned = nextOddsPollAt({
      now,
      nextStartAt: stats.nextStartAt,
      liveCount: stats.live,
      inPlay: deps.config.inPlay,
      budget,
    });
    // A league never polled with events waiting is read at once; otherwise new
    // fixtures can bring the next poll forward, never push it back.
    let nextOddsAt: Date | null = planned;
    if (stats.count > 0 && league.nextOddsAt === null) nextOddsAt = null;
    else if (league.nextOddsAt !== null && league.nextOddsAt.getTime() < planned.getTime()) {
      nextOddsAt = league.nextOddsAt;
    }
    await updateFeedLeaguePoll(ctx.db, ODDS_API_PROVIDER, league.sportKey, {
      lastEventsAt: now,
      nextStartAt: stats.nextStartAt,
      eventCount: stats.count,
      liveCount: stats.live,
      nextOddsAt,
    });
  }
  return summary;
}

export interface OddsPollSummary {
  leagues: number;
  created: number;
  updated: number;
  /** Events seen without a priceable market (not created). */
  unpriced: number;
  failed: number;
  published: number;
}

/** Odds poll: every due league's odds, priced by consensus. */
export async function runOddsApiOddsPoll(
  ctx: TaskContext,
  deps: OddsApiTaskDeps,
): Promise<OddsPollSummary> {
  const summary: OddsPollSummary = {
    leagues: 0,
    created: 0,
    updated: 0,
    unpriced: 0,
    failed: 0,
    published: 0,
  };
  if (await isPaused(ctx)) return summary;
  const now = ctx.clock();
  const budget = await currentBudget(ctx, deps.config);
  if (budget.mode === 'critical') return summary;
  const due = await listDueLeagues(ctx.db, ODDS_API_PROVIDER, 'odds', now);
  for (const league of due.slice(0, deps.leaguesPerTick ?? 6)) {
    if (budget.mode === 'reserve' && !(deps.config.inPlay && league.liveCount > 0)) {
      await updateFeedLeaguePoll(ctx.db, ODDS_API_PROVIDER, league.sportKey, {
        nextOddsAt: nextOddsPollAt({
          now,
          nextStartAt: league.nextStartAt,
          liveCount: 0,
          inPlay: false,
          budget,
        }),
      });
      continue;
    }
    summary.leagues++;
    await pollLeagueOdds(ctx, deps, league, budget, now, summary);
  }
  if (summary.leagues > 0) ctx.logger.info({ ...summary }, 'odds api odds poll');
  return summary;
}

async function pollLeagueOdds(
  ctx: TaskContext,
  deps: OddsApiTaskDeps,
  league: FeedLeagueRow,
  budget: Budget,
  now: Date,
  summary: OddsPollSummary,
): Promise<void> {
  const entry = entryOf(league);
  if (entry === null) return;
  const sport = entry.sport;
  const query: OddsQuery = {
    markets: FEATURED_MARKETS[sport],
    ...(deps.config.bookmakers.length > 0
      ? { bookmakers: deps.config.bookmakers }
      : { regions: deps.config.regions }),
    commenceTimeTo: new Date(now.getTime() + ODDS_HORIZON_MS),
  };
  const response = await call(ctx, 'odds', league.sportKey, estimateOddsCost(query), () =>
    deps.client.odds(league.sportKey, query),
  );
  if (!response.ok) {
    summary.failed++;
    await updateFeedLeaguePoll(ctx.db, ODDS_API_PROVIDER, league.sportKey, {
      lastError: errorText(response.error),
      lastErrorAt: now,
      nextOddsAt: new Date(now.getTime() + 10 * MINUTE_MS),
    });
    return;
  }

  const events = response.result.data.filter(
    (event): event is OddsApiEvent & { homeTeam: string; awayTeam: string } =>
      event.homeTeam !== null &&
      event.awayTeam !== null &&
      event.commenceTime.getTime() - now.getTime() <= ODDS_HORIZON_MS,
  );
  const known = await feedEventsByRef(
    ctx.db,
    ODDS_API_PROVIDER,
    events.map((event) => event.id),
  );
  let competitionId = league.competitionId;
  for (const event of events) {
    const current = known.get(event.id);
    const started = event.commenceTime.getTime() <= now.getTime();
    const live = current?.status === 'live';
    // Never create a started event; a kicked-off one is priced only in play.
    if (current === undefined ? started : !live && (started || current.status !== 'scheduled'))
      continue;
    if (live && !deps.config.inPlay) continue;
    const notBefore = live
      ? new Date(
          Math.max(now.getTime() - IN_PLAY_QUOTE_MAX_AGE_MS, current.stateChangedAt.getTime()),
        )
      : new Date(
          now.getTime() - prematchQuoteMaxAgeMs(event.commenceTime.getTime() - now.getTime()),
        );
    try {
      const detail = eventConsensus(event, sport, {
        notBefore,
        minBooks: deps.config.minBooks,
        requireSharp: deps.mode === 'licensed',
      });
      const priced = priceEvent(detail.consensus, {
        margins: pricingMargins(league.marginBps ?? deps.config.marginBps, live),
        // The goals model describes a whole match from 0-0: in play it would
        // misprice correct score and BTTS, so only the bookmakers' markets run.
        derived: deps.config.derivedMarkets && !live,
      });
      if (current === undefined && priced.markets.length === 0) {
        summary.unpriced++;
        continue;
      }
      if (competitionId === null) {
        const placement = entry;
        competitionId = await ctx.db.transaction((tx) =>
          ensureLeagueCompetition(tx, ODDS_API_PROVIDER, league.sportKey, sport, placement),
        );
      }
      const target = competitionId;
      const result = await ctx.db.transaction(async (tx) => {
        const homeTeamId = await resolveFeedTeam(tx, ODDS_API_PROVIDER, sport, event.homeTeam);
        const awayTeamId = await resolveFeedTeam(tx, ODDS_API_PROVIDER, sport, event.awayTeam);
        return upsertFixture(
          tx,
          {
            feedProvider: ODDS_API_PROVIDER,
            feedRef: event.id,
            sport,
            competitionId: target,
            homeTeamId,
            awayTeamId,
            startTime: event.commenceTime,
          },
          priced.markets,
          {
            now,
            allowLive: deps.config.inPlay,
            suspendMissing: true,
            shouldWrite: shouldWritePrice,
            ...(priced.markets.length > 0 ? { pricedAt: now } : {}),
          },
        );
      });
      if (result.created) summary.created++;
      else if (
        result.oddsChanged +
          result.marketsAdded +
          result.marketsSuspended +
          result.marketsReopened >
        0
      ) {
        summary.updated++;
      }
      summary.published += await publishAfterCommit(
        ctx.redis,
        result.messages,
        ctx.channel,
        ctx.logger,
      );
    } catch (error) {
      summary.failed++;
      ctx.logger.error(
        { err: error, feedRef: event.id, sportKey: league.sportKey },
        'odds api event sync failed',
      );
    }
  }

  const stats = eventStats(events, now);
  await updateFeedLeaguePoll(ctx.db, ODDS_API_PROVIDER, league.sportKey, {
    lastOddsAt: now,
    nextStartAt: stats.nextStartAt,
    eventCount: stats.count,
    liveCount: stats.live,
    nextOddsAt: nextOddsPollAt({
      now,
      nextStartAt: stats.nextStartAt,
      liveCount: stats.live,
      inPlay: deps.config.inPlay,
      budget,
    }),
    lastError: null,
    lastErrorAt: null,
  });
}

/** Both sides' scores as whole numbers, or null when the feed's score cannot be read. */
export function readScore(score: OddsApiScore): { home: number; away: number } | null {
  const value = (name: string): number | null => {
    const entry = score.scores?.find(
      (s) => s.name.trim().toLowerCase() === name.trim().toLowerCase(),
    );
    if (entry === undefined || !/^\d{1,4}$/.test(entry.score.trim())) return null;
    return Number(entry.score.trim());
  };
  const home = value(score.homeTeam);
  const away = value(score.awayTeam);
  return home === null || away === null || score.homeTeam === score.awayTeam
    ? null
    : { home, away };
}

/** Why staff must confirm a final score in this mode, or null to apply it automatically. */
export function reviewReasonFor(
  league: Pick<FeedLeagueRow, 'cup'>,
  sport: SportCode,
  mode: OperatingMode,
): FeedReviewReason | null {
  if (mode !== 'licensed') return null;
  if (league.cup) return 'cup';
  return sport === 'tennis' ? 'tennis' : null;
}

export interface ScoresPollSummary {
  leagues: number;
  live: number;
  finals: number;
  resulted: number;
  failed: number;
  published: number;
}

/** Scores poll: kick-offs, live scores and final scores; then the results whose wait is over. */
export async function runOddsApiScoresPoll(
  ctx: TaskContext,
  deps: OddsApiTaskDeps,
): Promise<ScoresPollSummary> {
  const summary: ScoresPollSummary = {
    leagues: 0,
    live: 0,
    finals: 0,
    resulted: 0,
    failed: 0,
    published: 0,
  };
  if (await isPaused(ctx)) return summary;
  const now = ctx.clock();
  const budget = await currentBudget(ctx, deps.config);
  const due = await listDueLeagues(ctx.db, ODDS_API_PROVIDER, 'scores', now);
  for (const league of due.slice(0, deps.leaguesPerTick ?? 6)) {
    const entry = entryOf(league);
    const idle = {
      nextScoresAt: nextScoresPollAt({
        now,
        live: false,
        awaitingResults: false,
        budget,
        inPlay: deps.config.inPlay,
      }),
    };
    if (entry === null || league.competitionId === null || !hasFeedScores(entry.sport)) {
      // Nothing to read: unsupported, or a sport the API has no scores for (tennis),
      // whose results staff enter (see the sweeps).
      await updateFeedLeaguePoll(ctx.db, ODDS_API_PROVIDER, league.sportKey, idle);
      continue;
    }
    const started = await startedFeedEvents(
      ctx.db,
      ODDS_API_PROVIDER,
      league.competitionId,
      new Date(now.getTime() - 3 * DAY_MS),
      now,
    );
    if (started.length === 0) {
      await updateFeedLeaguePoll(ctx.db, ODDS_API_PROVIDER, league.sportKey, idle);
      continue;
    }
    summary.leagues++;
    const oldest = started[0]?.startTime ?? now;
    const daysFrom = Math.min(
      3,
      Math.max(1, Math.ceil((now.getTime() - oldest.getTime()) / DAY_MS)),
    ) as 1 | 2 | 3;
    const response = await call(ctx, 'scores', league.sportKey, estimateScoresCost(daysFrom), () =>
      deps.client.scores(league.sportKey, { daysFrom }),
    );
    if (!response.ok) {
      summary.failed++;
      await updateFeedLeaguePoll(ctx.db, ODDS_API_PROVIDER, league.sportKey, {
        lastError: errorText(response.error),
        lastErrorAt: now,
        nextScoresAt: new Date(now.getTime() + 10 * MINUTE_MS),
      });
      continue;
    }
    const byRef = new Map(response.result.data.map((score) => [score.id, score]));
    let live = false;
    let awaiting = false;
    for (const event of started) {
      const score = byRef.get(event.feedRef);
      if (score === undefined) {
        awaiting = true;
        continue;
      }
      try {
        const read = readScore(score);
        const messages: LiveMessage[] = [];
        if (!score.completed) {
          if (read === null) continue;
          live = true;
          summary.live++;
          await ctx.db.transaction(async (tx) => {
            const change = await applyLiveState(tx, event.id, {
              status: 'live',
              minute: null,
              period: null,
              home: read.home,
              away: read.away,
            });
            messages.push(...change.messages);
            // Kick-off or a score (the clock is not tracked): no market stays open on
            // prices from before it; the next in-play consensus re-opens them.
            if (change.changed) messages.push(...(await suspendEvent(tx, event.id)).messages);
          });
        } else {
          awaiting = true;
          summary.finals++;
          await ctx.db.transaction(async (tx) => {
            // Finished: nothing more can be bet, whatever the odds poll still sees.
            messages.push(...(await setEventBettingOpen(tx, event.id, false)).messages);
            messages.push(...(await suspendEvent(tx, event.id)).messages);
            await recordFeedResult(tx, {
              eventId: event.id,
              provider: ODDS_API_PROVIDER,
              score: read,
              seenAt: now,
              reviewReason:
                read === null ? 'unreadable' : reviewReasonFor(league, entry.sport, deps.mode),
            });
          });
        }
        summary.published += await publishAfterCommit(ctx.redis, messages, ctx.channel, ctx.logger);
      } catch (error) {
        summary.failed++;
        ctx.logger.error({ err: error, eventId: event.id }, 'odds api score update failed');
      }
    }
    await updateFeedLeaguePoll(ctx.db, ODDS_API_PROVIDER, league.sportKey, {
      lastScoresAt: now,
      nextScoresAt: nextScoresPollAt({
        now,
        live,
        awaitingResults: awaiting,
        budget,
        inPlay: deps.config.inPlay,
      }),
      lastError: null,
      lastErrorAt: null,
    });
  }
  summary.resulted = await applyDueResults(ctx, deps, now, summary);
  return summary;
}

/** Results every feed score that has stood for the confirmation wait. */
async function applyDueResults(
  ctx: TaskContext,
  deps: OddsApiTaskDeps,
  now: Date,
  summary: { published: number; failed: number },
): Promise<number> {
  const readyBefore = new Date(now.getTime() - deps.config.resultConfirmMinutes * MINUTE_MS);
  let resulted = 0;
  for (const row of await dueFeedResults(ctx.db, ODDS_API_PROVIDER, readyBefore)) {
    if (row.scoreHome === null || row.scoreAway === null) continue;
    const score = { home: row.scoreHome, away: row.scoreAway };
    try {
      const outcome = await ctx.db.transaction(async (tx) => {
        const event = await lockEvent(tx, row.eventId);
        if (event.status !== 'scheduled' && event.status !== 'live') {
          // Resulted already (by staff): the feed's score is not needed any more.
          await markFeedResultApplied(tx, row.eventId, now);
          return null;
        }
        const result = await resultEvent(tx, row.eventId, { status: 'finished', score });
        await markFeedResultApplied(tx, row.eventId, now);
        return result;
      });
      if (outcome === null) continue;
      resulted++;
      summary.published += await publishAfterCommit(
        ctx.redis,
        outcome.messages,
        ctx.channel,
        ctx.logger,
      );
    } catch (error) {
      summary.failed++;
      if (error instanceof RangeError) {
        // A score the markets cannot take (a tie in a two-way market): staff decide.
        await recordFeedResult(ctx.db, {
          eventId: row.eventId,
          provider: ODDS_API_PROVIDER,
          score,
          seenAt: now,
          reviewReason: 'unreadable',
        });
      }
      ctx.logger.error({ err: error, eventId: row.eventId }, 'applying a feed result failed');
    }
  }
  return resulted;
}

export interface SweepSummary {
  stale: number;
  /** Matches of a sport without feed scores (tennis) sent to staff for their result. */
  toStaff: number;
  overdue: number;
  voided: number;
  pruned: number;
  published: number;
  failed: number;
}

/** Sweeps: suspend stale prices, send overdue events to review (void them in demo mode), prune the call log. */
export async function runOddsApiSweeps(
  ctx: TaskContext,
  deps: OddsApiTaskDeps,
): Promise<SweepSummary> {
  const summary: SweepSummary = {
    stale: 0,
    toStaff: 0,
    overdue: 0,
    voided: 0,
    pruned: 0,
    published: 0,
    failed: 0,
  };
  const now = ctx.clock();
  const budget = await currentBudget(ctx, deps.config);
  const stale = new Set<string>();
  for (const bucket of staleBuckets(freshnessFactor(budget.factor, deps.mode === 'licensed'))) {
    const ids = await staleFeedEvents(ctx.db, ODDS_API_PROVIDER, {
      now,
      prematchBefore: new Date(now.getTime() - bucket.maxAgeMs),
      liveBefore: new Date(now.getTime() - IN_PLAY_STALE_MS),
      ...(bucket.startsWithinMs === null
        ? {}
        : { startsBefore: new Date(now.getTime() + bucket.startsWithinMs) }),
    });
    for (const id of ids) stale.add(id);
  }
  for (const id of stale) {
    try {
      const change = await ctx.db.transaction((tx) => suspendEvent(tx, id));
      if (change.changed) summary.stale++;
      summary.published += await publishAfterCommit(
        ctx.redis,
        change.messages,
        ctx.channel,
        ctx.logger,
      );
    } catch (error) {
      summary.failed++;
      ctx.logger.error({ err: error, eventId: id }, 'suspending a stale event failed');
    }
  }

  const pending = await pendingFeedResultIds(ctx.db, ODDS_API_PROVIDER);
  // The API reports no scores for these sports: once the match should be
  // over, staff enter the result (in both modes; demo still voids at 72 h).
  const scoreless = new Map<string, SportCode>();
  for (const league of await listFeedLeagues(ctx.db, ODDS_API_PROVIDER)) {
    const entry = entryOf(league);
    if (league.competitionId !== null && entry !== null && !hasFeedScores(entry.sport)) {
      scoreless.set(league.competitionId, entry.sport);
    }
  }
  for (const event of await overdueFeedEvents(
    ctx.db,
    ODDS_API_PROVIDER,
    new Date(now.getTime() - NO_FEED_SCORES_REVIEW_AFTER_MS),
    { competitionIds: [...scoreless.keys()] },
  )) {
    if (pending.has(event.id)) continue;
    const reviewReason = scoreless.get(event.competitionId) === 'tennis' ? 'tennis' : 'overdue';
    try {
      const messages = await ctx.db.transaction(async (tx) => {
        const change = await suspendEvent(tx, event.id);
        await recordFeedResult(tx, {
          eventId: event.id,
          provider: ODDS_API_PROVIDER,
          score: null,
          seenAt: now,
          reviewReason,
        });
        return change.messages;
      });
      pending.add(event.id);
      summary.toStaff++;
      summary.published += await publishAfterCommit(ctx.redis, messages, ctx.channel, ctx.logger);
    } catch (error) {
      summary.failed++;
      ctx.logger.error({ err: error, eventId: event.id }, 'sending an event to staff failed');
    }
  }
  for (const event of await overdueFeedEvents(
    ctx.db,
    ODDS_API_PROVIDER,
    new Date(now.getTime() - OVERDUE_AFTER_MS),
  )) {
    try {
      const voidIt =
        deps.mode === 'demo' && now.getTime() - event.startTime.getTime() >= DEMO_VOID_AFTER_MS;
      const messages = await ctx.db.transaction(async (tx) => {
        const out: LiveMessage[] = [];
        if (voidIt) {
          const locked = await lockEvent(tx, event.id);
          if (locked.status !== 'scheduled' && locked.status !== 'live') return out;
          out.push(...(await resultEvent(tx, event.id, { status: 'cancelled' })).messages);
          if (pending.has(event.id)) await markFeedResultApplied(tx, event.id, now);
          return out;
        }
        out.push(...(await suspendEvent(tx, event.id)).messages);
        if (!pending.has(event.id)) {
          await recordFeedResult(tx, {
            eventId: event.id,
            provider: ODDS_API_PROVIDER,
            score: null,
            seenAt: now,
            reviewReason: 'overdue',
          });
        }
        return out;
      });
      if (voidIt) summary.voided++;
      else summary.overdue++;
      summary.published += await publishAfterCommit(ctx.redis, messages, ctx.channel, ctx.logger);
    } catch (error) {
      summary.failed++;
      ctx.logger.error({ err: error, eventId: event.id }, 'handling an overdue event failed');
    }
  }
  summary.pruned = await pruneFeedCalls(
    ctx.db,
    ODDS_API_PROVIDER,
    new Date(now.getTime() - CALL_RETENTION_MS),
  );
  if (summary.stale + summary.toStaff + summary.overdue + summary.voided + summary.failed > 0) {
    ctx.logger.info({ ...summary }, 'odds api sweeps');
  }
  return summary;
}

/**
 * Cancels the simulated feed's open events (demo mode, when switching to real
 * odds): no simulated match stays on the board next to real ones. Their bets
 * are voided and refunded by settlement as for any cancelled event.
 */
export async function retireSimulatedEvents(ctx: TaskContext): Promise<number> {
  let retired = 0;
  for (const event of await overdueFeedEvents(ctx.db, MOCK_PROVIDER_NAME, END_OF_TIME)) {
    try {
      const messages = await ctx.db.transaction(async (tx) => {
        const locked = await lockEvent(tx, event.id);
        if (locked.status !== 'scheduled' && locked.status !== 'live') return [];
        return (await resultEvent(tx, event.id, { status: 'cancelled' })).messages;
      });
      if (messages.length > 0) retired++;
      await publishAfterCommit(ctx.redis, messages, ctx.channel, ctx.logger);
    } catch (error) {
      ctx.logger.error({ err: error, eventId: event.id }, 'retiring a simulated event failed');
    }
  }
  if (retired > 0) ctx.logger.info({ retired }, 'cancelled the simulated feed events');
  return retired;
}

/** The four tasks of the real feed. */
export function oddsApiTasks(
  ctx: TaskContext,
  deps: OddsApiTaskDeps,
  options: OddsApiTaskOptions = {},
): WorkerTask[] {
  let retire = deps.mode === 'demo';
  const resolved: OddsApiTaskDeps = {
    ...deps,
    ...(options.leaguesPerTick === undefined ? {} : { leaguesPerTick: options.leaguesPerTick }),
  };
  return [
    intervalTask({
      name: 'oddsapi-catalog',
      intervalMs: options.catalogIntervalMs ?? 30 * MINUTE_MS,
      logger: ctx.logger,
      run: () =>
        exclusive(ctx, 'catalog', 10 * MINUTE_MS, async () => {
          if (retire) {
            retire = false;
            await retireSimulatedEvents(ctx);
          }
          return runOddsApiCatalogSync(ctx, resolved);
        }),
    }),
    intervalTask({
      name: 'oddsapi-odds',
      intervalMs: options.oddsIntervalMs ?? 30_000,
      logger: ctx.logger,
      run: () => exclusive(ctx, 'odds', 5 * MINUTE_MS, () => runOddsApiOddsPoll(ctx, resolved)),
    }),
    intervalTask({
      name: 'oddsapi-scores',
      intervalMs: options.scoresIntervalMs ?? 60_000,
      logger: ctx.logger,
      run: () => exclusive(ctx, 'scores', 5 * MINUTE_MS, () => runOddsApiScoresPoll(ctx, resolved)),
    }),
    intervalTask({
      name: 'oddsapi-sweeps',
      intervalMs: options.sweepIntervalMs ?? 60_000,
      logger: ctx.logger,
      run: () => exclusive(ctx, 'sweeps', 2 * MINUTE_MS, () => runOddsApiSweeps(ctx, resolved)),
    }),
  ];
}
