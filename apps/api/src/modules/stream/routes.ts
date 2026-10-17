import { PassThrough } from 'node:stream';
import {
  USER_CHANNEL_PREFIX,
  UserMessage,
  userChannelPattern,
  userIdOfChannel,
} from '@vamos/contracts';
import type { FastifyBaseLogger, FastifyInstance, FastifyPluginAsync } from 'fastify';
import type { Redis } from 'ioredis';
import { serviceUnavailable } from '../../lib/errors';
import { isSessionActive, requireUser } from '../../plugins/session';
import { HEARTBEAT_MS, MAX_BUFFERED_BYTES, PING_FRAME, RETRY_MS } from '../catalog/live';
import { sessionRevokedOf } from './control';

/**
 * GET /me/stream: the player's own push channel (Phase 7) as Server-Sent
 * Events. The worker publishes UserMessage envelopes (bet accepted /
 * rejected / settled / cashed out / reopened, wallet changed) on the Redis
 * channel `vamos:user:<userId>` once the change has committed; this relays
 * the authenticated player's channel, and only that one, as
 * `event: <type>` with the message's `data` as JSON (the framing of
 * /live/stream).
 *
 * - Authentication: the session cookie or a bearer token (requireAuth). A
 *   GET needs no CSRF token. When a session is revoked (log out; every
 *   session on a password reset, self-exclusion or suspension) the API
 *   announces it on the player's channel (announceSessionRevoked, after
 *   COMMIT) and every instance ends the matching streams at once; the
 *   client's reconnect gets a 401. As a backstop (a lost announcement, an
 *   expired session, an account closed elsewhere) the session is also
 *   checked every SESSION_RECHECK_MS.
 * - One shared PSUBSCRIBE on `vamos:user:*` per app instance (a duplicate of
 *   the app's Redis client, opened with the first stream) fans messages out
 *   by the user id in the channel name. Messages that do not parse as a
 *   UserMessage (or the API's session.revoked control) are dropped.
 * - Pub/sub has no replay: when that connection was lost, whatever was
 *   published meanwhile is gone. Once it is subscribed again every open
 *   stream gets `event: resync` (RESYNC_FRAME), and clients re-fetch what
 *   they show, as after a reconnect of their own.
 * - Heartbeats and back-pressure as /live/stream: a `ping` event every
 *   HEARTBEAT_MS (clients reconnect when nothing arrives for a few); a
 *   client more than MAX_BUFFERED_BYTES behind is disconnected.
 * - At most MAX_STREAMS_PER_USER streams per player per instance: a new
 *   stream ends the player's oldest. (A client that vanished without
 *   closing its connection, as on a dropped mobile link, leaves a stream the
 *   server cannot tell from a quiet one for many minutes; it must not lock
 *   the player's reconnect out.)
 */

/** How often an open stream re-checks its session (the backstop of announceSessionRevoked). */
export const SESSION_RECHECK_MS = 30_000;
/** Open streams one player may hold on one API instance (tabs, devices). */
export const MAX_STREAMS_PER_USER = 5;
/** Sent to every open stream after the Redis subscriber reconnected: re-fetch, pushes were lost. */
export const RESYNC_FRAME = 'event: resync\ndata: {}\n\n';

/** The SSE frame of a player message: `event: <type>\ndata: <data json>\n\n`. */
export function userFrame(message: UserMessage): string {
  return `event: ${message.type}\ndata: ${JSON.stringify(message.data)}\n\n`;
}

export interface UserListener {
  /** The session the stream was opened with. */
  sessionId: string;
  send(frame: string): void;
  /** Ends the stream cleanly (its session was revoked). */
  end(): void;
  /** Cuts the stream off at once (it made room for a newer one). */
  drop(): void;
}

/**
 * Fans the player channels out to the connected streams: one PSUBSCRIBE on
 * every channel under `prefix`, each message delivered to the listeners of
 * the user its channel names.
 */
export class UserHub {
  private subscriber: Redis | null = null;
  private ready: Promise<void> | null = null;
  private closed = false;
  /** The subscriber connection was lost since it last subscribed. */
  private lost = false;
  private readonly listeners = new Map<string, Set<UserListener>>();
  /** CLIENT SETNAME of the subscriber connection (diagnostics; tests find it by this name). */
  readonly connectionName: string;

  constructor(
    private readonly redis: Redis,
    private readonly log: Pick<FastifyBaseLogger, 'warn' | 'error'>,
    readonly prefix: string = USER_CHANNEL_PREFIX,
  ) {
    // Throws for a prefix that is not a plain channel prefix (no glob characters).
    userChannelPattern(prefix);
    this.connectionName = `user-hub:${prefix}`;
  }

  /** Listeners of every user. */
  get listenerCount(): number {
    let count = 0;
    for (const set of this.listeners.values()) count += set.size;
    return count;
  }

  /** Listeners of one user. */
  listenersOf(userId: string): number {
    return this.listeners.get(userId.toLowerCase())?.size ?? 0;
  }

  /** Whether the shared subscriber connection has been created. */
  get connected(): boolean {
    return this.subscriber !== null;
  }

  /**
   * Adds a listener for `userId` once the pattern is subscribed, first
   * dropping the user's oldest listeners so at most `max` remain; returns its
   * removal function.
   */
  async add(
    userId: string,
    listener: UserListener,
    max: number = Number.POSITIVE_INFINITY,
  ): Promise<() => void> {
    await this.connect();
    if (this.closed) throw new Error('the user hub is closed');
    const key = userId.toLowerCase();
    let set = this.listeners.get(key);
    if (set === undefined) {
      set = new Set();
      this.listeners.set(key, set);
    }
    // A Set iterates in insertion order: the oldest first.
    for (const oldest of set) {
      if (set.size < max) break;
      set.delete(oldest);
      oldest.drop();
    }
    set.add(listener);
    return () => {
      const current = this.listeners.get(key);
      if (current === undefined) return;
      current.delete(listener);
      if (current.size === 0) this.listeners.delete(key);
    };
  }

  private connect(): Promise<void> {
    if (this.closed) return Promise.reject(new Error('the user hub is closed'));
    this.ready ??= this.open().catch((error: unknown) => {
      this.ready = null;
      throw error;
    });
    return this.ready;
  }

  private async open(): Promise<void> {
    const pattern = userChannelPattern(this.prefix);
    const subscriber = this.redis.duplicate({ connectionName: this.connectionName });
    this.subscriber = subscriber;
    subscriber.on('error', (error: unknown) => {
      this.log.warn({ err: error }, 'user stream subscriber connection error');
    });
    subscriber.on('pmessage', (_pattern: string, channel: string, payload: string) => {
      this.dispatch(channel, payload);
    });
    subscriber.on('close', () => {
      this.lost = true;
    });
    subscriber.on('ready', () => {
      if (!this.lost || this.closed) return;
      this.lost = false;
      // ioredis subscribes again by itself; this PSUBSCRIBE (a no-op then) is
      // answered after it, so the pattern is live when the clients re-fetch.
      subscriber.psubscribe(pattern).then(
        () => this.resync(),
        (error: unknown) => {
          this.log.warn({ err: error }, 'user stream subscriber could not subscribe again');
        },
      );
    });
    try {
      await subscriber.psubscribe(pattern);
    } catch (error) {
      if (this.subscriber === subscriber) this.subscriber = null;
      subscriber.disconnect();
      throw error;
    }
  }

  private dispatch(channel: string, payload: string): void {
    const userId = userIdOfChannel(channel, this.prefix);
    if (userId === null) return;
    const listeners = this.listeners.get(userId);
    if (listeners === undefined || listeners.size === 0) return;
    let json: unknown;
    try {
      json = JSON.parse(payload);
    } catch {
      this.log.warn('dropping a user message that is not JSON');
      return;
    }
    const revoked = sessionRevokedOf(json);
    if (revoked !== null) {
      this.revoke(userId, revoked.data.sessionId);
      return;
    }
    const parsed = UserMessage.safeParse(json);
    if (!parsed.success) {
      this.log.warn('dropping a malformed user message');
      return;
    }
    const frame = userFrame(parsed.data);
    for (const listener of listeners) listener.send(frame);
  }

  /** Ends the streams of `sessionId` of the user (every stream of the user when null). */
  private revoke(userId: string, sessionId: string | null): void {
    const listeners = this.listeners.get(userId);
    if (listeners === undefined) return;
    for (const listener of [...listeners]) {
      if (sessionId !== null && listener.sessionId !== sessionId) continue;
      listeners.delete(listener);
      listener.end();
    }
    if (listeners.size === 0) this.listeners.delete(userId);
  }

  /** Tells every open stream that pushes may have been lost. */
  private resync(): void {
    for (const set of this.listeners.values()) {
      for (const listener of set) listener.send(RESYNC_FRAME);
    }
  }

  /** Drops every listener and closes the subscriber connection. */
  async close(): Promise<void> {
    this.closed = true;
    this.listeners.clear();
    await this.ready?.catch(() => undefined);
    const subscriber = this.subscriber;
    this.subscriber = null;
    if (subscriber !== null) {
      await subscriber.quit().catch(() => subscriber.disconnect());
    }
  }
}

/** Hubs by HTTP server, so tests (and diagnostics) can reach an app's hub. */
const HUBS = new WeakMap<object, UserHub>();

/** The user hub of an app built with this module (undefined before it is ready). */
export function userHubOf(app: FastifyInstance): UserHub | undefined {
  return HUBS.get(app.server);
}

export interface UserStreamOptions {
  /**
   * Prefix of the player channels (default `app.deps.userChannelPrefix`, else
   * `vamos:user:`). Not `prefix`: Fastify reads that as a route prefix.
   */
  channelPrefix?: string;
  /** Heartbeat interval in ms (default HEARTBEAT_MS). */
  heartbeatMs?: number;
  /** Session re-check interval in ms (default SESSION_RECHECK_MS). */
  sessionRecheckMs?: number;
}

const userStreamRoutes: FastifyPluginAsync<UserStreamOptions> = async (app, options) => {
  const { deps } = app;
  const hub = new UserHub(
    deps.redis,
    app.log,
    options.channelPrefix ?? deps.userChannelPrefix ?? USER_CHANNEL_PREFIX,
  );
  const heartbeatMs = options.heartbeatMs ?? HEARTBEAT_MS;
  const recheckMs = options.sessionRecheckMs ?? SESSION_RECHECK_MS;
  const streams = new Set<PassThrough>();
  HUBS.set(app.server, hub);

  // Open streams would keep server.close() waiting: end them first.
  app.addHook('preClose', async () => {
    for (const stream of streams) stream.end();
  });
  app.addHook('onClose', async () => {
    await hub.close();
    if (HUBS.get(app.server) === hub) HUBS.delete(app.server);
  });

  app.get('/me/stream', { preHandler: app.requireAuth }, async (request, reply) => {
    const user = requireUser(request);
    const stream = new PassThrough();
    const listener: UserListener = {
      sessionId: user.sessionId,
      end() {
        if (!stream.destroyed && !stream.writableEnded) stream.end();
      },
      drop() {
        if (!stream.destroyed) stream.destroy();
      },
      send(frame) {
        if (stream.destroyed || stream.writableEnded) return;
        if (stream.writableLength > MAX_BUFFERED_BYTES) {
          request.log.warn('user stream client too slow, disconnecting');
          stream.destroy();
          return;
        }
        stream.write(frame);
      },
    };

    let removeListener: (() => void) | undefined;
    let finished = false;
    let checking = false;
    const heartbeat = setInterval(() => listener.send(PING_FRAME), heartbeatMs);
    heartbeat.unref();
    const recheck = setInterval(() => {
      if (checking || finished) return;
      checking = true;
      isSessionActive(deps, user.sessionId)
        .then((active) => {
          if (!active && !finished) stream.end();
        })
        .catch((error: unknown) => {
          // Keep the stream: an outage is not a logout; the next check decides.
          request.log.warn({ err: error }, 'user stream session check failed');
        })
        .finally(() => {
          checking = false;
        });
    }, recheckMs);
    recheck.unref();
    const cleanup = () => {
      if (finished) return;
      finished = true;
      clearInterval(heartbeat);
      clearInterval(recheck);
      removeListener?.();
      streams.delete(stream);
      if (!stream.destroyed) stream.destroy();
    };
    // Fires when the response ends or the client goes away.
    reply.raw.once('close', cleanup);
    stream.once('close', cleanup);

    try {
      removeListener = await hub.add(user.id, listener, MAX_STREAMS_PER_USER);
    } catch (error) {
      cleanup();
      request.log.error({ err: error }, 'user stream subscription failed');
      throw serviceUnavailable(
        'stream_unavailable',
        'Updates are unavailable right now. Try again shortly.',
      );
    }
    if (finished) {
      // The client left while the subscription was set up.
      removeListener();
      reply.hijack();
      return;
    }
    streams.add(stream);
    // The first bytes flush the headers, so the client knows it is subscribed.
    stream.write(`retry: ${RETRY_MS}\n: connected\n\n`);

    return reply
      .header('content-type', 'text/event-stream')
      .header('cache-control', 'no-store')
      .header('x-accel-buffering', 'no')
      .send(stream);
  });
};

export default userStreamRoutes;
