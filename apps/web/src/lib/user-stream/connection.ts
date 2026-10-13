import type { UserMessage } from '@vamos/contracts';
import { PUBLIC_API_URL } from '@/lib/api/config';
import { parseUserFrame, USER_MESSAGE_TYPES } from './messages';

/**
 * One shared EventSource on GET /me/stream for the whole page, however many
 * components listen (the toast host, My Bets, the betslip's placed-bet view).
 * It opens with the first listener and closes with the last. Pub/sub has no
 * replay, so listeners also get a "resync" call whenever frames may have been
 * missed (reconnect, tab back in view): re-fetch what you show then.
 *
 * Browser-only; the hook that mounts it is in useUserStream.ts.
 */

const RECONNECT_MIN_MS = 3_000;
const RECONNECT_MAX_MS = 60_000;

export interface UserStreamListener {
  onMessage: (message: UserMessage) => void;
  /** Frames may have been missed since the last message. */
  onResync?: () => void;
}

const listeners = new Set<UserStreamListener>();
let source: EventSource | null = null;
let retryTimer: ReturnType<typeof setTimeout> | undefined;
let failures = 0;
let missed = false;
let visibilityBound = false;

function emitResync(): void {
  for (const listener of [...listeners]) listener.onResync?.();
}

function onFrame(event: MessageEvent<string>): void {
  const message = parseUserFrame(event.type, event.data);
  if (message === null) return;
  for (const listener of [...listeners]) listener.onMessage(message);
}

function close(): void {
  clearTimeout(retryTimer);
  if (source === null) return;
  source.close();
  source = null;
}

function connect(): void {
  clearTimeout(retryTimer);
  if (source !== null || listeners.size === 0 || typeof EventSource === 'undefined') return;
  if (document.visibilityState === 'hidden') {
    missed = true;
    return;
  }
  const next = new EventSource(`${PUBLIC_API_URL}/me/stream`, { withCredentials: true });
  source = next;
  for (const type of USER_MESSAGE_TYPES) next.addEventListener(type, onFrame as EventListener);
  next.onopen = () => {
    failures = 0;
    if (missed) emitResync();
    missed = false;
  };
  next.onerror = () => {
    missed = true;
    // A network error: the browser reconnects by itself. A refusal (401, 503,
    // a proxy's 502) closes the stream for good: reopen it with backoff.
    if (next.readyState !== EventSource.CLOSED) return;
    close();
    const delay = Math.min(RECONNECT_MIN_MS * 2 ** failures, RECONNECT_MAX_MS);
    failures += 1;
    retryTimer = setTimeout(connect, delay);
  };
}

function onVisibility(): void {
  if (document.visibilityState === 'hidden') {
    if (source !== null) missed = true;
    close();
  } else {
    connect();
  }
}

/** Starts listening; returns the function that stops. */
export function subscribeUserStream(listener: UserStreamListener): () => void {
  listeners.add(listener);
  if (!visibilityBound) {
    document.addEventListener('visibilitychange', onVisibility);
    visibilityBound = true;
  }
  connect();
  return () => {
    listeners.delete(listener);
    if (listeners.size > 0) return;
    close();
    missed = false;
    failures = 0;
    document.removeEventListener('visibilitychange', onVisibility);
    visibilityBound = false;
  };
}
