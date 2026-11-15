import { monitorEventLoopDelay } from 'node:perf_hooks';
import { paymentIntents, payouts } from '@vamos/db/schema';
import { and, asc, count, desc, eq, inArray, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { AppDeps } from '../deps';
import { safeEqualHex, sha256Hex } from '../lib/crypto';
import { AppError } from '../lib/errors';
import {
  Counter,
  Histogram,
  PROMETHEUS_CONTENT_TYPE,
  renderExposition,
  renderGauge,
} from '../lib/prometheus';

/**
 * GET /metrics: Prometheus text for the limits we watch (latency and errors by route, open
 * streams, the database pool, the event loop, and the queues a person has to empty). Off unless
 * METRICS_TOKEN is set (then 404, as if the route did not exist); with it, only a request that
 * carries it as a bearer token is answered. Caddy blocks the path on the public host too.
 */

export const METRICS_PATH = '/metrics';
/** The business gauges are read from the database at most this often (one result for all scrapes). */
export const BUSINESS_CACHE_MS = 15_000;
/** A manual payout claimed this long ago and still not settled counts as idle. */
export const CLAIMED_IDLE_MS = 30 * 60_000;
/** The base amounts listed by sms_open_deposits_busiest. */
export const BUSIEST_BASE_AMOUNTS = 5;

/** Streams the gauge counts; each stream route registers how to read its own open count. */
export type StreamName = 'live' | 'me';

export interface ApiMetrics {
  streams: Map<StreamName, () => number>;
}

declare module 'fastify' {
  interface FastifyInstance {
    metrics: ApiMetrics;
  }
}

/**
 * Tells /metrics how many streams `name` has open. A no-op on an app built without metrics (tests
 * that register one stream plugin alone).
 */
export function registerStreamGauge(
  app: FastifyInstance,
  name: StreamName,
  open: () => number,
): void {
  if (app.hasDecorator('metrics')) app.metrics.streams.set(name, open);
}

export interface BusinessGauges {
  smsOpenDeposits: number;
  /** The base amounts (what the player asked for) with the most open deposits, busiest first. */
  smsBusiest: { baseAmountBirr: string; open: number }[];
  manualPayoutOldestApprovedSeconds: number;
  manualPayoutClaimedIdle: number;
  withdrawalsAwaitingReview: number;
}

/** Santim as a whole-birr label: "100" for 10000, "12.50" only when santim remain. */
export function birrLabel(santim: bigint): string {
  const birr = santim / 100n;
  const rest = santim % 100n;
  return rest === 0n ? birr.toString() : `${birr}.${rest.toString().padStart(2, '0')}`;
}

/** Read-only queries behind the business gauges. */
export async function readBusinessGauges(deps: AppDeps): Promise<BusinessGauges> {
  const { db } = deps;
  const now = deps.clock();
  const idleBefore = new Date(now.getTime() - CLAIMED_IDLE_MS);
  const openSms = and(
    eq(paymentIntents.provider, 'sms'),
    inArray(paymentIntents.status, ['created', 'pending']),
  );
  // The base amount is what the player asked for; `amount` adds the 1-50 santim reference.
  const baseAmount = sql<bigint>`coalesce(${paymentIntents.requestedAmount}, ${paymentIntents.amount})`;

  const [[total], busiest, [queue]] = await Promise.all([
    db.select({ n: count() }).from(paymentIntents).where(openSms),
    db
      .select({ base: baseAmount, n: count() })
      .from(paymentIntents)
      .where(openSms)
      .groupBy(baseAmount)
      .orderBy(desc(count()), asc(baseAmount))
      .limit(BUSIEST_BASE_AMOUNTS),
    db
      .select({
        oldestApproved:
          sql<Date | null>`min(${payouts.approvedAt}) filter (where ${payouts.manual} and ${payouts.status} = 'approved')`.mapWith(
            payouts.approvedAt,
          ),
        claimedIdle:
          sql<number>`count(*) filter (where ${payouts.manual} and ${payouts.status} = 'processing' and ${payouts.processingAt} < ${idleBefore})`.mapWith(
            Number,
          ),
        awaitingReview:
          sql<number>`count(*) filter (where ${payouts.status} = 'requested')`.mapWith(Number),
      })
      .from(payouts)
      .where(inArray(payouts.status, ['requested', 'approved', 'processing'])),
  ]);

  const oldest = queue?.oldestApproved ?? null;
  return {
    smsOpenDeposits: total?.n ?? 0,
    smsBusiest: busiest.map((row) => ({
      baseAmountBirr: birrLabel(BigInt(row.base)),
      open: row.n,
    })),
    manualPayoutOldestApprovedSeconds:
      oldest === null ? 0 : Math.max(0, Math.floor((now.getTime() - oldest.getTime()) / 1000)),
    manualPayoutClaimedIdle: queue?.claimedIdle ?? 0,
    withdrawalsAwaitingReview: queue?.awaitingReview ?? 0,
  };
}

/**
 * Keeps one result for `ttlMs` and lets concurrent callers share the one read in flight. A failed
 * read is not kept: the next caller reads again.
 */
export class TtlCache<T> {
  private entry: { value: Promise<T>; expiresAt: number } | null = null;

  constructor(
    private readonly ttlMs: number,
    private readonly now: () => number,
  ) {}

  get(load: () => Promise<T>): Promise<T> {
    const at = this.now();
    if (this.entry !== null && at < this.entry.expiresAt) return this.entry.value;
    const value = load();
    const entry = { value, expiresAt: at + this.ttlMs };
    this.entry = entry;
    value.catch(() => {
      if (this.entry === entry) this.entry = null;
    });
    return value;
  }
}

function bearerToken(header: string | undefined): string | null {
  const match = /^Bearer +(\S+)$/i.exec(header ?? '');
  return match?.[1] ?? null;
}

/**
 * Counts every response by route template and status class (never the raw URL: ids in paths
 * would grow the series without bound), and serves GET /metrics when METRICS_TOKEN is set.
 * Call once while building the app, before the feature routes are registered.
 */
export function installMetrics(app: FastifyInstance, deps: AppDeps): void {
  const token = deps.config.metricsToken;
  const requests = new Counter(
    'http_requests_total',
    'HTTP responses by route template and status class.',
    ['route', 'status'],
  );
  const durations = new Histogram(
    'http_request_duration_seconds',
    'Time from request to response by route template.',
    ['route'],
  );
  const eventLoop = monitorEventLoopDelay({ resolution: 20 });
  const business = new TtlCache<BusinessGauges>(BUSINESS_CACHE_MS, () => deps.clock().getTime());
  const streams = new Map<StreamName, () => number>([
    ['live', () => 0],
    ['me', () => 0],
  ]);
  app.decorate('metrics', { streams });

  app.addHook('onResponse', async (request, reply) => {
    const route = request.is404 ? 'unmatched' : (request.routeOptions.url ?? 'unmatched');
    // The scraper's own requests would only count themselves.
    if (route === METRICS_PATH) return;
    requests.inc({ route, status: `${Math.floor(reply.statusCode / 100)}xx` });
    durations.observe({ route }, reply.elapsedTime / 1000);
  });

  if (token === undefined) return;

  const expected = sha256Hex(token);
  eventLoop.enable();
  app.addHook('onClose', async () => {
    eventLoop.disable();
  });

  app.get(METRICS_PATH, async (request, reply) => {
    const given = bearerToken(request.headers.authorization);
    // Hashing first makes the comparison constant-time whatever the lengths.
    if (given === null || !safeEqualHex(sha256Hex(given), expected)) {
      reply.header('www-authenticate', 'Bearer');
      throw new AppError(401, 'unauthorized', 'Authentication required');
    }

    let gauges: BusinessGauges | null = null;
    try {
      gauges = await business.get(() => readBusinessGauges(deps));
    } catch (error) {
      // Latency and pool numbers are most wanted when the database is struggling.
      request.log.warn({ err: error }, 'business metrics unavailable');
    }

    const pool = deps.pool;
    // The histogram covers the time since the previous scrape (it is reset here).
    const loopP50 = eventLoop.percentile(50) / 1e9;
    const loopP99 = eventLoop.percentile(99) / 1e9;
    eventLoop.reset();
    const memory = process.memoryUsage();

    const families = [
      requests.render(),
      durations.render(),
      renderGauge(
        'sse_open_streams',
        'Open server-sent event streams on this process.',
        [...streams].map(([stream, open]) => ({ labels: { stream }, value: open() })),
      ),
      renderGauge(
        'db_pool_connections',
        'Database pool connections of this process by state.',
        pool === undefined
          ? []
          : [
              { labels: { state: 'total' }, value: pool.totalCount },
              { labels: { state: 'idle' }, value: pool.idleCount },
              { labels: { state: 'waiting' }, value: pool.waitingCount },
            ],
      ),
      renderGauge('nodejs_eventloop_delay_seconds', 'Event loop delay since the previous scrape.', [
        { labels: { quantile: '0.5' }, value: loopP50 },
        { labels: { quantile: '0.99' }, value: loopP99 },
      ]),
      renderGauge('process_resident_memory_bytes', 'Resident set size.', [{ value: memory.rss }]),
      renderGauge('nodejs_heap_used_bytes', 'V8 heap in use.', [{ value: memory.heapUsed }]),
    ];
    if (gauges !== null) {
      families.push(
        renderGauge('sms_open_deposits', 'Open SMS deposits (created or pending).', [
          { value: gauges.smsOpenDeposits },
        ]),
        renderGauge(
          'sms_open_deposits_busiest',
          'Open SMS deposits of the busiest base amounts (what the player asked for); near 50 an amount is out of references.',
          gauges.smsBusiest.map((row) => ({
            labels: { base_amount_birr: row.baseAmountBirr },
            value: row.open,
          })),
        ),
        renderGauge(
          'manual_payout_oldest_approved_seconds',
          'Age of the oldest approved manual payout nobody has claimed (0: none).',
          [{ value: gauges.manualPayoutOldestApprovedSeconds }],
        ),
        renderGauge(
          'manual_payout_claimed_idle',
          'Manual payouts claimed over 30 minutes ago and not settled.',
          [{ value: gauges.manualPayoutClaimedIdle }],
        ),
        renderGauge('withdrawals_awaiting_review', 'Withdrawals waiting for manual review.', [
          { value: gauges.withdrawalsAwaitingReview },
        ]),
      );
    }
    return reply.header('content-type', PROMETHEUS_CONTENT_TYPE).send(renderExposition(families));
  });
}
