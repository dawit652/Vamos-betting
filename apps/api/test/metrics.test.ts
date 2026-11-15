import { randomBytes } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { paymentIntents, payoutAccounts, payouts } from '@vamos/db/schema';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { BUSINESS_CACHE_MS, birrLabel, CLAIMED_IDLE_MS } from '../src/plugins/metrics';
import { createTestContext, registerAndLogin, type TestContext } from './helpers';
import { openStream } from './sse';

const TOKEN = randomBytes(24).toString('hex');
const AUTH = { authorization: `Bearer ${TOKEN}` };

interface Sample {
  name: string;
  labels: Record<string, string>;
  value: number;
}

/** Parses an exposition body, checking its shape: every sample follows its HELP and TYPE lines. */
function parseExposition(body: string): { samples: Sample[]; types: Map<string, string> } {
  expect(body.endsWith('\n')).toBe(true);
  const types = new Map<string, string>();
  const helped = new Set<string>();
  const samples: Sample[] = [];
  for (const line of body.trimEnd().split('\n')) {
    const help = /^# HELP ([a-zA-Z_:][a-zA-Z0-9_:]*) .+$/.exec(line);
    if (help) {
      helped.add(help[1]!);
      continue;
    }
    const type = /^# TYPE ([a-zA-Z_:][a-zA-Z0-9_:]*) (counter|gauge|histogram)$/.exec(line);
    if (type) {
      expect(helped.has(type[1]!)).toBe(true);
      types.set(type[1]!, type[2]!);
      continue;
    }
    const sample = /^([a-zA-Z_:][a-zA-Z0-9_:]*)(?:\{(.*)\})? (\S+)$/.exec(line);
    expect(sample, `not a sample line: ${line}`).not.toBeNull();
    const labels: Record<string, string> = {};
    for (const pair of (sample![2] ?? '').matchAll(
      /([a-zA-Z_][a-zA-Z0-9_]*)="((?:[^"\\]|\\.)*)"/g,
    )) {
      labels[pair[1]!] = pair[2]!;
    }
    // A histogram's samples carry the family name plus a suffix.
    const family = sample![1]!.replace(/_(bucket|sum|count)$/, '');
    expect(types.has(sample![1]!) || types.get(family) === 'histogram').toBe(true);
    samples.push({
      name: sample![1]!,
      labels,
      value: sample![3] === '+Inf' ? Infinity : Number(sample![3]),
    });
  }
  return { samples, types };
}

function find(samples: Sample[], name: string, labels: Record<string, string> = {}): Sample[] {
  return samples.filter(
    (s) => s.name === name && Object.entries(labels).every(([k, v]) => s.labels[k] === v),
  );
}

describe('GET /metrics without METRICS_TOKEN', () => {
  let ctx: TestContext;
  beforeAll(async () => {
    ctx = await createTestContext();
  });
  afterAll(async () => {
    await ctx.close();
  });

  it('answers 404 as if the route did not exist, even with a token', async () => {
    const plain = await ctx.app.inject({ method: 'GET', url: '/metrics' });
    const withToken = await ctx.app.inject({ method: 'GET', url: '/metrics', headers: AUTH });
    expect(plain.statusCode).toBe(404);
    expect(withToken.statusCode).toBe(404);
    expect(plain.json()).toMatchObject({ error: { code: 'not_found' } });
  });
});

describe('GET /metrics', () => {
  let ctx: TestContext;
  let baseUrl: string;
  const scrape = () => ctx.app.inject({ method: 'GET', url: '/metrics', headers: AUTH });

  beforeAll(async () => {
    ctx = await createTestContext({ METRICS_TOKEN: TOKEN });
    await ctx.app.listen({ port: 0, host: '127.0.0.1' });
    baseUrl = `http://127.0.0.1:${(ctx.app.server.address() as AddressInfo).port}`;
  });
  afterAll(async () => {
    await ctx.close();
  });

  it('refuses a missing or wrong token with 401', async () => {
    const missing = await ctx.app.inject({ method: 'GET', url: '/metrics' });
    expect(missing.statusCode).toBe(401);
    expect(missing.headers['www-authenticate']).toBe('Bearer');
    for (const authorization of [
      `Bearer ${TOKEN}x`,
      `Bearer ${TOKEN.slice(1)}`,
      'Bearer ',
      `Basic ${TOKEN}`,
      TOKEN,
    ]) {
      const response = await ctx.app.inject({
        method: 'GET',
        url: '/metrics',
        headers: { authorization },
      });
      expect(response.statusCode).toBe(401);
      expect(response.body).not.toContain(TOKEN);
    }
  });

  it('answers 200 in the Prometheus text format with the right token', async () => {
    const response = await scrape();
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toBe('text/plain; version=0.0.4; charset=utf-8');
    const { samples, types } = parseExposition(response.body);
    expect(types.get('http_requests_total')).toBe('counter');
    expect(types.get('http_request_duration_seconds')).toBe('histogram');
    expect(types.get('db_pool_connections')).toBe('gauge');
    for (const state of ['total', 'idle', 'waiting']) {
      expect(find(samples, 'db_pool_connections', { state })).toHaveLength(1);
    }
    expect(find(samples, 'nodejs_eventloop_delay_seconds', { quantile: '0.5' })).toHaveLength(1);
    expect(find(samples, 'nodejs_eventloop_delay_seconds', { quantile: '0.99' })).toHaveLength(1);
    expect(find(samples, 'process_resident_memory_bytes')[0]!.value).toBeGreaterThan(0);
    expect(find(samples, 'nodejs_heap_used_bytes')[0]!.value).toBeGreaterThan(0);
    expect(find(samples, 'sse_open_streams', { stream: 'live' })).toHaveLength(1);
    expect(find(samples, 'sse_open_streams', { stream: 'me' })).toHaveLength(1);
  });

  it('labels requests by route template and status class, with cumulative buckets', async () => {
    const id = '5c1f7a9e-0000-4000-8000-000000000001';
    await ctx.app.inject({ method: 'GET', url: '/health' });
    await ctx.app.inject({ method: 'GET', url: `/events/${id}` });
    await ctx.app.inject({ method: 'GET', url: '/events/6d2e8b0f-0000-4000-8000-000000000002' });
    await ctx.app.inject({ method: 'GET', url: '/no/such/route/12345' });
    const { samples } = parseExposition((await scrape()).body);

    const routes = new Set(find(samples, 'http_requests_total').map((s) => s.labels.route));
    expect(routes.has('/health')).toBe(true);
    expect(routes.has('/events/:id')).toBe(true);
    expect(routes.has('unmatched')).toBe(true);
    // Ids and unknown paths never become labels, and the scraper does not count itself.
    for (const route of routes) {
      expect(route).not.toContain(id);
      expect(route).not.toContain('12345');
    }
    expect(routes.has('/metrics')).toBe(false);
    expect(
      find(samples, 'http_requests_total', { route: '/events/:id' }).reduce(
        (n, s) => n + s.value,
        0,
      ),
    ).toBe(2);
    expect(
      find(samples, 'http_requests_total', { route: '/health', status: '2xx' })[0]!.value,
    ).toBe(1);
    expect(
      find(samples, 'http_requests_total', { route: 'unmatched', status: '4xx' })[0]!.value,
    ).toBe(1);

    const buckets = find(samples, 'http_request_duration_seconds_bucket', { route: '/health' });
    expect(buckets.map((b) => b.labels.le)).toEqual([
      '0.005',
      '0.01',
      '0.025',
      '0.05',
      '0.1',
      '0.25',
      '0.5',
      '1',
      '2.5',
      '5',
      '10',
      '+Inf',
    ]);
    for (let i = 1; i < buckets.length; i += 1) {
      expect(buckets[i]!.value).toBeGreaterThanOrEqual(buckets[i - 1]!.value);
    }
    const count = find(samples, 'http_request_duration_seconds_count', { route: '/health' })[0]!;
    expect(buckets.at(-1)!.value).toBe(count.value);
    expect(count.value).toBe(1);
    expect(
      find(samples, 'http_request_duration_seconds_sum', { route: '/health' })[0]!.value,
    ).toBeGreaterThan(0);
  });

  it('counts the open live and player streams', async () => {
    const player = await registerAndLogin(ctx);
    const live = await openStream(baseUrl, '/live/stream');
    const me = await openStream(baseUrl, '/me/stream', { cookie: player.cookie });
    try {
      expect(live.status).toBe(200);
      expect(me.status).toBe(200);
      const open = async (stream: string) =>
        find(parseExposition((await scrape()).body).samples, 'sse_open_streams', { stream })[0]!
          .value;
      expect(await open('live')).toBe(1);
      expect(await open('me')).toBe(1);
    } finally {
      live.close();
      me.close();
    }
    await vi.waitFor(async () => {
      const { samples } = parseExposition((await scrape()).body);
      expect(find(samples, 'sse_open_streams', { stream: 'live' })[0]!.value).toBe(0);
      expect(find(samples, 'sse_open_streams', { stream: 'me' })[0]!.value).toBe(0);
    });
  });

  describe('business gauges', () => {
    // Unique among open SMS deposits: base amount + 1..50 santim.
    const seedDeposit = async (
      userId: string,
      base: bigint,
      reference: bigint,
      status: 'created' | 'pending' | 'expired' = 'pending',
    ) => {
      const now = ctx.deps.clock();
      await ctx.db.db.insert(paymentIntents).values({
        userId,
        provider: 'sms',
        amount: base + reference,
        requestedAmount: base,
        phone: '+251911000000',
        status,
        idempotencyKey: randomBytes(8).toString('hex'),
        expiresAt: new Date(now.getTime() + 3_600_000),
        createdAt: now,
        updatedAt: now,
      });
    };
    const gauge = (body: string, name: string, labels: Record<string, string> = {}) =>
      find(parseExposition(body).samples, name, labels)[0]?.value;

    it('reads deposits and payouts, and keeps one result for 15 seconds', async () => {
      // Earlier scrapes of this file left an (empty) result in the cache.
      ctx.clock.advance(BUSINESS_CACHE_MS + 1_000);
      const player = await registerAndLogin(ctx);
      const other = await registerAndLogin(ctx);
      const now = ctx.deps.clock();

      // Three open deposits of 1,000 birr, one of 500 birr and a 250 birr one that already expired.
      await seedDeposit(player.userId, 100_000n, 1n);
      await seedDeposit(player.userId, 100_000n, 2n, 'created');
      await seedDeposit(other.userId, 100_000n, 3n);
      await seedDeposit(other.userId, 50_000n, 4n);
      await seedDeposit(other.userId, 25_000n, 5n, 'expired');

      const [account] = await ctx.db.db
        .insert(payoutAccounts)
        .values({
          userId: player.userId,
          institution: 'telebirr',
          account: player.phone,
          accountName: 'Test Player',
          verifiedAt: now,
          createdAt: now,
          updatedAt: now,
        })
        .returning();
      const manual = (over: Partial<typeof payouts.$inferInsert>): typeof payouts.$inferInsert => ({
        userId: player.userId,
        provider: 'sms',
        amount: 500_00n,
        phone: player.phone,
        recipientName: 'Test Player',
        status: 'approved',
        approvedBy: 'staff-a',
        approvedAt: new Date(now.getTime() - 90_000),
        idempotencyKey: randomBytes(8).toString('hex'),
        holdLedgerTransactionId: '00000000-0000-4000-8000-000000000000',
        manual: true,
        payoutAccountId: account!.id,
        destinationInstitution: 'telebirr',
        destinationAccount: player.phone,
        destinationName: 'Test Player',
        requestedAt: new Date(now.getTime() - 120_000),
        updatedAt: now,
        ...over,
      });
      await ctx.db.db.insert(payouts).values([
        // Approved 90 s ago, nobody has claimed it; a younger one must not hide it.
        manual({}),
        manual({ approvedAt: new Date(now.getTime() - 10_000) }),
        // Claimed 31 minutes ago (idle) and 5 minutes ago (not yet).
        manual({
          status: 'processing',
          payingBy: 'staff-b',
          processingAt: new Date(now.getTime() - CLAIMED_IDLE_MS - 60_000),
        }),
        manual({
          status: 'processing',
          payingBy: 'staff-b',
          processingAt: new Date(now.getTime() - 5 * 60_000),
        }),
        // Waiting for review, and a non-manual approved payout that is not a manual payout.
        manual({ status: 'requested', approvedBy: null, approvedAt: null }),
        manual({
          manual: false,
          provider: 'chapa',
          payoutAccountId: null,
          destinationInstitution: null,
          destinationAccount: null,
          destinationName: null,
        }),
      ]);

      const first = (await scrape()).body;
      expect(gauge(first, 'sms_open_deposits')).toBe(4);
      expect(gauge(first, 'sms_open_deposits_busiest', { base_amount_birr: '1000' })).toBe(3);
      expect(gauge(first, 'sms_open_deposits_busiest', { base_amount_birr: '500' })).toBe(1);
      expect(find(parseExposition(first).samples, 'sms_open_deposits_busiest')).toHaveLength(2);
      expect(gauge(first, 'manual_payout_oldest_approved_seconds')).toBe(90);
      expect(gauge(first, 'manual_payout_claimed_idle')).toBe(1);
      expect(gauge(first, 'withdrawals_awaiting_review')).toBe(1);

      // Inside 15 seconds: the answer is kept, and no query reaches the database.
      await seedDeposit(other.userId, 100_000n, 6n);
      const query = vi.spyOn(ctx.db.pool, 'query');
      // The session hook also looks the bearer token up as a session; count the gauge queries only.
      const gaugeQueries = () =>
        query.mock.calls.filter(([config]) =>
          /"payment_intents"|"payouts"/.test(String((config as { text?: string }).text)),
        ).length;
      try {
        ctx.clock.advance(BUSINESS_CACHE_MS - 1_000);
        const cached = (await scrape()).body;
        expect(gauge(cached, 'sms_open_deposits')).toBe(4);
        expect(gaugeQueries()).toBe(0);

        // One result serves concurrent scrapes too, once it has expired.
        ctx.clock.advance(2_000);
        const bodies = await Promise.all(
          Array.from({ length: 5 }, async () => (await scrape()).body),
        );
        for (const body of bodies) expect(gauge(body, 'sms_open_deposits')).toBe(5);
        expect(gaugeQueries()).toBe(3);
        expect(gauge(bodies[0]!, 'manual_payout_oldest_approved_seconds')).toBe(
          90 + BUSINESS_CACHE_MS / 1000 + 1,
        );
      } finally {
        query.mockRestore();
      }
    });
  });
});

describe('birrLabel', () => {
  it('writes whole birr from santim without floating point', () => {
    expect(birrLabel(100_000n)).toBe('1000');
    expect(birrLabel(0n)).toBe('0');
    expect(birrLabel(1_250n)).toBe('12.50');
    expect(birrLabel(5n)).toBe('0.05');
    expect(birrLabel(9_007_199_254_740_993_00n)).toBe('9007199254740993');
  });
});
