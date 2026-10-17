'use client';

import { useEffect, useRef } from 'react';
import { PUBLIC_API_URL } from '@/lib/api/config';
import { browserSseEnvironment } from '@/lib/sse/resilient';
import { liveTickUrl, openLiveTick } from './live-tick';

/**
 * Calls `onTick` (throttled) when a live odds, match or market delta arrives
 * for one of `eventIds` on GET /live/stream, and when deltas may have been
 * missed (see openLiveTick). The stream is closed while the tab is hidden.
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
    const env = browserSseEnvironment();
    if (ids === '' || env === null) return;
    return openLiveTick(env, liveTickUrl(PUBLIC_API_URL, ids.split(',')), () => tick.current());
  }, [ids]);
}
