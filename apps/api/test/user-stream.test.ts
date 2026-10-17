import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import fastifyCookie from '@fastify/cookie';
import {
  SessionResponse,
  userChannel,
  USER_CHANNEL_PREFIX,
  type UserMessage,
} from '@vamos/contracts';
import Fastify, { type FastifyInstance } from 'fastify';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import userStreamRoutes, {
  MAX_STREAMS_PER_USER,
  SESSION_RECHECK_MS,
  userHubOf,
} from '../src/modules/stream/routes';
import { sessionPlugin } from '../src/plugins/session';
import {
  createTestContext,
  post,
  registerAndLogin,
  type LoggedInUser,
  type TestContext,
} from './helpers';
import { openStream, sleep, until, type Frame, type SseClient } from './sse';

const REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6379';
const bearer = (user: LoggedInUser) => ({ authorization: `Bearer ${user.sessionToken}` });

const settled = (betId: string, net = '1500'): UserMessage => ({
  type: 'bet.settled',
  data: {
    betId,
    shortId: 'AB12CD34',
    status: 'won',
    gross: '2000',
    tax: '500',
    net,
    corrected: false,
  },
});

const wallet = (cash: string): UserMessage => ({
  type: 'wallet.changed',
  data: { cash, bonus: '0' },
});

/** Frames carrying a player message (not comments, heartbeats or resyncs). */
const messages = (frames: Frame[]) =>
  frames.filter(
    (frame) => frame.data !== undefined && frame.event !== 'ping' && frame.event !== 'resync',
  );

/** Resolves with `promise`, or fails after `ms`. */
async function within<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`timed out waiting for ${what}`)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

describe('GET /me/stream', () => {
  let ctx: TestContext;
  let baseUrl: string;
  let publisher: Redis;
  const clients: SseClient[] = [];

  async function connect(headers: Record<string, string>) {
    const client = await openStream(baseUrl, '/me/stream', headers);
    clients.push(client);
    return client;
  }

  /** On this app's own channel prefix: tests never publish on the shared `vamos:user:`. */
  async function publishTo(userId: string, message: UserMessage | string) {
    await publisher.publish(
      userChannel(userId, ctx.deps.userChannelPrefix),
      typeof message === 'string' ? message : JSON.stringify(message),
    );
  }

  beforeAll(async () => {
    ctx = await createTestContext();
    await ctx.app.listen({ port: 0, host: '127.0.0.1' });
    const { port } = ctx.app.server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${port}`;
    publisher = new Redis(REDIS_URL);
  });

  afterAll(async () => {
    for (const client of clients) client.close();
    await publisher?.quit();
    if (ctx === undefined) return;
    const hub = userHubOf(ctx.app);
    await until(() => (hub?.listenerCount ?? 0) === 0, 3_000, 'listeners to be removed');
    ctx.app.server.closeAllConnections();
    await ctx.close();
  });

  it('relays its own prefix, never the shared one in tests (regression)', () => {
    expect(ctx.deps.userChannelPrefix).toMatch(/^vamos-test:[0-9a-f]+:user:$/);
    expect(userHubOf(ctx.app)?.prefix).toBe(ctx.deps.userChannelPrefix);
    expect(userHubOf(ctx.app)?.prefix).not.toBe(USER_CHANNEL_PREFIX);
  });

  it('requires a session (401)', async () => {
    const response = await ctx.app.inject({ method: 'GET', url: '/me/stream' });
    expect(response.statusCode).toBe(401);
    const forged = await ctx.app.inject({
      method: 'GET',
      url: '/me/stream',
      headers: { authorization: 'Bearer not-a-session' },
    });
    expect(forged.statusCode).toBe(401);
  });

  it("delivers each player's messages to that player only (cookie or bearer)", async () => {
    const alice = await registerAndLogin(ctx);
    const bob = await registerAndLogin(ctx);
    const aliceStream = await connect(bearer(alice));
    // A cookie session needs no CSRF token on this GET (EventSource cannot send headers).
    const bobStream = await connect({ cookie: bob.cookie });
    const aliceTab = await connect(bearer(alice));
    for (const stream of [aliceStream, bobStream, aliceTab]) {
      expect(stream.status).toBe(200);
      expect(stream.headers.get('content-type')).toBe('text/event-stream');
      expect(stream.headers.get('cache-control')).toBe('no-store');
      await stream.waitFor((frames) => frames.length > 0);
      expect(stream.frames[0]).toMatchObject({ retry: 3000, comments: ['connected'] });
    }
    const hub = userHubOf(ctx.app)!;
    expect(hub.listenersOf(alice.userId)).toBe(2);
    expect(hub.listenersOf(bob.userId)).toBe(1);

    const aliceBet = randomUUID();
    const bobBet = randomUUID();
    await publishTo(alice.userId, settled(aliceBet));
    await publishTo(bob.userId, settled(bobBet, '700'));
    await publishTo(randomUUID(), settled(randomUUID()));
    // Malformed messages on a player's channel are dropped.
    await publishTo(alice.userId, 'not json');
    await publishTo(alice.userId, JSON.stringify({ type: 'bet.settled', data: { betId: 'x' } }));
    await publishTo(alice.userId, JSON.stringify({ type: 'casino.win', data: {} }));
    // Not a player channel: userChannel always writes the id in lower case.
    await publisher.publish(
      `${ctx.deps.userChannelPrefix}${alice.userId.toUpperCase()}`,
      JSON.stringify(wallet('1')),
    );
    // A channel outside this app's prefix never reaches a stream.
    await publisher.publish(`vamos:user:${alice.userId}`, JSON.stringify(wallet('2')));
    await publishTo(alice.userId, wallet('123456'));

    for (const stream of [aliceStream, aliceTab]) {
      await stream.waitFor((frames) =>
        messages(frames).some((frame) => frame.event === 'wallet.changed'),
      );
      expect(messages(stream.frames).map((f) => [f.event, JSON.parse(f.data!) as unknown])).toEqual(
        [
          ['bet.settled', settled(aliceBet).data],
          ['wallet.changed', wallet('123456').data],
        ],
      );
    }
    await bobStream.waitFor((frames) => messages(frames).length >= 1);
    await sleep(100);
    expect(
      messages(bobStream.frames).map((f) => [f.event, JSON.parse(f.data!) as unknown]),
    ).toEqual([['bet.settled', settled(bobBet, '700').data]]);

    for (const client of clients.splice(0)) client.close();
    await until(() => hub.listenerCount === 0, 3_000, 'listeners to be removed');
  });

  it('keeps at most MAX_STREAMS_PER_USER streams per player: a new one ends the oldest', async () => {
    // A stream whose client vanished without a FIN (a dead mobile link) stays open on the
    // server for many minutes; it must not lock the player's reconnect out (no 429).
    const user = await registerAndLogin(ctx);
    const open: SseClient[] = [];
    for (let i = 0; i < MAX_STREAMS_PER_USER; i++) open.push(await connect(bearer(user)));
    for (const stream of open) expect(stream.status).toBe(200);
    const hub = userHubOf(ctx.app)!;
    await until(() => hub.listenersOf(user.userId) === MAX_STREAMS_PER_USER);

    const newest = await connect(bearer(user));
    expect(newest.status).toBe(200);
    await within(open[0]!.ended, 3_000, 'the oldest stream to end');
    await until(() => hub.listenersOf(user.userId) === MAX_STREAMS_PER_USER);
    await publishTo(user.userId, wallet('5'));
    for (const stream of [...open.slice(1), newest]) {
      await stream.waitFor((frames) => messages(frames).length === 1);
    }
    expect(messages(open[0]!.frames)).toEqual([]);
    for (const client of clients.splice(0)) client.close();
    await until(() => hub.listenerCount === 0, 3_000, 'listeners to be removed');
  });

  it('ends a stream as soon as its session is revoked, not at the next periodic check', async () => {
    const alice = await registerAndLogin(ctx);
    const login = await post(ctx, '/auth/login', { phone: alice.phone, password: alice.password });
    expect(login.statusCode).toBe(200);
    const second = SessionResponse.parse(login.json());
    const bob = await registerAndLogin(ctx);
    const first = await connect(bearer(alice));
    const other = await connect({ authorization: `Bearer ${second.sessionToken}` });
    const bobs = await connect(bearer(bob));
    for (const stream of [first, other, bobs]) await stream.waitFor((f) => f.length > 0);
    const hub = userHubOf(ctx.app)!;
    await until(() => hub.listenersOf(alice.userId) === 2 && hub.listenersOf(bob.userId) === 1);
    const started = Date.now();

    // Logging out ends that session's stream only.
    const logout = await ctx.app.inject({
      method: 'POST',
      url: '/auth/logout',
      headers: bearer(alice),
    });
    expect(logout.statusCode).toBe(200);
    await within(first.ended, 2_000, 'the logged-out stream to end');
    await until(() => hub.listenersOf(alice.userId) === 1, 2_000, 'one stream of alice');

    // Self-exclusion revokes every session of the player: the other stream ends too.
    const excluded = await ctx.app.inject({
      method: 'POST',
      url: '/me/exclusions',
      payload: { kind: 'self_exclusion', duration: '6m' },
      headers: { authorization: `Bearer ${second.sessionToken}` },
    });
    expect(excluded.statusCode).toBe(201);
    await within(other.ended, 2_000, 'the excluded player’s stream to end');
    await until(() => hub.listenersOf(alice.userId) === 0, 2_000, 'no stream of alice');
    expect(Date.now() - started).toBeLessThan(SESSION_RECHECK_MS);

    // Another player's stream is not touched.
    expect(hub.listenersOf(bob.userId)).toBe(1);
    await publishTo(bob.userId, wallet('8'));
    await bobs.waitFor((frames) => messages(frames).length === 1);
    for (const client of clients.splice(0)) client.close();
    await until(() => hub.listenerCount === 0, 3_000, 'listeners to be removed');
  });

  it('tells open streams to resync once the Redis subscriber has reconnected', async () => {
    const user = await registerAndLogin(ctx);
    const stream = await connect(bearer(user));
    await stream.waitFor((frames) => frames.length > 0);
    const hub = userHubOf(ctx.app)!;

    // Kill this app's subscriber connection only (other test files share the Redis server).
    const admin = new Redis(REDIS_URL);
    try {
      const list = (await admin.call('CLIENT', 'LIST', 'TYPE', 'pubsub')) as string;
      const ids = list
        .split('\n')
        .filter((line) => line.includes(` name=${hub.connectionName} `))
        .map((line) => /\bid=(\d+)/.exec(line)?.[1]);
      expect(ids).toHaveLength(1);
      await admin.call('CLIENT', 'KILL', 'ID', ids[0]!);
    } finally {
      await admin.quit();
    }

    // Pushes published while it was away are lost: the client is told to re-fetch.
    await stream.waitFor((frames) => frames.some((f) => f.event === 'resync'), 10_000);
    expect(stream.frames.find((f) => f.event === 'resync')?.data).toBe('{}');
    // Subscribed again: pushes reach the stream.
    await publishTo(user.userId, wallet('77'));
    await stream.waitFor((frames) => messages(frames).length === 1);
    expect(messages(stream.frames)[0]).toMatchObject({ event: 'wallet.changed' });
    for (const client of clients.splice(0)) client.close();
    await until(() => hub.listenerCount === 0, 3_000, 'listeners to be removed');
  });
});

describe('user stream lifecycle', () => {
  let ctx: TestContext;
  let app: FastifyInstance | undefined;

  beforeAll(async () => {
    ctx = await createTestContext();
  });

  afterAll(async () => {
    await app?.close();
    await ctx?.close();
  });

  it('sends heartbeats, ends the stream after log out, and closes with the app', async () => {
    const prefix = `${ctx.deps.userChannelPrefix}lifecycle:`;
    app = Fastify({ logger: false });
    app.decorate('deps', ctx.deps);
    await app.register(fastifyCookie);
    await app.register(sessionPlugin);
    await app.register(userStreamRoutes, {
      channelPrefix: prefix,
      heartbeatMs: 50,
      sessionRecheckMs: 50,
    });
    await app.listen({ port: 0, host: '127.0.0.1' });
    const { port } = app.server.address() as AddressInfo;
    const url = `http://127.0.0.1:${port}`;
    const hub = userHubOf(app)!;
    expect(hub.prefix).toBe(prefix);

    const leaving = await registerAndLogin(ctx);
    const staying = await registerAndLogin(ctx);
    const ends = await openStream(url, '/me/stream', bearer(leaving));
    const stays = await openStream(url, '/me/stream', bearer(staying));
    // A named event (not a comment), so a client can tell a stalled stream from a quiet one.
    await ends.waitFor(
      (frames) => frames.filter((f) => f.event === 'ping' && f.data === '{}').length >= 2,
    );

    const publisher = new Redis(REDIS_URL);
    try {
      await publisher.publish(userChannel(staying.userId, prefix), JSON.stringify(wallet('9')));
      await stays.waitFor((frames) => messages(frames).length === 1);
    } finally {
      await publisher.quit();
    }

    // Logging out (on the main app) revokes the session: the open stream ends.
    const logout = await ctx.app.inject({
      method: 'POST',
      url: '/auth/logout',
      headers: bearer(leaving),
    });
    expect(logout.statusCode).toBe(200);
    await ends.ended;
    await until(() => hub.listenersOf(leaving.userId) === 0, 3_000, 'the listener to go');
    expect(hub.listenersOf(staying.userId)).toBe(1);
    const reconnect = await openStream(url, '/me/stream', bearer(leaving));
    expect(reconnect.status).toBe(401);

    const started = Date.now();
    await app.close();
    expect(Date.now() - started).toBeLessThan(2_000);
    await stays.ended;
    expect(hub.connected).toBe(false);
    expect(hub.listenerCount).toBe(0);
    expect(userHubOf(app)).toBeUndefined();
    app = undefined;
  });
});
