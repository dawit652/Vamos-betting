import type { UserMessage } from '@vamos/contracts';
import { PUBLIC_API_URL } from '@/lib/api/config';
import {
  browserSseEnvironment,
  openResilientSource,
  type SseEnvironment,
} from '@/lib/sse/resilient';
import { parseUserFrame, USER_MESSAGE_TYPES } from './messages';

/**
 * One shared EventSource on GET /me/stream for the whole page, however many
 * components listen (the toast host, My Bets, the betslip's placed-bet view).
 * It opens with the first listener and closes with the last. Pub/sub has no
 * replay, so listeners also get a "resync" call whenever frames may have been
 * missed (reconnect, stall, tab back in view, the server's resync): re-fetch
 * what you show then. Reconnects, backoff and stall detection are
 * openResilientSource's (lib/sse/resilient.ts).
 *
 * Browser-only; the hook that mounts it is in useUserStream.ts.
 */

export interface UserStreamListener {
  onMessage: (message: UserMessage) => void;
  /** Frames may have been missed since the last message. */
  onResync?: () => void;
}

export interface UserStreamConnection {
  /** Starts listening; returns the function that stops. */
  subscribe(listener: UserStreamListener): () => void;
}

/** A shared connection to `url` (tests pass their own environment). */
export function createUserStreamConnection(
  environment: () => SseEnvironment | null,
  url: string,
): UserStreamConnection {
  const listeners = new Set<UserStreamListener>();
  let stop: (() => void) | null = null;

  const open = () => {
    const env = environment();
    if (env === null) return null;
    return openResilientSource({
      env,
      url,
      withCredentials: true,
      events: USER_MESSAGE_TYPES,
      onEvent: (type, data) => {
        const message = parseUserFrame(type, data);
        if (message === null) return;
        for (const listener of [...listeners]) listener.onMessage(message);
      },
      onResync: () => {
        for (const listener of [...listeners]) listener.onResync?.();
      },
    });
  };

  return {
    subscribe(listener) {
      listeners.add(listener);
      stop ??= open();
      return () => {
        listeners.delete(listener);
        if (listeners.size > 0) return;
        stop?.();
        stop = null;
      };
    },
  };
}

const shared = createUserStreamConnection(browserSseEnvironment, `${PUBLIC_API_URL}/me/stream`);

/** Starts listening to the player's stream; returns the function that stops. */
export function subscribeUserStream(listener: UserStreamListener): () => void {
  return shared.subscribe(listener);
}
