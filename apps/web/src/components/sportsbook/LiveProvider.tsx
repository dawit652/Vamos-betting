'use client';

import { useRouter } from 'next/navigation';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from 'react';
import { useT } from '@/i18n/client';
import { PUBLIC_API_URL } from '@/lib/api/config';
import { useBetslip } from '@/providers/BetslipProvider';
import type { MarketStatus } from './events';
import { LiveStore, parseLiveFrame, type MatchState, type OddsState } from './live-store';

/**
 * Client island for live pages (live list, event page): subscribes to
 * GET /live/stream for the given events and patches odds, market status and
 * match clocks rendered by the server. Prices of selections on the betslip are
 * pushed to the slip so it shows the change.
 *
 * Without a provider (prematch lists) the hooks return the server values.
 */

const LiveContext = createContext<LiveStore | null>(null);

/** Frames arriving in a burst re-render once. */
const FLUSH_MS = 250;
/** Live lists refresh from the server this often (new matches, finished ones). */
const DEFAULT_REFRESH_MS = 60_000;
/** Reopening a stream the browser gave up on (non-200 answer): 3 s, 6 s, 12 s … up to 60 s. */
const RECONNECT_MIN_MS = 3_000;
const RECONNECT_MAX_MS = 60_000;

export function LiveProvider({
  eventIds,
  refreshMs = DEFAULT_REFRESH_MS,
  children,
}: {
  /** Events to follow (at most 50; the API rejects more). */
  eventIds: readonly string[];
  /** Periodic `router.refresh()`; 0 turns it off. */
  refreshMs?: number;
  children: ReactNode;
}) {
  const [store] = useState(() => new LiveStore());
  const router = useRouter();
  const slip = useBetslip();
  // `has` changes with every slip edit; read it through a ref so the stream stays open.
  const slipRef = useRef(slip);
  useEffect(() => {
    slipRef.current = slip;
  }, [slip]);
  const ids = eventIds.join(',');

  // Where the frame sequence stood when we last asked the server for a re-render.
  const refreshMark = useRef<number | null>(null);
  const requestRefresh = useCallback(() => {
    refreshMark.current = store.mark();
    router.refresh();
  }, [router, store]);

  // New server props (a refresh, the stream's or anyone's): they are fresher
  // than the live values received before the refresh was asked for, so those
  // stop overriding them. `eventIds` is a new array for every server render
  // and the same one for client re-renders, which makes it the signal.
  useEffect(() => {
    const mark = refreshMark.current;
    refreshMark.current = null;
    store.dropUpTo(mark ?? store.mark());
    store.flush();
  }, [eventIds, store]);

  useEffect(() => {
    if (ids === '' || typeof EventSource === 'undefined') return;
    const url = `${PUBLIC_API_URL}/live/stream?events=${encodeURIComponent(ids)}`;
    let source: EventSource | null = null;
    let flushTimer: ReturnType<typeof setInterval> | undefined;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    let failures = 0;
    // Frames were (or may have been) missed: re-render from the server once connected.
    let missed = false;
    let slipChanges = new Map<string, number>();

    const flush = () => {
      store.flush();
      if (slipChanges.size > 0) {
        const changes = [...slipChanges].map(([selectionId, oddsMilli]) => ({
          selectionId,
          oddsMilli,
        }));
        slipChanges = new Map();
        slipRef.current.updateOdds(changes);
      }
    };

    const onFrame = (event: MessageEvent<string>) => {
      const change = parseLiveFrame(event.type, event.data);
      if (change === null) return;
      store.apply(change);
      if (change.type === 'odds' && change.state.open && slipRef.current.has(change.selectionId)) {
        slipChanges.set(change.selectionId, change.state.oddsMilli);
      }
    };

    const disconnect = () => {
      if (source === null) return;
      source.close();
      source = null;
      clearInterval(flushTimer);
      flush();
      missed = true;
    };

    const connect = () => {
      clearTimeout(retryTimer);
      if (source !== null) return;
      const next = new EventSource(url);
      source = next;
      next.addEventListener('odds', onFrame);
      next.addEventListener('match', onFrame);
      next.addEventListener('market', onFrame);
      next.onopen = () => {
        failures = 0;
        store.setConnected(true);
        store.flush();
        if (missed) requestRefresh();
        missed = false;
      };
      next.onerror = () => {
        store.setConnected(false);
        store.flush();
        missed = true;
        // After a network error the browser reconnects by itself (CONNECTING).
        // A non-200 answer (503 live_unavailable, a proxy's 502 during a
        // deploy) or a wrong content type closes the stream for good: reopen
        // it ourselves, backing off.
        if (next.readyState !== EventSource.CLOSED) return;
        disconnect();
        const delay = Math.min(RECONNECT_MIN_MS * 2 ** failures, RECONNECT_MAX_MS);
        failures += 1;
        retryTimer = setTimeout(connect, delay);
      };
      flushTimer = setInterval(flush, FLUSH_MS);
    };

    // A hidden tab gets no frames (mobile data, battery); back in view it
    // reconnects and re-renders from the server.
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') {
        clearTimeout(retryTimer);
        disconnect();
      } else {
        connect();
      }
    };

    if (document.visibilityState === 'hidden') missed = true;
    else connect();
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      clearTimeout(retryTimer);
      disconnect();
    };
  }, [ids, store, requestRefresh]);

  useEffect(() => {
    if (refreshMs <= 0) return;
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') requestRefresh();
    }, refreshMs);
    return () => clearInterval(timer);
  }, [refreshMs, requestRefresh]);

  return <LiveContext value={store}>{children}</LiveContext>;
}

const noopSubscribe = () => () => undefined;

/** Current odds of a selection: the live value when one arrived, else `initial`. */
export function useLiveOdds(selectionId: string, initial: OddsState): OddsState {
  const store = useContext(LiveContext);
  const live = useSyncExternalStore(
    store?.subscribe ?? noopSubscribe,
    () => store?.getOdds(selectionId),
    () => undefined,
  );
  return live ?? initial;
}

export function useLiveMarketStatus(marketId: string, initial: MarketStatus): MarketStatus {
  const store = useContext(LiveContext);
  const live = useSyncExternalStore(
    store?.subscribe ?? noopSubscribe,
    () => store?.getMarket(marketId),
    () => undefined,
  );
  return live ?? initial;
}

/** The latest match state from the stream (undefined until one arrives). */
export function useLiveMatch(eventId: string): MatchState | undefined {
  const store = useContext(LiveContext);
  return useSyncExternalStore(
    store?.subscribe ?? noopSubscribe,
    () => store?.getMatch(eventId),
    () => undefined,
  );
}

/** A thin bar while the stream is reconnecting (renders nothing otherwise). */
export function LiveStatusBar() {
  const t = useT();
  const store = useContext(LiveContext);
  const connected = useSyncExternalStore(
    store?.subscribe ?? noopSubscribe,
    () => store?.connected ?? true,
    () => true,
  );
  if (connected) return null;
  return (
    <p role="status" className="bg-demo-bg px-3 py-1 text-center text-xxs text-demo-ink">
      {t('sportsbook.live.paused')}
    </p>
  );
}
