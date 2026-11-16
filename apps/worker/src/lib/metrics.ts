import { createHash, timingSafeEqual } from 'node:crypto';
import type { QueueName, QueueSet } from './queues';
import { QUEUE_NAMES } from './queues';

/**
 * GET /metrics on the worker's health port: Prometheus text (version 0.0.4) for the queues and
 * the outbox that feeds them, so a backlog is seen before a player feels it. Off unless METRICS_TOKEN is set (then 404, as if the
 * route did not exist); with it, only a request that carries it as a bearer token is answered.
 * The exposition is written by hand, as the api's is (the worker does not import the api).
 */

export const METRICS_PATH = '/metrics';
export const PROMETHEUS_CONTENT_TYPE = 'text/plain; version=0.0.4; charset=utf-8';
/** One Redis read serves every scrape within this window. */
export const QUEUE_CACHE_MS = 5000;
/** Time limit of the Redis reads behind one scrape. */
export const QUEUE_READ_TIMEOUT_MS = 2000;

/** What the gauges need of one queue. */
export interface QueueSnapshot {
  queue: QueueName;
  waiting: number;
  active: number;
  delayed: number;
  failed: number;
  /** Seconds the oldest waiting job has waited (0: none waiting). */
  oldestWaitingSeconds: number;
}

/**
 * Reads every queue. `waiting` is what a consumer could take now (a delayed live bet is not
 * waiting until its delay is over), so the oldest-waiting age is the lag of the consumers.
 */
export async function readQueueSnapshots(
  queues: Pick<QueueSet, 'get'>,
  now: Date,
): Promise<QueueSnapshot[]> {
  return Promise.all(
    Object.values(QUEUE_NAMES).map(async (name) => {
      const queue = queues.get(name);
      const [counts, oldest] = await Promise.all([
        queue.getJobCounts('waiting', 'active', 'delayed', 'failed'),
        // The waiting list is pushed at the head and taken from the tail: the last entry is the oldest.
        queue.getWaiting(-1, -1),
      ]);
      const created = oldest[0]?.timestamp;
      return {
        queue: name,
        waiting: counts.waiting ?? 0,
        active: counts.active ?? 0,
        delayed: counts.delayed ?? 0,
        failed: counts.failed ?? 0,
        oldestWaitingSeconds:
          created === undefined ? 0 : Math.max(0, Math.floor((now.getTime() - created) / 1000)),
      };
    }),
  );
}

function gauge(
  name: string,
  help: string,
  samples: { labels?: Record<string, string>; value: number }[],
): string[] {
  const lines = [`# HELP ${name} ${help}`, `# TYPE ${name} gauge`];
  for (const sample of samples) {
    const labels = Object.entries(sample.labels ?? {})
      .map(([key, value]) => `${key}="${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`)
      .join(',');
    lines.push(`${name}${labels === '' ? '' : `{${labels}}`} ${sample.value}`);
  }
  return lines;
}

/** The outbox backlog as the gauges need it (readOutboxBacklog of @vamos/db). */
export interface OutboxSnapshot {
  unpublished: number;
  oldestSeconds: number;
}

/** The exposition body. Without `outbox` (no database reader given) its two gauges are left out. */
export function renderQueueMetrics(
  snapshots: readonly QueueSnapshot[],
  outbox?: OutboxSnapshot,
): string {
  const states = ['waiting', 'active', 'delayed', 'failed'] as const;
  const families = [
    gauge(
      'queue_jobs',
      'Jobs per worker queue by state (waiting: ready to be taken; delayed: not due yet).',
      snapshots.flatMap((snapshot) =>
        states.map((state) => ({
          labels: { queue: snapshot.queue, state },
          value: snapshot[state],
        })),
      ),
    ),
    gauge(
      'queue_oldest_waiting_seconds',
      'Age of the oldest waiting job per worker queue (0: none waiting).',
      snapshots.map((snapshot) => ({
        labels: { queue: snapshot.queue },
        value: snapshot.oldestWaitingSeconds,
      })),
    ),
  ];
  if (outbox !== undefined) {
    families.push(
      gauge(
        'outbox_unpublished',
        'Outbox rows not yet handed to the queues (rows backing off and dead letters included).',
        [{ value: outbox.unpublished }],
      ),
      gauge(
        'outbox_oldest_unpublished_seconds',
        'Age of the oldest outbox row not yet handed to the queues (0: none).',
        [{ value: outbox.oldestSeconds }],
      ),
    );
  }
  return `${families.map((lines) => lines.join('\n')).join('\n')}\n`;
}

const sha256 = (value: string) => createHash('sha256').update(value, 'utf8').digest();

/** Whether the Authorization header carries `token` as a bearer token (constant time). */
export function bearerMatches(header: string | undefined, token: string): boolean {
  const given = /^Bearer +(\S+)$/i.exec(header ?? '')?.[1];
  // Hashing first makes the comparison constant-time whatever the lengths.
  return given !== undefined && timingSafeEqual(sha256(given), sha256(token));
}

/** What the health server needs to serve /metrics. */
export interface MetricsEndpoint {
  token: string;
  /** The exposition body; throws when Redis cannot be read. */
  render: () => Promise<string>;
}

/**
 * A renderer that keeps one reading for QUEUE_CACHE_MS and shares a read in flight. With
 * `readOutbox` the outbox backlog (the step before every queue) is read from the database too.
 */
export function cachedQueueMetrics(
  queues: Pick<QueueSet, 'get'>,
  clock: () => Date,
  timeoutMs = QUEUE_READ_TIMEOUT_MS,
  readOutbox?: () => Promise<OutboxSnapshot>,
): () => Promise<string> {
  let entry: { value: Promise<string>; expiresAt: number } | null = null;
  return () => {
    const at = clock().getTime();
    if (entry !== null && at < entry.expiresAt) return entry.value;
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`queue read timed out after ${timeoutMs} ms`)),
        timeoutMs,
      );
    });
    const read = Promise.all([readQueueSnapshots(queues, clock()), readOutbox?.()]);
    const value = Promise.race([read, timeout])
      .then(([snapshots, outbox]) => renderQueueMetrics(snapshots, outbox))
      .finally(() => clearTimeout(timer));
    const mine = { value, expiresAt: at + QUEUE_CACHE_MS };
    entry = mine;
    // A failed read is not kept: the next scrape reads again.
    value.catch(() => {
      if (entry === mine) entry = null;
    });
    return value;
  };
}
