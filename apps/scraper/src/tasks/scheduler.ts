import {
  isDue,
  backoffAfterFailures,
  createAdapter,
  DAY_MS,
  fixturesPollIntervalMs,
  resultsPollIntervalMs,
} from '@vamos/scraper';
import {
  listRecentRuns,
  listScrapedEvents,
  listSources,
  sourceHealth,
  type ScrapeSource,
} from '@vamos/db';
import type { ScraperContext } from '../context';
import { intervalTask, type IntervalTask } from '../lib/interval';
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

/** How often a source should be polled: the fastest of the data classes its requests serve. */
function pollIntervalMs(source: ScrapeSource, now: Date, pending: readonly Date[]): number {
  const built = createAdapter({
    id: source.id,
    adapter: source.adapter,
    upstream: source.upstream,
    config: source.config,
  });
  const purposes = built.ok ? built.adapter.plan(now).map((item) => item.purpose) : ['fixtures'];
  const wants = (kind: 'fixtures' | 'results') =>
    purposes.some((purpose) => purpose === kind || purpose === 'both');
  const intervals: number[] = [];
  if (wants('fixtures')) intervals.push(fixturesPollIntervalMs());
  if (wants('results')) intervals.push(resultsPollIntervalMs(now, pending));
  return Math.min(...(intervals.length > 0 ? intervals : [fixturesPollIntervalMs()]));
}

function hostOf(source: ScrapeSource): string {
  const built = createAdapter({
    id: source.id,
    adapter: source.adapter,
    upstream: source.upstream,
    config: source.config,
  });
  return built.ok ? (built.adapter.allowedHosts[0] ?? source.id) : source.id;
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
 * time per host, at most `scraper.maxConcurrency` hosts in parallel. Sources
 * whose adapter is `therundown` are skipped: the TheRundown task polls them.
 */
export async function runDueSources(
  ctx: ScraperContext,
  options: SchedulerOptions = {},
): Promise<SchedulerSummary> {
  const now = ctx.clock();
  const random = options.random ?? (() => Math.random() * 0.1);
  // A TheRundown source is polled by its own task (budget and cadence tiers), never from here.
  const sources = (await listSources(ctx.db)).filter(
    (source) => source.enabled && source.adapter !== 'therundown',
  );
  const summary: SchedulerSummary = { due: 0, ran: 0, locked: 0 };
  if (sources.length === 0) return summary;

  const health = new Map((await sourceHealth(ctx.db, now)).map((h) => [h.sourceId, h]));
  const pending = (
    await listScrapedEvents(ctx.db, {
      from: new Date(now.getTime() - 7 * DAY_MS),
      to: now,
    })
  ).map((event) => event.startTime);

  const due: ScrapeSource[] = [];
  for (const source of sources) {
    const h = health.get(source.id);
    const failures = h?.consecutiveFailures ?? 0;
    const base = pollIntervalMs(source, now, pending);
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
