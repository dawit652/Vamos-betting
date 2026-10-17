import { PassThrough } from 'node:stream';
import { LIVE_CHANNEL, LiveMessage } from '@vamos/contracts';
import type { FastifyBaseLogger, FastifyInstance, FastifyPluginAsync } from 'fastify';
import type { Redis } from 'ioredis';
import { z } from 'zod';
import { parseInput, serviceUnavailable } from '../../lib/errors';

/**
 * GET /live/stream: Server-Sent Events relaying the worker's live changes
 * (LiveMessage envelopes on the LIVE_CHANNEL Redis channel) to clients.
 * Each message is sent as `event: <type>` with the compact delta as `data`.
 * One Redis subscriber connection per app instance serves every client.
 */

/**
 * A heartbeat (PING_FRAME) is sent this often, so proxies and mobile networks
 * keep the connection open and a client can tell a stalled stream (nothing
 * for a few heartbeats) from a quiet one.
 */
export const HEARTBEAT_MS = 15_000;
/**
 * The heartbeat: a named event, not an SSE comment, since comments never reach
 * the page's script (clients that do not listen for `ping` ignore it).
 */
export const PING_FRAME = 'event: ping\ndata: {}\n\n';
/** Most event ids one stream may filter on (`?events=a,b,c`). */
export const MAX_FILTER_EVENTS = 50;
/** A client this far behind (unsent bytes) is disconnected; EventSource reconnects. */
export const MAX_BUFFERED_BYTES = 1024 * 1024;
/** Reconnection delay suggested to EventSource clients. */
export const RETRY_MS = 3_000;

export const LiveStreamQuery = z.object({
  events: z
    .string()
    .max(4096)
    .optional()
    .transform((value) => {
      if (value === undefined) return undefined;
      const ids = value
        .split(',')
        .map((id) => id.trim().toLowerCase())
        .filter((id) => id.length > 0);
      return ids.length === 0 ? undefined : [...new Set(ids)];
    })
    .pipe(z.array(z.guid()).max(MAX_FILTER_EVENTS).optional()),
});

/** One connected client: the events it wants (null = all) and how to write a frame to it. */
export interface LiveListener {
  filter: ReadonlySet<string> | null;
  send(frame: string): void;
}

/** The SSE frame of a live message: `event: <type>\ndata: <delta json>\n\n`. */
export function liveFrame(message: LiveMessage): string {
  return `event: ${message.type}\ndata: ${JSON.stringify(message.data)}\n\n`;
}

/**
 * Fans the messages of one Redis channel out to the connected clients. The
 * subscriber connection (a duplicate of the app's Redis client) is opened on
 * the first listener and kept until close(); ioredis re-subscribes after a
 * reconnect. Messages that do not parse as a LiveMessage are dropped.
 */
export class LiveHub {
  private subscriber: Redis | null = null;
  private ready: Promise<void> | null = null;
  private closed = false;
  private readonly listeners = new Set<LiveListener>();

  constructor(
    private readonly redis: Redis,
    private readonly log: Pick<FastifyBaseLogger, 'warn' | 'error'>,
    readonly channel: string = LIVE_CHANNEL,
  ) {}

  get listenerCount(): number {
    return this.listeners.size;
  }

  /** Whether the shared subscriber connection has been created. */
  get connected(): boolean {
    return this.subscriber !== null;
  }

  /** Adds a listener once the channel is subscribed; returns its removal function. */
  async add(listener: LiveListener): Promise<() => void> {
    await this.connect();
    if (this.closed) throw new Error('the live hub is closed');
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private connect(): Promise<void> {
    if (this.closed) return Promise.reject(new Error('the live hub is closed'));
    this.ready ??= this.open().catch((error: unknown) => {
      this.ready = null;
      throw error;
    });
    return this.ready;
  }

  private async open(): Promise<void> {
    const subscriber = this.redis.duplicate();
    this.subscriber = subscriber;
    subscriber.on('error', (error: unknown) => {
      this.log.warn({ err: error }, 'live subscriber connection error');
    });
    subscriber.on('message', (channel: string, payload: string) => {
      if (channel === this.channel) this.dispatch(payload);
    });
    try {
      await subscriber.subscribe(this.channel);
    } catch (error) {
      if (this.subscriber === subscriber) this.subscriber = null;
      subscriber.disconnect();
      throw error;
    }
  }

  private dispatch(payload: string): void {
    let json: unknown;
    try {
      json = JSON.parse(payload);
    } catch {
      this.log.warn({ channel: this.channel }, 'dropping a live message that is not JSON');
      return;
    }
    const parsed = LiveMessage.safeParse(json);
    if (!parsed.success) {
      this.log.warn({ channel: this.channel }, 'dropping a malformed live message');
      return;
    }
    const message = parsed.data;
    const eventId = message.eventId.toLowerCase();
    const frame = liveFrame(message);
    for (const listener of this.listeners) {
      if (listener.filter === null || listener.filter.has(eventId)) listener.send(frame);
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
const HUBS = new WeakMap<object, LiveHub>();

/** The live hub of an app built with the catalogue module (undefined before it is ready). */
export function liveHubOf(app: FastifyInstance): LiveHub | undefined {
  return HUBS.get(app.server);
}

export interface LiveRoutesOptions {
  /** Redis channel to relay (default LIVE_CHANNEL). */
  channel?: string;
  /** Heartbeat interval in ms (default HEARTBEAT_MS). */
  heartbeatMs?: number;
}

const liveRoutes: FastifyPluginAsync<LiveRoutesOptions> = async (app, options) => {
  const hub = new LiveHub(app.deps.redis, app.log, options.channel ?? LIVE_CHANNEL);
  const heartbeatMs = options.heartbeatMs ?? HEARTBEAT_MS;
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

  app.get('/live/stream', async (request, reply) => {
    const query = parseInput(LiveStreamQuery, request.query);
    const filter = query.events === undefined ? null : new Set(query.events);
    const stream = new PassThrough();
    const listener: LiveListener = {
      filter,
      send(frame) {
        if (stream.destroyed || stream.writableEnded) return;
        if (stream.writableLength > MAX_BUFFERED_BYTES) {
          request.log.warn('live client too slow, disconnecting');
          stream.destroy();
          return;
        }
        stream.write(frame);
      },
    };

    let removeListener: (() => void) | undefined;
    let finished = false;
    const heartbeat = setInterval(() => listener.send(PING_FRAME), heartbeatMs);
    heartbeat.unref();
    const cleanup = () => {
      if (finished) return;
      finished = true;
      clearInterval(heartbeat);
      removeListener?.();
      streams.delete(stream);
      if (!stream.destroyed) stream.destroy();
    };
    // Fires when the response ends or the client goes away.
    reply.raw.once('close', cleanup);
    stream.once('close', cleanup);

    try {
      removeListener = await hub.add(listener);
    } catch (error) {
      cleanup();
      request.log.error({ err: error }, 'live stream subscription failed');
      throw serviceUnavailable(
        'live_unavailable',
        'Live updates are unavailable right now. Try again shortly.',
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
      .header('cache-control', 'no-cache')
      .header('x-accel-buffering', 'no')
      .send(stream);
  });
};

export default liveRoutes;
