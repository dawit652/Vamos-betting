import { openResilientSource, type SseEnvironment } from '@/lib/sse/resilient';
import { OFFER_REFRESH_MS } from './offer';
import { createThrottle } from './throttle';

/**
 * The cash-out live tick (pure of React; useLiveTick mounts it): calls
 * `onTick` (at most once per OFFER_REFRESH_MS, see createThrottle) when a
 * live odds, match or market delta arrives on GET /live/stream, once the
 * stream opens and whenever deltas may have been missed (reconnect, stall,
 * tab back in view). Cash-out offers follow the live odds but are not
 * pushed: the caller re-fetches them on a tick.
 */

/** The public live stream filtered on `eventIds`. */
export function liveTickUrl(apiUrl: string, eventIds: readonly string[]): string {
  return `${apiUrl}/live/stream?events=${encodeURIComponent(eventIds.join(','))}`;
}

/** Opens the tick; returns the function that stops it. */
export function openLiveTick(env: SseEnvironment, url: string, onTick: () => unknown): () => void {
  const throttle = createThrottle(onTick, OFFER_REFRESH_MS);
  const stop = openResilientSource({
    env,
    url,
    events: ['odds', 'match', 'market'],
    onEvent: () => throttle.request(),
    onResync: () => throttle.request(),
    // Offers may have moved since they were loaded.
    resyncOnFirstOpen: true,
  });
  return () => {
    stop();
    throttle.cancel();
  };
}
