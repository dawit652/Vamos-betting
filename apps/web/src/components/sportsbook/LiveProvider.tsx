'use client';

import { useRouter } from 'next/navigation';
import {
  createContext,
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

  useEffect(() => {
    if (ids === '' || typeof EventSource === 'undefined') return;
    const url = `${PUBLIC_API_URL}/live/stream?events=${encodeURIComponent(ids)}`;
    const source = new EventSource(url);
    let opened = false;
    let slipChanges = new Map<string, number>();
    const flush = setInterval(() => {
      store.flush();
      if (slipChanges.size > 0) {
        const changes = [...slipChanges].map(([selectionId, oddsMilli]) => ({
          selectionId,
          oddsMilli,
        }));
        slipChanges = new Map();
        slipRef.current.updateOdds(changes);
      }
    }, FLUSH_MS);

    const onFrame = (event: MessageEvent<string>) => {
      const change = parseLiveFrame(event.type, event.data);
      if (change === null) return;
      store.apply(change);
      if (change.type === 'odds' && change.state.open && slipRef.current.has(change.selectionId)) {
        slipChanges.set(change.selectionId, change.state.oddsMilli);
      }
    };
    source.addEventListener('odds', onFrame);
    source.addEventListener('match', onFrame);
    source.addEventListener('market', onFrame);
    source.onopen = () => {
      store.setConnected(true);
      // Frames sent while we were away are lost: re-render from the server.
      if (opened) router.refresh();
      opened = true;
    };
    source.onerror = () => {
      // EventSource reconnects by itself (the API suggests a 3 s retry).
      store.setConnected(false);
    };
    return () => {
      clearInterval(flush);
      source.close();
    };
  }, [ids, store, router]);

  useEffect(() => {
    if (refreshMs <= 0) return;
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') router.refresh();
    }, refreshMs);
    return () => clearInterval(timer);
  }, [refreshMs, router]);

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
