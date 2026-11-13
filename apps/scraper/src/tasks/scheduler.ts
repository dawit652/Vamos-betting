import {
  isDue,
  backoffAfterFailures,
  createAdapter,
  creditKeyOf,
  creditProjection,
  creditStatus,
  DAY_MS,
  fixturesPollIntervalMs,
  marketOddsPollIntervalMs,
  meteredResultsPollIntervalMs,
  MIN_LEAD_MS,
  resultsPollIntervalMs,
  utcMonthStart,
  type CreditGuardMode,
  type SourceAdapter,
} from '@vamos/scraper';
import {
  apiCreditUsage,
  listRecentRuns,
  listScrapedEvents,
  listSources,
  nextMarketOddsKickoffs,
  sourceHealth,
  type ScrapeSource,
} from '@vamos/db';
import type { ScraperContext } from '../context';
import { intervalTask, type IntervalTask } from '../lib/interval';
import { meteredPolling, type MeteredPolling } from '../lib/source-competition';
import { syncBudgetAlarm, syncProjectionAlarm } from '../pipeline/credit-alarms';
import { runSource } from '../pipeline/run-source';

export const SCHEDULER_INTERVAL_MS = 30_000;

export interface SchedulerOptions {
  /** Randomness for the early-start jitter (a fraction of 0 to 0.5 of the interval); default Math.random * 0.1. */
  random?: () => number;
}

export interface SchedulerSummary {
  due: number;
  ran: number;
  locked: number;
}

function adapterOf(source: ScrapeSource): SourceAdapter | null {
  const built = createAdapter({
    id: source.id,
    adapter: source.adapter,
    upstream: source.upstream,
    config: source.config,
  });
  return built.ok ? built.adapter : null;
}

/** True for a source whose requests are bookmaker prices (purpose `odds`), read on their own schedule. */
function readsOdds(adapter: SourceAdapter | null, now: Date): boolean {
  return adapter !== null && adapter.plan(now).some((item) => item.purpose === 'odds');
}

/**
 * True for a metered source that reads results (The Odds API's scores): read only in the result
 * window of its own league's matches, under the same credit guard as the odds of its key.
 */
function readsMeteredResults(adapter: SourceAdapter | null, now: Date): boolean {
  return (
    adapter !== null &&
    adapter.usage !== undefined &&
    adapter.plan(now).some((item) => item.purpose === 'results')
  );
}

/** Scores sources skipped as redundant at the last pass, to log each change once (C-2). Per process. */
const skippedScores = new Set<string>();

/** Logs a scores source that starts or stops being skipped as a redundant upstream, once per change. */
function logSkips(ctx: ScraperContext, polling: ReadonlyMap<string, MeteredPolling>): void {
  for (const [sourceId, p] of polling) {
    if (p.skipped && !skippedScores.has(sourceId)) {
      skippedScores.add(sourceId);
      ctx.logger.info(
        { sourceId, competition: p.competition, reason: 'redundant_scores_upstream' },
        'scores source skipped: two other full-time upstreams already cover its competition',
      );
    } else if (!p.skipped && skippedScores.has(sourceId)) {
      skippedScores.delete(sourceId);
      ctx.logger.info(
        { sourceId, competition: p.competition },
        'scores source read again: it is needed as a full-time upstream',
      );
    }
  }
}

/** The guard mode each key was in at the last pass, to log changes (rule G4). Per process. */
const lastModes = new Map<string, CreditGuardMode>();

/**
 * The credit guard of each key used by these odds sources (rules G1, G2, 4.7), from this month's
 * runs, with its alarm kept in step (budget_low, budget_exhausted: 4.8) and every change logged.
 */
async function guardModes(
  ctx: ScraperContext,
  groups: ReadonlyMap<string, ScrapeSource[]>,
  now: Date,
): Promise<Map<string, CreditGuardMode>> {
  const modes = new Map<string, CreditGuardMode>();
  for (const [key, sources] of groups) {
    const usage = await apiCreditUsage(ctx.db, {
      sourceIds: sources.map((s) => s.id),
      monthStart: utcMonthStart(now),
      since: new Date(now.getTime() - DAY_MS),
    });
    const status = creditStatus(
      usage,
      sources.map((s) => s.updatedAt),
      now,
    );
    const before = lastModes.get(key);
    if (before !== status.mode && (before !== undefined || status.mode !== 'normal')) {
      const fields = {
        creditKey: key,
        from: before ?? null,
        to: status.mode,
        remaining: status.remaining,
        spentLast24h: status.spentLast24h,
        keyRefused: status.keyRefused,
      };
      if (status.mode === 'normal') ctx.logger.info(fields, 'credit guard mode changed');
      else ctx.logger.warn(fields, 'credit guard mode changed');
    }
    lastModes.set(key, status.mode);
    modes.set(key, status.mode);
    const firstSource = sources[0];
    if (firstSource !== undefined) {
      const ref = {
        creditKey: key,
        sourceId: firstSource.id,
        runId: usage.latest?.runId ?? null,
        now,
        alerts: ctx.config.ownerAlerts,
      };
      const projection = creditProjection(status, now);
      await ctx.db.transaction(async (tx) => {
        await syncBudgetAlarm(tx, ref, status);
        await syncProjectionAlarm(tx, ref, status, projection);
      });
    }
  }
  return modes;
}

/** How often a source should be polled: the fastest of the data classes its requests serve. */
function pollIntervalMs(
  adapter: SourceAdapter | null,
  now: Date,
  pending: readonly Date[],
): number {
  const purposes = adapter !== null ? adapter.plan(now).map((item) => item.purpose) : ['fixtures'];
  const wants = (kind: 'fixtures' | 'results') =>
    purposes.some((purpose) => purpose === kind || purpose === 'both');
  const intervals: number[] = [];
  if (wants('fixtures')) intervals.push(fixturesPollIntervalMs());
  if (wants('results')) intervals.push(resultsPollIntervalMs(now, pending));
  return Math.min(...(intervals.length > 0 ? intervals : [fixturesPollIntervalMs()]));
}

function hostOf(source: ScrapeSource): string {
  return adapterOf(source)?.allowedHosts[0] ?? source.id;
}

/** The earliest time a blocked or circuit-open source asked us to wait for, if it is still ahead. */
async function retryAtOf(ctx: ScraperContext, sourceId: string, now: Date): Promise<Date | null> {
  const [last] = await listRecentRuns(ctx.db, { sourceId, limit: 1 });
  if (last === undefined) return null;
  const times = last.issues
    .map((issue) => issue.context?.retryAt)
    .flatMap((value) => (typeof value === 'string' ? [new Date(value)] : []))
    .filter((date) => !Number.isNaN(date.getTime()) && date.getTime() > now.getTime());
  return times.length === 0 ? null : new Date(Math.max(...times.map((d) => d.getTime())));
}

/**
 * Decides which enabled sources are due (cadence per data class, failure
 * backoff, the retry time a site asked for) and runs them: one source at a
 * time per host, at most `scraper.maxConcurrency` hosts in parallel.
 */
export async function runDueSources(
  ctx: ScraperContext,
  options: SchedulerOptions = {},
): Promise<SchedulerSummary> {
  const now = ctx.clock();
  const random = options.random ?? (() => Math.random() * 0.1);
  const sources = (await listSources(ctx.db)).filter((source) => source.enabled);
  const summary: SchedulerSummary = { due: 0, ran: 0, locked: 0 };
  if (sources.length === 0) return summary;

  const health = new Map((await sourceHealth(ctx.db, now)).map((h) => [h.sourceId, h]));
  // Unresulted scraped events that started in the last 7 days (scheduled or live).
  const pendingEvents = await listScrapedEvents(ctx.db, {
    from: new Date(now.getTime() - 7 * DAY_MS),
    to: now,
  });
  const pending = pendingEvents.map((event) => event.startTime);

  const adapters = new Map(sources.map((source) => [source.id, adapterOf(source)]));
  const oddsSources = sources.filter((source) => readsOdds(adapters.get(source.id) ?? null, now));
  // A source that also reads odds is read on the odds schedule, never as a scores source.
  const scoresSources = sources.filter((source) => {
    const adapter = adapters.get(source.id) ?? null;
    return !readsOdds(adapter, now) && readsMeteredResults(adapter, now);
  });
  const polling = await meteredPolling(ctx.db, {
    enabled: sources,
    odds: oddsSources,
    scores: scoresSources,
    failing: new Set(
      [...health.values()].filter((x) => x.consecutiveFailures > 0).map((x) => x.sourceId),
    ),
    priorityCompetitions: ctx.config.scraper.priorityCompetitions,
    skipRedundantScores: ctx.config.scraper.skipRedundantScores,
  });
  logSkips(ctx, polling);
  const groups = new Map<string, ScrapeSource[]>();
  for (const source of [...oddsSources, ...scoresSources]) {
    const key = creditKeyOf(source.id, adapters.get(source.id)?.plan(now) ?? []);
    groups.set(key, [...(groups.get(key) ?? []), source]);
  }
  const modes = await guardModes(ctx, groups, now);
  const nextKickoffs = await nextMarketOddsKickoffs(ctx.db, {
    sourceIds: oddsSources.map((s) => s.id),
    after: new Date(now.getTime() + MIN_LEAD_MS),
  });

  const due: ScrapeSource[] = [];
  for (const source of sources) {
    const h = health.get(source.id);
    const failures = h?.consecutiveFailures ?? 0;
    const adapter = adapters.get(source.id) ?? null;
    let base: number;
    if (readsOdds(adapter, now)) {
      const mode = modes.get(creditKeyOf(source.id, adapter?.plan(now) ?? [])) ?? 'normal';
      // Null: not read at all for now (stop, or minimal with no kickoff within 3 h) - not even a first run.
      const tier = polling.get(source.id)?.tier ?? 'priority';
      const interval = marketOddsPollIntervalMs(
        now,
        nextKickoffs.get(source.id) ?? null,
        mode,
        tier,
      );
      if (interval === null) continue;
      base = interval;
    } else if (readsMeteredResults(adapter, now)) {
      const mode = modes.get(creditKeyOf(source.id, adapter?.plan(now) ?? [])) ?? 'normal';
      const p = polling.get(source.id);
      // C-2: a redundant (third) full-time upstream is not read (SCRAPER_SKIP_REDUNDANT_SCORES=on).
      if (p?.skipped === true) continue;
      const competitionId = p?.competitionId ?? null;
      const kickoffs =
        competitionId === null
          ? []
          : pendingEvents.filter((e) => e.competitionId === competitionId).map((e) => e.startTime);
      // Null: none of its league's matches is in the result window (or the guard says stop).
      const interval = meteredResultsPollIntervalMs(now, kickoffs, mode);
      if (interval === null) continue;
      base = interval;
    } else {
      base = pollIntervalMs(adapter, now, pending);
    }
    const intervalMs = failures > 0 ? backoffAfterFailures(failures, base) : base;
    const lastRunAt = h?.lastRun?.startedAt ?? null;
    if (!isDue({ lastRunAt, intervalMs, now, jitterFraction: random() })) continue;
    if (failures > 0) {
      const retryAt = await retryAtOf(ctx, source.id, now);
      if (retryAt !== null) continue;
    }
    due.push(source);
  }
  summary.due = due.length;

  const byHost = new Map<string, ScrapeSource[]>();
  for (const source of due) {
    const host = hostOf(source);
    byHost.set(host, [...(byHost.get(host) ?? []), source]);
  }
  const queue = [...byHost.values()];
  const worker = async (): Promise<void> => {
    for (let group = queue.shift(); group !== undefined; group = queue.shift()) {
      for (const source of group) {
        try {
          const result = await runSource(ctx, source, { trigger: 'schedule' });
          if (result.status === 'locked') summary.locked += 1;
          else summary.ran += 1;
        } catch (error) {
          ctx.logger.error({ err: error, sourceId: source.id }, 'scheduled source run failed');
        }
      }
    }
  };
  const width = Math.max(1, Math.min(ctx.config.scraper.maxConcurrency, queue.length));
  await Promise.all(Array.from({ length: width }, worker));
  return summary;
}

export function schedulerTask(ctx: ScraperContext, options: SchedulerOptions = {}): IntervalTask {
  return intervalTask({
    name: 'scraper-scheduler',
    intervalMs: SCHEDULER_INTERVAL_MS,
    logger: ctx.logger,
    run: () => runDueSources(ctx, options),
  });
}
