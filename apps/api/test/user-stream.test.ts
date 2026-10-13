import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import fastifyCookie from '@fastify/cookie';
import { userChannel, USER_CHANNEL_PREFIX, type UserMessage } from '@vamos/contracts';
import Fastify, { type FastifyInstance } from 'fastify';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import userStreamRoutes, { MAX_STREAMS_PER_USER, userHubOf } from '../src/modules/stream/routes';
import { sessionPlugin } from '../src/plugins/session';
import {
  createTestContext,
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

/** Frames carrying a message (not comments). */
const messages = (frames: Frame[]) => frames.filter((frame) => frame.data !== undefined);

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

  it('caps the streams of one player (429 too_many_streams)', async () => {
    const user = await registerAndLogin(ctx);
    const open: SseClient[] = [];
    for (let i = 0; i < MAX_STREAMS_PER_USER; i++) open.push(await connect(bearer(user)));
    for (const stream of open) expect(stream.status).toBe(200);
    const hub = userHubOf(ctx.app)!;
    await until(() => hub.listenersOf(user.userId) === MAX_STREAMS_PER_USER);

    const refused = await ctx.app.inject({
      method: 'GET',
      url: '/me/stream',
      headers: bearer(user),
    });
    expect(refused.statusCode).toBe(429);
    expect(refused.json()).toMatchObject({ error: { code: 'too_many_streams' } });

    open[0]!.close();
    await until(() => hub.listenersOf(user.userId) === MAX_STREAMS_PER_USER - 1);
    const again = await connect(bearer(user));
    expect(again.status).toBe(200);
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
    await ends.waitFor((frames) => frames.filter((f) => f.comments.includes('ping')).length >= 2);

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
