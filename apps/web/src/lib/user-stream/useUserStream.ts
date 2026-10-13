'use client';

import type { UserMessage } from '@vamos/contracts';
import { useEffect, useRef } from 'react';
import { useSession } from '@/providers/SessionProvider';
import { subscribeUserStream } from './connection';

/**
 * Listens to the signed-in player's push stream (bet accepted / rejected /
 * settled / cashed out / re-opened, wallet changed) while the component is
 * mounted. Does nothing for an anonymous visitor. Callbacks may change between
 * renders; the subscription does not restart. `onResync` runs when frames may
 * have been missed (reconnect): re-fetch what you show.
 */
export function useUserStream(
  onMessage: (message: UserMessage) => void,
  onResync?: () => void,
): void {
  const { status } = useSession();
  const handlers = useRef({ onMessage, onResync });
  useEffect(() => {
    handlers.current = { onMessage, onResync };
  });
  useEffect(() => {
    if (status !== 'authenticated') return;
    return subscribeUserStream({
      onMessage: (message) => handlers.current.onMessage(message),
      onResync: () => handlers.current.onResync?.(),
    });
  }, [status]);
}
