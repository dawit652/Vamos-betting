import { and, eq, inArray, sql } from 'drizzle-orm';
import type { DbExecutor } from '../ledger/types';
import { serviceStatus } from '../schema/platform';
import { scrapeRuns, scrapeSources } from '../schema/scrape';
import { getBoardPricing, getNarobetEvents } from '../scrape/board-odds';

/**
 * The health of the services Nahubet depends on (table service_status, docs/plans/
 * counter-codes-and-deposit-recovery.md, G7). Callers report each call's outcome; the worker's
 * service-health task decides when that is an outage (serviceHealth in @vamos/core) and alerts.
 * Reporting never throws into the caller's work: use reportServiceOk / reportServiceFailure.
 */

/** A success clears the failure. Written at most every 30 seconds per service while it works. */
export async function recordServiceOk(exec: DbExecutor, service: string, at: Date): Promise<void> {
  await exec
    .insert(serviceStatus)
    .values({ service, lastOkAt: at, updatedAt: at })
    .onConflictDoUpdate({
      target: serviceStatus.service,
      set: { lastOkAt: at, failingSince: null, lastError: null, updatedAt: at },
      setWhere: sql`${serviceStatus.failingSince} IS NOT NULL OR ${serviceStatus.lastOkAt} IS NULL
        OR ${serviceStatus.lastOkAt} < ${new Date(at.getTime() - 30_000).toISOString()}::timestamptz`,
    });
}

/** A failure: `failing_since` keeps the first one since the last success. */
export async function recordServiceFailure(
  exec: DbExecutor,
  service: string,
  at: Date,
  error: string,
): Promise<void> {
  const reason = error.replace(/\s+/g, ' ').trim().slice(0, 200);
  await exec
    .insert(serviceStatus)
    .values({ service, failingSince: at, lastFailureAt: at, lastError: reason, updatedAt: at })
    .onConflictDoUpdate({
      target: serviceStatus.service,
      set: {
        failingSince: sql`COALESCE(${serviceStatus.failingSince}, excluded.failing_since)`,
        lastFailureAt: at,
        lastError: reason,
        updatedAt: at,
      },
    });
}

/** Like recordServiceOk, but never throws (a report must not break the call it reports on). */
export async function reportServiceOk(exec: DbExecutor, service: string, at: Date): Promise<void> {
  await recordServiceOk(exec, service, at).catch(() => {});
}

/** Like recordServiceFailure, but never throws. */
export async function reportServiceFailure(
  exec: DbExecutor,
  service: string,
  at: Date,
  error: string,
): Promise<void> {
  await recordServiceFailure(exec, service, at, error).catch(() => {});
}

export interface ServiceStatusRow {
  service: string;
  lastOkAt: Date | null;
  failingSince: Date | null;
  lastFailureAt: Date | null;
  lastError: string | null;
  alertedDownSince: Date | null;
}

export async function listServiceStatus(exec: DbExecutor): Promise<ServiceStatusRow[]> {
  return exec
    .select({
      service: serviceStatus.service,
      lastOkAt: serviceStatus.lastOkAt,
      failingSince: serviceStatus.failingSince,
      lastFailureAt: serviceStatus.lastFailureAt,
      lastError: serviceStatus.lastError,
      alertedDownSince: serviceStatus.alertedDownSince,
    })
    .from(serviceStatus)
    .orderBy(serviceStatus.service);
}

/**
 * Which of `services` are switched off (owner, 23 Nov 2026: "when an API is switched off in the
 * settings, its frequent Telegram alert must stop"). A switched-off service is neither watched nor
 * alerted about, and its health is forgotten (resetServiceHealth), so switching it on again starts
 * clean instead of with an old outage:
 *
 * - `mrx` while the back office switch `hulusport_pricing` is off (the scraper then does not read
 *   mr-x at all);
 * - `mrz` while both `narobet_pricing` and `narobet_events` are off (nor mr-z's board);
 * - `source:<id>` while that feed source is switched off;
 * - `payments:<name>` while the provider is not in PAYMENT_PROVIDERS (`paymentProviders`).
 */
export async function servicesSwitchedOff(
  exec: DbExecutor,
  services: readonly string[],
  options: { paymentProviders: readonly string[] },
): Promise<Set<string>> {
  const off = new Set<string>();
  if (services.includes('mrx') && !(await getBoardPricing(exec, 'hulusport')).enabled) {
    off.add('mrx');
  }
  if (
    services.includes('mrz') &&
    !(await getBoardPricing(exec, 'narobet')).enabled &&
    !(await getNarobetEvents(exec)).enabled
  ) {
    off.add('mrz');
  }
  const sourceIds = services
    .filter((service) => service.startsWith('source:'))
    .map((service) => service.slice('source:'.length));
  if (sourceIds.length > 0) {
    const enabled = await exec
      .select({ id: scrapeSources.id })
      .from(scrapeSources)
      .where(and(inArray(scrapeSources.id, sourceIds), eq(scrapeSources.enabled, true)));
    const on = new Set(enabled.map((row) => row.id));
    for (const id of sourceIds) if (!on.has(id)) off.add(`source:${id}`);
  }
  for (const service of services) {
    if (
      service.startsWith('payments:') &&
      !options.paymentProviders.includes(service.slice('payments:'.length))
    ) {
      off.add(service);
    }
  }
  return off;
}

/**
 * Forgets a switched-off service's health (last success, failure and the outage alerted), so it
 * reads "not reported yet" until it reports again. True when there was something to forget.
 */
export async function resetServiceHealth(
  exec: DbExecutor,
  service: string,
  at: Date,
): Promise<boolean> {
  const rows = await exec
    .update(serviceStatus)
    .set({
      lastOkAt: null,
      failingSince: null,
      lastFailureAt: null,
      lastError: null,
      alertedDownSince: null,
      updatedAt: at,
    })
    .where(
      and(
        eq(serviceStatus.service, service),
        sql`(${serviceStatus.lastOkAt} IS NOT NULL OR ${serviceStatus.failingSince} IS NOT NULL
          OR ${serviceStatus.lastFailureAt} IS NOT NULL OR ${serviceStatus.alertedDownSince} IS NOT NULL)`,
      ),
    )
    .returning({ service: serviceStatus.service });
  return rows.length > 0;
}

/** Records the outage the owner was told about (or none: null), creating the row if needed. */
export async function setServiceAlerted(
  exec: DbExecutor,
  service: string,
  downSince: Date | null,
  at: Date,
): Promise<void> {
  await exec
    .insert(serviceStatus)
    .values({ service, alertedDownSince: downSince, updatedAt: at })
    .onConflictDoUpdate({
      target: serviceStatus.service,
      set: { alertedDownSince: downSince, updatedAt: at },
    });
}

export interface SourceRunReport {
  /** 'source:<source id>'. */
  service: string;
  sourceName: string;
  lastOkAt: Date | null;
  /** The first run of the current streak of failed runs, when the streak has 2 runs or more. */
  failingSince: Date | null;
  lastError: string | null;
}

const FAILED_RUN = new Set(['failed', 'broken', 'blocked']);

/**
 * Each enabled scrape source's health from its last finished runs (scrape_runs): two failed runs in
 * a row (failed, broken or blocked) and no success since is a failure since the first of them; one
 * failed run alone is not (sources run every few minutes to hours).
 */
export async function sourceRunReports(exec: DbExecutor): Promise<SourceRunReport[]> {
  const sources = await exec
    .select({ id: scrapeSources.id, name: scrapeSources.name })
    .from(scrapeSources)
    .where(eq(scrapeSources.enabled, true));
  if (sources.length === 0) return [];
  const ranked = exec
    .select({
      sourceId: scrapeRuns.sourceId,
      startedAt: scrapeRuns.startedAt,
      status: scrapeRuns.status,
      error: scrapeRuns.error,
      n: sql<number>`row_number() OVER (PARTITION BY ${scrapeRuns.sourceId} ORDER BY ${scrapeRuns.startedAt} DESC)`.as(
        'n',
      ),
    })
    .from(scrapeRuns)
    .where(
      and(
        inArray(
          scrapeRuns.sourceId,
          sources.map((s) => s.id),
        ),
        inArray(scrapeRuns.status, ['ok', 'failed', 'broken', 'blocked']),
      ),
    )
    .as('ranked');
  const rows = await exec
    .select({
      sourceId: ranked.sourceId,
      startedAt: ranked.startedAt,
      status: ranked.status,
      error: ranked.error,
    })
    .from(ranked)
    .where(sql`${ranked.n} <= 10`)
    .orderBy(ranked.sourceId, sql`${ranked.startedAt} DESC`);
  const bySource = new Map<string, typeof rows>();
  for (const row of rows) {
    const list = bySource.get(row.sourceId) ?? [];
    list.push(row);
    bySource.set(row.sourceId, list);
  }
  return sources.map((source) => {
    const runs = bySource.get(source.id) ?? [];
    const streak: typeof runs = [];
    for (const run of runs) {
      if (!FAILED_RUN.has(run.status)) break;
      streak.push(run);
    }
    const lastOk = runs.find((run) => run.status === 'ok');
    return {
      service: `source:${source.id}`,
      sourceName: source.name,
      lastOkAt: lastOk?.startedAt ?? null,
      failingSince: streak.length >= 2 ? streak[streak.length - 1]!.startedAt : null,
      lastError: streak[0]?.error ?? null,
    };
  });
}
