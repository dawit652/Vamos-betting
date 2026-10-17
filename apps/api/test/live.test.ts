import { randomBytes, randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { LIVE_CHANNEL, type LiveMessage } from '@vamos/contracts';
import Fastify, { type FastifyInstance } from 'fastify';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import liveRoutes, { liveHubOf, MAX_FILTER_EVENTS } from '../src/modules/catalog/live';
import { createTestContext, type TestContext } from './helpers';
import { openStream, until, type Frame, type SseClient } from './sse';

const oddsMessage = (eventId: string, selectionId: string, odds: number): LiveMessage => ({
  type: 'odds',
  eventId,
  data: { s: selectionId, o: odds, st: 'open' },
});

/** Frames carrying deltas (not comments), restricted to the given marker strings. */
function dataFrames(frames: Frame[], ...markers: string[]): Frame[] {
  return frames.filter(
    (frame) => frame.data !== undefined && markers.some((m) => frame.data!.includes(m)),
  );
}

describe('GET /live/stream', () => {
  let ctx: TestContext;
  let baseUrl: string;
  let publisher: Redis;
  const clients: SseClient[] = [];

  async function connect(path?: string) {
    const client = await openStream(baseUrl, path);
    clients.push(client);
    return client;
  }

  /** This app's own channel: tests never publish on the shared LIVE_CHANNEL. */
  async function publish(message: LiveMessage | string) {
    await publisher.publish(
      ctx.deps.liveChannel!,
      typeof message === 'string' ? message : JSON.stringify(message),
    );
  }

  beforeAll(async () => {
    ctx = await createTestContext();
    await ctx.app.listen({ port: 0, host: '127.0.0.1' });
    const { port } = ctx.app.server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${port}`;
    publisher = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379');
  });

  afterAll(async () => {
    for (const client of clients) client.close();
    await publisher?.quit();
    if (ctx === undefined) return;
    const hub = liveHubOf(ctx.app);
    await until(() => (hub?.listenerCount ?? 0) === 0, 3_000, 'listeners to be removed');
    // Node's fetch opens a spare connection when a request is aborted. It never
    // sends a request, so server.close() would wait for the headers timeout.
    ctx.app.server.closeAllConnections();
    await ctx.close();
  });

  it('relays the channel of its dependencies, never the shared one in tests (regression)', () => {
    const hub = liveHubOf(ctx.app);
    expect(ctx.deps.liveChannel).toMatch(/^vamos-test:[0-9a-f]+:live$/);
    expect(hub?.channel).toBe(ctx.deps.liveChannel);
    expect(hub?.channel).not.toBe(LIVE_CHANNEL);
  });

  it('opens one shared subscriber lazily and streams with SSE headers', async () => {
    const hub = liveHubOf(ctx.app);
    expect(hub).toBeDefined();
    expect(hub!.connected).toBe(false);
    const duplicate = vi.spyOn(ctx.redis, 'duplicate');
    try {
      const streams = await Promise.all([connect(), connect(), connect()]);
      for (const stream of streams) {
        expect(stream.status).toBe(200);
        expect(stream.headers.get('content-type')).toBe('text/event-stream');
        expect(stream.headers.get('cache-control')).toBe('no-cache');
        expect(stream.headers.get('x-accel-buffering')).toBe('no');
        await stream.waitFor((frames) => frames.length > 0);
        expect(stream.frames[0]).toMatchObject({ retry: 3000, comments: ['connected'] });
      }
      expect(duplicate).toHaveBeenCalledTimes(1);
      expect(hub!.connected).toBe(true);
      expect(hub!.listenerCount).toBe(3);
    } finally {
      duplicate.mockRestore();
      for (const client of clients.splice(0)) client.close();
      await until(() => hub!.listenerCount === 0, 3_000, 'listeners to be removed');
    }
  });

  it('relays every message type as `event: <type>` with the delta as data', async () => {
    const stream = await connect();
    const eventId = randomUUID();
    const selectionId = randomUUID();
    const marketId = randomUUID();
    const messages: LiveMessage[] = [
      oddsMessage(eventId, selectionId, 1850),
      {
        type: 'match',
        eventId,
        data: { e: eventId, m: 67, p: '2H', sc: [2, 1], st: 'live', b: true },
      },
      { type: 'market', eventId, data: { k: marketId, st: 'suspended' } },
    ];
    for (const message of messages) await publish(message);

    await stream.waitFor(
      (frames) => dataFrames(frames, eventId, marketId, selectionId).length >= 3,
    );
    const relayed = dataFrames(stream.frames, eventId, marketId, selectionId);
    expect(relayed.map((frame) => [frame.event, JSON.parse(frame.data!) as unknown])).toEqual(
      messages.map((message) => [message.type, message.data]),
    );
    expect(relayed[0]?.data).toBe(`{"s":"${selectionId}","o":1850,"st":"open"}`);
    stream.close();
  });

  it('filters by ?events= (case-insensitive) and drops malformed messages', async () => {
    const wanted = randomUUID();
    const other = randomUUID();
    const third = randomUUID();
    const stream = await connect(`/live/stream?events=${wanted.toUpperCase()},%20${third}`);
    const all = await connect();
    expect(stream.status).toBe(200);

    await publish(oddsMessage(other, 'sel-other', 2000));
    await publish('not json at all');
    await publish(JSON.stringify({ type: 'odds', eventId: wanted, data: { s: 'sel-bad' } }));
    await publish(JSON.stringify({ type: 'goal', eventId: wanted, data: {} }));
    await publish(oddsMessage(wanted, 'sel-wanted', 2100));
    await publish(oddsMessage(third, 'sel-third', 2200));

    await stream.waitFor((frames) => dataFrames(frames, 'sel-third').length === 1);
    // Messages on one channel arrive in order: anything unwanted would already be here.
    expect(
      dataFrames(stream.frames, 'sel-').map(
        (frame) => (JSON.parse(frame.data!) as { s: string }).s,
      ),
    ).toEqual(['sel-wanted', 'sel-third']);
    await all.waitFor((frames) => dataFrames(frames, 'sel-third').length === 1);
    expect(
      dataFrames(all.frames, 'sel-').map((frame) => (JSON.parse(frame.data!) as { s: string }).s),
    ).toEqual(['sel-other', 'sel-wanted', 'sel-third']);
    stream.close();
    all.close();
  });

  it('rejects malformed or oversized event filters', async () => {
    const tooMany = Array.from({ length: MAX_FILTER_EVENTS + 1 }, () => randomUUID()).join(',');
    for (const query of [`events=${tooMany}`, 'events=not-an-id', `events=${'a'.repeat(5000)}`]) {
      const response = await ctx.app.inject({ method: 'GET', url: `/live/stream?${query}` });
      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({ error: { code: 'validation_error' } });
    }
    const exactly = Array.from({ length: MAX_FILTER_EVENTS }, () => randomUUID()).join(',');
    const stream = await connect(`/live/stream?events=${exactly}`);
    expect(stream.status).toBe(200);
    stream.close();
  });

  it('removes the listener when the client disconnects', async () => {
    const hub = liveHubOf(ctx.app)!;
    await until(() => hub.listenerCount === 0, 3_000, 'earlier streams to close');
    const first = await connect();
    const second = await connect();
    await until(() => hub.listenerCount === 2, 3_000, 'two listeners');

    first.close();
    await until(() => hub.listenerCount === 1, 3_000, 'the listener to be removed');

    // The remaining client still receives updates.
    const eventId = randomUUID();
    await publish(oddsMessage(eventId, 'sel-after-disconnect', 1500));
    await second.waitFor((frames) => dataFrames(frames, 'sel-after-disconnect').length === 1);
    second.close();
    await until(() => hub.listenerCount === 0, 3_000, 'all listeners to be removed');
  });
});

describe('live stream lifecycle', () => {
  let ctx: TestContext;
  let app: FastifyInstance | undefined;

  beforeAll(async () => {
    ctx = await createTestContext();
  });

  afterAll(async () => {
    await app?.close();
    await ctx?.close();
  });

  it('sends heartbeats, and closing the app ends streams and the subscriber', async () => {
    const channel = `vamos-test:live:${randomBytes(6).toString('hex')}`;
    app = Fastify({ logger: false });
    app.decorate('deps', ctx.deps);
    await app.register(liveRoutes, { channel, heartbeatMs: 50 });
    await app.listen({ port: 0, host: '127.0.0.1' });
    const { port } = app.server.address() as AddressInfo;
    const hub = liveHubOf(app)!;
    expect(hub.channel).toBe(channel);

    const stream = await openStream(`http://127.0.0.1:${port}`);
    // A named event (not a comment), so a client can tell a stalled stream from a quiet one.
    await stream.waitFor(
      (frames) => frames.filter((f) => f.event === 'ping' && f.data === '{}').length >= 2,
    );

    // A message on this app's own channel reaches the client.
    const publisher = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379');
    try {
      await publisher.publish(channel, JSON.stringify(oddsMessage(randomUUID(), 'sel-own', 1700)));
      await stream.waitFor((frames) => dataFrames(frames, 'sel-own').length === 1);
    } finally {
      await publisher.quit();
    }

    const started = Date.now();
    await app.close();
    expect(Date.now() - started).toBeLessThan(2_000);
    await stream.ended;
    expect(hub.connected).toBe(false);
    expect(hub.listenerCount).toBe(0);
    expect(liveHubOf(app)).toBeUndefined();
    app = undefined;
  });
});
