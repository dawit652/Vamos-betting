import {
  isDue,
  backoffAfterFailures,
  createAdapter,
  creditGuardMode,
  DAY_MS,
  daysLeftInMonthUtc,
  fixturesPollIntervalMs,
  marketOddsPollIntervalMs,
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
 * The credit key of an odds source: the name of the environment variable its requests use, so
 * every source on one key shares one guard (rule G1). A source without a key is its own group.
 */
function creditKeyOf(source: ScrapeSource, adapter: SourceAdapter | null, now: Date): string {
  const secret = adapter?.plan(now).find((item) => item.auth !== undefined)?.auth?.secret;
  return secret ?? `source:${source.id}`;
}

/** The guard mode each key was in at the last pass, to log changes (rule G4). Per process. */
const lastModes = new Map<string, CreditGuardMode>();

/**
 * The credit guard of each key used by these odds sources (rules G1, G2, 4.7): the latest reading
 * this month, the spend of the last 24 h, and a refused key (a 401 this month that no later
 * reading, and no change to a source of the key, has cleared).
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
    const refusedAt = usage.refusedAt;
    const keyRefused =
      refusedAt !== null &&
      (usage.latest === null || usage.latest.at.getTime() <= refusedAt.getTime()) &&
      // A person re-enabling (or editing) a source of the key gives it another try.
      !sources.some((s) => s.updatedAt.getTime() > refusedAt.getTime());
    const latest = usage.latest;
    const mode = creditGuardMode({
      quota: latest !== null && latest.used !== null ? latest.used + latest.remaining : null,
      remaining: latest?.remaining ?? null,
      spentLast24h: usage.spentSince,
      daysLeftInMonth: daysLeftInMonthUtc(now),
      keyRefused,
    });
    const before = lastModes.get(key);
    if (before !== mode && (before !== undefined || mode !== 'normal')) {
      const log =
        mode === 'normal' ? ctx.logger.info.bind(ctx.logger) : ctx.logger.warn.bind(ctx.logger);
      log(
        {
          creditKey: key,
          from: before ?? null,
          to: mode,
          remaining: latest?.remaining ?? null,
          spentLast24h: usage.spentSince,
          keyRefused,
        },
        'credit guard mode changed',
      );
    }
    lastModes.set(key, mode);
    modes.set(key, mode);
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
  const pending = (
    await listScrapedEvents(ctx.db, {
      from: new Date(now.getTime() - 7 * DAY_MS),
      to: now,
    })
  ).map((event) => event.startTime);

  const adapters = new Map(sources.map((source) => [source.id, adapterOf(source)]));
  const oddsSources = sources.filter((source) => readsOdds(adapters.get(source.id) ?? null, now));
  const groups = new Map<string, ScrapeSource[]>();
  for (const source of oddsSources) {
    const key = creditKeyOf(source, adapters.get(source.id) ?? null, now);
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
      const mode = modes.get(creditKeyOf(source, adapter, now)) ?? 'normal';
      // Null: not read at all for now (stop, or minimal with no kickoff within 3 h) - not even a first run.
      const interval = marketOddsPollIntervalMs(now, nextKickoffs.get(source.id) ?? null, mode);
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
