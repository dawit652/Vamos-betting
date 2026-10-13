'use client';

import { useEffect, useRef } from 'react';
import { PUBLIC_API_URL } from '@/lib/api/config';
import { createThrottle } from './throttle';
import { OFFER_REFRESH_MS } from './offer';

/**
 * Calls `onTick` (at most once per OFFER_REFRESH_MS, see createThrottle) when
 * a live odds, match or market delta arrives for one of `eventIds` on
 * GET /live/stream. Cash-out offers follow the live odds but are not pushed:
 * the caller re-fetches them on a tick. The stream is closed while the tab is
 * hidden and opened again, with one tick, when it is back in view.
 *
 * This is deliberately not the LiveProvider of the event pages: it patches no
 * odds and never asks the server for a re-render.
 */
export function useLiveTick(eventIds: readonly string[], onTick: () => unknown): void {
  const tick = useRef(onTick);
  useEffect(() => {
    tick.current = onTick;
  });
  const ids = eventIds.join(',');

  useEffect(() => {
    if (ids === '' || typeof EventSource === 'undefined') return;
    const throttle = createThrottle(() => tick.current(), OFFER_REFRESH_MS);
    const url = `${PUBLIC_API_URL}/live/stream?events=${encodeURIComponent(ids)}`;
    let source: EventSource | null = null;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let failures = 0;

    const connect = () => {
      clearTimeout(retry);
      if (source !== null || document.visibilityState === 'hidden') return;
      const next = new EventSource(url);
      source = next;
      const onFrame = () => throttle.request();
      for (const type of ['odds', 'match', 'market']) next.addEventListener(type, onFrame);
      next.onopen = () => {
        failures = 0;
        throttle.request(); // frames may have been missed
      };
      next.onerror = () => {
        if (next.readyState !== EventSource.CLOSED) return;
        next.close();
        source = null;
        retry = setTimeout(connect, Math.min(3_000 * 2 ** failures, 60_000));
        failures += 1;
      };
    };
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') {
        clearTimeout(retry);
        source?.close();
        source = null;
      } else {
        connect();
      }
    };

    connect();
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      clearTimeout(retry);
      source?.close();
      throttle.cancel();
    };
  }, [ids]);
}
