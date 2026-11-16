/**
 * Load test: page and list requests plus open live streams, against an API (and
 * web app) that are already up. It reads and publishes nothing that touches money,
 * so it runs against any mode; it only needs the Redis the API relays from.
 *
 *   pnpm load:pages [--scale 0.1] [--duration 30] [--streams N] [--rate N]
 *                   [--api http://localhost:4000] [--web http://localhost:3000]
 *
 * The mix is the page-and-stream part of section 2 of docs/plans/scale-and-payments-plan.md:
 * 10,000 people online make one page or list request every 15 s (about 700/s) and hold
 * 6,000 live streams. `--scale` is the fraction of that (0.1 = 70 requests/s and 600
 * streams); `--rate` and `--streams` override either number.
 *
 * 1. Takes events from GET /events for the pages (a missing event list stops the run).
 * 2. Opens the streams: GET /live/stream, each one counted open once the API has sent its
 *    first bytes.
 * 3. Sends requests at a fixed rate (open loop: a slow answer does not slow the sending), in
 *    this mix: web home 15%, web sport page 10%, web event page 10%, web live page 5%,
 *    API /sports 10%, API /events list (a few different queries) 30%, API /events/:id 20%.
 *    Web kinds are skipped, and said so, when the web app does not answer.
 * 4. While that runs, every 5 s publishes a price change on the live Redis channel, the way the
 *    worker does, and times how long each open stream takes to see it.
 *
 * Prints p50/p95/p99/max per kind of request and per stream delivery, and exits 1 when a
 * stream missed a price change, a stream could not be opened, or the error rate is above
 * `--max-error-rate` (default 0.5%, the plan's target). The p95 target (under 400 ms for
 * requests, under 2 s for a price change) is printed next to the result, not enforced: it
 * depends on the machine the script runs on, which also runs the system under test here.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import http from 'node:http';
import { performance } from 'node:perf_hooks';
import { parseArgs } from 'node:util';
import { loadConfig, loadDotEnv } from '@vamos/config';
import { LIVE_CHANNEL } from '@vamos/contracts';
import { Redis } from 'ioredis';

const PLAN_REQUESTS_PER_S = 700;
const PLAN_STREAMS = 6_000;
const REQUEST_P95_TARGET_MS = 400;
const DELIVERY_P95_TARGET_MS = 2_000;
const PUBLISH_EVERY_MS = 5_000;
const MAX_IN_FLIGHT = 5_000;

const { values: args } = parseArgs({
  options: {
    api: { type: 'string', default: process.env.LOAD_API_URL ?? 'http://localhost:4000' },
    web: { type: 'string', default: process.env.LOAD_WEB_URL ?? 'http://localhost:3000' },
    scale: { type: 'string', default: '0.1' },
    duration: { type: 'string', default: '30' },
    streams: { type: 'string' },
    rate: { type: 'string' },
    'max-error-rate': { type: 'string', default: '0.005' },
  },
});
const apiUrl = args.api.replace(/\/$/, '');
const webUrl = args.web.replace(/\/$/, '');
const scale = Number(args.scale);
const duration = Number(args.duration);
const streamTarget = Math.round(Number(args.streams ?? PLAN_STREAMS * scale));
const requestRate = Number(args.rate ?? PLAN_REQUESTS_PER_S * scale);
const maxErrorRate = Number(args['max-error-rate']);
if (![scale, duration, streamTarget, requestRate, maxErrorRate].every(Number.isFinite)) {
  console.error('--scale, --duration, --streams, --rate and --max-error-rate must be numbers');
  process.exit(2);
}

loadDotEnv();
const config = loadConfig();

/** Nearest-rank percentile of a sorted list, in ms. */
function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return 0;
  const rank = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return Math.round(sorted[rank]! * 10) / 10;
}
const summary = (values: readonly number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  return {
    samples: sorted.length,
    p50: percentile(sorted, 50),
    p95: percentile(sorted, 95),
    p99: percentile(sorted, 99),
    max: percentile(sorted, 100),
  };
};
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

interface EventItem {
  id: string;
  sport: string;
}

async function getJson<T>(url: string): Promise<T> {
  const response = await fetch(url, { headers: { accept: 'application/json' } });
  if (!response.ok) throw new Error(`${url}: ${response.status}`);
  return (await response.json()) as T;
}

// ---- Live streams ----------------------------------------------------------------------

const agent = new http.Agent({ keepAlive: true, maxSockets: Infinity });

interface StreamClient {
  request: http.ClientRequest;
  /** When each published marker was first seen on this stream, by marker. */
  seen: Map<number, number>;
}

/** Opens one stream; resolves once the API has sent its first bytes, or null when it did not. */
function openStream(markers: Set<number>): Promise<StreamClient | null> {
  return new Promise((resolve) => {
    const client: StreamClient = { request: undefined as never, seen: new Map() };
    let open = false;
    const request = http.get(
      `${apiUrl}/live/stream`,
      { agent, headers: { accept: 'text/event-stream' } },
      (response) => {
        if (response.statusCode !== 200) {
          response.resume();
          resolve(null);
          return;
        }
        response.setEncoding('utf8');
        response.on('data', (chunk: string) => {
          if (!open) {
            open = true;
            resolve(client);
          }
          const at = performance.now();
          // A price change frame: event: odds\ndata: {"s":..,"o":<marker>,"st":"open"}
          if (!chunk.includes('event: odds')) return;
          for (const marker of markers) {
            if (!client.seen.has(marker) && chunk.includes(`"o":${marker},`)) {
              client.seen.set(marker, at);
            }
          }
        });
        response.on('error', () => undefined);
      },
    );
    client.request = request;
    request.on('error', () => resolve(null));
    request.setTimeout(30_000, () => {
      if (!open) {
        request.destroy();
        resolve(null);
      }
    });
  });
}

// ---- Page and list requests ------------------------------------------------------------

interface Kind {
  name: string;
  weight: number;
  web: boolean;
  url: () => string;
}

async function main(): Promise<void> {
  const failures: string[] = [];
  const list = await getJson<{ items: EventItem[] }>(
    `${apiUrl}/events?filter=upcoming&limit=50`,
  ).catch((error: unknown) => {
    console.error(`cannot read the event list: ${String(error)}`);
    return null;
  });
  if (list === null || list.items.length === 0) {
    console.error('No events: start the worker (feed ingest) first so the catalogue has fixtures.');
    process.exit(2);
  }
  const events = list.items;
  const pick = <T>(items: readonly T[]): T =>
    items[Math.floor((randomBytes(4).readUInt32BE(0) / 2 ** 32) * items.length)]!;

  const webUp = await fetch(`${webUrl}/`, { signal: AbortSignal.timeout(5_000) })
    .then((r) => r.ok)
    .catch(() => false);
  if (!webUp) console.warn(`web app not answering at ${webUrl}: its page kinds are skipped`);

  const apiQueries = [
    'filter=upcoming&limit=50',
    'sport=football&filter=upcoming&limit=50',
    'filter=live&limit=50',
    'sport=football&filter=today&limit=20',
  ];
  const kinds: Kind[] = [
    { name: 'web /', weight: 15, web: true, url: () => `${webUrl}/` },
    { name: 'web /sport/football', weight: 10, web: true, url: () => `${webUrl}/sport/football` },
    {
      name: 'web /event/:id',
      weight: 10,
      web: true,
      url: () => `${webUrl}/event/${pick(events).id}`,
    },
    { name: 'web /live', weight: 5, web: true, url: () => `${webUrl}/live` },
    { name: 'api /sports', weight: 10, web: false, url: () => `${apiUrl}/sports` },
    {
      name: 'api /events',
      weight: 30,
      web: false,
      url: () => `${apiUrl}/events?${pick(apiQueries)}`,
    },
    {
      name: 'api /events/:id',
      weight: 20,
      web: false,
      url: () => `${apiUrl}/events/${pick(events).id}`,
    },
  ].filter((kind) => webUp || !kind.web);
  const totalWeight = kinds.reduce((sum, kind) => sum + kind.weight, 0);
  const chooseKind = (): Kind => {
    let roll = (randomBytes(4).readUInt32BE(0) / 2 ** 32) * totalWeight;
    for (const kind of kinds) {
      roll -= kind.weight;
      if (roll < 0) return kind;
    }
    return kinds[kinds.length - 1]!;
  };

  // 2. Streams.
  const markers = new Set<number>();
  const clients: StreamClient[] = [];
  let streamsRefused = 0;
  const opening = performance.now();
  let nextStream = 0;
  await Promise.all(
    Array.from({ length: Math.min(100, streamTarget) }, async () => {
      while (nextStream < streamTarget) {
        nextStream++;
        const client = await openStream(markers);
        if (client === null) streamsRefused++;
        else clients.push(client);
      }
    }),
  );
  console.log(
    `streams: ${clients.length} open of ${streamTarget} asked (${streamsRefused} not opened) ` +
      `in ${Math.round(performance.now() - opening)} ms`,
  );

  // 3 and 4. Requests at a fixed rate, with a price change every PUBLISH_EVERY_MS.
  const publisher = new Redis(config.redisUrl, { maxRetriesPerRequest: 2 });
  const publishedAt = new Map<number, number>();
  const latencies = new Map<string, number[]>(kinds.map((kind) => [kind.name, []]));
  const statuses = new Map<string, Record<string, number>>(kinds.map((kind) => [kind.name, {}]));
  let sent = 0;
  let failed = 0;
  let dropped = 0;
  let inFlight = 0;
  let marker = 1_000;

  const fire = (kind: Kind): void => {
    if (inFlight >= MAX_IN_FLIGHT) {
      dropped++;
      return;
    }
    inFlight++;
    sent++;
    const t0 = performance.now();
    // A distinct client address per request, so no per-address rate limit decides the result
    // (honoured only with TRUST_PROXY=127.0.0.1 on the API, as for load:deposits).
    const ip = `198.51.${100 + Math.floor(Math.random() * 100)}.${1 + Math.floor(Math.random() * 250)}`;
    fetch(kind.url(), { headers: { 'x-forwarded-for': ip } })
      .then(async (response) => {
        await response.arrayBuffer();
        const key = String(response.status);
        const byStatus = statuses.get(kind.name)!;
        byStatus[key] = (byStatus[key] ?? 0) + 1;
        if (response.status >= 400) failed++;
        else latencies.get(kind.name)!.push(performance.now() - t0);
      })
      .catch(() => {
        failed++;
        const byStatus = statuses.get(kind.name)!;
        byStatus.network_error = (byStatus.network_error ?? 0) + 1;
      })
      .finally(() => {
        inFlight--;
      });
  };

  const publish = async (): Promise<void> => {
    marker++;
    markers.add(marker);
    publishedAt.set(marker, performance.now());
    await publisher.publish(
      LIVE_CHANNEL,
      JSON.stringify({
        type: 'odds',
        eventId: pick(events).id,
        data: { s: randomUUID(), o: marker, st: 'open' },
      }),
    );
  };

  console.log(
    `requests: ${requestRate.toFixed(0)}/s for ${duration} s over ${kinds.length} kinds, ` +
      `a price change every ${PUBLISH_EVERY_MS / 1000} s`,
  );
  const started = performance.now();
  const tick = 10;
  let owed = 0;
  let lastPublish = started;
  while (performance.now() - started < duration * 1_000) {
    await sleep(tick);
    owed += (requestRate * tick) / 1_000;
    while (owed >= 1) {
      owed--;
      fire(chooseKind());
    }
    if (performance.now() - lastPublish >= PUBLISH_EVERY_MS && clients.length > 0) {
      lastPublish = performance.now();
      await publish();
    }
  }
  // Let the last price change reach the streams and the last requests answer.
  if (clients.length > 0 && markers.size === 0) await publish();
  const drain = performance.now();
  while (inFlight > 0 && performance.now() - drain < 15_000) await sleep(50);
  await sleep(2_000);
  const elapsed = (performance.now() - started) / 1_000;

  // Stream results.
  const deliveries: number[] = [];
  let missed = 0;
  let streamsMissingAny = 0;
  for (const client of clients) {
    let missingAny = false;
    for (const m of markers) {
      const at = client.seen.get(m);
      if (at === undefined) {
        missed++;
        missingAny = true;
      } else deliveries.push(at - publishedAt.get(m)!);
    }
    if (missingAny) streamsMissingAny++;
  }
  for (const client of clients) client.request.destroy();
  agent.destroy();
  await publisher.quit().catch(() => publisher.disconnect());

  const perKind = Object.fromEntries(
    kinds.map((kind) => [
      kind.name,
      { ...summary(latencies.get(kind.name)!), statuses: statuses.get(kind.name) },
    ]),
  );
  const result = {
    config: { api: apiUrl, web: webUp ? webUrl : null, scale, duration, requestRate, streamTarget },
    requests: {
      sent,
      failed,
      dropped,
      errorRate: sent === 0 ? 0 : Math.round((failed / sent) * 10_000) / 10_000,
      perSecond: Math.round((sent / elapsed) * 10) / 10,
      perKindLatencyMs: perKind,
      all: summary([...latencies.values()].flat()),
      p95TargetMs: REQUEST_P95_TARGET_MS,
    },
    streams: {
      asked: streamTarget,
      open: clients.length,
      priceChangesPublished: markers.size,
      deliveriesMissed: missed,
      streamsMissingAChange: streamsMissingAny,
      deliveryLatencyMs: summary(deliveries),
      p95TargetMs: DELIVERY_P95_TARGET_MS,
    },
  };
  console.log(JSON.stringify(result, null, 2));

  if (streamsRefused > 0) failures.push(`${streamsRefused} streams could not be opened`);
  if (clients.length > 0 && markers.size === 0) failures.push('no price change was published');
  if (missed > 0)
    failures.push(`${missed} price changes were not seen (${streamsMissingAny} streams)`);
  if (sent === 0) failures.push('no request was sent');
  if (sent > 0 && failed / sent > maxErrorRate) {
    failures.push(
      `error rate ${((failed / sent) * 100).toFixed(2)}% is above ${maxErrorRate * 100}%`,
    );
  }
  if (dropped > 0) failures.push(`${dropped} requests not sent: the client was saturated`);
  if (failures.length > 0) {
    console.error(`FAILED: ${failures.join('; ')}`);
    process.exitCode = 1;
  } else {
    console.log(
      `OK: ${sent} requests (p95 ${result.requests.all.p95} ms), ${clients.length} streams each saw ` +
        `${markers.size} price changes (p95 ${result.streams.deliveryLatencyMs.p95} ms)`,
    );
  }
}

await main();
