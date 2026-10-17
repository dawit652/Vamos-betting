/**
 * An EventSource that recovers by itself, shared by the player's push stream
 * (/me/stream) and the cash-out live tick (/live/stream). Browser-only; the
 * environment is passed in so tests can drive it (see ./testing.ts).
 *
 * - A network error is left to the browser, which reconnects by itself. A
 *   refusal (401, 503, a proxy's 502) closes the source for good: it is
 *   reopened after RECONNECT_MIN_MS, doubling up to RECONNECT_MAX_MS, and
 *   the backoff resets once a connection opens.
 * - The source is closed while the tab is hidden and reopened when it is
 *   back in view.
 * - The servers send a `ping` event every HEARTBEAT_MS. When nothing at all
 *   arrives for STALL_MS the connection is taken as stalled (a half-open
 *   mobile link sends no error) and replaced.
 * - Pub/sub has no replay: `onResync` runs whenever events may have been
 *   missed (a reconnect after an error or a stall, the tab back in view, or
 *   the server's `resync` event), so the caller re-fetches what it shows.
 */

export const RECONNECT_MIN_MS = 3_000;
export const RECONNECT_MAX_MS = 60_000;
/** The servers' heartbeat interval (HEARTBEAT_MS in apps/api). */
export const HEARTBEAT_MS = 15_000;
/** No event (heartbeats included) for this long: the stream is stalled. */
export const STALL_MS = (HEARTBEAT_MS * 5) / 2;

const CLOSED = 2;

/** What this module uses of an EventSource. */
export interface EventSourceLike {
  readonly readyState: number;
  onopen: ((event: Event) => unknown) | null;
  onerror: ((event: Event) => unknown) | null;
  addEventListener(type: string, listener: (event: MessageEvent<string>) => void): void;
  close(): void;
}

/** What this module uses of the document. */
export interface VisibilityTarget {
  readonly visibilityState: DocumentVisibilityState;
  addEventListener(type: 'visibilitychange', listener: () => void): void;
  removeEventListener(type: 'visibilitychange', listener: () => void): void;
}

export interface SseEnvironment {
  createSource(url: string, withCredentials: boolean): EventSourceLike;
  document: VisibilityTarget;
}

/** The browser's EventSource and document; null where there is none (server rendering). */
export function browserSseEnvironment(): SseEnvironment | null {
  if (typeof EventSource === 'undefined' || typeof document === 'undefined') return null;
  return {
    createSource: (url, withCredentials) => new EventSource(url, { withCredentials }),
    document,
  };
}

export interface ResilientSourceOptions {
  env: SseEnvironment;
  url: string;
  /** Send cookies (the player's own stream). Default false. */
  withCredentials?: boolean;
  /** Named events passed to onEvent (`ping` and `resync` are handled here). */
  events: readonly string[];
  onEvent: (type: string, data: string) => void;
  /** Events may have been missed: re-fetch what you show. */
  onResync: () => void;
  /** Also call onResync when the first connection opens. Default false. */
  resyncOnFirstOpen?: boolean;
}

/** Opens the source; returns the function that closes it for good. */
export function openResilientSource(options: ResilientSourceOptions): () => void {
  const { env } = options;
  let source: EventSourceLike | null = null;
  let retry: ReturnType<typeof setTimeout> | undefined;
  let watchdog: ReturnType<typeof setTimeout> | undefined;
  let failures = 0;
  let missed = options.resyncOnFirstOpen === true;
  let stopped = false;

  const closeSource = () => {
    clearTimeout(watchdog);
    watchdog = undefined;
    if (source === null) return;
    source.close();
    source = null;
  };

  const onStall = () => {
    missed = true;
    closeSource();
    connect();
  };

  // (Re)starts the stall timer: any event, a heartbeat included, shows the stream is alive.
  const alive = () => {
    clearTimeout(watchdog);
    watchdog = setTimeout(onStall, STALL_MS);
  };

  function connect(): void {
    clearTimeout(retry);
    retry = undefined;
    if (stopped || source !== null) return;
    if (env.document.visibilityState === 'hidden') {
      missed = true;
      return;
    }
    const next = env.createSource(options.url, options.withCredentials === true);
    source = next;
    const onFrame = (event: MessageEvent<string>) => {
      alive();
      options.onEvent(event.type, event.data);
    };
    for (const type of options.events) next.addEventListener(type, onFrame);
    next.addEventListener('ping', alive);
    next.addEventListener('resync', () => {
      alive();
      options.onResync();
    });
    next.onopen = () => {
      failures = 0;
      alive();
      if (!missed) return;
      missed = false;
      options.onResync();
    };
    next.onerror = () => {
      missed = true;
      // A network error: the browser reconnects by itself (the stall timer still runs).
      if (next.readyState !== CLOSED) return;
      closeSource();
      const delay = Math.min(RECONNECT_MIN_MS * 2 ** failures, RECONNECT_MAX_MS);
      failures += 1;
      retry = setTimeout(connect, delay);
    };
    alive();
  }

  const onVisibility = () => {
    if (env.document.visibilityState === 'hidden') {
      if (source !== null) missed = true;
      clearTimeout(retry);
      retry = undefined;
      closeSource();
    } else {
      connect();
    }
  };

  env.document.addEventListener('visibilitychange', onVisibility);
  connect();
  return () => {
    stopped = true;
    clearTimeout(retry);
    closeSource();
    env.document.removeEventListener('visibilitychange', onVisibility);
  };
}
