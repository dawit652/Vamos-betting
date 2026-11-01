import {
  closeReviewItemsBySubject,
  finishRun,
  getReferenceBudget,
  getReferencePollState,
  listReferenceCandidates,
  listReferenceEventMap,
  listReferencePollState,
  listSources,
  openReviewItem,
  pruneReference,
  recordReferenceBudget,
  setReferencePollState,
  startRun,
  utcDay,
  type ReferenceBudget,
  type ReferenceCandidate,
  type ReferencePollState,
  type ScrapeRun,
  type ScrapeRunIssueJson,
  type ScrapeSource,
} from '@vamos/db';
import {
  budgetLevel,
  effectiveDelaySeconds,
  expectedCost,
  isCostSpike,
  isQuotaExhausted,
  parseTherundownEvents,
  pollIntervalFor,
  readResponseMeters,
  REFERENCE_TIERS,
  referenceTier,
  TherundownConfigSchema,
  therundownAffiliatesUrl,
  therundownDayUrl,
  therundownEventUrl,
  utcDateOf,
  type BudgetLevel,
  type FetchResult,
  type TherundownConfig,
} from '@vamos/scraper';
import type { ScrapeRunStatus } from '@vamos/core';
import type { ScraperContext } from '../context';
import { intervalTask, type IntervalTask } from '../lib/interval';
import { tryLock } from '../lib/lock';
import { secretProblemMessage } from '../lib/secrets';
import { aliasIndexCache } from '../pipeline/run-source';
import {
  applyTherundownEvents,
  emptyApplySummary,
  REFERENCE_PROVIDER,
  resolveCompetitions,
  type ApplySummary,
} from '../pipeline/reference';

/**
 * The TheRundown poller (docs/therundown-plan/README.md 5.3): one task, every 15 seconds, for
 * every enabled source whose adapter is `therundown`. It decides which requests are due (one
 * request per event in the last 3 hours, otherwise one per sport and UTC day, each at the pace of
 * the nearest kickoff in it), spends the data-point budget carefully (rule A3), asks the books'
 * health once an hour, hands every response to the reference pipeline (mapping, the kickoff rule,
 * consensus, the odds-error guard) and prunes what the licence does not let us keep (A5).
 * TheRundown bodies are never archived and never stored: the licence allows 24 hours.
 *
 * Failures stop the tick, never loop: 429 for the quota holds price requests until the reset (A2),
 * 401 and 403 open `source_broken` and hold the source for HOLD_MS, an open circuit breaker waits.
 */

export const THERUNDOWN_INTERVAL_MS = 15_000;
/** The most requests one tick makes (the plan allows 2 a second; the fetcher paces them). */
export const MAX_REQUESTS_PER_TICK = 10;
/** A tick holds its source's lock this long at most. */
export const THERUNDOWN_LOCK_TTL_MS = 5 * 60_000;
/** After a 401 or a 403 the source is left alone this long; a person has to look. */
export const HOLD_MS = 10 * 60_000;

const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
const AFFILIATES_INTERVAL_MS = HOUR_MS;
const PRUNE_INTERVAL_MS = HOUR_MS;
const HORIZON_MS = 7 * DAY_MS;
/** A mapped event is polled alone only while its map row is this fresh; else the day request finds it again (rule M4). */
const NEAR_MAP_FRESH_MS = 10 * MINUTE_MS;
/** What the markets we ask for cost per book: a 1X2 (3) and a total (2). */
const PRICES_PER_BOOK = 5;

const POLL_AFFILIATES = 'affiliates';
const POLL_QUOTA = 'quota';
const POLL_HOLD = 'hold';
const POLL_PRUNE = 'prune';

export interface TherundownSummary {
  /** Enabled TheRundown sources looked at. */
  sources: number;
  /** Sources whose lock another instance held. */
  locked: number;
  /** HTTP requests made. */
  requests: number;
  ok: number;
  failed: number;
  /** The budget level of the last source looked at. */
  level: BudgetLevel | null;
  apply: ApplySummary;
  /** The hourly prune ran in this tick. */
  pruned: boolean;
}

const emptySummary = (): TherundownSummary => ({
  sources: 0,
  locked: 0,
  requests: 0,
  ok: 0,
  failed: 0,
  level: null,
  apply: emptyApplySummary(),
  pruned: false,
});

export const therundownLockKey = (sourceId: string): string => `scraper:therundown:${sourceId}`;

function addApply(into: ApplySummary, add: ApplySummary): void {
  for (const key of Object.keys(into) as Array<keyof ApplySummary>) into[key] += add[key];
}

/** The `until` a hold row stores (the outcome is one of `outcomes`), if it is a valid date. */
function holdUntil(
  state: ReferencePollState | undefined,
  outcomes: readonly string[],
): Date | null {
  if (state === undefined || !outcomes.includes(state.lastOutcome)) return null;
  const raw = state.details?.until;
  const at = typeof raw === 'string' ? new Date(raw) : null;
  return at !== null && !Number.isNaN(at.getTime()) ? at : null;
}

/**
 * The budget level (rule A3) from the stored meters and today's spend. A reading whose period has
 * reset is old news and counts as unknown (the next response brings a fresh one); a 429 for the
 * quota that is still holding makes it red.
 */
export function levelOf(
  budget: ReferenceBudget | null,
  quota: number,
  now: Date,
  states: ReadonlyMap<string, ReferencePollState>,
): BudgetLevel {
  const hold = holdUntil(states.get(POLL_QUOTA), ['quota_exhausted']);
  if (hold !== null && hold.getTime() > now.getTime()) return 'red';
  if (budget === null) return 'unknown';
  const stale = budget.resetAt !== null && budget.resetAt.getTime() <= now.getTime();
  const snapshot =
    stale || (budget.remaining === null && budget.used === null)
      ? null
      : {
          used: budget.used,
          remaining: budget.remaining,
          resetAt: budget.resetAt,
          observedAt: budget.observedAt,
        };
  return budgetLevel({
    snapshot,
    quota: Math.max(0, quota),
    spentToday: budget.spentDay === utcDay(now) ? budget.spentToday : 0,
    now,
  }).level;
}

// --- Requests due ----------------------------------------------------------------------------

interface DueRequest {
  key: string;
  url: string;
  kind: 'day' | 'event' | 'affiliates';
  tierIndex: number;
  lastFetchedAt: Date | null;
}

/**
 * The requests that are due at `now`: the books' health once an hour (when there is anything to
 * check), a request per mapped event in the last 3 hours, and one request per (sport, UTC day)
 * for the other candidates, each at the pace of its tier at the budget level. At most
 * MAX_REQUESTS_PER_TICK, nearest kickoffs first. Pure apart from its arguments.
 */
export function planRequests(input: {
  config: TherundownConfig;
  baseUrl: string;
  now: Date;
  level: BudgetLevel;
  candidates: readonly ReferenceCandidate[];
  /** Our competition id -> TheRundown sport id. */
  sportOf: ReadonlyMap<string, number>;
  /** Our event id -> its fresh map row's provider event id. */
  mapped: ReadonlyMap<string, string>;
  states: ReadonlyMap<string, ReferencePollState>;
}): DueRequest[] {
  const { config, baseUrl, now, level, candidates, sportOf, mapped, states } = input;
  if (level === 'red') return [];
  const filters = {
    marketIds: config.markets,
    bookIds: [...config.books.anchors, ...config.books.others],
  };
  const wanted = new Map<string, DueRequest & { intervalMs: number }>();
  const want = (request: DueRequest, tierIndex: number, pollMs: number): void => {
    const intervalMs = pollIntervalFor(tierIndex, REFERENCE_TIERS.length, pollMs, level);
    if (intervalMs === null) return;
    const known = wanted.get(request.key);
    // A day request serves its fastest tier.
    if (known === undefined || intervalMs < known.intervalMs) {
      wanted.set(request.key, { ...request, tierIndex, intervalMs });
    }
  };
  for (const candidate of candidates) {
    const tier = referenceTier(candidate.startTime, now);
    const sportId = sportOf.get(candidate.competitionId);
    if (tier === null || sportId === undefined) continue;
    const tierIndex = REFERENCE_TIERS.findIndex((t) => t.name === tier.name);
    const providerEventId = mapped.get(candidate.eventId);
    const lastOf = (key: string) => states.get(key)?.lastFetchedAt ?? null;
    if (tier.name === 'near' && providerEventId !== undefined) {
      const key = `event:${providerEventId}`;
      want(
        {
          key,
          kind: 'event',
          url: therundownEventUrl(baseUrl, providerEventId, filters),
          tierIndex,
          lastFetchedAt: lastOf(key),
        },
        tierIndex,
        tier.pollMs,
      );
    } else {
      const date = utcDateOf(candidate.startTime);
      const key = `day:${sportId}:${date}`;
      want(
        {
          key,
          kind: 'day',
          url: therundownDayUrl(baseUrl, sportId, date, filters),
          tierIndex,
          lastFetchedAt: lastOf(key),
        },
        tierIndex,
        tier.pollMs,
      );
    }
  }
  const due: DueRequest[] = [...wanted.values()]
    .filter(
      (r) => r.lastFetchedAt === null || now.getTime() - r.lastFetchedAt.getTime() >= r.intervalMs,
    )
    .map(({ intervalMs: _intervalMs, ...request }) => request)
    .sort(
      (a, b) =>
        a.tierIndex - b.tierIndex ||
        (a.lastFetchedAt?.getTime() ?? 0) - (b.lastFetchedAt?.getTime() ?? 0) ||
        (a.key < b.key ? -1 : a.key > b.key ? 1 : 0),
    );
  // The books' health matters only when some request would use it.
  if (wanted.size > 0) {
    const last = states.get(POLL_AFFILIATES)?.lastFetchedAt ?? null;
    if (last === null || now.getTime() - last.getTime() >= AFFILIATES_INTERVAL_MS) {
      due.unshift({
        key: POLL_AFFILIATES,
        kind: 'affiliates',
        url: therundownAffiliatesUrl(baseUrl),
        tierIndex: -1,
        lastFetchedAt: last,
      });
    }
  }
  return due.slice(0, MAX_REQUESTS_PER_TICK);
}

// --- Book health -----------------------------------------------------------------------------

/**
 * The books `/api/v2/affiliates` calls healthy: a bare array or `{ affiliates: [...] }`, each
 * with its id in `affiliate_id` or `id` and `status` 'healthy'. null when the body is not that
 * (the health is then unknown).
 */
export function parseHealthyBooks(body: Uint8Array): Set<number> | null {
  let json: unknown;
  try {
    json = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body));
  } catch {
    return null;
  }
  const list: unknown = Array.isArray(json) ? json : isObject(json) ? json.affiliates : undefined;
  if (!Array.isArray(list)) return null;
  const healthy = new Set<number>();
  for (const item of list as unknown[]) {
    if (!isObject(item)) continue;
    const raw = item.affiliate_id ?? item.id;
    const id = typeof raw === 'string' && /^\d+$/.test(raw) ? Number(raw) : raw;
    if (typeof id === 'number' && Number.isSafeInteger(id) && id > 0 && item.status === 'healthy') {
      healthy.add(id);
    }
  }
  return healthy;
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

function healthyFrom(state: ReferencePollState | undefined): Set<number> | null {
  const raw = state?.details?.healthyBooks;
  if (!Array.isArray(raw)) return null;
  return new Set(raw.filter((id): id is number => typeof id === 'number'));
}

// --- One tick --------------------------------------------------------------------------------

const RANK: Record<'ok' | 'broken' | 'failed' | 'blocked', number> = {
  ok: 0,
  broken: 1,
  failed: 2,
  blocked: 3,
};
type Outcome = keyof typeof RANK;

/** Hourly: deletes what is older than the retention (rule A5), whether or not any source is on. */
async function pruneIfDue(
  ctx: ScraperContext,
  now: Date,
  summary: TherundownSummary,
): Promise<void> {
  const last = await getReferencePollState(ctx.db, REFERENCE_PROVIDER, POLL_PRUNE);
  if (last !== null && now.getTime() - last.lastFetchedAt.getTime() < PRUNE_INTERVAL_MS) return;
  const counts = await pruneReference(
    ctx.db,
    REFERENCE_PROVIDER,
    now,
    ctx.config.therundown.retentionHours,
  );
  await setReferencePollState(ctx.db, {
    provider: REFERENCE_PROVIDER,
    requestKey: POLL_PRUNE,
    fetchedAt: now,
    outcome: 'ok',
    details: { ...counts },
  });
  summary.pruned = true;
  const total = counts.eventMap + counts.bookPrices + counts.consensus + counts.pollState;
  ctx.logger[total > 0 ? 'info' : 'debug']({ ...counts }, 'TheRundown data pruned');
}

/**
 * One tick of the poller. Never throws for a bad source or a failed request: those become the
 * tick's run status, a review item or a log line. A source whose lock another instance holds is
 * left to it.
 */
export async function runTherundown(ctx: ScraperContext): Promise<TherundownSummary> {
  const summary = emptySummary();
  if (!ctx.config.therundown.enabled) return summary;
  if (ctx.config.therundown.oddsUse === 'off') {
    ctx.logger.debug('THERUNDOWN_ODDS_USE=off: nothing is polled');
    return summary;
  }
  try {
    await pruneIfDue(ctx, ctx.clock(), summary);
  } catch (error) {
    ctx.logger.error({ err: error }, 'pruning TheRundown data failed');
  }
  const sources = (await listSources(ctx.db)).filter(
    (source) => source.enabled && source.adapter === 'therundown',
  );
  for (const source of sources) {
    const parsed = TherundownConfigSchema.safeParse(source.config);
    if (!parsed.success) {
      ctx.logger.warn(
        { sourceId: source.id, errors: parsed.error.issues.slice(0, 5).map((i) => i.message) },
        'TheRundown source has an invalid configuration; skipped',
      );
      continue;
    }
    summary.sources += 1;
    const lock = await tryLock(ctx.redis, therundownLockKey(source.id), THERUNDOWN_LOCK_TTL_MS);
    if (lock === null) {
      summary.locked += 1;
      ctx.logger.debug({ sourceId: source.id }, 'TheRundown source is locked; skipping');
      continue;
    }
    try {
      await tickSource(ctx, source, parsed.data, summary);
    } catch (error) {
      ctx.logger.error({ err: error, sourceId: source.id }, 'TheRundown tick failed');
    } finally {
      await lock.release().catch(() => false);
    }
  }
  return summary;
}

async function tickSource(
  ctx: ScraperContext,
  source: ScrapeSource,
  config: TherundownConfig,
  summary: TherundownSummary,
): Promise<void> {
  const started = ctx.clock();
  const t = ctx.config.therundown;
  const states = new Map(
    (await listReferencePollState(ctx.db, REFERENCE_PROVIDER)).map((s) => [s.requestKey, s]),
  );

  // A 401 or 403 holds the source until a person has looked.
  const held = holdUntil(states.get(POLL_HOLD), ['unauthorized', 'forbidden']);
  if (held !== null && held.getTime() > started.getTime()) {
    ctx.logger.debug(
      { sourceId: source.id, until: held.toISOString() },
      'TheRundown source on hold',
    );
    return;
  }

  // a. The budget.
  let budget = await getReferenceBudget(ctx.db, REFERENCE_PROVIDER);
  let level = levelOf(budget, t.monthlyBudget, started, states);
  summary.level = level;
  if ((budget?.level ?? 'unknown') !== level && (budget !== null || level !== 'unknown')) {
    await ctx.db.transaction((tx) =>
      recordReferenceBudget(tx, { provider: REFERENCE_PROVIDER, now: started, level }),
    );
  }
  if (level === 'red') {
    ctx.logger.warn({ sourceId: source.id }, 'TheRundown budget is red: no price requests');
    return;
  }

  // b. Competitions.
  const indexes = aliasIndexCache(ctx);
  const { resolved, unresolved } = await resolveCompetitions(indexes, source, config);
  for (const label of unresolved) {
    ctx.logger.warn(
      { sourceId: source.id, competition: label },
      'TheRundown competition label does not resolve through the aliases; its sport id is skipped',
    );
  }
  if (resolved.size === 0) return;
  const sportOf = new Map<string, number>();
  for (const competition of resolved.values()) {
    if (!sportOf.has(competition.competitionId)) {
      sportOf.set(competition.competitionId, competition.sportId);
    }
  }

  // c. Candidates.
  const candidates = await listReferenceCandidates(ctx.db, {
    competitionIds: [...sportOf.keys()],
    after: started,
    upTo: new Date(started.getTime() + HORIZON_MS),
  });
  const mapRows =
    candidates.length === 0
      ? []
      : await listReferenceEventMap(ctx.db, REFERENCE_PROVIDER, {
          eventIds: candidates.map((c) => c.eventId),
        });
  const mapped = new Map(
    mapRows
      .filter((row) => started.getTime() - row.lastSeenAt.getTime() <= NEAR_MAP_FRESH_MS)
      .map((row) => [row.eventId, row.providerEventId]),
  );

  // d. The requests that are due.
  const due = planRequests({
    config,
    baseUrl: t.baseUrl,
    now: started,
    level,
    candidates,
    sportOf,
    mapped,
    states,
  });
  if (due.length === 0) return;

  let healthyBooks = healthyFrom(states.get(POLL_AFFILIATES));
  let run: ScrapeRun | null = null;
  let outcome: Outcome = 'ok';
  const issues: ScrapeRunIssueJson[] = [];
  const counts = { requests: 0, bytes: 0, seen: 0, accepted: 0 };
  let okResponses = 0;
  const worsen = (next: Outcome) => {
    if (RANK[next] > RANK[outcome]) outcome = next;
  };
  const ensureRun = async (): Promise<ScrapeRun> => {
    run ??= await startRun(ctx.db, {
      sourceId: source.id,
      trigger: 'schedule',
      startedAt: started,
    });
    return run;
  };
  const sourceBroken = async (
    reason: 'unauthorized' | 'forbidden',
    title: string,
    detail: string,
  ) => {
    const current = await ensureRun();
    await ctx.db.transaction((tx) =>
      openReviewItem(tx, {
        kind: 'source_broken',
        subjectKey: `source|${source.id}`,
        severity: 'warning',
        title,
        payload: {
          rules: ['A2'],
          reasons: [reason],
          sourceId: source.id,
          runId: current.id,
          reason,
          recordsAccepted: 0,
          baseline: null,
          detail,
        },
        now: ctx.clock(),
      }),
    );
    await setReferencePollState(ctx.db, {
      provider: REFERENCE_PROVIDER,
      requestKey: POLL_HOLD,
      fetchedAt: ctx.clock(),
      outcome: reason,
      details: { until: new Date(ctx.clock().getTime() + HOLD_MS).toISOString() },
    });
  };
  const setState = (
    request: DueRequest,
    at: Date,
    result: string,
    cost: number | null,
    details: Record<string, unknown> | null = null,
  ) =>
    setReferencePollState(ctx.db, {
      provider: REFERENCE_PROVIDER,
      requestKey: request.key,
      fetchedAt: at,
      outcome: result,
      cost,
      details,
    });
  const fail = (
    request: DueRequest,
    code: string,
    message: string,
    context?: Record<string, unknown>,
  ) => {
    worsen('failed');
    issues.push({
      severity: 'error',
      code,
      message,
      context: { request: request.key, ...context },
    });
  };

  // A bug or a database failure while handling a response ends the tick, not the process: the run
  // is finished as failed below, and that request waits for its interval like any other.
  let current: DueRequest | null = null;
  try {
    for (const request of due) {
      current = request;
      const result: FetchResult = await ctx.fetcher.fetch(
        { url: request.url, purpose: 'both', auth: config.auth },
        { allowedHosts: config.allowedHosts, sourceKey: source.id },
      );
      if (result.kind === 'circuit_open') {
        // Nothing was requested: wait for the breaker (the same one serves every request).
        if (run !== null) {
          worsen('failed');
          issues.push({
            severity: 'error',
            code: 'circuit_open',
            message: 'too many recent failures; not trying until the breaker closes',
            context: { retryAt: result.retryAt.toISOString() },
          });
        }
        break;
      }
      await ensureRun();
      counts.requests += 1;
      summary.requests += 1;
      const at = result.kind === 'ok' ? result.fetchedAt : ctx.clock();

      if (result.kind === 'ok') {
        counts.bytes += result.body.length;
        const meters = readResponseMeters(result.headers, at);
        const delay = effectiveDelaySeconds(meters.delayHeader, t.planDelaySeconds);
        budget = await ctx.db.transaction((tx) =>
          recordReferenceBudget(tx, {
            provider: REFERENCE_PROVIDER,
            now: at,
            cost: meters.cost ?? 0,
            snapshot: meters.snapshot,
            delaySeconds: delay,
            rateLimit: meters.rateLimit,
          }),
        );

        if (request.kind === 'affiliates') {
          const healthy = parseHealthyBooks(result.body);
          healthyBooks = healthy;
          if (healthy === null) {
            fail(request, 'affiliates_unreadable', 'the books list is not in a shape we read');
          }
          await setState(request, at, healthy === null ? 'unreadable' : 'ok', meters.cost, {
            healthyBooks: healthy === null ? null : [...healthy].sort((a, b) => a - b),
          });
          summary.ok += healthy === null ? 0 : 1;
          summary.failed += healthy === null ? 1 : 0;
          okResponses += healthy === null ? 0 : 1;
        } else {
          // Never archived: nothing but the parsed prices we may keep for the retention is stored.
          const parsed = parseTherundownEvents(result.body, { allowedMarketIds: config.markets });
          counts.seen += parsed.events.length;
          if (parsed.counts.fatal !== undefined) {
            worsen('broken');
            summary.failed += 1;
            issues.push({
              severity: 'error',
              code: 'shape_broken',
              message: 'the response is not a TheRundown events response',
              context: { request: request.key },
            });
            await setState(request, at, 'parse_failed', meters.cost);
          } else {
            counts.accepted += parsed.events.length;
            if (meters.cost !== null) {
              const expected = expectedCost(
                parsed.events.length,
                config.books.anchors.length + config.books.others.length,
                PRICES_PER_BOOK,
              );
              if (isCostSpike(expected, meters.cost)) {
                ctx.logger.warn(
                  { request: request.key, cost: meters.cost, expected },
                  'a TheRundown response cost far more than expected: a filter may be ignored',
                );
              }
            }
            const applied = await applyTherundownEvents({
              ctx,
              source,
              config,
              competitions: resolved,
              candidates,
              indexes,
              events: parsed.events,
              fetchedAt: at,
              delaySeconds: delay,
              healthyBooks,
            });
            addApply(summary.apply, applied);
            await setState(request, at, 'ok', meters.cost, { events: parsed.events.length });
            summary.ok += 1;
            okResponses += 1;
          }
        }
        level = levelOf(budget, t.monthlyBudget, at, states);
        summary.level = level;
        if (level === 'red') {
          ctx.logger.warn(
            { sourceId: source.id },
            'TheRundown budget turned red: stopping this tick',
          );
          break;
        }
        continue;
      }

      summary.failed += 1;
      if (result.kind === 'blocked') {
        worsen('blocked');
        if (result.reason === 'rate_limited' && isQuotaExhausted(result, at)) {
          // The quota is gone (A2): no price request until the reset, and never a retry.
          const reset = budget?.resetAt ?? null;
          const fallback =
            reset !== null && reset.getTime() > at.getTime()
              ? reset
              : new Date(at.getTime() + HOUR_MS);
          const until = new Date(
            Math.max(at.getTime() + MINUTE_MS, (result.retryAt ?? fallback).getTime()),
          );
          await setReferencePollState(ctx.db, {
            provider: REFERENCE_PROVIDER,
            requestKey: POLL_QUOTA,
            fetchedAt: at,
            outcome: 'quota_exhausted',
            details: { until: until.toISOString() },
          });
          await ctx.db.transaction((tx) =>
            recordReferenceBudget(tx, { provider: REFERENCE_PROVIDER, now: at, level: 'red' }),
          );
          summary.level = 'red';
          await setState(request, at, 'quota_exhausted', null);
          issues.push({
            severity: 'error',
            code: 'quota_exhausted',
            message: 'TheRundown says the data point limit is reached; waiting for the reset',
            context: { request: request.key, until: until.toISOString() },
          });
        } else if (result.reason === 'forbidden') {
          await setState(request, at, 'forbidden', null);
          issues.push({
            severity: 'error',
            code: 'forbidden',
            message: 'TheRundown refused the request (HTTP 403): the plan may not include it',
            context: { request: request.key },
          });
          await sourceBroken(
            'forbidden',
            'TheRundown refused the request (HTTP 403)',
            'The plan does not include this request, or the key was restricted. A person checks the plan and the key.',
          );
        } else {
          await setState(request, at, result.reason, null);
          issues.push({
            severity: 'error',
            code: 'blocked',
            message: `TheRundown told us to stop (${result.reason}); backing off`,
            context: { request: request.key, retryAt: result.retryAt?.toISOString() ?? null },
          });
        }
        // Every kind of block stops the tick: more requests would only repeat it.
        break;
      }
      if (result.kind === 'refused' && result.reason.startsWith('secret_')) {
        worsen('failed');
        issues.push({
          severity: 'error',
          code: result.reason,
          message: secretProblemMessage(result.reason, config.auth.secret),
          fatal: true,
          context: { request: request.key },
        });
        await setState(request, at, result.reason, null);
        if (result.reason === 'secret_echoed') continue;
        await sourceBroken(
          'unauthorized',
          'TheRundown API key is missing or unusable',
          secretProblemMessage(result.reason, config.auth.secret),
        );
        break;
      }
      if (result.kind === 'error' && result.status === 401) {
        fail(request, 'unauthorized', 'TheRundown refused the API key (HTTP 401)');
        await setState(request, at, 'unauthorized', null);
        await sourceBroken(
          'unauthorized',
          'TheRundown refused the API key (HTTP 401)',
          'The key was refused. A person checks SCRAPER_SECRET_THERUNDOWN and the account.',
        );
        break;
      }
      if (result.kind === 'refused') {
        fail(request, `refused_${result.reason}`, `refused: ${result.reason}`);
        await setState(request, at, `refused_${result.reason}`, null);
        if (request.kind === 'affiliates') await markHealthUnknown(ctx, request, at);
        continue;
      }
      if (result.kind === 'error') {
        fail(request, `fetch_${result.code}`, result.message, { status: result.status ?? null });
        await setState(request, at, `error_${result.code}`, null, {
          status: result.status ?? null,
          ...(request.kind === 'affiliates' ? { healthyBooks: null } : {}),
        });
        if (request.kind === 'affiliates') healthyBooks = null;
        continue;
      }
      // not_modified cannot happen for a request we sent without validators.
      fail(request, 'unexpected_response', `unexpected ${result.kind} response`);
      await setState(request, at, 'unexpected', null);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    ctx.logger.error({ err: error, sourceId: source.id }, 'TheRundown tick crashed');
    worsen('failed');
    summary.failed += 1;
    issues.push({ severity: 'error', code: 'run_crashed', message });
    if (current !== null) {
      await setState(current, ctx.clock(), 'processing_failed', null).catch(() => undefined);
    }
  }

  if (run !== null) {
    const finished = run as ScrapeRun;
    const status: ScrapeRunStatus = outcome;
    const errorText = issues.find((i) => i.fatal === true)?.message ?? issues[0]?.message ?? null;
    await ctx.db.transaction(async (tx) => {
      if (status === 'ok' && okResponses > 0) {
        await closeReviewItemsBySubject(tx, `source|${source.id}`, {
          kinds: ['source_broken'],
          resolution: 'TheRundown answers again',
          now: ctx.clock(),
        });
      }
      await finishRun(tx, finished.id, {
        status,
        requests: counts.requests,
        bytes: counts.bytes,
        recordsSeen: counts.seen,
        recordsAccepted: counts.accepted,
        issues,
        error: status === 'ok' ? null : errorText,
        finishedAt: ctx.clock(),
      });
    });
    ctx.logger.info(
      { sourceId: source.id, runId: finished.id, status, ...counts, level },
      'TheRundown tick finished',
    );
  }
}

/** A books-health request that failed: the health is unknown until the next one (rule P4). */
async function markHealthUnknown(
  ctx: ScraperContext,
  request: { key: string },
  at: Date,
): Promise<void> {
  await setReferencePollState(ctx.db, {
    provider: REFERENCE_PROVIDER,
    requestKey: request.key,
    fetchedAt: at,
    outcome: 'unknown',
    details: { healthyBooks: null },
  });
}

export function therundownTask(ctx: ScraperContext): IntervalTask {
  return intervalTask({
    name: 'scraper-therundown',
    intervalMs: THERUNDOWN_INTERVAL_MS,
    logger: ctx.logger,
    run: () => runTherundown(ctx),
  });
}
